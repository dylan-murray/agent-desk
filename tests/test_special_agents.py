import json
import os
import shlex
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from agent_desk import server
from agent_desk.special_agents import SpecialAgents, launch_payload


class SpecialAgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'roles.sqlite3'
        self.store = SpecialAgents(self.path)
        self.role = self.store.save_role(dict(name='Slack triage', kind='watcher', scope='#team only',
            instructions='Find actionable requests', cwd=self.temp.name, choice='claude', command='claude', mode='/bin/zsh'))

    def tearDown(self):
        self.temp.cleanup()

    def test_deduplicated_findings_stay_reviewed_and_survive_restart(self):
        payload = dict(role_id=self.role['id'], event_key='thread:123', title='Action', detail='Evidence')
        item = self.store.publish(payload)
        self.store.review(dict(id=item['id'], state='done'))
        self.assertEqual(self.store.publish(payload)['state'], 'done')
        reopened = SpecialAgents(self.path).snapshot()
        self.assertEqual(len(reopened['inbox']), 1)
        self.assertEqual(reopened['roles'][0]['name'], 'Slack triage')

    def test_one_active_run_and_interrupted_recovery(self):
        def start(_):
            try:
                return self.store.start_run(self.role['id'])
            except ValueError:
                return None
        with ThreadPoolExecutor(max_workers=4) as pool:
            runs = [r for r in pool.map(start, range(4)) if r]
        self.assertEqual(len(runs), 1)
        self.store.update_run(runs[0]['id'], 'running', terminal_id='terminal-fixture')
        self.store.reconcile(set())
        self.assertEqual(self.store.snapshot()['runs'][0]['state'], 'interrupted')
        self.assertTrue(self.store.start_run(self.role['id']))

    def test_unsubmitted_draft_is_recovered_only_after_exit_and_never_as_success(self):
        run=self.store.start_run(self.role['id'])
        self.store.update_run(run['id'],'running',terminal_id='terminal-fixture')
        (Path(run['context']['output_dir'])/'result.md').write_text('# Results\nPermission classifier unavailable.')
        self.store.reconcile({'terminal-fixture'})
        self.assertFalse(self.store.recover_report(run['id']))
        self.assertEqual(self.store.snapshot()['inbox'],[])
        self.store.reconcile(set())
        snapshot=self.store.snapshot()
        self.assertEqual(snapshot['runs'][0]['state'],'blocked')
        self.assertIn('Permission classifier unavailable',snapshot['inbox'][0]['detail'])
        self.assertIn('completion has not been verified',snapshot['inbox'][0]['detail'])
        self.store.review(dict(id=snapshot['inbox'][0]['id'],state='done'))
        self.store.reconcile(set())
        self.assertFalse(self.store.recover_report(run['id']))
        self.assertEqual(self.store.snapshot()['inbox'][0]['state'],'done')

    def test_recovery_rejects_symlinks_and_mismatched_run_directory(self):
        import json
        run=self.store.start_run(self.role['id'])
        self.store.update_run(run['id'],'interrupted')
        other=Path(self.temp.name)/'other.md';other.write_text('Other private report')
        result=Path(run['context']['output_dir'])/'result.md';result.symlink_to(other)
        self.assertFalse(self.store.recover_report(run['id']))
        result.unlink();result.write_text('Draft')
        context=dict(run['context'],output_dir=self.temp.name)
        with self.store.db() as db:db.execute('UPDATE run_contexts SET payload=? WHERE run_id=?',(json.dumps(context),run['id']))
        self.assertFalse(self.store.recover_report(run['id']))
        self.assertEqual(self.store.snapshot()['inbox'],[])

    def test_launch_prompt_is_quoted_and_has_explicit_handoff(self):
        run = self.store.start_run(self.role['id'])
        self.role['scope'] = 'Literal $(touch /tmp/not-a-command) and `echo ignored`'
        payload = launch_payload(self.role, run, 'http://127.0.0.1:4310', Path('/tmp/project with spaces'))
        self.assertEqual(payload['argv'][:4], ['/bin/zsh', '-lic', 'claude "$@"', 'agent-desk'])
        self.assertEqual(payload['argv'][4:6], ['--permission-mode', 'auto'])
        self.assertIn('--run ' + run['id'], payload['argv'][-1])
        self.assertIn('not a scheduled background service', payload['argv'][-1])
        self.assertIn('fenced html-diagram block', payload['argv'][-1])
        self.assertNotIn('$(touch', payload['argv'][2])

    def test_the_report_command_runs_on_the_desks_python_not_python3_from_path(self):
        run = self.store.start_run(self.role['id'])
        payload = launch_payload(self.role, run, 'agent-desk://' + 'a' * 32, Path(__file__).resolve().parents[1])
        report = next(line for line in payload['argv'][-1].splitlines() if ' report --run ' in line and '--state review' in line)
        launcher = shlex.split(report)[0]
        self.assertNotIn(' ', launcher)
        self.assertIn(shlex.quote(sys.executable), Path(launcher).read_text())
        self.assertIn('Bash(' + report + ')', payload['argv'][payload['argv'].index('--settings') + 1].replace('\\"', '"'))
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / 'python3').write_text('#!/bin/sh\nexit 7\n');(Path(folder) / 'python3').chmod(0o755)
            done = subprocess.run([launcher, '--help'], env=dict(os.environ, PATH=folder + os.pathsep + os.environ['PATH']), capture_output=True, text=True, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('report', done.stdout)

    def test_a_reply_to_a_report_becomes_the_users_instruction_for_the_next_pass(self):
        first = self.store.start_run(self.role['id'])
        report = self.store.report(dict(run_id=first['id'], state='review', detail='# Triage digest\n\n## Open questions\n- Should #ops count as in scope?'))
        found, follow_up = self.store.follow_up(dict(id=report['id'], reply='  Yes, include #ops from now on.  '))
        self.assertEqual((found['id'], follow_up['reply'], follow_up['title']), (report['id'], 'Yes, include #ops from now on.', 'Slack triage · review'))
        run = self.store.start_run(self.role['id'], None, follow_up)
        prompt = launch_payload(self.role, run, 'http://127.0.0.1:4310', Path('/tmp'))['argv'][-1]
        self.assertIn('follows up on your own earlier report, "Slack triage · review"', prompt)
        self.assertIn("The user's reply:\nYes, include #ops from now on.", prompt)
        self.assertIn('Your earlier report:\n# Triage digest', prompt)
        self.assertIn('shown for context only', prompt)
        # The reply is part of the run's frozen context, so a relaunch of this run says the same thing.
        self.assertEqual(self.store.run_context(run['id'])['follow_up']['reply'], 'Yes, include #ops from now on.')
        for bad in (dict(id=report['id'], reply='   '), dict(id=report['id'], reply='x' * 4001), dict(id='missing', reply='Hi')):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.store.follow_up(bad)

    def test_delete_keeps_reports_and_refuses_while_a_run_is_active(self):
        finding = self.store.publish(dict(role_id=self.role['id'], event_key='thread:1', title='Action', detail='Evidence'))
        run = self.store.start_run(self.role['id'])
        with self.assertRaises(ValueError) as refused:
            self.store.delete_role(self.role['id'])
        self.assertIn('run in progress', str(refused.exception))
        self.store.update_run(run['id'], 'review', 'Done')
        self.assertEqual(self.store.delete_role(self.role['id']), {'deleted': self.role['id']})
        reopened = SpecialAgents(self.path).snapshot()
        self.assertEqual(reopened['roles'], [])
        self.assertEqual([i['id'] for i in reopened['inbox']], [finding['id']])
        self.assertEqual([r['id'] for r in reopened['runs']], [run['id']])
        with self.assertRaises(ValueError):
            self.store.delete_role(self.role['id'])
        with self.assertRaises(ValueError):
            self.store.start_run(self.role['id'])

    def test_invalid_source_and_scope_rejected(self):
        with self.assertRaises(ValueError):
            self.store.publish(dict(role_id=self.role['id'],event_key='a',title='a',detail='a',url='javascript:alert(1)'))
        with self.assertRaises(ValueError):
            self.store.save_role(dict(self.role,scope=''))

    def test_report_is_atomic_idempotent_and_does_not_reopen_reviewed_work(self):
        run = self.store.start_run(self.role['id'])
        payload = dict(run_id=run['id'], state='review', detail='Checked the channels; nothing actionable.')
        first = self.store.report(payload)
        self.store.review(dict(id=first['id'],state='done'))
        self.assertEqual(self.store.report(payload)['state'], 'done')
        self.assertEqual(self.store.snapshot()['runs'][0]['state'], 'review')
        with self.assertRaises(ValueError):
            self.store.report(dict(payload,detail='Conflicting report'))

    def test_run_findings_form_one_report_and_review_together(self):
        run=self.store.start_run(self.role['id'])
        finding=self.store.publish(dict(role_id=self.role['id'],run_id=run['id'],event_key='source:1',title='Detailed finding',detail='Full evidence'))
        self.assertEqual(len(self.store.snapshot()['inbox']),1)
        report=self.store.report(dict(run_id=run['id'],state='review',detail='Summary'))
        items=self.store.snapshot()['inbox'];self.assertEqual(len(items),1)
        self.assertEqual(items[0]['detail'],'Summary');self.assertEqual(items[0]['findings'][0]['detail'],'Full evidence')
        self.store.review(dict(id=report['id'],state='done'))
        with self.store.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM inbox').fetchone()[0],2)
            self.assertEqual(db.execute('SELECT state FROM inbox WHERE id=?',(finding['id'],)).fetchone()[0],'done')
        next_run=self.store.start_run(self.role['id'])
        self.store.report(dict(run_id=next_run['id'],state='review',detail='Next pass'))
        self.assertEqual(len(self.store.snapshot()['inbox']),2)

    def test_finding_cannot_attach_to_another_automation_run(self):
        with self.assertRaises(ValueError):
            self.store.publish(dict(role_id=self.role['id'],run_id='unrelated',event_key='source:bad',title='Wrong',detail='Wrong run'))
        self.assertEqual(self.store.snapshot()['inbox'],[])

    def completed_terminal(self, outcome='review'):
        from types import SimpleNamespace
        from unittest.mock import Mock
        run=self.store.start_run(self.role['id'])
        self.store.update_run(run['id'],'running',terminal_id='terminal-fixture')
        self.store.report(dict(run_id=run['id'],state=outcome,detail='Final report'))
        terminal=SimpleNamespace(id='terminal-fixture',name='Test',cwd=self.temp.name,argv=['claude'],launch_profile='claude',start=0)
        terminal.output=Mock(side_effect=lambda cursor:dict(data='eA==' if cursor==0 else '',cursor=1,exit_code=None))
        terminal.stop=Mock()
        manager=SimpleNamespace(get=Mock(return_value=terminal))
        return run,terminal,manager

    def test_completion_archives_before_stop_and_allows_next_run(self):
        from unittest.mock import patch
        import json
        run,terminal,manager=self.completed_terminal()
        def stop():
            with self.store.db() as db:
                saved=db.execute('SELECT * FROM run_terminals').fetchone()
                self.assertEqual(saved['state'],'closing')
                self.assertEqual(json.loads(saved['metadata'])['session_id'],'native-123')
        terminal.stop.side_effect=stop
        with patch('agent_desk.native_session_lookup.find_conversation',return_value='native-123') as lookup:
            self.store.close_completed(manager,grace=0)
            lookup.assert_called_once_with('claude',run['id'],handoff='report --run '+run['id'])
            self.store.close_completed(manager,grace=0)
        terminal.stop.assert_called_once()
        self.assertEqual(self.store.hidden_terminals(),{'terminal-fixture'})
        self.assertEqual(SpecialAgents(self.path).snapshot()['inbox'][0]['detail'],'Final report')
        self.assertTrue(self.store.start_run(self.role['id']))

    def test_grace_delays_cleanup_but_blocked_reports_do_close(self):
        run,terminal,manager=self.completed_terminal('blocked')
        self.store.close_completed(manager,grace=60)
        terminal.stop.assert_not_called()
        from unittest.mock import patch
        with patch('agent_desk.native_session_lookup.find_conversation',return_value=None):
            self.store.close_completed(manager,grace=0)
        terminal.stop.assert_called_once()
        self.assertEqual(self.store.hidden_terminals(),{'terminal-fixture'})
        self.assertTrue(self.store.start_run(self.role['id']))

    def test_failed_cleanup_retries_saved_history(self):
        from unittest.mock import patch
        run,terminal,manager=self.completed_terminal()
        terminal.stop.side_effect=OSError('temporary stop failure')
        with patch('agent_desk.native_session_lookup.find_conversation',return_value=None) as lookup:
            with self.assertRaises(OSError):self.store.close_completed(manager,grace=0)
            self.assertEqual(self.store.hidden_terminals(),set())
            terminal.stop.side_effect=None
            self.store.close_completed(manager,grace=0)
            self.assertEqual(lookup.call_count,1)
        self.assertEqual(self.store.hidden_terminals(),{'terminal-fixture'})

    def test_launch_registration_cannot_overwrite_fast_final_report(self):
        run=self.store.start_run(self.role['id'])
        self.store.report(dict(run_id=run['id'],state='review',detail='Fast final report'))
        self.store.update_run(run['id'],'running',terminal_id='terminal-fast')
        saved=self.store.snapshot()['runs'][0]
        self.assertEqual(saved['state'],'review')
        self.assertEqual(saved['detail'],'Fast final report')
        self.assertEqual(saved['terminal_id'],'terminal-fast')


    def test_every_harness_may_write_its_run_folder_and_report_but_nothing_broader(self):
        cursor_home = Path(self.temp.name) / 'cursor-home'
        cursor_home.mkdir()
        run = self.store.start_run(self.role['id'])
        output = Path(run['context']['output_dir'])
        broad = {'--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox', '--always-approve', '--yolo', '--force',
                 '--dangerously-allow-all-tool-calls', '--bypass', 'bypassPermissions', 'danger-full-access'}
        (Path(self.temp.name) / 'snowflake' / 'cortex').mkdir(parents=True)
        (Path(self.temp.name) / 'snowflake' / 'cortex' / 'settings.json').write_text('{"theme": "dark"}')
        with patch.dict(os.environ, CURSOR_CONFIG_DIR=str(cursor_home), SNOWFLAKE_HOME=str(Path(self.temp.name) / 'snowflake')), patch('agent_desk.automation_grants.DATA_DIR', Path(self.temp.name)):
            for choice, mode in (('claude', '/bin/zsh'), ('codex', '/bin/zsh'), ('grok', 'direct'), ('opencode', 'direct'), ('pi', 'direct'),
                                 ('cortex', 'direct'), ('cursor-agent', 'direct')):
                with self.subTest(choice):
                    role = self.store.save_role(dict(self.role, id='', choice=choice, command=choice, mode=mode))
                    payload = launch_payload(role, dict(run, context=dict(run['context'], role=role)), 'http://127.0.0.1:4310', Path('/tmp'))
                    argv, env = payload['argv'], payload.get('env', {})
                    self.assertFalse(broad & set(argv), argv)
                    self.assertIn('report --run ' + run['id'], argv[-1])
                    self.assertEqual(payload['launch_profile'], choice if choice in ('claude', 'codex') else None)
                    granted = ' '.join(argv[:-1]) + json.dumps(env)
                    if choice == 'cortex':
                        granted += Path(argv[argv.index('--config') + 1]).read_text()
                    if choice != 'pi':
                        self.assertIn(str(output), granted)
                    if choice == 'grok':
                        self.assertNotIn('--add-dir', argv)
                    self.assertNotIn(str(Path(self.temp.name)) + '/**', granted.replace(str(output), ''))
        self.assertEqual(set(env), {'CURSOR_CONFIG_DIR'})
        settings = json.loads((Path(env['CURSOR_CONFIG_DIR']) / 'cli-config.json').read_text())
        self.assertIn('Write(' + str(output) + '/**)', settings['permissions']['allow'])
        self.assertEqual(sum(rule.startswith('Shell(') for rule in settings['permissions']['allow']), 3)

    def test_cursor_runs_on_the_users_own_folder_with_only_this_runs_rules_added(self):
        from agent_desk.automation_grants import cursor_config
        home = Path(self.temp.name) / 'cursor-home'
        (home / 'chats').mkdir(parents=True)
        (home / 'mcp.json').write_text('{}')
        original = {'version': 1, 'editor': {'vimMode': True}, 'permissions': {'allow': ['Shell(ls)'], 'deny': ['Shell(rm)']}}
        (home / 'cli-config.json').write_text(json.dumps(original))
        folder = cursor_config('run-1', ['Write(/runs/run-1/**)'], home=home, root=Path(self.temp.name))
        self.assertEqual({p.name for p in folder.iterdir()}, {'chats', 'mcp.json', 'cli-config.json'})
        self.assertEqual((folder / 'chats').resolve(), (home / 'chats').resolve())
        self.assertFalse((folder / 'cli-config.json').is_symlink())
        layered = json.loads((folder / 'cli-config.json').read_text())
        self.assertEqual(layered['editor'], {'vimMode': True})
        self.assertEqual(layered['permissions'], {'allow': ['Shell(ls)', 'Write(/runs/run-1/**)'], 'deny': ['Shell(rm)']})
        self.assertEqual(json.loads((home / 'cli-config.json').read_text()), original)
        self.assertNotIn(Path(self.temp.name) / 'automation-runs', folder.parents)

    def test_cortex_keeps_its_own_settings_when_the_user_has_none(self):
        from agent_desk.automation_grants import cortex_settings
        missing = Path(self.temp.name) / 'no-cortex'
        self.assertIsNone(cortex_settings('run-1', ['Write(/runs/run-1/**)'], home=missing, root=Path(self.temp.name)))
        missing.mkdir()
        (missing / 'settings.json').write_text(json.dumps({'theme': 'dark', 'permissions': {'allow': ['Read'], 'deny': ['Bash(rm:*)']}}))
        path = cortex_settings('run-1', ['Write(/runs/run-1/**)'], home=missing, root=Path(self.temp.name))
        self.assertEqual(json.loads(path.read_text()), {'theme': 'dark', 'permissions': {'allow': ['Read', 'Write(/runs/run-1/**)'], 'deny': ['Bash(rm:*)']}})

    def test_a_report_saved_in_the_run_folder_is_submitted_and_others_are_refused(self):
        run = self.store.start_run(self.role['id'])
        folder = Path(run['context']['output_dir']) / 'handoff'
        folder.mkdir()
        (folder / 'report-other.json').write_text(json.dumps(dict(operation='report', run_id='another-run', state='review', detail='Not mine')))
        (folder / 'finding-foreign.json').write_text(json.dumps(dict(operation='finding', run_id=run['id'], role_id='another-role',
                                                                       event_key='x', title='Foreign', detail='Nope', url='')))
        (folder / 'finding-1.json').write_text(json.dumps(dict(operation='finding', run_id=run['id'], role_id=self.role['id'],
                                                                event_key='thread:1', title='Lead', detail='Evidence', url='')))
        (folder / 'report-1.json').write_text(json.dumps(dict(operation='report', run_id=run['id'], state='review', detail='# Done')))
        self.assertEqual(self.store.collect_handoffs(), 2)
        self.assertEqual(sorted(p.name for p in folder.iterdir()),
                         ['finding-1.submitted', 'finding-foreign.rejected', 'report-1.submitted', 'report-other.rejected'])
        snapshot = self.store.snapshot()
        self.assertEqual(next(r for r in snapshot['runs'] if r['id'] == run['id'])['state'], 'review')
        (folder / 'report-2.json').write_text(json.dumps(dict(operation='report', run_id=run['id'], state='failed', detail='Late')))
        self.assertEqual(self.store.collect_handoffs(), 0)
        self.assertTrue((folder / 'report-2.json').exists())

    def test_a_symlinked_handoff_folder_is_ignored(self):
        run = self.store.start_run(self.role['id'])
        elsewhere = Path(self.temp.name) / 'elsewhere'
        elsewhere.mkdir()
        (elsewhere / 'report-1.json').write_text(json.dumps(dict(operation='report', run_id=run['id'], state='review', detail='# Done')))
        (Path(run['context']['output_dir']) / 'handoff').symlink_to(elsewhere)
        self.assertEqual(self.store.collect_handoffs(), 0)
        self.assertEqual(self.store.snapshot()['runs'][0]['state'], 'launching')

    def test_the_report_helper_saves_a_report_it_cannot_deliver(self):
        root = Path(__file__).resolve().parents[1]
        result = Path(self.temp.name) / 'result.md'
        result.write_text('# Report\n')
        env = dict(os.environ, AGENT_DESK_DATA_DIR=self.temp.name)
        done = subprocess.run([sys.executable, str(root / 'scripts' / 'special_agent.py'), '--desk', 'agent-desk://' + 'f' * 32,
                               'report', '--run', 'run-1', '--state', 'blocked', '--file', str(result)], env=env, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        [saved] = (Path(self.temp.name) / 'handoff').iterdir()
        self.assertEqual(json.loads(saved.read_text()), dict(operation='report', run_id='run-1', state='blocked', detail='# Report\n'))
        self.assertIn('submits it within a few seconds', done.stdout)

    def test_auto_mode_is_scoped_to_claude_automations(self):
        run=self.store.start_run(self.role['id'])
        for choice in ('claude','claude-personal','codex','codex-personal','custom'):
            for mode in ('direct','/bin/zsh','/bin/bash'):
                with self.subTest(choice=choice,mode=mode):
                    role=dict(self.role,choice=choice,command=choice if choice!='custom' else '/tmp/my-harness',mode=mode)
                    argv=launch_payload(role,{k:v for k,v in run.items() if k!='context'},'http://127.0.0.1:4310',Path('/tmp'))['argv']
                    self.assertEqual('--permission-mode' in argv,choice.startswith('claude'))
                    self.assertNotIn('--dangerously-skip-permissions',argv)
                    self.assertIn('report --run '+run['id'],argv[-1])

    def test_run_freezes_exact_role_event_and_uses_private_artifacts(self):
        event={'source':'fixture-A'}
        run=self.store.start_run(self.role['id'],event)
        changed=dict(self.role,instructions='Unrelated later edit')
        self.store.save_role(changed)
        saved=self.store.run_context(run['id'])
        self.assertEqual(saved['role']['instructions'],'Find actionable requests')
        self.assertEqual(saved['event_context'],event)
        argv=launch_payload(changed,run,'http://127.0.0.1:4310',Path('/tmp'),{'source':'wrong'})['argv']
        self.assertIn('Find actionable requests',argv[-1])
        self.assertNotIn('Unrelated later edit',argv[-1])
        self.assertNotIn('"source": "wrong"',argv[-1])
        self.assertIn(str(Path(saved['output_dir'])/'result.md'),argv[-1])
        self.assertEqual(Path(saved['output_dir']).stat().st_mode&0o777,0o700)
        settings=__import__('json').loads(argv[argv.index('--settings')+1])
        self.assertFalse(settings['autoMemoryEnabled'])
        allowed=settings['permissions']['allow']
        self.assertEqual(allowed[:2],['WebSearch','WebFetch'])
        self.assertEqual(len(allowed),5)
        for rule in allowed[2:]:
            self.assertIn('report --run '+run['id'],rule)
            self.assertIn(str(Path(saved['output_dir'])/'result.md'),rule)
            self.assertNotIn('*',rule)
        self.store.report(dict(run_id=run['id'],state='review',detail='Fixture done'))
        next_run=self.store.start_run(self.role['id'])
        next_argv=launch_payload(changed,next_run,'http://127.0.0.1:4310',Path('/tmp'))['argv']
        self.assertNotEqual(argv[argv.index('--session-id')+1],next_argv[next_argv.index('--session-id')+1])
        self.assertNotEqual(saved['output_dir'],next_run['context']['output_dir'])


class FollowUpRouteTests(unittest.TestCase):
    """A reply to a report is the user's instruction for the next pass, so only the page may send one."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = SpecialAgents(Path(self.temp.name) / 'roles.sqlite3')
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.patch = patch.object(server, 'SPECIAL_AGENTS', self.store)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.http.shutdown()
        self.http.server_close()
        self.temp.cleanup()

    def post(self, token, payload):
        request = Request(f'http://127.0.0.1:{self.http.server_port}/api/special-agents/follow-up', data=json.dumps(payload).encode(),
                          headers={'Content-Type': 'application/json', 'X-Agent-Desk-Terminal': token})
        try:
            with urlopen(request, timeout=5) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def test_an_agent_cannot_reply_for_the_user(self):
        self.assertEqual(self.post(server.HELPER_TOKEN, dict(id='report', reply='Ship it')), (403, {'error': 'Only the page can reply to a report'}))
        code, body = self.post(server.TERMINAL_TOKEN, dict(id='missing', reply='Ship it'))
        self.assertEqual((code, body['error']), (400, 'This report is no longer in the Inbox'))

