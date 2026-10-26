"""The terminal WebSocket: framing, authentication, streamed output and input, and the supervisor wait behind it."""
import base64
import hashlib
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from agent_desk import pane_guard, server, websocket
from agent_desk.terminal_owners import TerminalOwners
from agent_desk.terminal_supervisor import SupervisorClient
from agent_desk.terminals import TerminalManager


def encode(value):
    return base64.b64encode(value.encode()).decode()


class Client:
    """A minimal browser-side WebSocket: masked frames, as RFC 6455 requires of clients."""

    def __init__(self, port, origin=None):
        self.sock = socket.create_connection(('127.0.0.1', port), timeout=10)
        self.key = base64.b64encode(os.urandom(16)).decode()
        lines = ['GET /api/terminals/stream HTTP/1.1', f'Host: 127.0.0.1:{port}', 'Upgrade: websocket',
                 'Connection: Upgrade', f'Sec-WebSocket-Key: {self.key}', 'Sec-WebSocket-Version: 13']
        if origin:
            lines.append('Origin: ' + origin)
        self.sock.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode())
        self.file = self.sock.makefile('rb')
        self.status = int(self.file.readline().split()[1])
        self.headers = {}
        while (line := self.file.readline().decode().strip()):
            name, value = line.split(':', 1)
            self.headers[name.lower()] = value.strip()

    def frame(self, payload, opcode=websocket.TEXT, final=True, masked=True):
        size = len(payload)
        header = bytes([(0x80 if final else 0) | opcode])
        flag = 0x80 if masked else 0
        header += (bytes([flag | size]) if size < 126 else struct.pack('!BH', flag | 126, size) if size < 65536
                   else struct.pack('!BQ', flag | 127, size))
        mask = os.urandom(4) if masked else b''
        self.sock.sendall(header + mask + (websocket.unmask(payload, mask) if masked else payload))

    def send(self, **message):
        self.frame(json.dumps(message).encode())

    def read_frame(self):
        first, second = self.file.read(2)
        length = second & 0x7F
        if length == 126:
            length = struct.unpack('!H', self.file.read(2))[0]
        elif length == 127:
            length = struct.unpack('!Q', self.file.read(8))[0]
        return first & 0x0F, self.file.read(length)

    def receive(self):
        opcode, payload = self.read_frame()
        if opcode == websocket.CLOSE:
            return dict(type='closed', code=struct.unpack('!H', payload[:2])[0])
        return json.loads(payload)

    def until(self, check, timeout=5):
        deadline, seen = time.monotonic() + timeout, []
        self.sock.settimeout(timeout)
        while time.monotonic() < deadline:
            message = self.receive()
            seen.append(message)
            if check(message, seen):
                return seen
        raise AssertionError(f'Timed out; received {seen!r}')

    def close(self):
        self.sock.close()


def text(messages):
    return b''.join(base64.b64decode(m['data']) for m in messages if m.get('type') == 'output').decode(errors='replace')


class FramingTests(unittest.TestCase):
    def setUp(self):
        self.ws, self.peer = self.pair()

    def pair(self):
        ours, theirs = socket.socketpair()
        self.addCleanup(ours.close)
        self.addCleanup(theirs.close)
        peer = SimpleNamespace(sock=theirs, file=theirs.makefile('rb'))
        peer.frame = lambda *a, **k: Client.frame(peer, *a, **k)
        peer.read_frame = lambda: Client.read_frame(peer)
        return websocket.WebSocket(ours.makefile('rb'), ours.makefile('wb', buffering=0)), peer

    def test_fragments_are_joined_and_pings_answered_in_between(self):
        self.peer.frame(b'hel', final=False)
        self.peer.frame(b'are you there', opcode=websocket.PING)
        self.peer.frame(b'lo \xe2\x9c\x93', opcode=0)
        self.assertEqual(self.ws.receive(), 'hello ✓')
        self.assertEqual(self.peer.read_frame(), (websocket.PONG, b'are you there'))

    def test_large_messages_round_trip(self):
        payload = 'x' * 70000
        # Larger than a socket buffer, so each side writes while the other reads.
        threading.Thread(target=self.peer.frame, args=(payload.encode(),), daemon=True).start()
        self.assertEqual(self.ws.receive(), payload)
        threading.Thread(target=self.ws.send_text, args=(payload,), daemon=True).start()
        self.assertEqual(self.peer.read_frame(), (websocket.TEXT, payload.encode()))

    def test_protocol_violations_close_with_the_matching_code(self):
        for frame, code in ((dict(payload=b'{}', masked=False), 1002), (dict(payload=b'\x00', opcode=websocket.BINARY), 1003),
                            (dict(payload=b'\xff'), 1007)):
            with self.subTest(code=code):
                ws, peer = self.pair()
                peer.frame(**frame)
                with self.assertRaises(websocket.Closed):
                    ws.receive()
                opcode, payload = peer.read_frame()
                self.assertEqual((opcode, struct.unpack('!H', payload[:2])[0]), (websocket.CLOSE, code))
                with self.assertRaises(websocket.Closed):
                    ws.send_text('after close')

    def test_oversized_message_is_refused_before_it_is_read(self):
        self.peer.sock.sendall(bytes([0x81, 0x80 | 127]) + struct.pack('!Q', websocket.MAX_MESSAGE + 1))
        with self.assertRaises(websocket.Closed):
            self.ws.receive()
        opcode, payload = self.peer.read_frame()
        self.assertEqual(struct.unpack('!H', payload[:2])[0], 1009)

    def test_peer_close_is_answered(self):
        self.peer.frame(struct.pack('!H', 1001), opcode=websocket.CLOSE)
        with self.assertRaises(websocket.Closed):
            self.ws.receive()
        self.assertEqual(self.peer.read_frame()[0], websocket.CLOSE)


class StreamTests(unittest.TestCase):
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
        self.patch = patch.object(server, 'TERMINALS', self.manager)
        self.patch.start()
        self.clients = []

    def tearDown(self):
        for client in self.clients:
            client.close()
        self.patch.stop()
        self.manager.close()
        self.temp.cleanup()

    def connect(self, authenticate=True, **extra):
        client = Client(self.port, **extra)
        self.clients.append(client)
        if authenticate:
            self.assertEqual(client.status, 101)
            client.send(type='auth', token=server.TERMINAL_TOKEN)
        return client

    def launch(self, argv=('/bin/sh',)):
        return self.manager.launch(dict(cwd=self.temp.name, argv=list(argv), name='Streamed shell'))

    def test_handshake_requires_an_upgrade_a_local_origin_and_the_token_first(self):
        from urllib.error import HTTPError
        from urllib.request import urlopen
        with self.assertRaises(HTTPError) as caught:
            urlopen(f'http://127.0.0.1:{self.port}/api/terminals/stream')
        self.assertEqual(caught.exception.code, 426)
        caught.exception.close()
        self.assertEqual(self.connect(False, origin='https://evil.example').status, 403)
        client = self.connect(False, origin=f'http://127.0.0.1:{self.port}')
        expected = base64.b64encode(hashlib.sha1((client.key + websocket.GUID).encode()).digest()).decode()
        self.assertEqual((client.status, client.headers['sec-websocket-accept']), (101, expected))
        session = self.launch()
        client.send(type='subscribe', sub='1', id=session.id, cursor=0)
        self.assertEqual(client.receive(), dict(type='closed', code=1008))
        wrong = self.connect(False)
        wrong.send(type='auth', token='guess')
        self.assertEqual(wrong.receive(), dict(type='closed', code=1008))

    def test_output_input_resize_and_exit_flow_over_one_socket(self):
        session = self.launch()
        client = self.connect()
        client.send(type='subscribe', sub='1', id=session.id, cursor=0)
        # Replay first, then one empty reply marks the pane as caught up.
        client.until(lambda m, _: m['type'] == 'output' and not m['data'])
        client.send(type='resize', id=session.id, cols=91, rows=27)
        started = time.monotonic()
        client.send(type='input', id=session.id, data=encode("stty size; printf 'streamed-%s\\n' ok\n"))
        seen = client.until(lambda _, s: 'streamed-ok' in text(s))
        # No polling interval: output is pushed as soon as the supervisor reads it.
        self.assertLess(time.monotonic() - started, 2)
        self.assertIn('27 91', text(seen))
        self.assertTrue(all(m['sub'] == '1' and m['id'] == session.id for m in seen))
        client.send(type='input', id=session.id, data='not base64!')
        self.assertIn('base64', client.until(lambda m, _: m['type'] == 'error')[-1]['message'])
        client.send(type='input', id=session.id, data=encode('exit 3\n'))
        exit_message = client.until(lambda m, _: m['type'] == 'exit')[-1]
        self.assertEqual(exit_message['exit_code'], 3)
        self.assertEqual(exit_message['cursor'], session.start + len(session.buffer))

    def test_reconnecting_from_the_last_cursor_loses_and_repeats_nothing(self):
        script = Path(self.temp.name) / 'count.py'
        script.write_text('import sys,time\nfor i in range(60):\n    print(f"line-{i:03}", flush=True); time.sleep(.02)\ntime.sleep(30)\n')
        session = self.launch([sys.executable, str(script)])
        first = self.connect()
        first.send(type='subscribe', sub='a', id=session.id, cursor=0)
        seen = first.until(lambda _, s: 'line-010' in text(s))
        cursor = [m for m in seen if m['type'] == 'output'][-1]['cursor']
        first.close()
        time.sleep(.3)  # output keeps arriving while no tab is connected
        second = self.connect()
        second.send(type='subscribe', sub='b', id=session.id, cursor=cursor)
        rest = second.until(lambda _, s: 'line-059' in text(s))
        lines = (text(seen) + text(rest)).split()
        self.assertEqual(lines, [f'line-{i:03}' for i in range(60)])

    def test_a_subscriber_that_falls_behind_is_told_when_it_has_caught_up_again(self):
        script = Path(self.temp.name) / 'flood.py'
        script.write_text("import os,sys,time\nsys.stdin.readline()\nos.write(1,b'x'*6000000+b'FLOOD_END')\ntime.sleep(30)\n")
        session = self.launch([sys.executable, str(script)])
        client = self.connect()
        client.send(type='subscribe', sub='1', id=session.id, cursor=0)
        client.until(lambda m, _: m['type'] == 'output' and not m['data'])
        # The tab stops reading while the terminal floods, so the socket backs up and the
        # supervisor's 2 MiB buffer moves past the cursor this subscription was sending from.
        client.send(type='input', id=session.id, data=encode('\n'))
        deadline = time.monotonic() + 15
        while not session.buffer.endswith(b'FLOOD_END') and time.monotonic() < deadline:
            time.sleep(.05)
        seen = client.until(lambda m, s: any(x.get('truncated') for x in s) and m['type'] == 'output' and not m['data'], timeout=20)
        self.assertTrue(text(seen).endswith('FLOOD_END'))

    def test_local_helpers_stream_but_never_reach_protected_panes(self):
        shared, protected = self.launch(), self.launch()
        with patch.object(server, 'PROTECTED_PANES', pane_guard.ProtectedPanes(Path(self.temp.name) / 'protected.json')):
            server.PROTECTED_PANES.set(protected.id, True)
            # A helper such as `agent-desk attach` authenticates with the token from its owner-only file.
            helper = self.connect(False)
            helper.send(type='auth', token=server.HELPER_TOKEN)
            helper.send(type='subscribe', sub='1', id=shared.id, cursor=0)
            helper.until(lambda m, _: m['type'] == 'output' and not m['data'])
            helper.send(type='input', id=shared.id, data=encode("printf 'helper-%s\\n' ok\n"))
            helper.until(lambda _, s: 'helper-ok' in text(s))
            refused = 'This session is protected: only the user, at the desk, can read or type into it'
            helper.send(type='subscribe', sub='2', id=protected.id, cursor=0)
            self.assertEqual(helper.until(lambda m, _: m['type'] == 'error')[-1], dict(type='error', sub='2', id=protected.id, message=refused))
            for kind, fields in (('input', dict(data=encode('echo typed\n'))), ('resize', dict(cols=50, rows=10))):
                helper.send(type=kind, id=protected.id, **fields)
                self.assertEqual(helper.until(lambda m, _: m['type'] == 'error')[-1]['message'], refused)
            # The desk page still reaches every pane.
            page = self.connect()
            page.send(type='subscribe', sub='3', id=protected.id, cursor=0)
            page.until(lambda m, _: m['type'] == 'output' and not m['data'])

    def test_unknown_terminals_and_unsubscribed_panes(self):
        client = self.connect()
        client.send(type='subscribe', sub='1', id='terminal-missing', cursor=0)
        self.assertEqual(client.receive(), dict(type='error', sub='1', id='terminal-missing', message='Terminal not found'))
        session = self.launch()
        client.send(type='subscribe', sub='2', id=session.id, cursor=0)
        client.until(lambda m, _: m['type'] == 'output' and not m['data'])
        client.send(type='unsubscribe', sub='2')
        client.send(type='input', id=session.id, data=encode("printf 'quiet-%s\\n' now\n"))
        deadline = time.monotonic() + 5
        while b'quiet-now' not in session.buffer and time.monotonic() < deadline:
            time.sleep(.03)
        client.sock.settimeout(.5)
        with self.assertRaises(socket.timeout):
            client.receive()


class SessionWaitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.manager = TerminalManager()

    def tearDown(self):
        self.manager.close()
        self.temp.cleanup()

    def test_output_waits_for_bytes_times_out_quietly_and_wakes_on_exit(self):
        session = self.manager.launch(dict(cwd=self.temp.name, argv=['/bin/sh'], name='Waiting shell'))
        time.sleep(.3)
        end = session.output(0)['cursor']
        started = time.monotonic()
        self.assertEqual(self.manager.output(session.id, end, .3)['data'], '')
        self.assertGreaterEqual(time.monotonic() - started, .25)
        threading.Timer(.2, lambda: self.manager.send(session.id, dict(op='input', data=encode('echo woke\n')))).start()
        started = time.monotonic()
        woke = self.manager.output(session.id, end, 10)
        self.assertLess(time.monotonic() - started, 5)
        self.assertNotEqual(woke['data'], '')
        threading.Timer(.2, lambda: self.manager.send(session.id, dict(op='input', data=encode('exit 0\n')))).start()
        cursor = woke['cursor']
        while (result := self.manager.output(session.id, cursor, 10))['exit_code'] is None:
            cursor = result['cursor']
        self.assertEqual(result['exit_code'], 0)


class SupervisorWaitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='desk-stream-')
        self.root = Path(self.temp.name)
        self.client = SupervisorClient(self.root, 4324)

    def tearDown(self):
        try:
            for item in self.client.list():
                self.client.get(item['id']).stop()
            self.client.shutdown()
            deadline = time.monotonic() + 10
            while (self.client.folder / 'rpc.sock').exists() and time.monotonic() < deadline:
                time.sleep(.05)
        finally:
            self.temp.cleanup()

    def record(self):
        calls, call = [], self.client.call
        def recording(operation, **fields):
            calls.append(operation)
            return call(operation, **fields)
        self.client.call = recording
        return calls

    def test_wait_output_is_advertised_and_wakes_on_new_bytes(self):
        self.assertIn('wait_output', self.client.call('hello')['features'])
        session = self.client.launch(dict(cwd=str(self.root), argv=['/bin/sh'], name='Supervised'))
        time.sleep(.3)
        end = self.client.output(session.id, 0)['cursor']
        calls = self.record()
        threading.Timer(.3, lambda: self.client.send(session.id, dict(op='input', data=encode('echo pushed\n')))).start()
        started, received = time.monotonic(), b''
        while b'pushed' not in received:
            result = self.client.output(session.id, end, 10)
            received, end = received + base64.b64decode(result['data']), result['cursor']
        self.assertLess(time.monotonic() - started, 5)
        self.assertIn('wait_output', calls)
        self.assertNotIn('output', calls)

    def test_an_older_supervisor_is_polled_by_the_backend_instead(self):
        session = self.client.launch(dict(cwd=str(self.root), argv=['/bin/sh'], name='Supervised'))
        time.sleep(.3)
        end = self.client.output(session.id, 0)['cursor']
        calls = self.record()
        real = self.client.call
        def older(operation, **fields):
            if operation == 'wait_output':
                raise ValueError('Unknown terminal supervisor operation')
            if operation == 'hello':
                return {key: value for key, value in real(operation, **fields).items() if key != 'features'}
            return real(operation, **fields)
        self.client.call = older
        self.client.features = {'wait_output'}  # learned before a downgrade
        self.assertEqual(self.client.output(session.id, end, .3)['data'], '')
        self.assertEqual(self.client.features, set())
        threading.Timer(.3, lambda: self.client.send(session.id, dict(op='input', data=encode('echo polled\n')))).start()
        received = b''
        while b'polled' not in received:
            result = self.client.output(session.id, end, 10)
            received, end = received + base64.b64decode(result['data']), result['cursor']
        self.assertGreater(calls.count('output'), 1)


class OwnerLookupTests(unittest.TestCase):
    def test_owner_is_listed_once_per_terminal_not_on_every_call(self):
        class Owner:
            def __init__(self, ids):
                self.ids, self.lists = ids, 0
            def list(self):
                self.lists += 1
                return [dict(id=i) for i in self.ids]
            def output(self, identity, cursor, wait=0):
                return dict(owner=self, id=identity)
        first, second = Owner(['a']), Owner(['b'])
        owners = TerminalOwners(first, [second])
        for _ in range(5):
            self.assertIs(owners.output('b', 0)['owner'], second)
            self.assertIs(owners.output('a', 0)['owner'], first)
        self.assertEqual((first.lists, second.lists), (2, 2))
        with self.assertRaisesRegex(ValueError, 'Terminal not found'):
            owners.output('missing', 0)
        single = Owner([])
        self.assertIs(TerminalOwners(single).output('anything', 0)['owner'], single)
        self.assertEqual(single.lists, 0)


class RequestLogTests(unittest.TestCase):
    def test_successful_api_reads_are_not_logged(self):
        handler = server.Handler.__new__(server.Handler)
        logged = []
        handler.log_message = lambda form, *args: logged.append(form % args)
        handler.requestline = 'request'
        for command, path, code in (('GET', '/api/terminals/output?id=x', 200), ('GET', '/api/agents', 200),
                                    ('GET', '/api/terminals/output?id=x', 400), ('POST', '/api/terminals/input', 200),
                                    ('GET', '/index.html', 200)):
            handler.command, handler.path = command, path
            handler.log_request(code)
        self.assertEqual(len(logged), 3)
        self.assertTrue(all('400' in line or '200' in line for line in logged))


if __name__ == '__main__':
    unittest.main()
