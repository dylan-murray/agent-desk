import base64
import json
import os
from pathlib import Path
import sys
import shlex
import tempfile
import time
import unittest
from unittest.mock import patch
from agent_desk.launch_profiles import terminal_environment, infer_profile, profile_command, AUTH_OVERRIDES, CALLER_CONTEXT
from agent_desk.terminals import TerminalManager
from account_fixtures import use_accounts


def setUpModule():
    use_accounts()


class LaunchProfileTests(unittest.TestCase):
    def test_fresh_agents_do_not_inherit_caller_conversation_or_annotation_owner(self):
        parent={key:'unrelated-caller' for key in CALLER_CONTEXT}|{'PATH':'/bin','PROJECT_OPTION':'keep'}
        for profile in (None,'claude','codex-personal'):
            result=terminal_environment(parent,profile)
            self.assertFalse(set(CALLER_CONTEXT)&set(result))
            self.assertEqual(result['PROJECT_OPTION'],'keep')
        with patch.dict(os.environ,{'AGENT_DESK_REMOTE_NATIVE':'1'}):
            self.assertFalse(set(CALLER_CONTEXT)&set(terminal_environment(parent,'claude')))

    def test_accounts_ignore_launcher_auth_and_custom_keeps_its_environment(self):
        parent={key:'inherited-personal-value' for key in AUTH_OVERRIDES}
        parent['HOME']='/test/home';parent['PATH']='/bin';parent['UNRELATED_PROJECT_SETTING']='keep'
        for key,variable,folder in [('codex','CODEX_HOME','.codex'),('codex-personal','CODEX_HOME','.codex-personal'),('claude','CLAUDE_CONFIG_DIR',None),('claude-personal','CLAUDE_CONFIG_DIR','.claude-personal')]:
            result=terminal_environment(parent,key,home='/test/home')
            self.assertEqual(result.get(variable),'/test/home/'+folder if folder else None)
            if folder is None:self.assertNotIn(variable,result)
            self.assertFalse(any(v in result for v in AUTH_OVERRIDES if v!=variable))
            self.assertEqual(result['UNRELATED_PROJECT_SETTING'],'keep')
            self.assertEqual(result['HOME'],'/test/home')
        self.assertEqual(terminal_environment(parent),parent)
        with self.assertRaises(ValueError):terminal_environment(parent,'unknown')

    def test_known_controller_launches_infer_profiles_without_guessing_custom_commands(self):
        for name in ('claude','claude-personal','codex','codex-personal'):
            self.assertEqual(infer_profile([name]),name)
            self.assertEqual(infer_profile(['/bin/zsh','-lic',name+' "$@"','agent-desk']),name)
        self.assertIsNone(infer_profile(['/bin/zsh','-lic','custom-agent "$@"','agent-desk']))

    def test_login_shell_cannot_restore_other_account_or_api_key(self):
        manager=TerminalManager()
        try:
            with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{'ZDOTDIR':tmp}):
                fixture=Path(tmp)/'fake_claude.py'
                fixture.write_text("import os,json,sys; print('PROFILE_RESULT='+json.dumps(dict(config=os.environ.get('CLAUDE_CONFIG_DIR'),store=os.environ.get('CLAUDE_SECURESTORAGE_CONFIG_DIR'),key=os.environ.get('ANTHROPIC_API_KEY'),args=sys.argv[1:])),flush=True)")
                (Path(tmp)/'.zshrc').write_text(
                    'export ANTHROPIC_API_KEY=fixture-key CLAUDE_CONFIG_DIR=/wrong CLAUDE_SECURESTORAGE_CONFIG_DIR=/wrong\n'
                    +'alias claude='+shlex.quote(shlex.join([sys.executable,str(fixture)]))+'\n'
                    +"alias claude-personal='CLAUDE_CONFIG_DIR=$HOME/.claude-personal claude'\n")
                argument='literal spaces; $(not-a-command)'
                for profile in ('claude','claude-personal'):
                    argv=['/bin/zsh','-lic',profile+' "$@"','agent-desk',argument]
                    self.assertEqual(profile_command(argv,None),argv)
                    session=manager.launch(dict(cwd=tmp,argv=argv,name='Shell auth fixture',launch_profile=profile))
                    session.process.wait(5);session.reader.join(2)
                    output=base64.b64decode(session.output(0)['data']).decode()
                    payload=json.loads(output.split('PROFILE_RESULT=',1)[1].strip())
                    self.assertEqual(payload['config'],None if profile=='claude' else str(Path.home()/'.claude-personal'))
                    self.assertIsNone(payload['store']);self.assertIsNone(payload['key'])
                    self.assertEqual(payload['args'],[argument])
        finally:manager.close()

    def test_actual_pty_receives_selected_profile_not_server_credentials(self):
        manager=TerminalManager()
        try:
            with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{key:'inherited-value' for key in (*AUTH_OVERRIDES,*CALLER_CONTEXT)}):
                keys=['CODEX_HOME','CLAUDE_CONFIG_DIR','CLAUDE_SECURESTORAGE_CONFIG_DIR','OPENAI_API_KEY','ANTHROPIC_API_KEY',*CALLER_CONTEXT]
                script="import os,json; print('PROFILE_RESULT='+json.dumps({k:os.environ.get(k) for k in "+repr(keys)+"}),flush=True)"
                for profile,variable,folder in [('codex','CODEX_HOME','.codex'),('claude','CLAUDE_CONFIG_DIR',None),('codex-personal','CODEX_HOME','.codex-personal'),('claude-personal','CLAUDE_CONFIG_DIR','.claude-personal')]:
                    session=manager.launch({'cwd':tmp,'argv':[sys.executable,'-c',script],'name':'Profile fixture','launch_profile':profile})
                    deadline=time.time()+4
                    while session.process.poll() is None and time.time()<deadline:time.sleep(.02)
                    output=base64.b64decode(session.output(0)['data']).decode()
                    payload=json.loads(output.split('PROFILE_RESULT=',1)[1].strip())
                    self.assertEqual(payload[variable],str(Path.home()/folder) if folder else None)
                    self.assertIsNone(payload['CLAUDE_SECURESTORAGE_CONFIG_DIR'])
                    self.assertIsNone(payload['OPENAI_API_KEY']);self.assertIsNone(payload['ANTHROPIC_API_KEY'])
                    self.assertTrue(all(payload[key] is None for key in CALLER_CONTEXT))
                    self.assertEqual(session.info()['launch_profile'],profile)
        finally:manager.close()
