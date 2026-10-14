import tempfile
import unittest
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
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
