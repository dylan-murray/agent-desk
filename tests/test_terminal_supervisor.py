"""Real detached PTYs, private RPC, and backend crash/restart acceptance tests."""
import base64
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.request import Request, urlopen

from agent_desk.terminal_supervisor import SupervisorClient, VERSION, read_message, write_message, location
from agent_desk.worker_screen import WorkerNotReady

ROOT = Path(__file__).resolve().parents[1]


def wait(check, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(.05)
    raise AssertionError('Timed out waiting for terminal/restart fixture')


def text(session):
    return base64.b64decode(session.output(0)['data']).decode(errors='replace')


def send(session, value):
    session.send({'op': 'input', 'data': base64.b64encode(value.encode()).decode()})


class SupervisorTests(unittest.TestCase):
    def test_attach_two_existing_owners_routes_without_restarting_either(self):
        from agent_desk.terminal_owners import TerminalOwners
        from unittest.mock import patch
        other=SupervisorClient(self.root/'old',4323)
        first=self.launch()
        second=other.launch(dict(cwd=str(self.root),argv=['/bin/sh'],name='Recovered fixture'))
        try:
            owners=[self.client.call('hello')['pid'],other.call('hello')['pid']]
            with patch('agent_desk.terminal_owners.legacy_location',return_value=other.folder):
                attached=TerminalOwners.attach(self.root,4322,start=False)
            self.assertEqual({s['id'] for s in attached.list()},{first.id,second.id})
            self.assertEqual(attached.get(second.id).process.pid,second.process.pid)
            send(attached.get(second.id),"printf 'recovered-%s\\n' owner\n")
            wait(lambda:'recovered-owner' in text(second))
            self.assertNotIn('recovered-owner',text(first))
            attached.external_parents.add('coordinator-recovered')
            attached.get(second.id).parent_id='coordinator-recovered'
            self.assertEqual(second.parent_id,'coordinator-recovered')
            attached.close()
            self.assertIsNone(first.process.poll());self.assertIsNone(second.process.poll())
            self.assertEqual([self.client.call('hello')['pid'],other.call('hello')['pid']],owners)
        finally:
            second.stop();other.shutdown()
            wait(lambda:not (other.folder/'rpc.sock').exists())

    def test_short_workspace_uses_durable_supervisor_directory(self):
        root=Path('/tmp/desk-short-root')
        self.assertEqual(location(root,4310),root.resolve()/'.supervisor-4310')
        self.assertEqual(location('/'+('long-folder/'*12),4310).parent,Path.home()/'.agent-desk-supervisors')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='desk-supervisor-')
        self.root = Path(self.temp.name)
        self.client = SupervisorClient(self.root, 4322)

    def tearDown(self):
        try:
            for item in self.client.list():
                self.client.get(item['id']).stop()
            self.client.shutdown()
            wait(lambda: not (self.client.folder / 'rpc.sock').exists())
        finally:
            self.temp.cleanup()

    def launch(self, argv=None, **extra):
        return self.client.launch(dict(cwd=str(self.root), argv=argv or ['/bin/sh'], name='Persistent shell', **extra))

    def test_detach_preserves_process_metadata_output_input_and_explicit_stop(self):
        session = self.launch()
        session.rename('My surviving agent')
        self.client.external_parents.add('coordinator-fixture')
        session.parent_id = 'coordinator-fixture'
        session.send(dict(op='resize', cols=93, rows=29))
        send(session, "stty size; printf 'before-%s\\n' detach\n")
        wait(lambda: 'before-detach' in text(session))
        self.assertIn('29 93', text(session))
        pid, identity = session.process.pid, session.id
        cursor = session.output(0)['cursor']
        self.client.close()
        replacement = SupervisorClient(self.root, 4322)
        resumed = replacement.get(identity)
        self.assertEqual(resumed.process.pid, pid)
        self.assertIsNone(resumed.process.poll())
        self.assertEqual(resumed.info()['display_name'], 'My surviving agent')
        self.assertEqual(resumed.parent_id, 'coordinator-fixture')
        self.assertIn(pid, replacement.child_pids())
        send(resumed, "printf 'after-%s\\n' detach\n")
        wait(lambda: 'after-detach' in text(resumed))
        self.assertGreater(resumed.output(cursor)['cursor'], cursor)
        with self.assertRaisesRegex(ValueError, 'running sessions'):
            replacement.shutdown()
        refused = subprocess.run([sys.executable, '-m', 'agent_desk.terminal_supervisor',
                                  '--data-dir', str(self.root), '--port', '4322', '--shutdown'],
                                 cwd=ROOT, capture_output=True, text=True, timeout=5)
        self.assertEqual(refused.returncode, 1)
        self.assertIn('stop them explicitly', refused.stderr)
        self.assertNotIn('Traceback', refused.stderr)
        resumed.stop()
        self.assertIsNotNone(resumed.process.poll())
        self.assertIn('after-detach', text(resumed))

    def test_authentication_protocol_and_workspace_isolation(self):
        original = self.client.token
        self.client.token = 'wrong'
        with self.assertRaisesRegex(ValueError, 'authentication'):
            self.client.list()
        self.client.token = original
        with socket.socket(socket.AF_UNIX) as connection:
            connection.connect(str(self.client.folder / 'rpc.sock'))
            with connection.makefile('rwb') as stream:
                write_message(stream, dict(token=original, version=VERSION + 1, op='hello'))
                self.assertIn('Incompatible', read_message(stream)['error'])
        self.assertEqual(self.client.folder.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.client.folder / 'token').stat().st_mode & 0o777, 0o600)
        other = SupervisorClient(self.root, 4323)
        try:
            session = self.launch()
            self.assertEqual(other.list(), [])
            with self.assertRaisesRegex(ValueError, 'not found'):
                other.get(session.id)
        finally:
            other.shutdown()
            wait(lambda: not (other.folder / 'rpc.sock').exists())

    def test_concurrent_clients_reuse_one_owner_and_replay_is_bounded(self):
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=4) as pool:
            clients = list(pool.map(lambda _: SupervisorClient(self.root, 4322), range(4)))
        self.assertEqual(len({c.call('hello')['pid'] for c in clients}), 1)
        script = self.root / 'output.py'
        script.write_text("import os,time\nos.write(1,b'x'*(2200000)+b'BUFFER_END')\ntime.sleep(30)\n")
        session = self.launch([sys.executable, str(script)])
        wait(lambda: session.start > 0)
        wait(lambda: session.buffer.endswith(b'BUFFER_END'))
        self.assertEqual(len(session.buffer), 2 * 1024 * 1024)
        output = clients[0].get(session.id).output(0)
        self.assertTrue(output['truncated'])
        self.assertLessEqual(len(base64.b64decode(output['data'])), 131072)
        self.assertEqual(clients[1].get(session.id).process.pid, session.process.pid)

    def test_coordinator_recovery_keeps_live_worker_and_does_not_replay_action(self):
        from agent_desk.coordinator_runtime import CoordinatorRuntime
        from scripts.control_mailbox import Mailbox
        box = Mailbox(self.root / 'mail.sqlite3')
        path = self.root / 'coordinator.sqlite3'
        runtime = CoordinatorRuntime(path, self.client, box, lambda *args: dict(message='', actions=[]))
        coordinator = runtime.create(dict(cwd=str(self.root), name='Recovery fixture', profile='claude'))
        session = self.launch(parent_id=coordinator['id'])
        runtime.remember_worker(session)
        with runtime.db() as db:
            db.execute('INSERT INTO turns VALUES(?,?,?,?,?)', ('interrupted-turn', coordinator['id'], 'running', 0, time.time()))
            db.execute('INSERT INTO actions VALUES(?,?,?,?,?,?,?,?)', ('uncertain-action', coordinator['id'], 'launch', '{}', 'running', session.id, None, 'Starting'))
        runtime.close()
        replacement = CoordinatorRuntime(path, SupervisorClient(self.root, 4322), box, lambda *args: dict(message='', actions=[]))
        try:
            replacement.start()
            self.assertEqual(replacement.saved_workers(), [])
            self.assertEqual(replacement.terminals.get(session.id).process.pid, session.process.pid)
            self.assertIsNone(session.process.poll())
            with replacement.db() as db:
                self.assertEqual(db.execute("SELECT state FROM actions WHERE id='uncertain-action'").fetchone()[0], 'uncertain')
                self.assertEqual(db.execute("SELECT state FROM turns WHERE id='interrupted-turn'").fetchone()[0], 'interrupted')
            self.assertEqual(len(self.client.list()), 1)
        finally:
            replacement.close()

    def test_codex_placeholder_feedback_delivers_through_real_supervisor(self):
        from agent_desk.coordinator_runtime import CoordinatorRuntime
        from scripts.control_mailbox import Mailbox
        from agent_desk.feedback_delivery import submit_feedback,drain_feedback,feedback_status
        script=self.root/'codex_prompt.py'
        script.write_text("import os,tty,time\ntty.setraw(0)\ntime.sleep(.4)\nos.write(1,'\\x1b[?2004h› \\x1b[2mAsk Codex to do anything\\x1b[0m\\r\\x1b[3G'.encode())\nwhile True:\n data=os.read(0,65536)\n with open('received','ab') as f:f.write(data)\n")
        session=self.launch([sys.executable,str(script)],launch_profile='codex')
        runtime=CoordinatorRuntime(self.root/'coord.sqlite3',self.client,Mailbox(self.root/'mail.sqlite3'),lambda *args:None)
        try:
            result=submit_feedback(runtime,{'target_id':session.id,'request_id':'fixture-delivery','notes':[{'id':'pin','note':'Fix spacing'}]})
            self.assertTrue(result.get('queued'))
            def delivered():
                drain_feedback(runtime)
                return (self.root/'received').exists()
            wait(delivered)
            self.assertEqual(feedback_status(runtime,{})['submissions'][0]['state'],'sent')
            raw=(self.root/'received').read_bytes();self.assertEqual(raw.count(b'Submission: fixture-delivery'),1)
            drain_feedback(runtime);self.assertEqual((self.root/'received').read_bytes(),raw)
        finally:runtime.close()

    def test_task_reservation_failure_disconnect_and_success(self):
        # Fictional CLI with a real PTY and a recognizable empty Claude prompt.
        script = self.root / 'prompt.py'
        script.write_text("import os,tty\ntty.setraw(0)\nos.write(1, '\\x1b[?2004h❯ '.encode())\nwhile True:\n data=os.read(0,65536)\n with open('received','ab') as f:f.write(data)\n")
        session = self.launch([sys.executable, str(script)], launch_profile='claude')
        wait(lambda: '❯' in text(session))
        time.sleep(.4)  # The screen observer requires a stable empty prompt.
        def refuse():
            raise ValueError('Reservation refused')
        with self.assertRaisesRegex(ValueError, 'Reservation refused'):
            session.send_task('must not arrive', before_send=refuse)
        time.sleep(.1)
        self.assertFalse((self.root / 'received').exists())
        # Backend disappears while the supervisor waits for durable intent.
        with socket.socket(socket.AF_UNIX) as connection:
            connection.connect(str(self.client.folder / 'rpc.sock'))
            with connection.makefile('rwb') as stream:
                write_message(stream, dict(token=self.client.token, version=VERSION, op='send_task', id=session.id, text='also must not arrive'))
                self.assertTrue(read_message(stream)['reserve'])
        time.sleep(.1)
        self.assertFalse((self.root / 'received').exists())
        reservations = []
        session.send_task('exactly once', before_send=lambda: reservations.append(True))
        # The fixture creates the file before writing; wait for its contents.
        wait(lambda: (self.root / 'received').exists() and (self.root / 'received').read_bytes())
        self.assertEqual(reservations, [True])
        self.assertEqual((self.root / 'received').read_bytes(), b'\x1b[200~exactly once\x1b[201~\r')
        with self.assertRaises(WorkerNotReady):
            session.send_task('do not inject into busy prompt')


class BackendRestartTests(unittest.TestCase):
    def test_same_terminal_and_workflow_survive_graceful_restart_and_sigkill(self):
        with tempfile.TemporaryDirectory(prefix='desk-restart-') as directory:
            root = Path(directory)
            with socket.socket() as port_socket:
                port_socket.bind(('127.0.0.1', 0))
                port = port_socket.getsockname()[1]
            base = f'http://127.0.0.1:{port}'
            process = None
            client = None
            log = (root / 'server.log').open('ab')
            env = dict(os.environ, AGENT_DESK_DATA_DIR=directory)
            token = None
            def api(route, payload=None):
                headers = {'X-Agent-Desk-Terminal': token or '', 'Content-Type': 'application/json'}
                with urlopen(Request(base + route, data=json.dumps(payload).encode() if payload is not None else None, headers=headers), timeout=3) as response:
                    return json.load(response)
            def boot():
                nonlocal process, token
                process = subprocess.Popen([sys.executable, '-m', 'agent_desk', '--port', str(port), *(['--attach-only'] if client else [])], cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
                def ready():
                    nonlocal token
                    if process.poll() is not None:
                        raise AssertionError((root / 'server.log').read_text())
                    try:urlopen(base + '/config.js', timeout=3).close();token = (Path(directory) / f'.terminal-token-{port}').read_text().strip();return True
                    except OSError:return False
                wait(ready)
            def halt(sig):
                process.send_signal(sig)
                process.wait(15)
            try:
                boot()
                client = SupervisorClient(root, port)
                session = api('/api/terminals/launch', dict(cwd=directory, argv=['/bin/sh'], name='Restart survivor'))
                terminal = client.get(session['id'])
                pid = terminal.process.pid
                api('/api/terminals/rename', {'id': terminal.id, 'name': 'Preserved name'})
                send(terminal, "echo $$ > shell.pid; printf 'first-%s\\n' marker\n")
                wait(lambda: 'first-marker' in text(terminal))
                shell_pid = (root / 'shell.pid').read_text()
                # A detached workflow worker also continues, and a replacement
                # scheduler must not launch it twice or overlap its configuration.
                worker = root / 'workflow.py'
                worker.write_text("from pathlib import Path\nimport time\np=Path(__file__).parent\nwith (p/'runs').open('a') as f:f.write('started\\n')\nwhile not (p/'release').exists():time.sleep(.05)\nprint('workflow survived')\n")
                config = api('/api/workflows/save-config', dict(name='Restart worker', kind='command', cwd=directory, argv=[sys.executable, str(worker)], timeout=60))
                rule = api('/api/workflows/save', dict(name='Restart flow', trigger='manual', nodes=[dict(id='task', config_id=config['id'], depends_on=[])]))
                api('/api/workflows/run', {'id': rule['id']})
                wait(lambda: (root / 'runs').exists())
                for sig in (signal.SIGINT, signal.SIGKILL):
                    halt(sig)
                    send(terminal, "echo $$ > shell.pid; printf 'offline-%s\\n' " + str(sig) + "\n")
                    wait(lambda: f'offline-{sig}' in text(terminal))
                    self.assertEqual((root / 'shell.pid').read_text(), shell_pid)
                    boot()
                    restored = next(a for a in api('/api/agents')['agents'] if a['id'] == terminal.id)
                    self.assertEqual(restored['display_name'], 'Preserved name')
                    self.assertIsNone(restored['exit_code'])
                    self.assertEqual(client.get(terminal.id).process.pid, pid)
                    api('/api/terminals/input', dict(id=terminal.id, data=base64.b64encode(b"printf 'online-%s\\n' again\n").decode()))
                    wait(lambda: 'online-again' in text(terminal))
                    state = api('/api/workflows')
                    self.assertEqual(len([r for r in state['executions'] if r['config_id'] == config['id']]), 1)
                (root / 'release').touch()
                wait(lambda: any(r['config_id'] == config['id'] and r['state'] == 'succeeded' for r in api('/api/workflows')['executions']))
                self.assertEqual((root / 'runs').read_text(), 'started\n')
                api('/api/terminals/stop', {'id': terminal.id})
                self.assertIsNotNone(terminal.process.poll())
                print('Observed backend SIGINT and SIGKILL: same terminal ID/PID, offline output recovered, input works, workflow started once.')
            finally:
                (root / 'release').touch()
                if process is not None and process.poll() is None:
                    halt(signal.SIGINT)
                if client:
                    for session in client.list():client.get(session['id']).stop()
                    client.shutdown()
                    wait(lambda: not (client.folder / 'rpc.sock').exists())
                log.close()


if __name__ == '__main__':
    unittest.main()
