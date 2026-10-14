import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from agent_desk import pane_guard, server
from agent_desk.terminals import TerminalManager


class RefusalTests(unittest.TestCase):
    def test_a_protected_session_is_closed_to_reading_and_typing(self):
        for write in (True, False):
            self.assertIn('protected', pane_guard.refusal('prod', {'prod'}, write=write))
            self.assertIn('protected', pane_guard.refusal('prod', {'prod'}, 'prod', {}.get, write))
        self.assertIsNone(pane_guard.refusal('other', {'prod'}))

    def test_an_agent_types_only_into_its_own_pane_and_its_workers(self):
        parents = {'worker': 'agent', 'grandchild': 'worker', 'stranger': None, 'loop-a': 'loop-b', 'loop-b': 'loop-a'}
        for target in ('agent', 'worker', 'grandchild'):
            self.assertIsNone(pane_guard.refusal(target, set(), 'agent', parents.get), target)
        for target in ('stranger', 'missing', 'loop-a'):
            self.assertIn('belongs to someone else', pane_guard.refusal(target, set(), 'agent', parents.get), target)
        # A worker cannot reach up to the agent that started it, or across to another worker.
        self.assertIsNotNone(pane_guard.refusal('agent', set(), 'worker', parents.get))
        # Reading another session stays open; a helper outside any pane is not scoped.
        self.assertIsNone(pane_guard.refusal('stranger', set(), 'agent', parents.get, write=False))
        self.assertIsNone(pane_guard.refusal('stranger', set()))

    def test_protection_survives_a_restart_and_ignores_a_damaged_file(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'state' / 'protected-panes.json'
            panes = pane_guard.ProtectedPanes(path)
            self.assertEqual(panes.set('terminal-a', True), {'id': 'terminal-a', 'protected': True})
            self.assertIn('terminal-a', pane_guard.ProtectedPanes(path))
            panes.set('terminal-a', False)
            self.assertNotIn('terminal-a', pane_guard.ProtectedPanes(path))
            for bad in ((None, True), ('', True), ('terminal-a', 'yes')):
                with self.assertRaises(ValueError):
                    panes.set(*bad)
            for damaged in ('not json', '{"a": 1}', '[1, null, "terminal-b"]'):
                path.write_text(damaged)
                self.assertEqual(pane_guard.ProtectedPanes(path).ids, {'terminal-b'} if 'terminal-b' in damaged else set())


class ServerGuardTests(unittest.TestCase):
    """The page, a helper with the token file, and an agent's own tool, against real shell panes."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        manager = TerminalManager(); self.addCleanup(manager.close)
        for patcher in (patch.object(server, 'TERMINALS', server.DeskTerminals(manager)),
                        patch.object(server, 'PROTECTED_PANES', pane_guard.ProtectedPanes(Path(self.temp.name) / 'protected.json')),
                        patch.object(server, 'discover', return_value=[])):
            patcher.start(); self.addCleanup(patcher.stop)
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.addCleanup(self.http.server_close); self.addCleanup(self.http.shutdown)
        self.base = f'http://127.0.0.1:{self.http.server_port}'
        launch = lambda name, parent=None: self.call('/api/terminals/launch', {'cwd': self.temp.name, 'argv': ['/bin/sh'], 'name': name, **({'parent_id': parent} if parent else {})})[1]['id']
        self.agent = launch('Agent'); self.worker = launch('Worker', self.agent); self.prod = launch('Prod shell')

    def call(self, path, payload=None, token=None, pane=None):
        headers = {'X-Agent-Desk-Terminal': token or server.TERMINAL_TOKEN, 'Content-Type': 'application/json', **({'X-Agent-Desk-Pane': pane} if pane else {})}
        try:
            with urlopen(Request(self.base + path, data=json.dumps(payload).encode() if payload is not None else None, headers=headers), timeout=10) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            with error:
                return error.code, json.load(error)

    def typed(self, identity, text, **who):
        return self.call('/api/terminals/input', {'id': identity, 'data': __import__('base64').b64encode(text.encode()).decode()}, **who)[0]

    def test_only_the_page_reaches_a_protected_session(self):
        helper = dict(token=server.HELPER_TOKEN)
        self.assertEqual(self.typed(self.prod, 'echo before\n', **helper), 200)
        self.assertEqual(self.call('/api/terminals/protect', {'id': self.prod, 'protected': True}, **helper)[0], 403, 'a helper protected or unprotected a session')
        self.assertEqual(self.call('/api/terminals/protect', {'id': self.prod, 'protected': True}), (200, {'id': self.prod, 'protected': True}))
        listed = {agent['id']: agent.get('protected', False) for agent in self.call('/api/agents')[1]['agents']}
        self.assertEqual((listed[self.prod], listed[self.agent]), (True, False))
        for who in (helper, dict(token=server.HELPER_TOKEN, pane=self.agent), dict(token=server.HELPER_TOKEN, pane=self.prod)):
            self.assertEqual(self.typed(self.prod, 'echo intruder\n', **who), 403)
            for path, payload in (('/api/terminals/stop', {'id': self.prod}), ('/api/terminals/rename', {'id': self.prod, 'name': 'x'}),
                                  ('/api/coordinators/submit-feedback', {'target_id': self.prod, 'request_id': 'r1', 'notes': [{'id': 'n', 'note': 'x'}]})):
                status, body = self.call(path, payload, **who)
                self.assertEqual(status, 403, path); self.assertIn('protected', body['error'])
            self.assertEqual(self.call('/api/terminals/output?id=' + self.prod + '&cursor=0', **who)[0], 403)
        # The user, at the desk, still can.
        self.assertEqual(self.typed(self.prod, 'echo desk-$((40+2))\n'), 200)
        end = time.time() + 5; seen = ''
        while time.time() < end and 'desk-42' not in seen:
            status, body = self.call('/api/terminals/output?id=' + self.prod + '&cursor=0')
            seen = __import__('base64').b64decode(body.get('data', '')).decode(errors='replace'); time.sleep(.1)
        self.assertIn('desk-42', seen); self.assertNotIn('intruder', seen)
        self.assertEqual(self.call('/api/terminals/protect', {'id': 'terminal-missing', 'protected': True})[0], 400)
        self.call('/api/terminals/protect', {'id': self.prod, 'protected': False})
        self.assertEqual(self.typed(self.prod, 'echo after\n', **helper), 200)

    def test_a_helper_may_resize_but_not_shut_down_a_protected_session(self):
        helper = dict(token=server.HELPER_TOKEN)
        self.call('/api/terminals/protect', {'id': self.prod, 'protected': True})
        self.assertEqual(self.call('/api/terminals/resize', {'id': self.prod, 'cols': 100, 'rows': 30}, **helper)[0], 200)
        status, body = self.call('/api/desks/shutdown', {'id': 'main', 'ids': [self.prod, self.agent]}, **helper)
        self.assertEqual(status, 200)
        self.assertEqual(body['stopped'], [self.agent])
        self.assertEqual([item['id'] for item in body['failed']], [self.prod]); self.assertIn('protected', body['failed'][0]['error'])
        self.assertIsNone(server.TERMINALS.get(self.prod).info()['exit_code'])
        # An agent's tool shutting down a desk is held to its own pane, like stop.
        status, body = self.call('/api/desks/shutdown', {'id': 'main', 'ids': [self.worker]}, token=server.HELPER_TOKEN, pane=self.prod)
        self.assertEqual([item['id'] for item in body['failed']], [self.worker])
        self.assertEqual(self.call('/api/desks/shutdown', {'id': 'main', 'ids': [self.prod]})[1]['stopped'], [self.prod])

    def test_remote_sessions_are_checked_before_they_are_forwarded(self):
        helper = dict(token=server.HELPER_TOKEN)
        remote = [dict(id='remote:node:prod', protected=True), dict(id='remote:node:open')]
        with patch.object(server.REMOTES, 'records', return_value=remote), \
             patch.object(server.REMOTES, 'request', return_value={'ok': True}) as forwarded:
            for path, payload in (('/api/terminals/input', {'id': 'remote:node:prod', 'data': ''}), ('/api/terminals/stop', {'id': 'remote:node:prod'}),
                                  ('/api/terminals/protect', {'id': 'remote:node:prod', 'protected': False})):
                self.assertEqual(self.call(path, payload, **helper)[0], 403, path)
            self.assertEqual(self.call('/api/terminals/input', {'id': 'remote:node:open', 'data': ''}, token=server.HELPER_TOKEN, pane=self.agent)[0], 403)
            forwarded.assert_not_called()
            self.assertEqual(self.call('/api/terminals/input', {'id': 'remote:node:open', 'data': ''}, **helper)[0], 200)
            # Locking a remote session from the desk is also enforced here, before any refresh.
            self.assertEqual(self.call('/api/terminals/protect', {'id': 'remote:node:open', 'protected': True})[0], 200)
            self.assertIn('remote:node:open', server.PROTECTED_PANES)
            self.assertEqual(self.call('/api/terminals/input', {'id': 'remote:node:open', 'data': ''}, **helper)[0], 403)
            self.assertEqual(forwarded.call_count, 2)

    def test_an_agents_tool_is_kept_to_its_own_pane_and_workers(self):
        tool = dict(token=server.HELPER_TOKEN, pane=self.agent)
        self.assertEqual(self.typed(self.agent, 'echo self\n', **tool), 200)
        self.assertEqual(self.typed(self.worker, 'echo worker\n', **tool), 200)
        self.assertEqual(self.typed(self.prod, 'echo other\n', **tool), 403)
        status, body = self.call('/api/terminals/stop', {'id': self.prod}, **tool)
        self.assertEqual(status, 403); self.assertIn('belongs to someone else', body['error'])
        self.assertEqual(self.typed(self.agent, 'echo up\n', token=server.HELPER_TOKEN, pane=self.worker), 403)
        # It may still read another session's output, and a helper outside any pane is not scoped.
        self.assertEqual(self.call('/api/terminals/output?id=' + self.prod + '&cursor=0', **tool)[0], 200)
        self.assertEqual(self.typed(self.prod, 'echo helper\n', token=server.HELPER_TOKEN), 200)
        self.assertEqual(self.call('/api/terminals/stop', {'id': self.worker}, **tool)[0], 200)


if __name__ == '__main__':
    unittest.main()
