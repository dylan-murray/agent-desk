import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from agent_desk import server
from agent_desk.desks import Desks


def agent(identity, parent=None):
    return dict(id=identity, parent_id=parent)


class DeskTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'desks.json'
        self.desks = Desks(self.path)

    def resolved(self, agents, desks=None):
        (desks or self.desks).annotate(agents)
        return {a['id']: a['desk'] for a in agents}

    def test_first_run_has_one_desk_and_writes_nothing_until_changed(self):
        self.assertEqual(self.desks.snapshot(), [dict(id='main', name='Main')])
        self.assertEqual(self.resolved([agent('a')]), {'a': 'main'})
        self.assertFalse(self.path.exists())

    def test_followers_go_where_what_they_follow_goes_unless_placed(self):
        research = self.desks.create('Research')['id']
        team = [agent('coordinator'), agent('worker', 'coordinator'), agent('subagent', 'worker'), agent('pinned', 'coordinator')]
        self.desks.place(['pinned'], 'main')
        self.desks.place(['coordinator'], research)
        self.assertEqual(self.resolved(team), {'coordinator': research, 'worker': research, 'subagent': research, 'pinned': 'main'})
        # A worker whose coordinator is not in the list still finds the coordinator's desk.
        self.assertEqual(self.resolved([agent('worker', 'coordinator')]), {'worker': research})

    def test_desks_and_placements_survive_a_restart(self):
        work = self.desks.create('Work')['id']
        self.desks.place(['a'], work)
        self.desks.rename('main', 'Personal')
        again = Desks(self.path)
        self.assertEqual([d['name'] for d in again.snapshot()], ['Personal', 'Work'])
        self.assertEqual(self.resolved([agent('a'), agent('b')], again), {'a': work, 'b': 'main'})

    def test_names_are_validated_and_unique_regardless_of_case(self):
        self.desks.create('Research')
        for bad in ('', '   ', 'x' * 41, 'tab\there', 'research', ' RESEARCH '):
            with self.assertRaises(ValueError, msg=bad):
                self.desks.create(bad)
        self.assertEqual(self.desks.rename('main', 'main ')['name'], 'main')
        with self.assertRaises(ValueError):
            self.desks.place(['a'], 'no-such-desk')

    def test_deleting_moves_everything_on_it_including_agents_there_by_default(self):
        work = self.desks.create('Work')['id']
        research = self.desks.create('Research')['id']
        everyone = [agent('loose'), agent('placed'), agent('worker', 'loose'), agent('elsewhere'), agent('closed-parent-child', 'gone')]
        self.desks.place(['placed'], 'main')
        self.desks.place(['elsewhere'], work)
        self.desks.place(['offline'], 'main')
        # Deleting the first desk: what fell to it by default must not slide onto the next first desk.
        self.assertEqual([d['id'] for d in self.desks.delete('main', research, everyone)], [work, research])
        self.assertEqual(self.resolved(everyone), {'loose': research, 'placed': research, 'worker': research, 'elsewhere': work, 'closed-parent-child': research})
        self.assertEqual(self.resolved([agent('offline')]), {'offline': research})
        # The worker still follows rather than being pinned, so moving its parent moves it.
        self.desks.place(['loose'], work)
        self.assertEqual(self.resolved(everyone)['worker'], work)

    def test_deleting_needs_another_existing_desk(self):
        with self.assertRaises(ValueError):
            self.desks.delete('main', 'main', [])
        work = self.desks.create('Work')['id']
        with self.assertRaises(ValueError):
            self.desks.delete(work, 'nowhere', [])
        self.assertEqual(len(self.desks.snapshot()), 2)

    def test_unreadable_file_is_kept_aside_not_overwritten(self):
        self.path.write_text('{not json')
        self.assertEqual(self.desks.snapshot(), [dict(id='main', name='Main')])
        aside = list(self.path.parent.glob('desks.json.unreadable-*'))
        self.assertEqual([p.read_text() for p in aside], ['{not json'])

    def test_parent_cycles_do_not_hang(self):
        self.assertEqual(self.resolved([agent('a', 'b'), agent('b', 'a')]), {'a': 'main', 'b': 'main'})


class DeskRouteTests(unittest.TestCase):
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
        desks = patch.object(server, 'DESKS', Desks(Path(temp.name) / 'desks.json'))
        desks.start()
        self.addCleanup(desks.stop)

    def post(self, path, body, headers=None):
        request = Request(self.base + path, data=json.dumps(body).encode(),
                          headers={'X-Agent-Desk-Terminal': server.TERMINAL_TOKEN} if headers is None else headers)
        with urlopen(request) as response:
            return json.load(response)

    def test_desk_changes_require_local_terminal_auth(self):
        for headers in ({}, {'X-Agent-Desk-Terminal': server.TERMINAL_TOKEN, 'Origin': 'https://foreign.example'}):
            with self.assertRaises(HTTPError) as caught:
                self.post('/api/desks/create', {'name': 'Sneaky'}, headers)
            self.assertEqual(caught.exception.code, 403)
            caught.exception.close()
        self.assertEqual(len(server.DESKS.snapshot()), 1)

    def test_agents_carry_their_desk_and_launches_land_on_the_desk_they_came_from(self):
        research = self.post('/api/desks/create', {'name': 'Research'})
        launched = dict(id='terminal-1', parent_id=None)
        with patch.object(server.TERMINALS.terminals, 'launch') as launch, patch('agent_desk.standalone_agent.launch_payload', side_effect=lambda p: p):
            launch.return_value.id, launch.return_value.info.return_value = launched['id'], dict(launched)
            reply = self.post('/api/terminals/launch', {'cwd': '/', 'argv': ['sh'], 'desk': research['id']})
        self.assertNotIn('desk', launch.call_args.args[0], 'the terminal itself never sees the desk')
        self.assertEqual(reply['desk'], research['id'])
        with patch.object(server.TERMINALS, 'list', return_value=[dict(launched, cwd='/', exit_code=None)]), \
             patch.object(server, 'discover', return_value=[]), \
             patch.object(server.MAILBOX, 'subagents', return_value=[dict(id='sub', parent_id='terminal-1', cwd='/')]):
            with urlopen(self.base + '/api/agents') as response:
                data = json.load(response)
        desks = {a['id']: a['desk'] for a in data['agents']}
        self.assertEqual((desks['terminal-1'], desks['sub']), (research['id'], research['id']))
        self.assertEqual([d['name'] for d in data['desks']], ['Main', 'Research'])

    def test_a_child_launched_without_a_desk_goes_where_its_parent_is(self):
        # scripts/agent_control.py launch --parent sends parent_id and no desk.
        research = self.post('/api/desks/create', {'name': 'Research'})
        parent, child = dict(id='terminal-1', parent_id=None), dict(id='terminal-2', parent_id='terminal-1')
        with patch.object(server.TERMINALS.terminals, 'launch') as launch, patch('agent_desk.standalone_agent.launch_payload', side_effect=lambda p: p):
            launch.return_value.id, launch.return_value.info.return_value = parent['id'], dict(parent)
            self.post('/api/terminals/launch', {'cwd': '/', 'argv': ['sh'], 'desk': research['id']})
            launch.return_value.id, launch.return_value.info.return_value = child['id'], dict(child)
            self.post('/api/terminals/launch', {'cwd': '/', 'argv': ['sh'], 'parent_id': 'terminal-1'})
        agents = [dict(parent), dict(child)]
        server.DESKS.annotate(agents)
        self.assertEqual([a['desk'] for a in agents], [research['id'], research['id']])
        # The child follows rather than being pinned, so moving its parent moves it.
        self.post('/api/desks/place', {'ids': ['terminal-1'], 'desk': server.DESKS.snapshot()[0]['id']})
        server.DESKS.annotate(agents)
        self.assertEqual(agents[1]['desk'], server.DESKS.snapshot()[0]['id'])

    def test_the_running_terminal_limit_is_per_desk(self):
        class Backend:
            def __init__(self):
                self.rows = []
            def list(self):
                return [dict(row) for row in self.rows]
            def launch(self, payload, coordinator=None):
                row = dict(id=f'terminal-{len(self.rows)}', parent_id=payload.get('parent_id'), exit_code=None)
                self.rows.append(row)
                return Mock(id=row['id'], info=lambda: dict(row))
        backend = Backend()
        research = self.post('/api/desks/create', {'name': 'Research'})['id']
        launch = lambda **fields: self.post('/api/terminals/launch', {'cwd': '/', 'argv': ['sh'], **fields})
        def refused(**fields):
            with self.assertRaises(HTTPError) as caught:
                launch(**fields)
            self.assertEqual(caught.exception.code, 400)
            return json.load(caught.exception)['error']
        with patch.object(server, 'TERMINALS', server.DeskTerminals(backend)), \
             patch('agent_desk.standalone_agent.launch_payload', side_effect=lambda p: p):
            on_main = [launch(desk='main')['id'] for _ in range(server.TERMINALS_PER_DESK)]
            self.assertEqual(refused(desk='main'), '16 terminals are already running on Main. Stop one before launching another.')
            # A full Main desk leaves Research its own sixteen.
            on_research = [launch(desk=research)['id'] for _ in range(server.TERMINALS_PER_DESK)]
            self.assertIn('already running on Research', refused(desk=research))
            # A child sent without a desk counts on its parent's desk.
            self.assertIn('already running on Main', refused(parent_id=on_main[0]))
            # Exited terminals do not count, and moving one off a desk frees its place there.
            backend.rows[0]['exit_code'] = 0
            self.assertEqual(launch(desk='main')['desk'], 'main')
            self.post('/api/desks/place', {'ids': [on_research[0]], 'desk': 'main'})
            self.assertEqual(launch(desk=research)['desk'], research)
            self.assertIn('already running on Main', refused(desk='main'))
        self.assertEqual(len(backend.rows), 2 * server.TERMINALS_PER_DESK + 2, "a refused launch starts nothing")

    def test_launching_onto_a_deleted_desk_is_refused_before_anything_starts(self):
        with patch.object(server.TERMINALS, 'launch') as launch:
            with self.assertRaises(HTTPError) as caught:
                self.post('/api/terminals/launch', {'cwd': '/', 'argv': ['sh'], 'desk': 'desk-gone'})
        self.assertEqual(caught.exception.code, 400)
        self.assertIn('no longer exists', json.load(caught.exception)['error'])
        launch.assert_not_called()

    def test_remote_coordinators_are_placed_here_and_the_remote_never_sees_desks(self):
        research = self.post('/api/desks/create', {'name': 'Research'})
        with patch.object(server.REMOTES, 'request', return_value=dict(id='remote-node-1:coordinator-1')) as request:
            reply = self.post('/api/coordinators/create', {'remote_node': 'node-1', 'name': 'Remote', 'desk': research['id']})
        self.assertNotIn('desk', request.call_args.args[2])
        self.assertEqual(reply['desk'], research['id'])
        agents = [dict(id='remote-node-1:coordinator-1')]
        server.DESKS.annotate(agents)
        self.assertEqual(agents[0]['desk'], research['id'])

    def test_shutdown_stops_only_what_was_listed_on_that_desk(self):
        import time
        from agent_desk.terminals import TerminalManager
        manager = TerminalManager()
        self.addCleanup(manager.close)
        research = self.post('/api/desks/create', {'name': 'Research'})
        shell = lambda name: manager.launch(dict(cwd='/tmp', argv=['/bin/sh'], name=name))
        researcher, worker, other, late = shell('Researcher'), shell('Worker'), shell('Work shell'), shell('Started after the dialog')
        worker.parent_id = 'coordinator-1'
        server.DESKS.place([researcher.id, late.id, 'coordinator-1'], research['id'])
        coordinator = dict(id='coordinator-1', name='Coordinator', coordinator_workspace=True, controller=True, exit_code=None)
        with patch.object(server, 'TERMINALS', manager), \
             patch.object(server.COORDINATORS, 'agents', return_value=[coordinator]), \
             patch.object(server.COORDINATORS, 'snapshot', return_value={'coordinators': [coordinator]}), \
             patch.object(server.COORDINATORS, 'close_conversation') as close, \
             patch.object(server.COORDINATORS, 'stop_worker', side_effect=lambda p: manager.get(p['worker_id']).stop()) as stop_worker:
            # The dialog listed the research sessions, plus one id that is on another desk.
            result = self.post('/api/desks/shutdown', {'id': research['id'], 'ids': [researcher.id, worker.id, 'coordinator-1', other.id]})
        self.assertEqual(sorted(result['stopped']), sorted([researcher.id, worker.id]))
        self.assertEqual((result['closed'], result['skipped'], result['failed']), (['coordinator-1'], [other.id], []))
        close.assert_called_once_with('coordinator-1')
        self.assertEqual(stop_worker.call_args.args[0]['worker_id'], worker.id, 'a worker is saved for Resume, not just killed')
        deadline = time.time() + 5
        while time.time() < deadline and None in (researcher.process.poll(), worker.process.poll()):
            time.sleep(0.05)
        self.assertIsNotNone(researcher.process.poll())
        self.assertIsNotNone(worker.process.poll())
        self.assertIsNone(other.process.poll(), 'another desk is never touched')
        self.assertIsNone(late.process.poll(), 'a session started after the confirmation is not stopped')

    def test_shutdown_reports_failures_and_keeps_going(self):
        research = self.post('/api/desks/create', {'name': 'Research'})
        server.DESKS.place(['remote:node:t1', 'remote:node:t2'], research['id'])
        remote = [dict(id='remote:node:t1', terminal_id='t1', exit_code=None, remote_node='node'),
                  dict(id='remote:node:t2', terminal_id='t2', exit_code=None, remote_node='node')]
        def request(node, path, payload):
            if payload['id'] == 'remote:node:t1':
                raise ValueError('Reconnect this remote environment first.')
            return {'ok': True}
        with patch.object(server.REMOTES, 'records', return_value=remote), patch.object(server.REMOTES, 'request', side_effect=request) as sent, \
             patch.object(server.TERMINALS, 'list', return_value=[]):
            result = self.post('/api/desks/shutdown', {'id': research['id'], 'ids': ['remote:node:t1', 'remote:node:t2']})
        self.assertEqual(result['failed'], [dict(id='remote:node:t1', error='Reconnect this remote environment first.')])
        self.assertEqual(result['stopped'], ['remote:node:t2'])
        self.assertEqual(sent.call_args.args[:2], ('node', '/api/terminals/stop'))

    def test_rename_place_and_delete_round_trip(self):
        work = self.post('/api/desks/create', {'name': 'Work'})
        self.assertEqual(self.post('/api/desks/rename', {'id': work['id'], 'name': 'Office'})['name'], 'Office')
        self.post('/api/desks/place', {'ids': ['someone'], 'desk': work['id']})
        with patch.object(server.TERMINALS, 'list', return_value=[]):
            remaining = self.post('/api/desks/delete', {'id': work['id'], 'move_to': 'main'})['desks']
        self.assertEqual([d['id'] for d in remaining], ['main'])
        with self.assertRaises(HTTPError) as caught:
            self.post('/api/desks/delete', {'id': 'main', 'move_to': 'main'})
        self.assertEqual(caught.exception.code, 400)
        caught.exception.close()


if __name__ == '__main__':
    unittest.main()
