import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from agent_desk.coordinator_planners import NativePlanner, parse_reply, run_command
from agent_desk.coordinator_runtime import SCHEMA,RULES
from account_fixtures import use_accounts

REPLY={'message':'Ready','actions':[{'kind':'read','name':'','profile':'','task':'','worker_id':'worker-one'}]}


def setUpModule():
    use_accounts()


class PlannerTests(unittest.TestCase):
    def test_all_native_adapters_preserve_context_and_use_bounded_output(self):
        for profile in ('claude','claude-personal','codex','codex-personal','grok'):
            with self.subTest(profile=profile),tempfile.TemporaryDirectory() as directory:
                calls=[]
                def runner(argv,cwd,env,source,cancel,outputs=()):
                    calls.append(argv)
                    self.assertEqual(cwd,directory)
                    self.assertNotIn('--always-approve',argv);self.assertNotIn('--bypass',argv)
                    self.assertNotIn('--dangerously-bypass-approvals-and-sandbox',argv)
                    if profile.startswith(('claude','codex')):
                        self.assertNotIn('ANTHROPIC_API_KEY',env);self.assertNotIn('OPENAI_API_KEY',env)
                    if profile.startswith('claude'):
                        self.assertEqual(json.loads(source)['original_goal'],'Keep the existing goal')
                        self.assertEqual(argv[argv.index('--tools')+1],'')
                        return json.dumps({'structured_output':REPLY})
                    if profile=='grok':
                        self.assertEqual(argv[argv.index('--tools')+1],'')
                        self.assertEqual(argv[argv.index('--deny')+1],'*')
                        self.assertIn('Keep the existing goal',Path(argv[argv.index('--prompt-file')+1]).read_text())
                        return json.dumps({'result':json.dumps(REPLY)})
                    if profile.startswith('codex'):
                        self.assertIn('Keep the existing goal',source)
                        self.assertEqual(env['CODEX_HOME'],str(Path.home()/('.codex-personal' if profile.endswith('personal') else '.codex')))
                        self.assertEqual(argv[argv.index('--sandbox')+1],'read-only')
                        self.assertEqual(json.loads(Path(argv[argv.index('--output-schema')+1]).read_text()),SCHEMA)
                    path=Path(argv[argv.index('--output-last-message')+1]);path.write_text(json.dumps(REPLY))
                    self.assertIn(path,outputs)
                    return '{}'
                with patch('agent_desk.coordinator_planners.shutil.which',side_effect=lambda name:'/bin/'+name),patch.dict(os.environ,{'OPENAI_API_KEY':'fixture','ANTHROPIC_API_KEY':'fixture'}):
                    planner=NativePlanner(SCHEMA,RULES,runner)
                    result=planner(dict(profile=profile,cwd=directory,model='test-model'),{'original_goal':'Keep the existing goal'},threading.Event())
                self.assertEqual(result,REPLY);self.assertEqual(len(calls),1)
                self.assertIn('test-model',calls[0])

    def test_opencode_and_pi_plan_without_tools_and_tolerate_prose_around_the_reply(self):
        for profile in ('opencode','pi'):
            with self.subTest(profile=profile),tempfile.TemporaryDirectory() as directory:
                calls=[]
                def runner(argv,cwd,env,source,cancel,outputs=()):
                    calls.append(argv)
                    self.assertEqual(cwd,directory)
                    self.assertIn('Keep the existing goal',source);self.assertIn('"maxItems"',source)
                    self.assertNotIn(RULES[:80],source,'rules travel as the system prompt, not twice')
                    if profile=='pi':
                        self.assertIn('--no-tools',argv);self.assertIn('--no-session',argv)
                        self.assertEqual(argv[argv.index('--system-prompt')+1],RULES)
                        return 'Here is the plan:\n```json\n'+json.dumps(REPLY)+'\n```\n'
                    agent=json.loads(env['OPENCODE_CONFIG_CONTENT'])['agent'][argv[argv.index('--agent')+1]]
                    self.assertEqual(agent['prompt'],RULES)
                    self.assertIs(agent['tools']['*'],False);self.assertFalse(any(agent['tools'].values()))
                    events=[dict(type='step_start',sessionID='ses_plan1'),dict(type='text',sessionID='ses_plan1',part=dict(type='text',text='draft')),
                            dict(type='step_start',sessionID='ses_plan1'),dict(type='text',sessionID='ses_plan1',part=dict(type='text',text=json.dumps(REPLY)))]
                    return '\n'.join(json.dumps(e) for e in events)
                with patch('agent_desk.coordinator_planners.shutil.which',side_effect=lambda name:'/bin/'+name),\
                     patch('agent_desk.coordinator_planners.subprocess.run') as cleanup:
                    result=NativePlanner(SCHEMA,RULES,runner)(dict(profile=profile,cwd=directory,model='test/model'),{'original_goal':'Keep the existing goal'},threading.Event())
                self.assertEqual(result,REPLY);self.assertEqual(len(calls),1);self.assertIn('test/model',calls[0])
                if profile=='opencode':
                    self.assertEqual(cleanup.call_args.args[0],['/bin/opencode','session','delete','ses_plan1'])
                else:cleanup.assert_not_called()

    def test_codex_planning_disables_mcp_servers_with_keys_codex_accepts(self):
        # Codex's -c parser treats TOML quotes as part of the name; a quoted override defines a
        # transport-less server and the CLI refuses to load its configuration.
        with tempfile.TemporaryDirectory() as home,tempfile.TemporaryDirectory() as directory:
            (Path(home)/'.codex').mkdir()
            (Path(home)/'.codex'/'config.toml').write_text('[mcp_servers.node_repl]\ncommand="n"\n[mcp_servers.computer-use]\ncommand="c"\n[mcp_servers."has.dot"]\ncommand="d"\n')
            calls=[]
            def runner(argv,cwd,env,source,cancel,outputs=()):
                calls.append(argv);outputs[0].write_text(json.dumps(REPLY));return '{}'
            with patch('pathlib.Path.home',return_value=Path(home)):
                NativePlanner(SCHEMA,RULES,runner)({'profile':'codex','cwd':directory},{},threading.Event())
            overrides=[calls[0][i+1] for i,a in enumerate(calls[0][:-1]) if a=='-c' and calls[0][i+1].startswith('mcp_servers.')]
            self.assertEqual(overrides,['mcp_servers.node_repl.enabled=false','mcp_servers.computer-use.enabled=false','mcp_servers."has.dot".enabled=false'])

    def test_invalid_provider_json_never_becomes_actions(self):
        for text in ('not json','{"message":"Hi","actions":[{"kind":"shell","command":"rm"}]}','{"message":"Hi","actions":{}}','{"message":"Hi","actions":[],"extra":true}'):
            with self.subTest(text=text),self.assertRaises(ValueError):parse_reply(text)
        self.assertEqual(parse_reply('```json\n'+json.dumps(REPLY)+'\n```'),REPLY)

    def test_cancellation_stops_native_process(self):
        cancel=threading.Event();timer=threading.Timer(.2,cancel.set);timer.start()
        try:
            with self.assertRaisesRegex(ValueError,'interrupted'):
                run_command([sys.executable,'-c','import time; time.sleep(30)'],os.getcwd(),dict(os.environ),'',cancel)
        finally:timer.cancel()

    def test_provider_failure_and_missing_response_are_visible(self):
        with self.assertRaisesRegex(ValueError,'status 7'):
            run_command([sys.executable,'-c','raise SystemExit(7)'],os.getcwd(),dict(os.environ),'',threading.Event())
        with self.assertRaisesRegex(ValueError,'final planning response'):
            NativePlanner(SCHEMA,RULES,lambda *args:'{}')({'profile':'codex','cwd':os.getcwd()},{},threading.Event())
