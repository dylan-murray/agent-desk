import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from http.server import BaseHTTPRequestHandler
import socketserver

from agent_desk import pane_edit, paths, server, terminals
from agent_desk.pane_editor import PaneEdits
from agent_desk import pane_files
from agent_desk.local_transport import runtime_directory
from agent_desk.terminals import PANE_EDIT, TerminalManager, pane_editor, pane_environment
from account_fixtures import use_accounts


def setUpModule():
    use_accounts()


class PaneFilesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'src').mkdir()
        (self.root / 'src' / 'app.py').write_text('print(1)\n')
        (self.root / 'node_modules').mkdir()
        (self.root / 'node_modules' / 'skip.js').write_text('x')

    def tearDown(self):
        self.temp.cleanup()

    def test_listing_outside_git_skips_dependency_folders(self):
        self.assertEqual(pane_files.listing(self.root)['files'], ['src/app.py'])

    def test_read_then_save_round_trips_and_refuses_a_stale_version(self):
        opened = pane_files.read(self.root, 'src/app.py')
        self.assertEqual(opened['text'], 'print(1)\n')
        saved = pane_files.write(self.root, 'src/app.py', 'print(2)\n', opened['version'])
        self.assertEqual((self.root / 'src' / 'app.py').read_text(), 'print(2)\n')
        (self.root / 'src' / 'app.py').write_text('print("agent")\n')
        conflict = pane_files.write(self.root, 'src/app.py', 'print(3)\n', saved['version'])
        self.assertTrue(conflict['conflict'])
        self.assertEqual(conflict['text'], 'print("agent")\n')
        self.assertEqual((self.root / 'src' / 'app.py').read_text(), 'print("agent")\n')

    def test_save_as_creates_a_new_file_but_never_replaces_one(self):
        pane_files.write(self.root, 'notes/plan.md', '# Plan', None)
        self.assertEqual((self.root / 'notes' / 'plan.md').read_text(), '# Plan')
        with self.assertRaises(FileExistsError):
            pane_files.write(self.root, 'notes/plan.md', 'other', None)

    def test_only_text_files_inside_the_pane_folder(self):
        with self.assertRaises(PermissionError):
            pane_files.read(self.root, '../outside.txt')
        (self.root / 'link').symlink_to('/etc')
        with self.assertRaises(PermissionError):
            pane_files.read(self.root, 'link/hosts')
        (self.root / 'blob.bin').write_bytes(b'\x00\x01')
        with self.assertRaises(ValueError):
            pane_files.read(self.root, 'blob.bin')


class PaneEditsTests(unittest.TestCase):
    def test_an_edit_needs_a_listening_page(self):
        edits = PaneEdits()
        with self.assertRaises(LookupError):
            edits.open('terminal-a', 'prompt.md', 'hi')
        edits.pending(None, 0)
        self.assertTrue(edits.open('terminal-a', 'prompt.md', 'hi')['id'].startswith('edit-'))

    def test_saved_text_reaches_the_waiting_editor(self):
        edits = PaneEdits()
        edits.pending(None, 0)
        edit = edits.open('terminal-a', 'prompt.md', 'before')['id']
        listed = edits.pending(None, 0)
        self.assertEqual(listed['edits'], [dict(id=edit, terminal_id='terminal-a', name='prompt.md', text='before')])
        self.assertEqual(edits.wait('terminal-a', edit, 0), dict(done=False))
        threading.Timer(.1, edits.finish, (edit, 'after')).start()
        self.assertEqual(edits.wait('terminal-a', edit, 5), dict(done=True, saved=True, text='after'))
        self.assertEqual(edits.pending(listed['revision'], 0)['edits'], [])

    def test_cancel_another_panes_wait_and_abandon(self):
        edits = PaneEdits()
        edits.pending(None, 0)
        edit = edits.open('terminal-a', 'prompt.md', 'x')['id']
        with self.assertRaises(LookupError):
            edits.wait('terminal-b', edit, 0)
        edits.finish(edit, None)
        self.assertEqual(edits.wait('terminal-a', edit, 0), dict(done=True, saved=False, text=None))
        second = edits.open('terminal-a', 'prompt.md', 'x')['id']
        edits.abandon('terminal-a', second)
        with self.assertRaises(LookupError):
            edits.finish(second, 'too late')


class PaneEditorEnvironmentTests(unittest.TestCase):
    def test_panes_edit_with_the_shim_and_remember_the_editor_they_had(self):
        env = pane_environment({'EDITOR': 'nano', 'PATH': '/bin'}, 'terminal-a', 'token', None)
        launcher = pane_editor()
        self.assertEqual((env['VISUAL'], env['EDITOR'], env['AGENT_DESK_FALLBACK_EDITOR']), (str(launcher), str(launcher), 'nano'))
        # git runs $EDITOR through a shell, so the path has no spaces; it runs the desk's own Python, not one off PATH.
        self.assertNotIn(' ', str(launcher))
        self.assertTrue(os.access(launcher, os.X_OK))
        self.assertIn(sys.executable, launcher.read_text())
        self.assertIn(str(PANE_EDIT), launcher.read_text())
        nested = pane_environment(env, 'terminal-b', 'token', None)
        self.assertEqual(nested['AGENT_DESK_FALLBACK_EDITOR'], 'nano')

    def test_without_a_terminal_the_shim_runs_the_previous_editor(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'message.txt'
            env = dict(os.environ, AGENT_DESK_TERMINAL_ID='terminal-a', AGENT_DESK_PANE_TOKEN='token', AGENT_DESK_URL='http://127.0.0.1:9',
                       AGENT_DESK_FALLBACK_EDITOR="/bin/sh -c 'echo fell back to the old editor for \"$0\"'")
            result = subprocess.run([str(pane_editor()), str(target)], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.stdout.strip(), f'fell back to the old editor for {target}')


    def test_a_data_folder_with_spaces_keeps_the_launcher_under_the_socket_root(self):
        with tempfile.TemporaryDirectory() as folder:
            data, root = Path(folder) / 'Application Support' / 'Agent Desk', Path(folder) / 'sockets'
            data.mkdir(parents=True)
            with patch.object(paths, 'DATA_DIR', data), patch.object(terminals, '_launcher', None), patch.dict(os.environ, AGENT_DESK_SOCKET_ROOT=str(root)):
                launcher = pane_editor()
        self.assertTrue(launcher.is_relative_to(root), launcher)
        self.assertNotIn(' ', str(launcher))


class DesktopAddressTests(unittest.TestCase):
    """A desktop pane's desk is agent-desk://WORKSPACE, reached over a Unix socket rather than a port."""
    def test_the_pane_editor_reaches_a_desktop_desk_over_its_socket(self):
        seen = []

        class Desk(BaseHTTPRequestHandler):
            def address_string(self):
                return 'socket'

            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                seen.append((self.path, self.headers['Host'], self.headers['Authorization'], body))
                data = json.dumps({'id': 'edit-1'}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        # A socket path must stay under about 100 bytes, which macOS's own temp folder is not.
        with tempfile.TemporaryDirectory(prefix='ad-', dir='/private/tmp' if sys.platform == 'darwin' else None) as folder:
            data = Path(folder) / 'data'
            data.mkdir()
            with patch.object(paths, 'DATA_DIR', data), patch.dict(os.environ, AGENT_DESK_SOCKET_ROOT=str(Path(folder) / 's')):
                socket_path = runtime_directory(data, '0123456789abcdef0123456789abcdef') / 'backend.sock'
                listener = socketserver.UnixStreamServer(str(socket_path), Desk)
                threading.Thread(target=listener.serve_forever, daemon=True).start()
                try:
                    answer = pane_edit.call('agent-desk://0123456789abcdef0123456789abcdef', 'fixture-token', '/api/pane-editor/open', {'id': 'terminal-a', 'name': 'a.txt', 'text': 'hi'}, 5)
                finally:
                    listener.shutdown()
                    listener.server_close()
        self.assertEqual(answer, {'id': 'edit-1'})
        self.assertEqual(seen, [('/api/pane-editor/open', 'app', 'Bearer fixture-token', {'id': 'terminal-a', 'name': 'a.txt', 'text': 'hi'})])


class PaneEditorRoundTripTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.manager = TerminalManager()
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.manager.desk = f'http://127.0.0.1:{self.http.server_port}'
        self.edits = PaneEdits()
        self.patches = [patch.object(server, 'TERMINALS', self.manager), patch.object(server, 'PANE_EDITS', self.edits)]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in self.patches:
            item.stop()
        self.manager.close()
        self.http.shutdown()
        self.http.server_close()
        self.temp.cleanup()

    def screen(self, session):
        return base64.b64decode(session.output(0)['data']).decode(errors='replace')

    def wait_for(self, session, expected):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if expected in self.screen(session):
                return
            time.sleep(.05)
        self.fail(f'Missing {expected!r} in {self.screen(session)!r}')

    def run_editor(self, session, name):
        session.send(dict(op='input', data=base64.b64encode(f'printf before > {name}; "$EDITOR" {name}; echo "exit-$?"\n'.encode()).decode()))
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            listed = self.edits.pending(None, 0)['edits']
            if listed:
                return listed[0]
            time.sleep(.05)
        self.fail(f'No edit reached the page: {self.screen(session)!r}')

    def test_editor_in_a_pane_waits_for_the_page_and_writes_what_it_saved(self):
        self.edits.pending(None, 0)
        session = self.manager.launch(dict(cwd=self.temp.name, argv=['/bin/sh'], name='Editor pane'))
        edit = self.run_editor(session, 'prompt.md')
        self.assertEqual((edit['terminal_id'], edit['name'], edit['text']), (session.id, 'prompt.md', 'before'))
        self.wait_for(session, 'Editing in Agent Desk')
        self.edits.finish(edit['id'], 'written in the page\nsecond line')
        self.wait_for(session, 'exit-0')
        self.assertEqual((Path(self.temp.name) / 'prompt.md').read_text(), 'written in the page\nsecond line')

    def test_cancel_leaves_the_file_alone(self):
        self.edits.pending(None, 0)
        session = self.manager.launch(dict(cwd=self.temp.name, argv=['/bin/sh'], name='Editor pane'))
        edit = self.run_editor(session, 'keep.md')
        self.edits.finish(edit['id'], None)
        self.wait_for(session, 'exit-0')
        self.assertEqual((Path(self.temp.name) / 'keep.md').read_text(), 'before')

    def test_file_routes_are_for_the_page_only(self):
        session = self.manager.launch(dict(cwd=self.temp.name, argv=['/bin/sh'], name='Editor pane'))
        (Path(self.temp.name) / 'a.txt').write_text('hello')
        def call(route, payload, token):
            request = Request(self.manager.desk + route, data=json.dumps(payload).encode(),
                              headers={'X-Agent-Desk-Terminal': token, 'Content-Type': 'application/json'})
            with urlopen(request, timeout=5) as response:
                return json.load(response)
        self.assertEqual(call('/api/files/read', dict(id=session.id, path='a.txt'), server.TERMINAL_TOKEN)['text'], 'hello')
        with self.assertRaises(HTTPError) as caught:
            call('/api/files/read', dict(id=session.id, path='a.txt'), server.HELPER_TOKEN)
        self.assertEqual(caught.exception.code, 403)

    def test_only_the_panes_own_token_opens_an_edit(self):
        self.edits.pending(None, 0)
        session = self.manager.launch(dict(cwd=self.temp.name, argv=['/bin/sh'], name='Editor pane'))
        request = Request(self.manager.desk + '/api/pane-editor/open', data=json.dumps(dict(id=session.id, name='x.md', text='')).encode(),
                          headers={'Authorization': 'Bearer not-the-token', 'Content-Type': 'application/json'})
        with self.assertRaises(HTTPError) as caught:
            urlopen(request, timeout=5)
        self.assertEqual(caught.exception.code, 403)
        self.assertEqual(self.edits.pending(None, 0)['edits'], [])

    def test_a_desktop_desk_takes_the_panes_token_on_its_own_routes_only(self):
        self.http.desktop, self.http.paused = True, False
        self.edits.pending(None, 0)
        session = self.manager.launch(dict(cwd=self.temp.name, argv=['/bin/sh'], name='Editor pane'))
        def call(route, payload):
            request = Request(self.manager.desk + route, data=json.dumps(payload).encode(),
                              headers={'Host': 'app', 'Authorization': 'Bearer ' + session.pane_token, 'Content-Type': 'application/json'})
            with urlopen(request, timeout=5) as response:
                return json.load(response)
        edit = call('/api/pane-editor/open', dict(id=session.id, name='desktop.md', text='before'))['id']
        self.assertEqual([row['id'] for row in self.edits.pending(None, 0)['edits']], [edit])
        with self.assertRaises(HTTPError) as caught:
            call('/api/terminals/input', dict(id=session.id, data=''))
        self.assertEqual((caught.exception.code, json.load(caught.exception)['error']), (403, 'Desktop authorization required'))

if __name__ == '__main__':
    unittest.main()
