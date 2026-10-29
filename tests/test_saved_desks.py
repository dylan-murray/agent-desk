"""Saving a desk and reopening it: the stored record, the page's layout, and the server routes."""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from agent_desk import saved_desks, server
from agent_desk.desks import Desks

CODEX_ID = '22222222-2222-7222-8222-222222222222'
LAYOUT = dict(layout='columns', panes=[dict(id='terminal-a', rect=dict(x=0, y=0, w=6, h=12)), dict(id='web-1', rect=dict(x=6, y=0, w=6, h=12))],
              pages=[dict(id='web-1', url='http://localhost:3000/', name='App')])


def record(identity, argv, **fields):
    """A terminal as the supervisor records it for a restart."""
    return dict(id=identity, name='Codex', display_name=None, cwd='/srv', argv=argv, launch_profile='codex', parent_id=None,
                created=1, origin=0, native_session=None, agent_exited=False) | fields


class SavedDeskStoreTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / 'desks.json'
        self.desks = Desks(self.path)

    def test_a_saved_desk_keeps_its_record_until_it_reopens(self):
        work = self.desks.create('Work')['id']
        self.desks.keep(work, dict(terminals=[], coordinators=['coordinator-1'], layout=LAYOUT))
        again = Desks(self.path)
        self.assertIsInstance(next(d for d in again.snapshot() if d['id'] == work)['saved_at'], float)
        self.assertEqual(again.saved_record(work)['coordinators'], ['coordinator-1'])
        with self.assertRaises(ValueError):
            again.keep(work, {})
        again.unsave(work)
        self.assertNotIn('saved_at', next(d for d in again.snapshot() if d['id'] == work))
        with self.assertRaises(ValueError):
            again.saved_record(work)

    def test_the_last_open_desk_cannot_be_saved_and_new_agents_go_to_an_open_one(self):
        work = self.desks.create('Work')['id']
        self.desks.keep('main', {})
        with self.assertRaises(ValueError) as caught:
            self.desks.keep(work, {})
        self.assertIn('last open desk', str(caught.exception))
        self.assertEqual(self.desks.desk_for(None), work)

    def test_deleting_a_saved_desk_forgets_its_record(self):
        work = self.desks.create('Work')['id']
        self.desks.keep(work, {})
        self.desks.delete(work, 'main', [])
        self.assertEqual(json.loads(self.path.read_text())['saved'], {})


class SavedDeskRecordTests(unittest.TestCase):
    def test_layout_keeps_panes_sizes_and_pages_and_refuses_anything_else(self):
        self.assertEqual(saved_desks.layout(LAYOUT), LAYOUT)
        for bad in (None, dict(LAYOUT, layout='spiral'), dict(LAYOUT, panes=[dict(id='a b')]),
                    dict(LAYOUT, panes=[dict(id='a', rect=dict(x=8, y=0, w=6, h=1))]), dict(LAYOUT, pages=[dict(id='web-1', url='file:///etc/passwd')]),
                    dict(LAYOUT, panes=[dict(id=f'p{i}') for i in range(17)])):
            with self.assertRaises(ValueError, msg=bad):
                saved_desks.layout(bad)

    def test_records_are_read_without_touching_an_unreadable_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'terminal-sessions-4310.json'
            self.assertEqual(saved_desks.session_records(path), {})
            path.write_text('{not json')
            self.assertEqual(saved_desks.session_records(path), {})
            self.assertEqual(path.read_text(), '{not json', 'the supervisor\'s file is never moved or rewritten')
            path.write_text(json.dumps(dict(version=1, sessions=[record('terminal-a', ['/bin/zsh', '-l']), 'junk'])))
            self.assertEqual(list(saved_desks.session_records(path)), ['terminal-a'])

    def test_the_save_dialog_says_what_each_terminal_comes_back_as(self):
        resumes = saved_desks.outcome(record('terminal-a', ['/usr/bin/codex'], native_session=CODEX_ID))
        self.assertEqual(resumes, dict(id='terminal-a', resumes=True, detail=f'On reopen: resumes Codex conversation {CODEX_ID}'))
        shell = saved_desks.outcome(record('terminal-b', ['/bin/zsh', '-l'], launch_profile=None))
        self.assertEqual((shell['resumes'], shell['detail']), (False, 'On reopen: starts a new shell in the same folder'))
        command = saved_desks.outcome(record('terminal-c', ['/usr/bin/make', 'watch'], launch_profile=None))
        self.assertEqual(command['detail'], 'On reopen: starts a shell instead of re-running make watch')


class SavedDeskRouteTests(unittest.TestCase):
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

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.records = Path(temp.name) / 'terminal-sessions.json'
        for patcher in (patch.object(server, 'DESKS', Desks(Path(temp.name) / 'desks.json')), patch.object(server, 'SESSION_RECORDS', self.records)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def post(self, path, body):
        request = Request(self.base + path, data=json.dumps(body).encode(), headers={'X-Agent-Desk-Terminal': server.TERMINAL_TOKEN})
        with urlopen(request) as response:
            return json.load(response)

    def error(self, path, body):
        with self.assertRaises(HTTPError) as caught:
            self.post(path, body)
        with caught.exception as response:
            return json.load(response)['error']

    def test_save_keeps_records_read_before_stopping_and_reopen_resumes_them(self):
        work = self.post('/api/desks/create', {'name': 'Work'})['id']
        agent = record('terminal-a', ['/usr/bin/codex', '--model', 'x'], native_session=CODEX_ID, display_name='Reviewer')
        child = record('terminal-b', ['/bin/zsh', '-l'], launch_profile=None, parent_id='terminal-a', created=2)
        self.records.write_text(json.dumps(dict(version=1, sessions=[agent, child])))
        stopped = dict(stopped=['terminal-a', 'terminal-b', 'terminal-remote'], closed=['coordinator-1', 'coordinator-remote'], skipped=[], failed=[])
        coordinators = Mock(agents=Mock(return_value=[dict(id='coordinator-1')]))
        with patch.object(server, 'shutdown_desk', return_value=stopped) as shutdown, patch.object(server, 'COORDINATORS', coordinators):
            saved = self.post('/api/desks/save', {'id': work, 'ids': ['terminal-a'], 'layout': LAYOUT})
        self.assertEqual(shutdown.call_args.args[0]['ids'], ['terminal-a'])
        self.assertEqual(saved['saved'], ['terminal-a', 'terminal-b', 'coordinator-1'])
        self.assertTrue(next(d for d in saved['desks'] if d['id'] == work)['saved_at'])
        self.assertIn('already saved', self.error('/api/desks/save', {'id': work, 'ids': [], 'layout': LAYOUT}))

        launched = []
        def launch(payload, coordinator=None, desk=None):
            launched.append((payload, desk))
            return Mock(id=f'terminal-new-{len(launched)}')
        coordinators.reopen.return_value = dict(name='Planner')
        with patch.object(server, 'TERMINALS', Mock(launch=launch)), patch.object(server, 'COORDINATORS', coordinators):
            reopened = self.post('/api/desks/reopen', {'id': work})
        (first, first_desk), (second, second_desk) = launched
        self.assertEqual(first['argv'], ['/usr/bin/codex', '--model', 'x', 'resume', CODEX_ID])
        self.assertEqual((first_desk, second['parent_id'], second_desk), (work, 'terminal-new-1', None), 'a child follows its reopened parent')
        self.assertEqual([(r['id'], r.get('new_id'), r['resumed']) for r in reopened['results']],
                         [('terminal-a', 'terminal-new-1', True), ('terminal-b', 'terminal-new-2', False), ('coordinator-1', 'coordinator-1', True)])
        self.assertEqual(reopened['layout'], LAYOUT)
        self.assertNotIn('saved_at', next(d for d in reopened['desks'] if d['id'] == work))
        self.assertIn('not saved', self.error('/api/desks/reopen', {'id': work}))

    def test_sessions_left_out_stop_but_are_not_kept_and_take_their_workers(self):
        work = self.post('/api/desks/create', {'name': 'Work'})['id']
        parent = record('terminal-a', ['/usr/bin/codex'], native_session=CODEX_ID)
        worker = record('terminal-b', ['/bin/zsh', '-l'], launch_profile=None, parent_id='terminal-a', created=2)
        shell = record('terminal-c', ['/bin/zsh', '-l'], launch_profile=None, created=3)
        self.records.write_text(json.dumps(dict(version=1, sessions=[parent, worker, shell])))
        stopped = dict(stopped=['terminal-a', 'terminal-b', 'terminal-c'], closed=['coordinator-1'], skipped=[], failed=[])
        coordinators = Mock(agents=Mock(return_value=[dict(id='coordinator-1')]))
        with patch.object(server, 'shutdown_desk', return_value=stopped) as shutdown, patch.object(server, 'COORDINATORS', coordinators):
            saved = self.post('/api/desks/save', {'id': work, 'ids': ['terminal-a', 'terminal-c', 'coordinator-1'], 'layout': LAYOUT,
                                                  'drop': ['terminal-a', 'coordinator-1', 7]})
        self.assertEqual(shutdown.call_args.args[0]['ids'], ['terminal-a', 'terminal-c', 'coordinator-1'], 'everything still stops')
        self.assertEqual(saved['saved'], ['terminal-c'])
        self.assertEqual([t['id'] for t in server.DESKS.saved_record(work)['terminals']], ['terminal-c'])
        self.assertEqual(server.DESKS.saved_record(work)['coordinators'], [])

    def test_a_terminal_that_cannot_start_is_reported_and_the_rest_reopen(self):
        work = self.post('/api/desks/create', {'name': 'Work'})['id']
        server.DESKS.keep(work, dict(terminals=[record('terminal-a', ['/bin/zsh', '-l'], launch_profile=None, cwd='/gone'),
                                                 record('terminal-b', ['/bin/zsh', '-l'], launch_profile=None, created=2)], coordinators=[], layout=LAYOUT))
        def launch(payload, coordinator=None, desk=None):
            if payload['cwd'] == '/gone':
                raise ValueError('Choose an existing absolute working directory')
            return Mock(id='terminal-new')
        with patch.object(server, 'TERMINALS', Mock(launch=launch)):
            results = self.post('/api/desks/reopen', {'id': work})['results']
        self.assertEqual([(r['id'], r.get('error'), r.get('new_id')) for r in results],
                         [('terminal-a', 'Choose an existing absolute working directory', None), ('terminal-b', None, 'terminal-new')])

    def test_a_new_name_is_applied_and_a_taken_one_refused_before_anything_stops(self):
        work, other = (self.post('/api/desks/create', {'name': name})['id'] for name in ('Work', 'Other'))
        with patch.object(server, 'shutdown_desk') as shutdown:
            self.assertIn('Other', self.error('/api/desks/save', {'id': work, 'ids': [], 'layout': LAYOUT, 'name': 'Other'}))
        shutdown.assert_not_called()
        stopped = dict(stopped=[], closed=[], skipped=[], failed=[])
        with patch.object(server, 'shutdown_desk', return_value=stopped), patch.object(server, 'COORDINATORS', Mock(agents=Mock(return_value=[]))):
            saved = self.post('/api/desks/save', {'id': work, 'ids': [], 'layout': LAYOUT, 'name': ' Later '})
        self.assertEqual(next(d['name'] for d in saved['desks'] if d['id'] == work), 'Later')

    def test_the_last_open_desk_is_refused_before_anything_stops(self):
        with patch.object(server, 'shutdown_desk') as shutdown:
            self.assertIn('last open desk', self.error('/api/desks/save', {'id': 'main', 'ids': [], 'layout': LAYOUT}))
        shutdown.assert_not_called()


if __name__ == '__main__':
    unittest.main()
