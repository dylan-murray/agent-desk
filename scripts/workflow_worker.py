"""A durable execution worker; survives the web server restarting."""
import json
import os
from pathlib import Path
import selectors
import signal
import socket
import subprocess
import sys
import time
from urllib.request import urlopen
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from agent_desk.workflow_runtime import WorkflowRuntime
from agent_control import DeskClient

runtime=WorkflowRuntime(sys.argv[1],sys.argv[3]);identity=sys.argv[2]
with runtime.db() as db:row=dict(db.execute('SELECT * FROM executions WHERE id=?',(identity,)).fetchone())
config=json.loads(row['payload']);child=None;cancelled=False;terminal_id=None
logdir=runtime.path.parent/'workflow-logs';logdir.mkdir(exist_ok=True)
fd=os.open(logdir/(identity+'.log'),os.O_CREAT|os.O_WRONLY|os.O_TRUNC,0o600)
log=os.fdopen(fd,'wb',buffering=0)

def stop(signum=None,frame=None):
    global cancelled
    cancelled=True
signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)

def stop_child():
    if child and child.poll() is None:
        os.killpg(child.pid,signal.SIGTERM)
        try:child.wait(timeout=3)
        except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
    if terminal_id:
        try:DeskClient(runtime.desk).request('/api/terminals/stop',{'id':terminal_id})
        except Exception:pass

def owns_listener(port,pid):
    tree=subprocess.run(['ps','-axo','pid=,ppid='],capture_output=True,text=True,timeout=3)
    pairs=[tuple(map(int,line.split())) for line in tree.stdout.splitlines() if len(line.split())==2]
    owned={pid}
    while True:
        expanded=owned|{p for p,parent in pairs if parent in owned}
        if expanded==owned:break
        owned=expanded
    listeners=subprocess.run(['lsof','-nP','-tiTCP:'+str(port),'-sTCP:LISTEN'],capture_output=True,text=True,timeout=3)
    return bool(owned & {int(p) for p in listeners.stdout.split() if p.isdigit()})

try:
    with runtime.db() as db:
        if db.execute('SELECT state FROM executions WHERE id=?',(identity,)).fetchone()[0]=='cancelled':cancelled=True
    if cancelled:raise RuntimeError('Cancelled')
    runtime.update(identity,state='running',pid=os.getpid())
    deadline=time.monotonic()+config['timeout']
    if config['kind']=='automation':
        client=DeskClient(runtime.desk)
        result=client.request('/api/special-agents/launch',{'id':config['role_id'], 'event_context':config.get('event_context')})
        terminal_id=result['session']['id'];agent_run=result['run_id']
        runtime.update(identity,terminal_id=terminal_id,agent_run=agent_run)
        while not cancelled and time.monotonic()<deadline:
            # Read the durable handoff directly, including runs older than the API's history window.
            from agent_desk.special_agents import SpecialAgents
            store=SpecialAgents(runtime.path.parent/'special-agents.sqlite3')
            with store.db() as db:r=db.execute('SELECT * FROM runs WHERE id=?',(agent_run,)).fetchone()
            if r and r['state'] not in ('launching','running'):
                state='succeeded' if r['state']=='review' else 'blocked' if r['state']=='blocked' else 'failed'
                runtime.update(identity,state=state,detail=r['detail'],finished=time.time());log.write(r['detail'].encode());break
            # Let the server reconcile exited managed terminals. An unavailable server is retried without launching again.
            try:client.request('/api/special-agents')
            except Exception:client.token=None
            time.sleep(1)
        else:raise RuntimeError('Cancelled' if cancelled else 'Automation timed out waiting for its report')
        # The server archives and closes successful automation terminals after
        # acknowledging their final report, including manual and scheduled runs.
    else:
        ready=False
        for attempt in range(3):
            port=None
            if config['kind']=='app':
                with socket.socket() as reservation:
                    reservation.bind(('127.0.0.1',0));port=reservation.getsockname()[1]
            env=dict(os.environ)
            if 'event_context' in config:
                env['AGENT_DESK_EVENT']=json.dumps(config['event_context'],ensure_ascii=True)
            if port:env['PORT']=str(port)
            argv=[arg.replace('{port}',str(port)) if port else arg for arg in config['argv']]
            child=subprocess.Popen(argv,cwd=config['cwd'],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)  # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-tainted-env-args.dangerous-subprocess-use-tainted-env-args
            runtime.update(identity,port=port)
            selector=selectors.DefaultSelector();selector.register(child.stdout,selectors.EVENT_READ)
            started=time.monotonic();last_probe=0
            while not cancelled:
                for key,_ in selector.select(.15):
                    data=os.read(key.fd,32768)
                    if data:
                        if log.tell()>5*1024*1024:log.seek(0);log.truncate()
                        log.write(data)
                    else:selector.unregister(key.fileobj)
                code=child.poll();now=time.monotonic()
                if code is not None and not selector.get_map():break
                if not port and now>=deadline:raise RuntimeError('Task timed out')
                if port and not ready and now-last_probe>1:
                    last_probe=now
                    if owns_listener(port,child.pid):
                        try:
                            with urlopen(f'http://127.0.0.1:{port}/',timeout=2) as response: response.read(1)
                            ready=True;runtime.update(identity,state='ready',detail='App listening on its assigned port')
                        except Exception:pass
                    if now-started>30:raise RuntimeError('App did not become ready on its assigned port within 30 seconds')
            selector.close();child.stdout.close()
            if cancelled:raise RuntimeError('Cancelled')
            if port and not ready and attempt<2:
                # Retry only if another process claimed the selected port; other failures need user review.
                with socket.socket() as probe:
                    try:probe.bind(('127.0.0.1',port))
                    except OSError:continue
            if code!=0:raise RuntimeError(f'Process exited with code {code}; see Logs')
            if port and not ready:raise RuntimeError('App exited before becoming ready')
            runtime.update(identity,state='succeeded',detail='App stopped' if port else 'Command completed',finished=time.time());break
except BaseException as exc:
    stop_child()
    runtime.update(identity,state='cancelled' if cancelled else 'failed',detail=str(exc),finished=time.time())
    log.write((str(exc)+'\n').encode())
finally:
    log.close()
