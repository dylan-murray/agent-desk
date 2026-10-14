"""Two-process integration: remote runtime + SSH-stream substitute, no AWS/model calls."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.request import urlopen
from urllib.error import HTTPError
from agent_desk.remote_environments import SSHBridge, RemoteEnvironments


class RemoteRuntimeTests(unittest.TestCase):
    def test_worker_reports_survive_bridge_disconnect_and_coordinator_reopens(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);state=root/'state';state.mkdir();binary=root/'bin';binary.mkdir()
            cli=binary/'grok'
            cli.write_text('#!'+sys.executable+'\n'+'''import json,os,re,sys,time
from pathlib import Path
assert os.environ['AGENT_DESK_TEST_REMOTE_AUTH']=='remote-only'
state=Path(os.environ['AGENT_DESK_DATA_DIR'])
if '--json-schema' in sys.argv:
    count=state/'planner-count'
    n=int(count.read_text()) if count.exists() else 0
    count.write_text(str(n+1))
    actions=[{'kind':'launch','name':'Remote worker','profile':'grok','model':'','task':'Complete the fixture task','worker_id':''}] if n==0 else []
    print(json.dumps({'message':'Remote worker completed.' if n else 'Dispatching remote work.','actions':actions}))
else:
    task=re.search(r'reply (task-[a-z0-9]+) --file',sys.argv[-1]).group(1)
    desk=re.search(r'--desk (http://127.0.0.1:[0-9]+)',sys.argv[-1]).group(1)
    deadline=time.monotonic()+30
    while not (state/'finish').exists() and time.monotonic()<deadline:time.sleep(.05)
    from scripts.control_mailbox import Mailbox
    Mailbox().reply(desk,task,'Remote final report; remote auth preserved.','completed')
    print('Remote worker finished',flush=True)
''');cli.chmod(0o700)
            shim=root/'ssh-fixture'
            shim.write_text('#!'+sys.executable+'\nimport os,sys\nos.execv(sys.executable,[sys.executable,"-m","agent_desk.remote_node","--bridge"])\n');shim.chmod(0o700)
            env=dict(os.environ,AGENT_DESK_DATA_DIR=str(state),AGENT_DESK_REMOTE_NATIVE='1',AGENT_DESK_TEST_REMOTE_AUTH='remote-only',PYTHONPATH=str(Path.cwd()),PATH=str(binary)+os.pathsep+os.environ['PATH'])
            runtime=subprocess.Popen([sys.executable,'-m','agent_desk.remote_node'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            bridges=[]
            def until(check):
                deadline=time.monotonic()+20
                while time.monotonic()<deadline:
                    result=check()
                    if result:return result
                    time.sleep(.1)
                self.fail('Remote fixture timed out')
            try:
                until(lambda:(state/'node.json').exists())
                metadata=json.loads((state/'node.json').read_text())
                with self.assertRaises(HTTPError) as error:urlopen(f"http://127.0.0.1:{metadata['port']}/api/terminal-auth")
                self.assertEqual(error.exception.code,403);error.exception.close()
                with patch('agent_desk.remote_environments.ssh_command',return_value=[str(shim)]),patch('agent_desk.remote_environments.environment',return_value=env):
                    bridge=SSHBridge({}, {'state':str(state),'root':str(Path.cwd())});bridges.append(bridge)
                    manager=RemoteEnvironments(root/'local-registry.json')
                    manager.bridges['fixture']=bridge
                    manager.nodes['fixture']={'id':'fixture','name':'Remote fixture','connected':True,'profiles':['grok'],'node':True}
                    c=manager.request('fixture','/api/coordinators/create',{'name':'Remote controller','cwd':str(root),'profile':'grok','remote_node':'fixture'})
                    self.assertEqual(c['remote_node'],'fixture')
                    identity=c['id'].split(':',2)[2]
                    bridge.request('/api/coordinators/message',{'id':identity,'text':'Run the remote task','request_id':'remote-test'})
                    until(lambda:any(a.get('terminal_id') for a in bridge.request('/api/agents')['agents']))
                    team=bridge.request('/api/agents')['agents'];worker=next(a for a in team if a.get('terminal_id'))
                    self.assertEqual(worker['parent_id'],identity)
                    bridge.close();self.assertIsNone(runtime.poll())
                    (state/'finish').touch()
                    bridge=SSHBridge({}, {'state':str(state),'root':str(Path.cwd())});bridges.append(bridge)
                    snapshot=until(lambda:(lambda s:s if any(m['kind']=='worker' for m in s['messages']) else None)(bridge.request('/api/coordinators?id='+identity)))
                    reports=[m for m in snapshot['messages'] if m['kind']=='worker']
                    self.assertEqual(len(reports),1)
                    self.assertEqual(reports[0]['reply_task']['result'],'Remote final report; remote auth preserved.')
                    until(lambda:int((state/'planner-count').read_text())>=2)
                    output=bridge.request('/api/terminals/output?id='+worker['id']+'&cursor=0')
                    self.assertIn('data',output)
                    bridge.request('/api/coordinators/close',{'id':identity})
                    self.assertTrue(bridge.request('/api/coordinators?id='+identity)['coordinators'][0]['closed'])
                    bridge.request('/api/coordinators/reopen',{'id':identity})
                    self.assertFalse(bridge.request('/api/coordinators?id='+identity)['coordinators'][0]['closed'])
                    self.assertEqual(int((state/'planner-count').read_text()),2)
            finally:
                for bridge in bridges:bridge.close()
                runtime.terminate();runtime.wait(timeout=5)
