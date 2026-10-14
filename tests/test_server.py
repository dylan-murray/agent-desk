import json
import threading
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from agent_desk import server


def sample_note(note_id='pin-1'):
    return dict(id=note_id, kind='pin', note='Move this', createdAt='2026-09-04',
                url='http://localhost', page='Agents', mode='demo', selector='body', elementText='',
                point=dict(viewportX=40, viewportY=80, documentX=40, documentY=80),
                viewport=dict(width=1000, height=800, devicePixelRatio=2),
                bounds=dict(x=0, y=0, width=1000, height=800), scroll=dict(x=0, y=0))


class FeedbackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.patch = patch.object(server, 'FEEDBACK_FILE', Path(self.temp.name) / 'data' / 'feedback.json')
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_migration_is_idempotent_and_persists_coordinates(self):
        note = sample_note()
        server.save_feedback({'notes': [note]})
        server.save_feedback({'notes': [note]})
        self.assertEqual(server.read_feedback()['notes'], [note])

    def test_box_annotations_save_with_their_area(self):
        box = {**sample_note('box'), 'kind': 'region', 'region': dict(x=.1, y=.2, width=.5, height=.4),
               'regionBox': dict(x=100, y=160, width=500, height=320)}
        self.assertEqual(server.save_feedback({'notes': [box]})['notes'], [box])
        for broken in ({k: v for k, v in box.items() if k != 'regionBox'}, {**box, 'region': dict(x=0, y=0, width=float('nan'), height=1)}):
            with self.assertRaises(ValueError):
                server.save_feedback({'notes': [broken]})
        with self.assertRaises(ValueError):
            server.save_feedback({'notes': [{**sample_note('odd'), 'kind': 'lasso'}]})

    def test_merge_preserves_other_tabs_and_deleted_notes_stay_deleted(self):
        server.save_feedback({'notes': [sample_note('one')]})
        saved = server.save_feedback({'notes': [sample_note('two')]})
        self.assertEqual(len(saved['notes']), 2)
        server.save_feedback({'deleted': ['one']})
        saved = server.save_feedback({'notes': [sample_note('one')]})
        self.assertEqual([n['id'] for n in saved['notes']], ['two'])

    def test_history_preserves_edits_and_clears_without_restoring_pins(self):
        import sqlite3
        old=sample_note('history');new={**old,'note':'New explanation','updatedAt':'2026-09-09T03:00:00Z'}
        server.save_feedback({'notes':[old]})
        server.save_feedback({'notes':[new]})
        server.save_feedback({'notes':[new]})
        server.save_feedback({'deleted':['history']})
        server.save_feedback({'notes':[old]})
        self.assertEqual(server.read_feedback()['notes'],[])
        connection=sqlite3.connect(server.FEEDBACK_FILE.with_name('feedback-history.sqlite3'))
        try:
            rows=connection.execute('SELECT payload FROM revisions WHERE note_id=?',('history',)).fetchall()
            self.assertEqual({json.loads(r[0])['note'] for r in rows},{old['note'],new['note']})
            self.assertEqual(len(rows),2)
            self.assertEqual(connection.execute('SELECT note_id FROM cleared').fetchall(),[('history',)])
            self.assertTrue(all(json.loads(r[0])['point']==old['point'] for r in rows))
        finally:connection.close()

    def test_history_imports_existing_note_before_first_clear(self):
        import sqlite3
        note=sample_note('pre-archive')
        server.FEEDBACK_FILE.parent.mkdir(parents=True)
        server.FEEDBACK_FILE.write_text(json.dumps({'notes':[note],'deleted':[]}))
        server.save_feedback({'deleted':[note['id']]})
        connection=sqlite3.connect(server.FEEDBACK_FILE.with_name('feedback-history.sqlite3'))
        try:self.assertEqual(json.loads(connection.execute('SELECT payload FROM revisions').fetchone()[0]),note)
        finally:connection.close()

    def test_bad_coordinates_do_not_overwrite_saved_feedback(self):
        server.save_feedback({'notes': [sample_note()]})
        bad = sample_note('bad')
        bad['point']['viewportX'] = float('nan')
        with self.assertRaises(ValueError):
            server.save_feedback({'notes': [bad]})
        self.assertEqual(len(server.read_feedback()['notes']), 1)


class AgentTests(unittest.TestCase):
    def setUp(self):
        server.SESSIONS.clear()

    def test_reported_agent_lineage_rejects_cycles(self):
        server.ingest(dict(id='root'))
        child=server.ingest(dict(id='child',parent_id='root'))
        self.assertEqual(child['parent_id'],'root')
        with self.assertRaises(ValueError):server.ingest(dict(id='root',parent_id='child'))
        with self.assertRaises(ValueError):server.ingest(dict(id='self',parent_id='self'))

    def test_lifecycle_preserves_task_clears_question_and_bounds_history(self):
        server.ingest(dict(id='a', task='Build UI', status='needs_input', question='Which color?'))
        for _ in range(105):
            agent = server.ingest(dict(id='a', status='working'))
        self.assertEqual(agent['task'], 'Build UI')
        self.assertIsNone(agent['question'])
        self.assertEqual(len(agent['events']), 100)

    def test_invalid_events_cannot_corrupt_sessions(self):
        for payload in ({'id': []}, {'id': '../x'}, {'id': 'a', 'status': 'busy'},
                        {'id': 'a', 'task': []}, {'id': 'a', 'pid': True}):
            with self.assertRaises(ValueError):
                server.ingest(payload)
        self.assertEqual(server.SESSIONS, {})

    def test_folder_context_finds_parent_repo_and_worktree_marker(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / '.git').write_text('gitdir: elsewhere')
            nested = root / 'src' / 'ui'
            nested.mkdir(parents=True)
            context = server.folder_context(str(nested))
            self.assertEqual(context['repo'], str(root))
            self.assertEqual(context['cwd'], str(nested))
            self.assertEqual(context['project'], root.name)

    @patch('agent_desk.server.os.readlink', side_effect=OSError)
    @patch('agent_desk.server.subprocess.run')
    def test_cwd_lookup_handles_spaces_and_missing_processes(self, run, readlink):
        run.return_value.stdout = 'p123\nfcwd\nn/Users/test/my repo\np124\nfcwd\nn/tmp/another\n'
        self.assertEqual(server.process_directories({123, 124, 125}),
                         {123: '/Users/test/my repo', 124: '/tmp/another'})

    @patch('agent_desk.server.process_directories', return_value={123: '/tmp/example'})
    @patch('agent_desk.server.subprocess.run')
    def test_discovery_attaches_folder_without_guessing_status(self, run, directories):
        run.return_value.stdout = '123 /usr/local/bin/codex\n'
        agent = server.discover()[0]
        self.assertEqual(agent['cwd'], '/tmp/example')
        self.assertEqual(agent['project'], 'example')
        self.assertEqual(agent['status'], 'unknown')

    def test_adapter_cwd_must_be_absolute(self):
        with self.assertRaises(ValueError):
            server.ingest({'id': 'bad', 'cwd': 'relative/path'})
        self.assertNotIn('bad', server.SESSIONS)

    @patch('agent_desk.server.subprocess.run')
    def test_discovery_does_not_infer_activity_or_match_unrelated_names(self, run):
        run.return_value.stdout = '123 /usr/local/bin/codex\n124 /usr/bin/claude\n125 /usr/bin/not-codex\n'
        agents = server.discover()
        self.assertEqual([a['pid'] for a in agents], [123, 124])
        self.assertTrue(all(a['status'] == 'unknown' for a in agents))


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.patch = patch.object(server, 'FEEDBACK_FILE', Path(self.temp.name) / 'feedback.json')
        self.patch.start()
        self.ui_patch = patch.object(server, 'SKILL_UIS_FILE', Path(self.temp.name) / 'uis.json')
        self.ui_patch.start()

    def tearDown(self):
        self.ui_patch.stop()
        self.patch.stop()
        self.temp.cleanup()

    @classmethod
    def setUpClass(cls):
        cls.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.http.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()

    def test_write_requires_token_and_bad_host_is_rejected(self):
        for req in (Request(self.base+'/api/events', data=b'{}'),
                    Request(self.base+'/api/agents', headers={'Host': 'evil.example'})):
            with self.assertRaises(HTTPError) as caught:
                urlopen(req)
            self.assertEqual(caught.exception.code, 403)

    def test_a_rebound_hostname_cannot_post(self):
        rebound = {'Host': 'evil.example', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json'}
        for path in ('/api/readouts', '/api/events', '/api/terminals/input'):
            self.assertEqual(self.fetch(path, rebound, b'{}')[0], 403, path)

    def fetch(self, path, headers=None, data=None):
        try:
            with urlopen(Request(self.base+path, data=data, headers=headers or {})) as response:
                return response.status, response.headers
        except HTTPError as error:
            with error:
                return error.code, error.headers

    def test_every_response_refuses_framing_and_cross_origin_loads(self):
        for path in ('/', '/config.js', '/api/agents', '/api/nope'):
            _, headers = self.fetch(path)
            policy = dict(part.split(' ', 1) for part in headers['Content-Security-Policy'].split('; '))
            self.assertEqual(policy['script-src'], "'self'")
            self.assertEqual(policy['object-src'], "'none'")
            self.assertEqual(policy['base-uri'], "'none'")
            self.assertEqual(policy['frame-ancestors'], "'self'")
            self.assertIn(f'ws://127.0.0.1:{self.http.server_port}', policy['connect-src'])
            self.assertEqual(headers['X-Frame-Options'], 'SAMEORIGIN')
            self.assertEqual(headers['Cross-Origin-Resource-Policy'], 'same-origin')
            self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')

    def test_requests_started_by_another_site_or_port_are_refused(self):
        token = {'X-Agent-Desk-Terminal': server.TERMINAL_TOKEN}
        foreign = (
            # a page on the web reading the terminal token
            ('GET', '/api/terminal-auth', {'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty'}),
            # another localhost app including config.js as a script
            ('GET', '/config.js', {'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script'}),
            # a page framing the desk to trick clicks into its terminals
            ('GET', '/', {'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe'}),
            # a navigation is still never allowed to reach the API
            ('GET', '/api/agents', {'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document'}),
            # a write, even one carrying a valid token
            ('POST', '/api/terminals/input', {**token, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty'}),
            ('POST', '/api/readouts', {'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty'}),
        )
        for method, path, headers in foreign:
            with self.subTest(path=path, headers=headers):
                status, _ = self.fetch(path, headers, b'{"id": "x", "data": ""}' if method == 'POST' else None)
                self.assertEqual(status, 403)

    def test_the_desk_itself_links_and_local_clients_still_work(self):
        allowed = (
            ('/', {'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document'}),
            ('/', {'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document'}),
            ('/api/terminal-auth', {'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty'}),
            ('/api/agents', {}),
        )
        for path, headers in allowed:
            with self.subTest(path=path, headers=headers):
                self.assertEqual(self.fetch(path, headers)[0], 200)

    def test_the_terminal_token_is_only_served_to_the_desk_page(self):
        # curl, scripts and agents send no browser fetch metadata; they read the token file.
        for headers in ({}, {'Sec-Fetch-Site': 'none'}, {'Origin': self.base}):
            with self.subTest(headers=headers):
                with self.assertRaises(HTTPError) as caught:
                    urlopen(Request(self.base+'/api/terminal-auth', headers=headers))
                with caught.exception:
                    self.assertEqual(caught.exception.code, 403)
                    self.assertIn('.terminal-token-', json.load(caught.exception)['error'])
        with urlopen(Request(self.base+'/api/terminal-auth', headers={'Sec-Fetch-Site': 'same-origin'})) as response:
            self.assertEqual(json.load(response)['token'], server.TERMINAL_TOKEN)

    def test_browsers_without_fetch_metadata_are_judged_by_origin_and_referer(self):
        # Safari before 16.4 sends neither Sec-Fetch header; a foreign page still names itself.
        for headers in ({'Origin': 'http://evil.example'}, {'Referer': 'http://evil.example/page'},
                        {'Origin': 'http://127.0.0.1:1'}, {'Referer': self.base + '.evil.example/'}):
            with self.subTest(headers=headers):
                self.assertEqual(self.fetch('/api/agents', headers)[0], 403)
                self.assertEqual(self.fetch('/config.js', headers)[0], 403)
        for headers in ({'Origin': self.base}, {'Referer': self.base + '/'}, {}):
            with self.subTest(headers=headers):
                self.assertEqual(self.fetch('/api/agents', headers)[0], 200)
        # Its own page still gets the terminal token; a page elsewhere, or no page at all, does not.
        self.assertEqual(self.fetch('/api/terminal-auth', {'Referer': self.base + '/'})[0], 200)
        for headers in ({'Referer': 'http://evil.example/'}, {'Referer': self.base + '/', 'Sec-Fetch-Site': 'cross-site'}):
            self.assertEqual(self.fetch('/api/terminal-auth', headers)[0], 403)

    def test_the_token_file_holds_a_helper_token_not_the_pages(self):
        self.assertNotEqual(server.HELPER_TOKEN, server.TERMINAL_TOKEN)
        for token, expected in ((server.HELPER_TOKEN, 200), (server.TERMINAL_TOKEN, 200), ('wrong', 403)):
            self.assertEqual(self.fetch('/api/remote/nodes', {'X-Agent-Desk-Terminal': token}, b'{}')[0], expected)

    def test_remote_routes_require_local_terminal_auth(self):
        for path in ('prerequisites', 'test', 'connect'):
            for headers in ({}, {'X-Agent-Desk-Terminal':server.TERMINAL_TOKEN, 'Origin':'https://foreign.example'}):
                with self.assertRaises(HTTPError) as caught:
                    urlopen(Request(self.base+'/api/remote/'+path, data=b'{}', headers=headers))
                self.assertEqual(caught.exception.code,403)
        with patch.object(server,'remote_prerequisites',return_value={'tools':{}}):
            with urlopen(Request(self.base+'/api/remote/prerequisites',data=b'{}',headers={'X-Agent-Desk-Terminal':server.TERMINAL_TOKEN})) as response:
                self.assertEqual(response.status,200)

    def test_skill_sync_requires_local_terminal_auth(self):
        for headers in ({}, {'X-Agent-Desk-Terminal':server.TERMINAL_TOKEN, 'Origin':'https://foreign.example'}):
            with self.assertRaises(HTTPError) as caught:
                urlopen(Request(self.base+'/api/skills/sync', data=b'{}', headers=headers))
            self.assertEqual(caught.exception.code,403)
        result={'linked':[],'conflicts':[],'harnesses':[],'skills':[]}
        with patch.object(server.skill_harnesses,'make_available_everywhere',return_value=result) as sync:
            with urlopen(Request(self.base+'/api/skills/sync',data=b'{}',headers={'X-Agent-Desk-Terminal':server.TERMINAL_TOKEN})) as response:
                self.assertEqual(json.loads(response.read()),result)
        sync.assert_called_once_with()

    def test_authenticated_event_roundtrip(self):
        req = Request(self.base+'/api/events', data=json.dumps({'id':'roundtrip','status':'needs_input','question':'Ready?'}).encode(), headers={'Authorization':'Bearer '+server.TOKEN})
        with urlopen(req) as response:
            self.assertEqual(json.load(response)['question'], 'Ready?')
        with urlopen(self.base+'/api/agents') as response:
            self.assertIn('roundtrip', [a['id'] for a in json.load(response)['agents']])

    def test_malformed_json(self):
        req = Request(self.base+'/api/events', data=b'{', headers={'Authorization':'Bearer '+server.TOKEN})
        with self.assertRaises(HTTPError) as caught:
            urlopen(req)
        self.assertEqual(caught.exception.code, 400)

    def test_production_disables_feedback_api_and_sets_config(self):
        with patch.object(server, 'DEVELOPMENT', False):
            with urlopen(self.base+'/config.js') as response:
                self.assertIn(b'"development": false', response.read())
            for req in (Request(self.base+'/api/feedback'), Request(self.base+'/api/feedback', data=b'{}')):
                with self.assertRaises(HTTPError) as caught:
                    urlopen(req)
                self.assertEqual(caught.exception.code, 404)
                caught.exception.close()

    def test_feedback_roundtrip_and_cross_origin_rejection(self):
        body = json.dumps({'notes': [sample_note()]}).encode()
        headers = {'X-Agent-Desk': 'feedback', 'Content-Type': 'application/json'}
        with urlopen(Request(self.base+'/api/feedback', data=body, headers=headers)) as response:
            self.assertEqual(len(json.load(response)['notes']), 1)
        with urlopen(self.base+'/api/feedback') as response:
            self.assertEqual(json.load(response)['notes'][0]['kind'], 'pin')
        for rejected in ({}, {**headers, 'Origin': 'https://evil.example'}):
            with self.assertRaises(HTTPError) as caught:
                urlopen(Request(self.base+'/api/feedback', data=body, headers=rejected))
            self.assertEqual(caught.exception.code, 403)
            caught.exception.close()

    def test_skill_ui_registration_and_direct_endpoint(self):
        payload = {'id': 'readme-test', 'title': 'README', 'skill': 'readme-review', 'url': 'http://127.0.0.1:8766'}
        req = Request(self.base+'/api/skill-uis', data=json.dumps(payload).encode(),
                      headers={'Authorization': 'Bearer '+server.TOKEN})
        with urlopen(req) as response:
            self.assertEqual(json.load(response)['endpoint'], '/apps/readme-test')
        with urlopen(self.base+'/api/skill-uis') as response:
            self.assertEqual(len(json.load(response)['uis']), 1)
        with urlopen(self.base+'/apps/readme-test') as response:
            self.assertIn(b'id="agents-page"', response.read())
        with self.assertRaises(HTTPError) as caught:
            urlopen(Request(self.base+'/api/skill-uis', data=json.dumps(payload).encode()))
        self.assertEqual(caught.exception.code, 403)
        caught.exception.close()

    def test_ui_registry_rejects_external_urls_and_path_injection(self):
        for changes in ({'url':'https://example.com'}, {'url':self.base}, {'id':'../bad'},
                        {'url':'http://127.0.0.1:8766@evil.example:80'}, {'url':'javascript:alert(1)'}):
            payload = {'id':'test','title':'test','skill':'test','url':'http://127.0.0.1:8766',**changes}
            with self.assertRaises(ValueError):
                server.register_skill_ui(payload, self.http.server_port)
        self.assertEqual(server.read_skill_uis(), [])

    def test_ui_registry_is_checked_again_when_it_is_read(self):
        rows = [{'id':'kept', 'title':'Kept', 'skill':'test', 'url':'http://127.0.0.1:8766', 'endpoint':'/apps/kept'},
                {'id':'desk', 'title':'Desk', 'skill':'test', 'url':self.base + '/apps/kept', 'endpoint':'/apps/desk'},
                {'id':'script', 'title':'Script', 'skill':'test', 'url':'javascript:alert(1)', 'endpoint':'/apps/script'},
                {'id':'remote', 'title':'Remote', 'skill':'test', 'url':'https://example.com', 'endpoint':'/apps/remote'},
                {'id':'missing', 'title':'Missing', 'skill':'test'}, 'text']
        server.SKILL_UIS_FILE.parent.mkdir(parents=True, exist_ok=True)
        server.SKILL_UIS_FILE.write_text(json.dumps(rows))
        with urlopen(self.base+'/api/skill-uis') as response:
            self.assertEqual([ui['id'] for ui in json.load(response)['uis']], ['kept'])

    def test_ui_registry_keeps_the_owner_when_a_tool_is_relaunched(self):
        payload = {'id':'owned','title':'Owned','skill':'diagram-doc-creator','url':'http://127.0.0.1:8766'}
        server.register_skill_ui({**payload, 'agent_id':'terminal-a'}, self.http.server_port)
        server.register_skill_ui(payload, self.http.server_port)
        self.assertEqual(server.read_skill_uis()[0]['agent_id'], 'terminal-a')
        server.register_skill_ui({**payload, 'agent_id':'terminal-b'}, self.http.server_port)
        self.assertEqual(server.read_skill_uis()[0]['agent_id'], 'terminal-b')


if __name__ == '__main__':
    unittest.main()
