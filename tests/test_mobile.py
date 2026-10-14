"""`agent-desk attach` and `agent-desk mobile`: the iOS app's view of a running desk, over its loopback API."""
import base64
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_desk import accounts, desk_tokens, mobile, pane_guard, server, websocket
from agent_desk.desks import Desks
from agent_desk.terminals import TerminalManager

ROOT = Path(__file__).resolve().parents[1]
APPROVAL = 'printf "Do you want to proceed?\\n\\342\\235\\257 1. Yes\\n  2. No\\n"; sleep 30'


class ClientFramingTests(unittest.TestCase):
    def pair(self):
        ours, theirs = socket.socketpair()
        self.addCleanup(ours.close)
        self.addCleanup(theirs.close)
        client = websocket.WebSocket(ours.makefile('rb'), ours.makefile('wb', buffering=0), client=True)
        peer = websocket.WebSocket(theirs.makefile('rb'), theirs.makefile('wb', buffering=0))
        return client, peer

    def test_client_masks_what_it_sends_and_reads_unmasked_replies(self):
        client, peer = self.pair()
        payload = 'x' * 70000
        threading.Thread(target=client.send_text, args=(payload,), daemon=True).start()
        self.assertEqual(peer.receive(), payload)
        threading.Thread(target=peer.send_text, args=('ok ✓',), daemon=True).start()
        self.assertEqual(client.receive(), 'ok ✓')

    def test_client_refuses_masked_frames_from_a_server(self):
        client, peer = self.pair()
        # A server must never mask; a client WebSocket pretending to be one does.
        impostor = websocket.WebSocket(peer.rfile, peer.wfile, client=True)
        impostor.send_text('masked')
        with self.assertRaises(websocket.Closed):
            client.receive()


class DeskTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.http.server_port

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.manager = TerminalManager()
        for target, name, value in ((server, 'TERMINALS', server.DeskTerminals(self.manager)),
                                    (server, 'DESKS', Desks(Path(self.temp.name) / 'desks.json')),
                                    (accounts, 'ACCOUNTS_FILE', Path(self.temp.name) / 'accounts.json'),
                                    (server, 'PROTECTED_PANES', pane_guard.ProtectedPanes(Path(self.temp.name) / 'protected.json'))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        # These commands are local helpers: they use the token the desk writes for them, never the page's.
        desk_tokens.write_token('terminal', self.port, server.HELPER_TOKEN, data_dir=self.temp.name)
        self.desk = mobile.Desk(self.port, data_dir=self.temp.name)

    def tearDown(self):
        self.manager.close()
        self.temp.cleanup()

    def launch(self, *argv):
        return self.manager.launch(dict(cwd=self.temp.name, argv=list(argv), name='Phone shell'))

    def attach(self, identity, keys, attachment=None):
        """Run an attachment over pipes, as mosh-server would over its PTY, typing `keys` into it."""
        stdin_read, stdin_write = os.pipe()
        stdout_read, stdout_write = os.pipe()
        attachment = attachment or mobile.Attachment(self.desk, identity, stdin_read, stdout_write)
        attachment.stdin, attachment.stdout = stdin_read, stdout_write
        received = bytearray()

        def drain():
            while chunk := os.read(stdout_read, 65536):
                received.extend(chunk)

        reader = threading.Thread(target=drain, daemon=True)
        reader.start()

        def type_keys():
            time.sleep(.5)
            os.write(stdin_write, keys)

        threading.Thread(target=type_keys, daemon=True).start()
        code = attachment.run()
        os.close(stdout_write)
        reader.join(5)
        for fd in (stdin_read, stdin_write, stdout_read):
            os.close(fd)
        return code, bytes(received)

    def test_attach_relays_keys_and_output_until_the_terminal_exits(self):
        session = self.launch('/bin/sh')
        code, received = self.attach(session.id, b'echo attach-$((6*7))\nexit 3\n')
        self.assertEqual(code, 0)
        self.assertIn(b'attach-42', received)
        self.assertIn(b'[Agent Desk: this terminal exited with code 3]', received)
        # The pane's own history has the same bytes, so the browser sees what the phone typed.
        replay = base64.b64decode(self.manager.output(session.id, 0)['data'])
        self.assertIn(b'attach-42', replay)

    def test_attach_reconnects_when_the_stream_drops(self):
        session = self.launch('/bin/sh')
        real, calls = self.desk.stream, []

        def flaky():
            # Connects, then the desk restarts once: the second attempt fails, the third succeeds.
            calls.append(1)
            if len(calls) == 2:
                raise mobile.DeskError('restarting')
            socket = real()
            if len(calls) == 1:
                threading.Timer(.8, socket.close).start()
            return socket

        attachment = mobile.Attachment(self.desk, session.id)
        with patch.object(self.desk, 'stream', flaky):
            code, received = self.attach(session.id, b'sleep 1.5; echo back-$((40+2)); exit\n', attachment)
        self.assertEqual((code, len(calls)), (0, 3))
        self.assertIn(b'back-42', received)

    def test_attach_polls_remote_panes_like_the_browser(self):
        identity, sent = 'remote:node-1:terminal-r', []

        class RemoteDesk:
            def request(self, path, body=None):
                sent.append((path, body))
                if not path.startswith('/api/terminals/output'):
                    return {'ok': True}
                if path.endswith('cursor=0'):
                    return dict(data=base64.b64encode(b'remote hello').decode(), cursor=12, exit_code=None)
                # The remote shell exits once it has been sent its input.
                typed = any(p == '/api/terminals/input' for p, _ in sent)
                return dict(data='', cursor=12, exit_code=0 if typed else None)

        code, received = self.attach(identity, b'ls\n', mobile.Attachment(RemoteDesk(), identity))
        self.assertEqual(code, 0)
        self.assertTrue(received.startswith(b'remote hello'))
        self.assertIn(('/api/terminals/output?id=remote%3Anode-1%3Aterminal-r&cursor=12', None), sent)
        self.assertIn(('/api/terminals/input', dict(id=identity, data=base64.b64encode(b'ls\n').decode())), sent)

    def test_attach_explains_an_unknown_terminal(self):
        code, received = self.attach('terminal-missing', b'')
        self.assertEqual(code, 1)
        self.assertIn(b'[Agent Desk: Terminal not found]', received)

    def printed(self, session, text, seconds=10):
        """Waits until the pane has printed `text`: a just-launched shell may not have yet."""
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if text in base64.b64decode(self.manager.output(session.id, 0)['data']):
                return
            time.sleep(.05)
        self.fail(f'{session.id} never printed {text!r}')

    def test_watch_reads_approval_prompts_from_the_terminal_screen(self):
        approval = self.launch('/bin/sh', '-c', APPROVAL)
        quiet = self.launch('/bin/sh', '-c', 'sleep 30')
        self.printed(approval, b'2. No')
        out = io.StringIO()
        mobile.Watch(self.desk, out).run(once=True)
        snapshot = json.loads(out.getvalue())
        self.assertEqual((snapshot['type'], snapshot['protocol'], snapshot['ready']), ('snapshot', mobile.PROTOCOL, True))
        sessions = {s['id']: s for s in snapshot['sessions']}
        self.assertEqual((sessions[approval.id]['status'], sessions[approval.id]['question']), ('needs_input', 'Do you want to proceed?'))
        self.assertEqual((sessions[quiet.id]['status'], sessions[quiet.id]['question']), ('quiet', None))
        self.assertEqual(sessions[quiet.id]['desk'], 'main')
        self.assertEqual(snapshot['desks'], [dict(id='main', name='Main')])

    def test_watch_streams_changes_then_heartbeats(self):
        out = io.StringIO()
        watch = mobile.Watch(self.desk, out)
        with patch.object(mobile, 'HEARTBEAT', 0), patch.object(mobile, 'REFRESH', .2):
            thread = threading.Thread(target=watch.run, daemon=True)
            thread.start()
            time.sleep(1)
            session = self.launch('/bin/sh', '-c', 'sleep 30')
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and session.id not in out.getvalue():
                time.sleep(.1)
            time.sleep(.6)
            watch.stop()
            thread.join(5)
        lines = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual(lines[0]['sessions'], [])
        self.assertTrue(any(s['id'] == session.id for line in lines if line['type'] == 'snapshot' for s in line['sessions']))
        self.assertIn('heartbeat', [line['type'] for line in lines])

    def launched(self, request):
        """What `launch` asks the desk to start, without starting it."""
        sent, real = [], self.desk.request

        def request_to(path, body=None):
            if path != '/api/terminals/launch':
                return real(path, body)
            sent.append(body)
            return {'id': 'terminal-new'}

        with patch.object(self.desk, 'request', request_to):
            result = mobile.launch(self.desk, request)
        self.assertEqual(result, dict(type='launched', session={'id': 'terminal-new'}))
        return sent

    def test_launch_builds_the_same_command_as_the_browser_dialog(self):
        sent = self.launched(dict(choice='claude', cwd=self.temp.name, desk='main', prompt='fix the build'))
        self.assertEqual(sent, [dict(cwd=self.temp.name, name='Claude', launch_profile='claude', desk='main',
                                     argv=['/bin/zsh', '-lic', 'claude "$@"', 'agent-desk', 'fix the build'])])
        # Agents without accounts launch directly, with no profile.
        sent = self.launched(dict(choice='grok', cwd=self.temp.name))
        self.assertEqual(sent, [dict(cwd=self.temp.name, name='Grok', launch_profile=None, argv=['grok'])])

    def test_added_accounts_launch_from_the_phone_as_from_the_browser(self):
        accounts.ACCOUNTS_FILE.write_text(json.dumps([dict(id='claude-2', harness='claude', name='Personal', config_dir='~/.claude-personal')]))
        self.assertIn(dict(key='claude-2', label='Claude · Personal', harness='claude'), mobile.info(self.desk)['launch_choices'])
        sent = self.launched(dict(choice='claude-2', cwd=self.temp.name))
        # The account's key is its profile; the desk turns it into the CLI with that config folder.
        self.assertEqual(sent, [dict(cwd=self.temp.name, name='Claude · Personal', launch_profile='claude-2',
                                     argv=['/bin/zsh', '-lic', 'claude-2 "$@"', 'agent-desk'])])

    def test_launch_starts_a_real_pane_and_refuses_bad_requests(self):
        result = mobile.launch(self.desk, dict(choice='shell', cwd=self.temp.name, desk='main'))
        self.assertEqual(result['session']['cwd'], self.temp.name)
        self.assertIn(result['session']['id'], {s['id'] for s in self.manager.list()})
        for request, error in ((dict(choice='custom', cwd=self.temp.name), 'Choose one of'),
                               (dict(choice='shell', cwd='relative'), 'existing project folder'),
                               (dict(choice='shell', cwd=self.temp.name, prompt='hi'), 'needs a coding agent'),
                               ([], 'Expected a JSON object')):
            with self.subTest(error=error), self.assertRaisesRegex(mobile.DeskError, error):
                mobile.launch(self.desk, request)

    def test_protected_panes_stay_at_the_desk(self):
        session = self.launch('/bin/sh', '-c', APPROVAL)
        self.printed(session, b'2. No')
        server.PROTECTED_PANES.set(session.id, True)
        code, received = self.attach(session.id, b'')
        self.assertEqual(code, 1)
        self.assertIn(b'[Agent Desk: This session is protected: only the user, at the desk, can read or type into it]', received)
        out = io.StringIO()
        mobile.Watch(self.desk, out).run(once=True)
        snapshot = json.loads(out.getvalue())
        record = next(s for s in snapshot['sessions'] if s['id'] == session.id)
        # Listed, so the phone can say why it cannot open it, but its screen is never read.
        self.assertEqual((snapshot['ready'], record['protected'], record['question']), (True, True, None))

    def test_a_missing_token_is_explained(self):
        desk = mobile.Desk(self.port, data_dir=Path(self.temp.name) / 'elsewhere')
        with self.assertRaisesRegex(mobile.DeskError, f'Agent Desk on port {self.port} has not written its helper token to '):
            desk.request('/api/agents')

    def test_info_lists_desks_launch_choices_and_projects(self):
        value = mobile.info(self.desk)
        self.assertEqual((value['type'], value['protocol'], value['port']), ('info', mobile.PROTOCOL, self.port))
        self.assertIn(dict(key='claude', label='Claude', harness='claude'), value['launch_choices'])
        self.assertNotIn('custom', [c['key'] for c in value['launch_choices']])
        self.assertIsInstance(value['projects'], list)


class CommandTests(unittest.TestCase):
    def run_agent_desk(self, *args):
        env = {k: v for k, v in os.environ.items() if not k.startswith('AGENT_DESK_')}
        env['PYTHONPATH'] = str(ROOT)
        probe = ('import sys,runpy\nsys.argv=["agent-desk",*sys.argv[1:]]\n'
                 'try:runpy.run_module("agent_desk",run_name="__main__")\n'
                 'except SystemExit as e:print("exit",e.code,"server" if "agent_desk.server" in sys.modules else "client",file=sys.stderr)')
        # An open, silent stdin, as mosh-server's terminal is: attach exits when stdin closes.
        stdin, keep_open = os.pipe()
        try:
            return subprocess.run([sys.executable, '-c', probe, *args], stdin=stdin, capture_output=True, text=True, env=env, timeout=30)
        finally:
            os.close(stdin)
            os.close(keep_open)

    def test_client_commands_report_a_missing_desk_without_loading_the_server(self):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        result = self.run_agent_desk('mobile', '--port', str(port), 'info')
        self.assertEqual(json.loads(result.stdout), dict(type='error', protocol=mobile.PROTOCOL,
                                                         message=f'Agent Desk is not running on port {port}. Start it with: agent-desk --port {port}'))
        self.assertEqual(result.stderr.strip(), 'exit 1 client')
        result = self.run_agent_desk('attach', '--port', str(port), 'terminal-x')
        self.assertIn(f'[Agent Desk: Agent Desk is not running on port {port}.', result.stdout)
        self.assertEqual(result.stderr.strip(), 'exit 1 client')


if __name__ == '__main__':
    unittest.main()
