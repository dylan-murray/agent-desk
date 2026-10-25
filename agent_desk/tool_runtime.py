"""Shared skill UI lifecycle for the API and command-line launcher."""
from agent_desk.paths import DATA_DIR
from agent_desk.local_transport import runtime_directory, write_private_json
from agent_desk.managed_processes import OwnedProcesses
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import uuid

ROOT=Path(__file__).resolve().parents[1]
# Annotation skills recognised by name, without a manifest. Any other skill registers with agent-desk-ui.json.
BUILTINS={
 'code-review':('Code review','Annotate changes in a Git working tree.','review_app.py','directory'),
 'readme-review':('Markdown review','Annotate a README or markdown document.','readme_annotate.py','file'),
 'document-builder':('Document review','Review and annotate a draft document.','notion_draft.py','file'),
 'diagram-doc-creator':('Diagram feedback','Review a diagram and mark precise changes.','diagram_doc.py','file'),
 'architecture-review':('Architecture review','Revise a system architecture on a canvas.','architecture_review.py','file'),
 'pull-request-description-review':('PR description review','Annotate a pull request description draft.','review_draft.py','file')}

class ToolRuntime:
    def __init__(self,state=None,roots=None):
        self.state=Path(state or DATA_DIR/'tool-runtime');self.state.mkdir(parents=True,exist_ok=True)
        self.processes={}
        self.roots=roots or ([Path(p).expanduser().resolve() for p in os.environ['AGENT_DESK_TOOL_ROOTS'].split(os.pathsep) if p] if os.environ.get('AGENT_DESK_TOOL_ROOTS') else [Path.home()/'.claude'/'skills',Path.home()/'.agents'/'skills'])

    def catalog(self):
        found={}
        for root in self.roots:
            if not root.is_dir():continue
            for folder in sorted(root.iterdir()):
                if folder.name in found or not folder.is_dir():continue
                manifest=folder/'agent-desk-ui.json'
                try:
                    if manifest.is_file():
                        item=json.loads(manifest.read_text())
                        if item.get('runtime')!='python-http':continue
                        script=(folder/item['entrypoint']).resolve()
                        if not script.is_relative_to(folder.resolve()):continue
                        title=item.get('title',folder.name);description=item.get('description','');kind=item.get('target','file')
                        # A tool may open on a file, a folder, or nothing at all; the agent that builds it decides.
                        transports=item.get('transports', [])
                        if os.environ.get('AGENT_DESK_WORKSPACE_ID') and 'unix-http-v1' not in transports:continue
                        arguments=item.get('args',(['{target}'] if kind!='none' else [])+['--port','{port}','--no-browser'])
                    elif folder.name in BUILTINS:
                        title,description,entry,kind=BUILTINS[folder.name];script=folder/entry
                        arguments=['{target}','--port','{port}','--no-browser']
                    else:continue
                    if not script.is_file() or kind not in ('file','directory','none') or not isinstance(arguments,list) or not all(isinstance(a,str) for a in arguments):continue
                    if not isinstance(title,str) or not isinstance(description,str):continue
                    found[folder.name]=dict(id=folder.name,title=title,description=description,target=kind,script=str(script),args=arguments)
                except (OSError,ValueError,KeyError,TypeError):continue
        return list(found.values())

    @contextmanager
    def locked(self):
        with (self.state/'launch.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            yield

    def record_path(self,identity):
        if not isinstance(identity,str) or not identity or len(identity)>80:raise ValueError('Invalid tool ID')
        return self.state/(hashlib.sha256(identity.encode()).hexdigest()+'.json')

    @staticmethod
    def read_record(path):
        try:return json.loads(path.read_text())
        except (OSError, ValueError):return None

    def read(self,identity):
        try:return json.loads(self.record_path(identity).read_text())
        except (OSError,ValueError):return None

    def save(self,item):
        path=self.record_path(item['id'])
        write_private_json(path, item)

    def owned(self,item):
        if not item or item.get('stopped'):return False
        try:
            result=subprocess.run(['ps','-ww','-p',str(item['pid']),'-o','command='],capture_output=True,text=True,timeout=2)
            return result.returncode==0 and 'serve_skill_ui.py' in result.stdout and '--instance '+item['instance'] in result.stdout
        except (OSError,subprocess.SubprocessError,KeyError):return False

    def status(self,identity):
        item=self.read(identity)
        return {'managed':bool(item),'status':('running' if self.owned(item) else 'stopped') if item else 'external'}

    def launch(self,skill,target,identity=None,title=None,port=None,extra=None):
        if title is not None and (not isinstance(title,str) or not 1<=len(title)<=2000):raise ValueError('Invalid tool title')
        spec=next((item for item in self.catalog() if item['id']==skill),None)
        if not spec:raise ValueError('No installed launcher found for this skill')
        if spec['target']=='none':target=None
        else:
            if not isinstance(target,str) or not Path(target).expanduser().is_absolute():raise ValueError('Choose an absolute target path')
            target=Path(target).expanduser().resolve()
            if not (target.is_file() if spec['target']=='file' else target.is_dir()):raise ValueError('Target must be an existing '+spec['target'])
        identity=identity or skill+'-'+hashlib.sha256(str(target or '').encode()).hexdigest()[:10]
        if not isinstance(identity,str) or len(identity)>80 or not all(c.isalnum() or c in '_-' for c in identity):raise ValueError('Invalid tool ID')
        if port is not None and (type(port) is not int or not 1<=port<=65535):raise ValueError('Invalid port')
        extra=extra or []
        if not isinstance(extra,list) or not all(isinstance(a,str) and len(a)<=10000 for a in extra):raise ValueError('Invalid arguments')
        if any(a.split('=')[0] in ('--port','--no-browser') for a in extra):raise ValueError('Port and browser mode are managed by Agent Desk')
        workspace=os.environ.get('AGENT_DESK_WORKSPACE_ID')
        if workspace and port is not None:raise ValueError('Desktop tools use Unix sockets, not TCP ports')
        with self.locked():
            if workspace and (self.state.parent/'desktop-shutdown.json').exists():
                raise ValueError('Desktop launches are paused during shutdown recovery')
            previous=self.read(identity)
            if previous and self.owned(previous):
                if previous['context']!=str(target or '') or previous['skill']!=skill:raise ValueError('This tool ID already belongs to another target')
                return previous
            instance=uuid.uuid4().hex;ready=self.state/(instance+'.ready');log=self.state/(instance+'.log')
            socket_path=None
            if workspace:
                folder=runtime_directory(DATA_DIR, workspace)
                socket_path=folder/('tool-'+instance[:16]+'.sock')
            with socket.socket(socket.AF_UNIX if workspace else socket.AF_INET) as listener:
                if workspace:
                    listener.bind(str(socket_path));os.chmod(socket_path,0o600);port=0
                else:
                    listener.bind(('127.0.0.1',port or 0));port=listener.getsockname()[1]
                argv=[arg.replace('{target}',str(target)).replace('{port}',str(port)) for arg in spec['args'] if target is not None or '{target}' not in arg]
                env=dict(os.environ,AGENT_DESK_LISTEN_FD=str(listener.fileno()),PYTHONUNBUFFERED='1')
                if workspace:env['AGENT_DESK_TOOL_INSTANCE']=instance
                if skill=='code-review' and identity.startswith('hook-ui-'):env['AGENT_DESK_REVIEW_BRIDGE']='1'
                with log.open('ab') as output:
                    process=subprocess.Popen([sys.executable,str(ROOT/'scripts'/'serve_skill_ui.py'),'--instance',instance,'--ready',str(ready),spec['script'],*argv,*extra],env=env,pass_fds=(listener.fileno(),),stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
            try:
                deadline=time.monotonic()+15
                while time.monotonic()<deadline:
                    if process.poll() is not None:raise ValueError('Tool exited during startup. See '+str(log))
                    if ready.exists() and json.loads(ready.read_text()).get('instance')==instance:break
                    time.sleep(.05)
                else:raise ValueError('Tool did not claim its reserved socket. See '+str(log))
                item=dict(id=identity,title=title or spec['title']+(' · '+target.name if target else ''),skill=skill,context=str(target or ''),url=f'http://127.0.0.1:{port}',pid=process.pid,instance=instance,log=str(log))
                if workspace:item.update(url='agent-tool://t'+instance,transport='unix-http-v1',socket=str(socket_path))
                self.processes[identity]=process
                self.save(item);return item
            except Exception:
                if process.poll() is None:OwnedProcesses(process.pid).stop()
                process.wait(timeout=3);raise
            finally:ready.unlink(missing_ok=True)

    def stop(self,identity):
        with self.locked():
            item=self.read(identity)
            if not item:raise ValueError('This tool was registered externally; Agent Desk does not own its process')
            if self.owned(item):
                OwnedProcesses(item['pid']).stop()
                process=self.processes.pop(identity,None)
                if process:process.wait(timeout=3)
            item['stopped']=True;self.save(item)
            return self.status(identity)
