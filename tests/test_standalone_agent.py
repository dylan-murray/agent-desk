import base64
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from agent_desk.standalone_agent import launch_payload, SHELL_MARKER
from agent_desk.terminals import TerminalManager


class StandaloneTests(unittest.TestCase):
    def test_owned_agents_and_shells_are_not_wrapped(self):
        for p in ({'argv':['/bin/sh']},{'argv':['claude'],'parent_id':'coordinator-1'},
                  {'argv':['claude'],'coordinator_harness':'claude'}):
            self.assertEqual(launch_payload(p),p)
        p={'argv':['/bin/zsh','-lic','claude-personal "$@"','agent-desk','a; $(touch BAD)'], 'launch_profile':'claude-personal'}
        wrapped=launch_payload(p)
        self.assertEqual(wrapped['argv'],[*p['argv'],SHELL_MARKER])
        self.assertEqual(wrapped['launch_profile'],'claude-personal')
        for cli in ('grok','opencode','pi'):
            self.assertEqual(launch_payload({'argv':[cli]})['argv'],[cli,SHELL_MARKER])

    def run_lifecycle(self,interrupt,login_launcher=False,harness=None):
        with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{'SHELL':'/bin/bash'}):
            root=Path(directory);agent=root/(harness or 'agent.py')
            agent.write_text('#!'+sys.executable+'\n'+"import os,sys,time\nprint('AGENT_READY',flush=True)\n"+('time.sleep(60)\n' if interrupt else 'sys.exit(0)\n'))
            agent.chmod(0o700)
            manager=TerminalManager()
            try:
                argv=[sys.executable,str(agent)]
                if harness:argv=[str(agent)]
                if login_launcher:argv=['/bin/bash','-lic','exec "$@"','agent-desk',*argv]
                session=manager.launch(launch_payload({'argv':argv,'cwd':directory,'launch_profile':None if harness else 'claude','name':'Fixture agent'}))
                if harness:self.assertEqual(session.info()['harness'],harness)
                def output():return base64.b64decode(session.output(0)['data']).decode(errors='replace')
                def wait(needle):
                    end=time.monotonic()+8
                    while time.monotonic()<end:
                        if needle in output():return
                        time.sleep(.05)
                    self.fail(output())
                wait('AGENT_READY')
                if interrupt:session.send({'op':'input','data':base64.b64encode(b'\x03').decode()})
                wait('Shell ready.')
                self.assertIsNone(session.process.poll())
                time.sleep(.4)
                with self.assertRaisesRegex(ValueError,'exited to a shell'):
                    session.send_task('must never be a shell command')
                session.send({'op':'input','data':base64.b64encode(b"printf shell-ok > result.txt\n").decode()})
                end=time.monotonic()+5
                while time.monotonic()<end and not (root/'result.txt').exists():time.sleep(.05)
                self.assertEqual((root/'result.txt').read_text(),'shell-ok')
                session.send({'op':'input','data':base64.b64encode(b'exit\n').decode()})
                end=time.monotonic()+5
                while time.monotonic()<end and session.process.poll() is None:time.sleep(.05)
                self.assertIsNotNone(session.process.poll())
            finally:manager.close()

    def test_normal_agent_exit_returns_to_working_shell(self):self.run_lifecycle(False)
    def test_ctrl_c_agent_exit_returns_to_working_shell(self):self.run_lifecycle(True)
    def test_login_launcher_ctrl_c_returns_to_working_shell(self):self.run_lifecycle(True,login_launcher=True)
    def test_grok_identity_and_shell_lifecycle(self):self.run_lifecycle(True,harness='grok')
