import concurrent.futures
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from types import SimpleNamespace

from agent_desk.event_bus import EventError, MAX_AGE, matches, predicate, validate_event
from agent_desk.workflow_runtime import WorkflowRuntime


class EventFixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.runtime = WorkflowRuntime(self.root / 'workflows.sqlite3')
        self.bus = self.runtime.events
        self.source = self.bus.save_source(dict(name='Local adapter', kind='webhook'))
        self.bus.toggle_source(self.source['id'], True)
        self.config = self.runtime.save_config(dict(name='Echo event', kind='command', cwd=self.temp.name,
                                                   argv=[sys.executable, '-c', 'print("complete")'], timeout=10))
        self.rule = self.runtime.save_workflow(dict(name='Messages', trigger='event', enabled=True,
            nodes=[dict(id='task', config_id=self.config['id'], depends_on=[])],
            event=dict(source_id=self.source['id'], predicate=dict(field='type', op='equals', value='message'))))

    def tearDown(self):
        for row in self.runtime.snapshot()['executions']:
            if row['state'] in ('queued', 'starting', 'running', 'ready'):
                self.runtime.stop(row['id'])
        for child in self.runtime.children.values():
            try: child.wait(timeout=6)
            except Exception: child.kill();child.wait()
        self.temp.cleanup()

    def enable(self):
        self.runtime.toggle(self.rule['id'], True, human=True)

    def post(self, identity='one', **extra):
        return self.bus.ingest(self.source['id'], dict(id=identity, payload={'type': 'message'}, **extra))

    def dispatch(self, runtime=None, now=None):
        runtime = runtime or self.runtime
        with runtime.lock, runtime.db() as db:
            db.execute('BEGIN IMMEDIATE')
            runtime.events.dispatch(db, now or time.time())

class EventBusTests(EventFixture, unittest.TestCase):
    def test_save_cannot_enable_and_ignored_events_do_not_replay(self):
        self.assertFalse(self.rule['enabled'])
        with self.assertRaisesRegex(ValueError, 'UI'):
            self.runtime.toggle(self.rule['id'], True)
        with self.assertRaisesRegex(ValueError, 'matching source'):
            self.runtime.start_flow(self.rule['id'])
        self.assertEqual(self.post()['state'], 'ignored')
        self.enable()
        self.assertTrue(self.post()['duplicate'])
        self.dispatch()
        self.assertEqual(self.runtime.snapshot()['flows'], [])

    def test_concurrent_duplicate_and_restart_create_exactly_one_flow(self):
        self.enable()
        def post(_):
            return WorkflowRuntime(self.runtime.path).events.ingest(self.source['id'], {'id': 'same', 'payload': {'type': 'message'}})
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(post, range(16)))
        self.assertEqual(sum(not result['duplicate'] for result in results), 1)
        reopened = WorkflowRuntime(self.runtime.path)
        self.dispatch(reopened)
        self.assertEqual(len(reopened.snapshot()['flows']), 1)
        self.assertTrue(post(0)['duplicate'])
        self.dispatch(reopened)
        self.assertEqual(len(reopened.snapshot()['flows']), 1)
        with reopened.db() as db:
            config = json.loads(db.execute('SELECT payload FROM executions').fetchone()[0])
            self.assertEqual(config['event_context']['payload']['type'], 'message')

    def test_crash_rolls_back_flow_and_event_receipt_together(self):
        self.enable();self.post()
        original = self.runtime.enqueue_flow
        def fail(*args, **kwargs):
            original(*args, **kwargs)
            raise RuntimeError('Simulated crash before commit')
        with patch.object(self.runtime, 'enqueue_flow', side_effect=fail):
            with self.assertRaises(RuntimeError):self.dispatch()
        self.assertEqual(self.runtime.snapshot()['flows'], [])
        self.assertEqual(self.bus.snapshot()['queued'], 1)
        self.dispatch()
        self.assertEqual(len(self.runtime.snapshot()['flows']), 1)

    def test_overlap_waits_even_across_rules_sharing_a_configuration(self):
        self.enable();self.post('first');self.dispatch()
        other = self.runtime.save_workflow(dict(self.rule, id='other-rule', name='Other rule'))
        self.runtime.toggle(self.rule['id'], False)
        self.runtime.toggle(other['id'], True, human=True)
        self.post('second');self.dispatch()
        self.assertEqual(self.bus.snapshot()['queued'], 1)
        self.assertIn('active configuration', self.bus.snapshot()['events'][0]['detail'])
        self.assertEqual(len(self.runtime.snapshot()['flows']), 1)
        with self.runtime.db() as db:
            db.execute("UPDATE executions SET state='succeeded',finished=?", (time.time(),))
            db.execute("UPDATE flows SET state='succeeded',finished=?", (time.time(),))
        self.dispatch()
        self.assertEqual(len(self.runtime.snapshot()['flows']), 2)

    def test_first_matching_rule_only_and_config_edit_revokes_approval(self):
        self.enable()
        second = self.runtime.save_workflow(dict(self.rule, id='second', name='Second'))
        self.runtime.toggle(second['id'], True, human=True)
        self.post();self.dispatch()
        self.assertEqual([f['workflow_id'] for f in self.runtime.snapshot()['flows']], [self.rule['id']])
        self.post('waiting')
        self.runtime.save_config(dict(self.config, argv=[sys.executable, '-c', 'print("changed")']))
        self.assertTrue(all(not r['enabled'] for r in self.runtime.snapshot()['workflows']))
        self.assertEqual(self.bus.snapshot()['events'][0]['state'], 'discarded')

    def test_bounded_queue_retry_and_expiry_survive_reopen(self):
        self.enable();self.bus.queue_limit = 1;self.post()
        with self.assertRaises(EventError) as cm:self.post('two')
        self.assertEqual(cm.exception.status, 429)
        self.assertIn('full', self.bus.snapshot()['sources'][0]['last_error'])
        self.dispatch(now=time.time() + MAX_AGE + 1)
        self.assertEqual(self.bus.snapshot()['events'][0]['state'], 'expired')
        self.assertFalse(self.post('two')['duplicate'])
        self.dispatch(WorkflowRuntime(self.runtime.path))
        self.assertTrue(self.post()['duplicate'])
        self.assertEqual(len(self.runtime.snapshot()['flows']), 1)

    def test_pause_and_edit_discard_pending_without_replay(self):
        self.enable();self.post()
        self.bus.toggle_source(self.source['id'], False)
        self.dispatch();self.assertEqual(self.runtime.snapshot()['flows'], [])
        self.assertEqual(self.bus.snapshot()['events'][0]['state'], 'discarded')
        with self.assertRaises(EventError) as cm:self.post('paused')
        self.assertEqual(cm.exception.status, 409)
        self.bus.toggle_source(self.source['id'], True)
        self.post('edit');self.runtime.save_workflow(self.rule)
        self.enable();self.dispatch()
        self.assertEqual(self.runtime.snapshot()['flows'], [])
        self.assertTrue(self.post('edit')['duplicate'])

    def test_payload_predicates_validation_and_tokens(self):
        for body in [[], {}, {'id': 'x', 'payload': []}, {'id': 'x', 'payload': {}, 'unknown': 1},
                     {'id': 'x', 'payload': {'number': float('nan')}}, {'id': '\n', 'payload': {}}]:
            with self.assertRaises(EventError):self.bus.ingest(self.source['id'], body)
        with self.assertRaises(EventError) as cm:self.post(occurred_at=time.time() - MAX_AGE - 1)
        self.assertEqual(cm.exception.status, 410)
        with self.assertRaises(EventError):validate_event({'id': 'x', 'payload': {'text': 'x' * 40000}})
        self.assertFalse(matches({'n': True}, predicate(dict(field='n', op='equals', value=1))))
        self.assertTrue(matches({'nested': {'n': None}}, predicate(dict(field='nested.n', op='exists'))))
        self.assertFalse(matches({'text': 4}, predicate(dict(field='text', op='contains', value='4'))))
        self.assertTrue(matches({'text': 'hello world'}, predicate(dict(field='text', op='contains', value='world'))))
        self.bus.authenticate(self.source['id'], self.source['token'])
        replacement = self.bus.rotate_token(self.source['id'])
        with self.assertRaises(EventError):self.bus.authenticate(self.source['id'], self.source['token'])
        self.bus.authenticate(self.source['id'], replacement['token'])
        self.assertNotIn(replacement['token'], json.dumps(self.bus.snapshot()))
        self.assertEqual(self.runtime.snapshot()['flows'], [])

    def test_files_and_directories_persist_baseline_and_ignore_symlink_children(self):
        watched = self.root / 'watched';watched.mkdir()
        file = watched / 'note';file.write_text('first')
        source = self.bus.save_source(dict(name='Files', kind='directory', settings={'path': str(watched)}))
        self.bus.toggle_source(source['id'], True)
        self.runtime.save_workflow(dict(self.rule, event=dict(source_id=source['id'], predicate=dict(field='path', op='exists'))))
        self.enable();self.bus.poll_files()
        self.assertEqual(self.bus.snapshot()['events'], [])
        file.write_text('second')
        with self.runtime.db() as db:db.execute('UPDATE event_sources SET next_check=0')
        reopened = WorkflowRuntime(self.runtime.path)
        reopened.events.poll_files()
        self.assertEqual(reopened.events.snapshot()['queued'], 1)
        file.unlink()
        with self.runtime.db() as db:db.execute('UPDATE event_sources SET next_check=0')
        reopened.events.poll_files()
        self.assertEqual(reopened.events.snapshot()['queued'], 2)
        outside = self.root / 'outside';outside.mkdir();(watched/'link').symlink_to(outside, target_is_directory=True)
        row = reopened.events.jobs(('directory',), time.time()+10)[0]
        _, before = reopened.events.file_snapshot(row)
        (outside/'invisible').write_text('ignored')
        _, after = reopened.events.file_snapshot(row)
        self.assertEqual(before, after)

    def test_file_queue_pressure_does_not_advance_baseline(self):
        file = self.root/'file';file.write_text('a')
        source = self.bus.save_source(dict(name='File', kind='file', settings={'path': str(file)}))
        self.bus.toggle_source(source['id'], True)
        self.runtime.save_workflow(dict(self.rule, event=dict(source_id=source['id'], predicate=dict(field='path', op='exists'))))
        self.enable();self.bus.poll_files();self.bus.queue_limit = 0
        file.write_text('changed')
        with self.runtime.db() as db:db.execute('UPDATE event_sources SET next_check=0')
        self.bus.poll_files()
        self.assertEqual(self.bus.snapshot()['queued'], 0)
        self.bus.queue_limit = 256
        with self.runtime.db() as db:db.execute('UPDATE event_sources SET next_check=0')
        self.bus.poll_files()
        self.assertEqual(self.bus.snapshot()['queued'], 1)

    def test_shared_coordinator_watch_runner_emits_pr_changes(self):
        from agent_desk.coordinator_runtime import CoordinatorRuntime
        from scripts.control_mailbox import Mailbox
        coordinator = CoordinatorRuntime(self.root/'coordinators.sqlite3', SimpleNamespace(external_parents=set(), list=lambda: []), Mailbox(self.root/'mail.sqlite3'))
        coordinator.event_bus = self.bus
        source = self.bus.save_source(dict(name='PR', kind='pr', settings={'url': 'https://github.com/example/project/pull/1'}))
        self.bus.toggle_source(source['id'], True)
        self.runtime.save_workflow(dict(self.rule, event=dict(source_id=source['id'], predicate=dict(field='state', op='equals', value='MERGED'))))
        self.enable()
        try:
            with patch.object(coordinator, 'fetch_pr', return_value={'state': 'OPEN', 'headRefOid': 'a'}) as fetch:
                coordinator.poll_watches();self.assertEqual(fetch.call_count, 1)
                self.assertEqual(self.bus.snapshot()['queued'], 0)
            with self.runtime.db() as db:db.execute('UPDATE event_sources SET next_check=0')
            with patch.object(coordinator, 'fetch_pr', return_value={'state': 'MERGED', 'headRefOid': 'a'}):coordinator.poll_watches()
            self.assertEqual(self.bus.snapshot()['queued'], 1)
            self.dispatch();self.assertEqual(len(self.runtime.snapshot()['flows']), 1)
        finally:coordinator.close()

    def test_automation_prompt_includes_event_as_data(self):
        from agent_desk.special_agents import launch_payload
        role = dict(id='role', name='Fixture', kind='watcher', scope='Local fixture only', instructions='Read event text',
                    command='/usr/bin/true', mode='direct', choice='custom', cwd=self.temp.name)
        context = dict(id='message-1', source_id=self.source['id'], payload={'text': 'A message to inspect'})
        launch = launch_payload(role, {'id': 'run'}, 'http://127.0.0.1:4322', self.root, context)
        prompt = launch['argv'][-1]
        self.assertIn('Scope: Local fixture only', prompt)
        self.assertIn('untrusted data', prompt)
        self.assertIn(json.dumps(context), prompt)
        self.assertEqual(launch['argv'][:-1], ['/usr/bin/true'])

    def test_url_changes_and_watch_errors_use_shared_runner(self):
        from agent_desk.coordinator_runtime import CoordinatorRuntime
        from scripts.control_mailbox import Mailbox
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        class Resource(BaseHTTPRequestHandler):
            content = b'first'
            def do_GET(self):
                self.send_response(200);self.end_headers();self.wfile.write(self.content)
            def log_message(self, *args):pass
        http = ThreadingHTTPServer(('127.0.0.1', 0), Resource)
        thread = threading.Thread(target=http.serve_forever, daemon=True);thread.start()
        coordinator = CoordinatorRuntime(self.root/'url-coordinator.sqlite3', SimpleNamespace(external_parents=set(), list=lambda: []), Mailbox(self.root/'mail.sqlite3'))
        coordinator.event_bus = self.bus
        source = self.bus.save_source(dict(name='URL', kind='url', settings={'url': f'http://127.0.0.1:{http.server_port}/'}))
        self.bus.toggle_source(source['id'], True)
        self.runtime.save_workflow(dict(self.rule, event=dict(source_id=source['id'], predicate=dict(field='status', op='equals', value=200))))
        self.enable()
        try:
            coordinator.poll_watches();self.assertEqual(self.bus.snapshot()['queued'], 0)
            Resource.content = b'changed'
            with self.runtime.db() as db:db.execute('UPDATE event_sources SET next_check=0')
            coordinator.poll_watches();self.assertEqual(self.bus.snapshot()['queued'], 1)
            with self.runtime.db() as db:db.execute('UPDATE event_sources SET next_check=0')
            with patch.object(coordinator, 'fetch_watch', side_effect=ValueError('URL offline')):coordinator.poll_watches()
            health = next(s for s in self.bus.snapshot()['sources'] if s['id'] == source['id'])
            self.assertEqual(health['last_error'], 'URL offline')
            self.assertGreater(health['next_check'], time.time())
        finally:
            coordinator.close();http.shutdown();http.server_close();thread.join()


class EventWebhookTests(EventFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        from agent_desk import server
        self.server = server
        self.patcher = patch.object(server, 'WORKFLOWS', self.runtime);self.patcher.start()
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True);self.thread.start()
        self.base = 'http://127.0.0.1:' + str(self.http.server_port)

    def tearDown(self):
        self.http.shutdown();self.http.server_close();self.thread.join();self.patcher.stop()
        super().tearDown()

    def request(self, path, value, headers=None, raw=None):
        request = Request(self.base + path, data=raw if raw is not None else json.dumps(value).encode(),
                          headers={'Content-Type': 'application/json', **(headers or {})})
        try:
            with urlopen(request) as response:return response.status, json.load(response)
        except HTTPError as exc:return exc.code, json.load(exc)

    def test_webhook_boundary_and_browser_only_rule_enable(self):
        path = '/api/event-bus/webhook/' + self.source['id']
        headers = {'Authorization': 'Bearer ' + self.source['token']}
        body = dict(id='real', payload={'type': 'message'})
        self.assertEqual(self.request(path, body)[0], 403)
        self.assertEqual(self.request(path+'unknown', body, headers)[0], 404)
        self.assertEqual(self.request(path, body, dict(headers, Host='foreign.example'))[0], 403)
        self.assertEqual(self.request(path, body, dict(headers, Origin=self.base))[0], 403)
        self.assertEqual(self.request(path, None, headers, raw=b'{')[0], 400)
        self.assertEqual(self.request(path, [], headers)[0], 400)
        self.assertEqual(self.request(path, None, headers, raw=b' ' * 40000)[0], 413)
        auth = {'X-Agent-Desk-Terminal': self.server.TERMINAL_TOKEN}
        self.assertEqual(self.request('/api/workflows/toggle', {'id': self.rule['id'], 'enabled': True}, auth)[0], 400)
        auth.update(Origin=self.base, **{'Sec-Fetch-Site': 'same-origin'})
        self.assertEqual(self.request('/api/workflows/toggle', {'id': self.rule['id'], 'enabled': True}, auth)[0], 200)
        self.assertEqual(self.request(path, body, headers)[0], 202)
        self.dispatch()
        code, result = self.request(path, body, headers)
        self.assertEqual(code, 200);self.assertTrue(result['duplicate'])
        self.assertEqual(len(self.runtime.snapshot()['flows']), 1)

    def test_real_http_to_worker_execution_payload_and_overlap(self):
        code = 'import os,json,time; e=json.loads(os.environ["AGENT_DESK_EVENT"]); print("EVENT="+e["id"],flush=True); time.sleep(1)'
        self.runtime.save_config(dict(self.config, argv=[sys.executable, '-c', code]))
        self.enable()
        path = '/api/event-bus/webhook/' + self.source['id']
        headers = {'Authorization': 'Bearer ' + self.source['token']}
        first = dict(id='real-1', payload={'type': 'message'})
        self.assertEqual(self.request(path, first, headers)[0], 202)
        self.runtime.tick()
        self.assertTrue(self.request(path, first, headers)[1]['duplicate'])
        self.request(path, dict(first, id='real-2'), headers)
        self.runtime.tick()
        self.assertEqual(len(self.runtime.snapshot()['flows']), 1)
        self.assertEqual(self.bus.snapshot()['queued'], 1)
        deadline = time.time() + 15
        while time.time() < deadline:
            self.runtime.tick()
            runs = self.runtime.snapshot()['executions']
            if len(runs) == 2 and all(run['state'] == 'succeeded' for run in runs):break
            time.sleep(.05)
        else:self.fail(str(self.runtime.snapshot()))
        self.assertEqual(len(self.runtime.snapshot()['flows']), 2)
        logs = '\n'.join(self.runtime.logs(run['id'])['text'] for run in runs)
        self.assertEqual(logs.count('EVENT=real-1'), 1)
        self.assertEqual(logs.count('EVENT=real-2'), 1)
        ordered = sorted(runs, key=lambda run: run['created'])
        self.assertLessEqual(ordered[0]['finished'], ordered[1]['created'])
        print('Observed real webhook → workflow worker: real-1 once, duplicate rejected, real-2 waited then succeeded.')
