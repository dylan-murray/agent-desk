import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from agent_desk import desk_tokens, server
from agent_desk.terminals import TerminalManager
from scripts.agent_control import DeskClient


class ControlTests(unittest.TestCase):
    def test_rejects_nonlocal_urls(self):
        for url in ('https://example.com:4310', 'http://127.0.0.1:4310/extra', 'http://user@localhost:4310', 'http://localhost:4310?token=x'):
            with self.assertRaises(ValueError):
                DeskClient(url)

    def test_real_terminal_lifecycle_and_external_read_only(self):
        manager = TerminalManager()
        with patch.object(server, 'TERMINALS', server.DeskTerminals(manager)), patch.object(server, 'discover', return_value=[]), patch.object(server, 'SESSIONS', {'external': {'id': 'external', 'name': 'External', 'events': []}}):
            http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True); thread.start()
            try:
                self.addCleanup(desk_tokens.write_token('terminal', http.server_port, server.TERMINAL_TOKEN).unlink)
                client = DeskClient('http://127.0.0.1:' + str(http.server_port))
                with self.assertRaises(ValueError):
                    client.send('external', 'do something', True)
                session = client.request('/api/terminals/launch', {'cwd': tempfile.gettempdir(), 'argv': ['/bin/zsh', '-f', '-i'], 'name': 'Control fixture'})
                identity = session['id']
                renamed = client.request('/api/terminals/rename', {'id': identity, 'name': '  Review · Example API  '})
                self.assertEqual(renamed['display_name'], 'Review · Example API')
                self.assertEqual(renamed['name'], session['name'])
                self.assertEqual(renamed['id'], identity)
                self.assertEqual(client.terminal(identity)['display_name'], 'Review · Example API')
                for invalid in ('', 'a'*101, 'bad\nname'):
                    with self.assertRaises(ValueError): client.request('/api/terminals/rename', {'id': identity, 'name': invalid})
                time.sleep(.3)
                client.send(identity, "printf 'CONTROL_%s\\n' 'SUCCESS'", True)
                deadline = time.time() + 5
                while time.time() < deadline:
                    output = client.read(identity)
                    if 'CONTROL_SUCCESS' in output['text']:
                        break
                    time.sleep(.1)
                self.assertIn('CONTROL_SUCCESS', output['text'])
                client.send(identity, "printf 'SLEEP_%s\\n' 'READY'; sleep 30", True)
                deadline = time.time() + 5
                while time.time() < deadline:
                    if 'SLEEP_READY' in client.read(identity)['text']:
                        break
                    time.sleep(.1)
                time.sleep(.2)
                client.input(identity, b'\x03')
                time.sleep(.2)
                client.send(identity, "printf 'AFTER_%s\\n' 'INTERRUPT'", True)
                deadline = time.time() + 5
                while time.time() < deadline:
                    fresh = client.read(identity, cursor=output['cursor'])
                    if 'AFTER_INTERRUPT' in fresh['text']:
                        break
                    time.sleep(.1)
                self.assertIn('AFTER_INTERRUPT', fresh['text'])
                with self.assertRaises(ValueError):
                    client.send(identity, '\x1bmalicious-control')
                client.request('/api/terminals/stop', {'id': identity})
                self.assertIsNotNone(client.terminal(identity)['exit_code'])
                with self.assertRaises(ValueError):
                    client.send(identity, 'after exit')
            finally:
                manager.close(); http.shutdown(); http.server_close(); thread.join()

class CoordinatorApiTests(unittest.TestCase):
    def test_event_inbox_auth_retry_ack_and_launch_adapter(self):
        import tempfile
        from pathlib import Path
        from urllib.request import urlopen, Request
        from urllib.error import HTTPError
        from scripts.control_mailbox import Mailbox
        with tempfile.TemporaryDirectory() as tmp:
            box = Mailbox(Path(tmp)/'mailbox.sqlite3')
            manager = TerminalManager()
            with patch.object(server, 'MAILBOX', box), patch.object(server, 'TERMINALS', manager):
                http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
                thread = threading.Thread(target=http.serve_forever, daemon=True); thread.start()
                self.addCleanup(desk_tokens.write_token('terminal', http.server_port, server.TERMINAL_TOKEN).unlink)
                client = DeskClient('http://localhost:' + str(http.server_port))
                try:
                    for path, data in [('/api/coordinator-events', None), ('/api/coordinator-events/ack', b'{}')]:
                        with self.assertRaises(HTTPError) as error:
                            urlopen(Request(client.desk+path, data=data), timeout=3)
                        self.assertEqual(error.exception.code, 403)
                        error.exception.close()
                    box.register(client.desk, 'controller', 'claude')
                    task, _ = box.create(client.desk, 'controller', 'worker', 'Check result')
                    box.reply(client.desk, task['id'], 'Ready for review', 'completed')
                    snapshot = client.request('/api/coordinator-events')
                    self.assertTrue(snapshot['event_delivery'])
                    self.assertEqual(snapshot['tasks'][0]['delivery'], 'queued')
                    box.claim(client.desk, 'controller')
                    with self.assertRaises(ValueError):
                        client.request('/api/coordinator-events/retry', {'id': task['id'], 'controller': 'wrong'})
                    client.request('/api/coordinator-events/retry', {'id': task['id'], 'controller': 'controller'})
                    client.request('/api/coordinator-events/ack', {'id': task['id'], 'controller': 'controller'})
                    self.assertEqual(client.request('/api/coordinator-events')['tasks'][0]['acknowledged'], 1)
                    with patch.object(manager, 'launch') as launch:
                        launch.return_value.info.return_value = {'id': 'fixture', 'coordinator_events': True}
                        result = client.request('/api/terminals/launch', {'cwd': tmp, 'argv': ['codex', 'objective'], 'coordinator_harness': 'codex'})
                        self.assertTrue(result['coordinator_events'])
                        self.assertEqual(launch.call_args.kwargs['coordinator'], {'harness': 'codex', 'desk': client.desk, 'db': str(box.path)})
                finally:
                    manager.close(); http.shutdown(); http.server_close(); thread.join()
