"""Restoring managed terminals after their supervisor ends: records, capture and relaunch."""
import base64
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen

from agent_desk.terminal_restore import RESTORE_GAP, SessionStore, claude_session, codex_session, plan, restore
from agent_desk.terminals import TerminalManager

ROOT = Path(__file__).resolve().parents[1]
CLAUDE_ID = '11111111-1111-4111-8111-111111111111'
CODEX_ID = '22222222-2222-7222-8222-222222222222'
SUBAGENT_ID = '33333333-3333-7333-8333-333333333333'

# Stand-ins for the CLIs: each records its conversation the way the real one
# does (Claude's per-PID session file, Codex's open rollout file), prints its
# argv, then idles like an agent at its prompt.
FAKE_CLAUDE = '''import json, os, sys, time
args = sys.argv[1:]
sid = args[args.index('--resume') + 1] if '--resume' in args else os.environ['FAKE_SESSION']
folder = os.path.join(os.environ.get('CLAUDE_CONFIG_DIR', os.path.expanduser('~/.claude')), 'sessions')
os.makedirs(folder, exist_ok=True)
with open(os.path.join(folder, f'{os.getpid()}.json'), 'w') as f:
    json.dump(dict(pid=os.getpid(), sessionId=sid, startedAt=int(time.time() * 1000), kind='interactive'), f)
print('ARGV ' + json.dumps(args), flush=True)
sys.stdin.read()
'''
FAKE_CODEX = '''import json, os, sys
args = sys.argv[1:]
sid = args[args.index('resume') + 1] if 'resume' in args else os.environ['FAKE_SESSION']
folder = os.path.join(os.environ['FAKE_CODEX_HOME'], 'sessions', '2026', '10', '04')
os.makedirs(folder, exist_ok=True)
def rollout(identity, source):
    f = open(os.path.join(folder, f'rollout-2026-10-04T21-00-00-{identity}.jsonl'), 'a')
    f.write(json.dumps(dict(type='session_meta', payload=dict(id=identity, thread_source=source))) + '\\n')
    f.flush()
    return f
held = [rollout(sid, 'user'), rollout(os.environ['FAKE_SUBAGENT'], 'subagent')]
print('ARGV ' + json.dumps(args), flush=True)
sys.stdin.read()
'''


def wait(check, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(.05)
    raise AssertionError('Timed out waiting for terminal restore fixture')


def text(session, cursor=0):
    return base64.b64decode(session.output(cursor)['data']).decode(errors='replace')


def send(session, value):
    session.send({'op': 'input', 'data': base64.b64encode(value.encode()).decode()})


class RestoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='desk-restore-')
        self.root = Path(self.temp.name).resolve()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for name, source in (('claude', FAKE_CLAUDE), ('codex', FAKE_CODEX)):
            path = self.bin / name
            path.write_text(f'#!{sys.executable}\n' + source)
            path.chmod(0o755)
        self.env = patch.dict(os.environ, PATH=f'{self.bin}{os.pathsep}{os.environ["PATH"]}', SHELL='/bin/sh',
                              CLAUDE_CONFIG_DIR=str(self.root / 'claude-config'), FAKE_CODEX_HOME=str(self.root / 'codex-home'),
                              FAKE_SUBAGENT=SUBAGENT_ID)
        self.env.start()
        self.store = SessionStore(self.root / 'terminal-sessions-4399.json')
        self.managers = []

    def tearDown(self):
        for manager in self.managers:
            manager.close()
        self.env.stop()
        self.temp.cleanup()

    def manager(self):
        manager = TerminalManager(store=self.store)
        self.managers.append(manager)
        return manager

    def launch(self, manager, argv, **extra):
        return manager.launch(dict(cwd=str(self.root), argv=argv, name='Fixture', launch_profile=None, **extra))

    def records(self):
        return {r['id']: r for r in self.store.load()}

    def test_records_follow_running_restorable_terminals_only(self):
        manager = self.manager()
        shell, command, worker = (self.launch(manager, ['/bin/sh']) for _ in range(3))
        shell.rename('My shell')
        manager.persist()
        self.assertEqual(self.records()[shell.id]['display_name'], 'My shell')
        # A coordinator's worker belongs to the coordinator runtime's recovery.
        manager.external_parents.add('coordinator-fixture')
        worker.parent_id = 'coordinator-fixture'
        manager.persist()
        self.assertEqual(set(self.records()), {shell.id, command.id})
        # Explicit stops and natural exits are never restored.
        command.stop()
        self.assertEqual(set(self.records()), {shell.id})
        send(shell, 'exit\n')
        wait(lambda: shell.process.poll() is not None and not self.records())
        # Supervisor teardown is not a user stop; its terminals stay recorded.
        survivor = self.launch(manager, ['/bin/sh'])
        manager.close()
        self.assertIsNotNone(survivor.process.poll())
        self.assertEqual(set(self.records()), {survivor.id})

    def test_restore_reuses_ids_resets_readers_and_never_reruns_commands(self):
        manager = self.manager()
        parent = self.launch(manager, ['/bin/sh'])
        child = self.launch(manager, ['/bin/sh'], parent_id=parent.id)
        marker = self.root / 'ran'
        command = self.launch(manager, [sys.executable, '-c', f'open({str(marker)!r}, "a").write("x"); import time; time.sleep(60)'])
        child.rename('Renamed child')
        manager.persist()
        wait(marker.exists)
        send(parent, "printf 'before-%s\\n' restart\n")
        wait(lambda: 'before-restart' in text(parent))
        old_cursor = parent.output(0)['cursor']
        manager.close()

        replacement = self.manager()
        restored = {r['id']: r['detail'] for r in restore(replacement, self.store)}
        self.assertEqual(set(restored), {parent.id, child.id, command.id})
        self.assertEqual(restored[parent.id], 'started a new shell in the same folder')
        self.assertTrue(restored[command.id].startswith('started a shell instead of re-running '), restored[command.id])
        self.assertEqual(marker.read_text(), 'x')
        again = replacement.get(child.id)
        self.assertEqual(again.info()['display_name'], 'Renamed child')
        self.assertEqual(again.parent_id, parent.id)
        self.assertEqual(again.info()['restored']['detail'], restored[child.id])
        shell = replacement.get(parent.id)
        self.assertIsNone(shell.process.poll())
        # A reader holding the old process's cursor is told to reset.
        gap = shell.output(old_cursor)
        self.assertTrue(gap['truncated'])
        self.assertEqual(shell.origin, RESTORE_GAP)
        self.assertIn('Agent Desk restored this terminal after a restart', text(shell, RESTORE_GAP))
        send(shell, "printf 'after-%s\\n' restart\n")
        wait(lambda: 'after-restart' in text(shell, RESTORE_GAP))
        self.assertEqual(set(self.records()), {parent.id, child.id, command.id})
        # A second restore moves past the first restored process too.
        replacement.close()
        third = self.manager()
        restore(third, self.store)
        self.assertEqual(third.get(parent.id).origin, 2 * RESTORE_GAP)

    def test_desktop_stop_checkpoints_exact_conversations_before_process_exit(self):
        from agent_desk.terminal_supervisor import SupervisorClient
        for cli, native in [('claude', CLAUDE_ID), ('codex', CODEX_ID)]:
            with patch.dict(os.environ, FAKE_SESSION=native):
                data = self.root / cli
                client = SupervisorClient(data, 4398)
                try:
                    agent = client.launch(dict(cwd=str(self.root), argv=[cli], name='Fictional saved agent', launch_profile=None))
                    wait(lambda: 'ARGV' in text(agent))
                    client.shutdown(for_restart=True)
                    records = SessionStore(data / 'terminal-sessions-4398.json').load()
                    self.assertEqual([r['id'] for r in records], [agent.id])
                    self.assertEqual(records[0]['native_session'], native)
                    client = SupervisorClient(data, 4398)
                    resumed = client.get(agent.id)
                    wait(lambda: 'ARGV' in text(resumed, RESTORE_GAP))
                    self.assertEqual(resumed.info()['restored']['native_session'], native)
                    self.assertIn(native, text(resumed, RESTORE_GAP))
                finally:
                    for row in client.list():client.get(row['id']).stop()
                    client.shutdown()

    def test_desktop_checkpoint_failure_keeps_sessions_running_and_allows_retry(self):
        from agent_desk.terminal_supervisor import Handler, SupervisorClient, SupervisorServer, write_message
        manager=self.manager()
        with patch.dict(os.environ,FAKE_SESSION=CODEX_ID):
            agent=self.launch(manager,['codex'])
        wait(lambda:'ARGV' in text(agent))
        server=SupervisorServer(str(self.root/'rpc.sock'),Handler)
        server.token='fixture-token';server.manager=manager;server.draining=False;server.lifecycle_lock=threading.Lock()
        thread=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.01},daemon=True);thread.start()
        client=SupervisorClient.__new__(SupervisorClient);client.folder=self.root;client.token=server.token
        try:
            failures=[('capture_conversations',OSError('Fictional capture failure')),
                      ('capture_conversations',subprocess.TimeoutExpired('fixture capture',10)),
                      ('persist',OSError('Fictional storage failure'))]
            for method,error in failures:
                with self.subTest(method=method,error=type(error).__name__),patch.object(manager,method,side_effect=error),patch('agent_desk.managed_processes.OwnedProcesses') as owned:
                    with self.assertRaisesRegex((OSError,ValueError),'capture|storage'):
                        client.shutdown(for_restart=True)
                    owned.return_value.stop.assert_not_called()
                self.assertFalse(manager.closing);self.assertFalse(server.draining)
                self.assertIsNone(agent.process.poll())
                self.assertEqual(client.get(agent.id).process.pid,agent.process.pid)
            def lose_checkpoint_reply(stream,value):
                if value=={'result':None}:raise BrokenPipeError('Fictional checkpoint reply failure')
                write_message(stream,value)
            with patch('agent_desk.terminal_supervisor.write_message',side_effect=lose_checkpoint_reply),patch('agent_desk.managed_processes.OwnedProcesses') as owned:
                with self.assertRaisesRegex(OSError,'checkpoint reply failure'):client.shutdown(for_restart=True)
                owned.return_value.stop.assert_not_called()
            self.assertFalse(manager.closing);self.assertFalse(server.draining)
            self.assertEqual(client.get(agent.id).process.pid,agent.process.pid)
            # A retry must checkpoint the original live conversation before teardown.
            with patch('agent_desk.managed_processes.OwnedProcesses') as owned:
                owned.return_value.remaining.return_value=[]
                client.shutdown(for_restart=True)
            thread.join(timeout=5);self.assertFalse(thread.is_alive())
            self.assertEqual(self.records()[agent.id]['native_session'],CODEX_ID)
            self.assertTrue(manager.closing)
        finally:
            server.shutdown();server.server_close();thread.join(timeout=5)

    def test_claude_terminal_resumes_its_exact_conversation(self):
        manager = self.manager()
        with patch.dict(os.environ, FAKE_SESSION=CLAUDE_ID):
            agent = self.launch(manager, ['claude', '--continue', '--model', 'opus'])
            wait(lambda: 'ARGV' in text(agent))
            observed = manager.capture_conversations({Path(os.environ['CLAUDE_CONFIG_DIR'])})
        self.assertEqual(observed, {agent.id: CLAUDE_ID})
        self.assertEqual(self.records()[agent.id]['native_session'], CLAUDE_ID)
        manager.close()
        replacement = self.manager()
        self.assertEqual(restore(replacement, self.store), [dict(id=agent.id, detail=f'resumed Claude conversation {CLAUDE_ID}')])
        resumed = replacement.get(agent.id)
        wait(lambda: 'ARGV' in text(resumed, RESTORE_GAP))
        self.assertIn(json.dumps(['--model', 'opus', '--resume', CLAUDE_ID]), text(resumed, RESTORE_GAP))
        self.assertEqual(resumed.info()['restored']['native_session'], CLAUDE_ID)
        # The resumed process keeps reporting the same conversation.
        self.assertEqual(replacement.capture_conversations({Path(os.environ['CLAUDE_CONFIG_DIR'])}), {agent.id: CLAUDE_ID})

    def test_codex_terminal_resumes_its_own_rollout_not_a_subagent(self):
        manager = self.manager()
        with patch.dict(os.environ, FAKE_SESSION=CODEX_ID):
            agent = self.launch(manager, ['codex'])
            wait(lambda: 'ARGV' in text(agent))
            self.assertEqual(manager.capture_conversations(set()), {agent.id: CODEX_ID})
        manager.close()
        replacement = self.manager()
        restore(replacement, self.store)
        resumed = replacement.get(agent.id)
        wait(lambda: 'ARGV' in text(resumed, RESTORE_GAP))
        # The worker keeps interactive Codex in its pane with --no-daemon.
        self.assertIn(json.dumps(['--no-daemon', 'resume', CODEX_ID]), text(resumed, RESTORE_GAP))

    def test_agent_that_exited_to_its_shell_is_restored_as_a_shell(self):
        from agent_desk.standalone_agent import launch_payload
        manager = self.manager()
        # The claude profile drops CLAUDE_CONFIG_DIR, so the agent uses HOME/.claude.
        with patch.dict(os.environ, HOME=str(self.root), FAKE_SESSION=CLAUDE_ID):
            agent = manager.launch(launch_payload(dict(cwd=str(self.root), argv=['claude'], name='Claude')))
            self.assertEqual(agent.launch_profile, 'claude')
            wait(lambda: 'ARGV' in text(agent))
            self.assertEqual(manager.capture_conversations({self.root / '.claude'}), {agent.id: CLAUDE_ID})
            send(agent, '\x04')
            wait(lambda: 'Shell ready' in text(agent) and self.records()[agent.id]['agent_exited'])
            manager.close()
            [result] = restore(self.manager(), self.store)
        self.assertEqual(result['detail'], 'Claude had exited, so this is a new shell in the same folder')

    def test_opencode_and_pi_relaunch_as_new_sessions(self):
        for cli, label in (('opencode', 'OpenCode'), ('pi', 'Pi')):
            item = dict(id='terminal-0000000000000003', name=label, display_name=None, cwd=str(self.root),
                        argv=[cli], launch_profile=None, parent_id=None, created=1, origin=0, native_session=None)
            payload, resumed, detail = plan(item)
            self.assertEqual((payload['argv'], resumed), ([cli], False))
            self.assertEqual(detail, label + ' conversations are not recorded, so this is a new session')

    def test_agent_without_a_conversation_starts_new_and_unrecorded_folder_falls_back(self):
        item = dict(id='terminal-0000000000000001', name='Codex', display_name=None, cwd=str(self.root),
                    argv=[str(self.bin / 'codex')], launch_profile=None, parent_id=None, created=1, origin=0, native_session=None)
        payload, resumed, detail = plan(item)
        self.assertFalse(resumed)
        self.assertEqual(payload['argv'], item['argv'])
        self.assertEqual(detail, 'no Codex conversation had started, so this is a new session')
        gone = dict(item, id='terminal-0000000000000002', cwd=str(self.root / 'deleted'), argv=['/bin/sh'])
        self.store.save([gone])
        manager = self.manager()
        [result] = restore(manager, self.store)
        self.assertIn('could not relaunch (Choose an existing absolute working directory); started a shell in ' + str(Path.home()), result['detail'])
        self.assertEqual(manager.get(gone['id']).cwd, str(Path.home()))

    def test_unreadable_record_is_kept_aside_not_discarded(self):
        self.store.path.write_text('{not json')
        self.assertEqual(self.store.load(), [])
        [kept] = self.root.glob('terminal-sessions-4399.unreadable-*.json')
        self.assertEqual(kept.read_text(), '{not json')

    def test_capture_rejects_stale_and_ambiguous_evidence(self):
        folder = self.root / 'claude-config'
        (folder / 'sessions').mkdir(parents=True)
        now = time.time()
        def session_file(pid, identity, started, kind='interactive'):
            (folder / 'sessions' / f'{pid}.json').write_text(json.dumps(dict(sessionId=identity, startedAt=int(started * 1000), kind=kind)))
        session_file(101, 'stale', now - 3600)
        self.assertIsNone(claude_session({101: (1, now)}, {folder}))
        session_file(101, 'fresh', now)
        session_file(102, 'nested', now)
        self.assertEqual(claude_session({101: (1, now), 102: (2, now)}, {folder}), 'fresh')
        session_file(103, 'sibling', now)
        self.assertIsNone(claude_session({101: (1, now), 103: (1, now)}, {folder}))
        session_file(104, 'print-mode', now, kind='print')
        self.assertIsNone(claude_session({104: (1, now)}, {folder}))
        self.assertIsNone(codex_session({201: (1, now)}, {201: ['/tmp/notes.jsonl']}))


class BackendRestoreTests(unittest.TestCase):
    def test_reboot_restores_terminals_through_the_real_backend(self):
        """Kill the backend and the supervisor (with its terminals), as a reboot does."""
        from agent_desk.terminal_supervisor import SupervisorClient
        with tempfile.TemporaryDirectory(prefix='desk-reboot-') as directory:
            root = Path(directory).resolve()
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            (bin_dir / 'claude').write_text(f'#!{sys.executable}\n' + FAKE_CLAUDE)
            (bin_dir / 'claude').chmod(0o755)
            with socket.socket() as port_socket:
                port_socket.bind(('127.0.0.1', 0))
                port = port_socket.getsockname()[1]
            base = f'http://127.0.0.1:{port}'
            # The claude profile unsets CLAUDE_CONFIG_DIR for the agent, so it
            # writes HOME/.claude like a default install; use a private HOME.
            env = dict(os.environ, AGENT_DESK_DATA_DIR=str(root), PATH=f'{bin_dir}{os.pathsep}{os.environ["PATH"]}',
                       HOME=str(root), FAKE_SESSION=CLAUDE_ID, SHELL='/bin/sh')
            env.pop('CLAUDE_CONFIG_DIR', None)
            log = (root / 'server.log').open('ab')
            process, token = None, None

            def api(route, payload=None):
                headers = {'X-Agent-Desk-Terminal': token or '', 'Content-Type': 'application/json'}
                data = json.dumps(payload).encode() if payload is not None else None
                with urlopen(Request(base + route, data=data, headers=headers), timeout=5) as response:
                    return json.load(response)

            def boot():
                nonlocal process, token
                process = subprocess.Popen([sys.executable, '-m', 'agent_desk', '--port', str(port)], cwd=ROOT, env=env,
                                           stdin=subprocess.DEVNULL, stdout=log, stderr=log)
                def ready():
                    nonlocal token
                    if process.poll() is not None:
                        raise AssertionError((root / 'server.log').read_text())
                    try:
                        with urlopen(base + '/config.js', timeout=5):
                            pass
                        token = (Path(env['AGENT_DESK_DATA_DIR']) / f'.terminal-token-{port}').read_text().strip()
                        return True
                    except OSError:
                        return False
                wait(ready)

            def output(identity, cursor=0):
                return base64.b64decode(api(f'/api/terminals/output?id={identity}&cursor={cursor}')['data']).decode(errors='replace')

            def agent(identity):
                return next(a for a in api('/api/agents')['agents'] if a['id'] == identity)

            records = root / f'terminal-sessions-{port}.json'
            try:
                boot()
                shell = api('/api/terminals/launch', dict(cwd=str(root), argv=['/bin/sh'], name='Shell'))
                # Like the UI, launch the standalone agent path (profile inferred, shell-on-exit wrapper).
                claude = api('/api/terminals/launch', dict(cwd=str(root), argv=['claude'], name='Claude'))
                api('/api/terminals/rename', {'id': claude['id'], 'name': 'Reviewer'})
                wait(lambda: 'ARGV' in output(claude['id']))
                # The supervisor samples conversations every few seconds.
                wait(lambda: any(r.get('native_session') == CLAUDE_ID for r in json.loads(records.read_text())['sessions']), 20)
                owner = SupervisorClient(root, port, start=False).call('hello')['pid']
                client = SupervisorClient(root, port, start=False)
                old = {s['id']: client.get(s['id']).process.pid for s in client.list()}
                os.kill(owner, signal.SIGKILL)
                process.send_signal(signal.SIGKILL)
                process.wait(10)
                def gone(pid):
                    try:
                        os.kill(pid, 0)
                        return False
                    except ProcessLookupError:
                        return True
                wait(lambda: gone(owner) and all(gone(pid) for pid in old.values()))

                boot()
                restored = agent(claude['id'])
                self.assertIsNone(restored['exit_code'])
                self.assertEqual(restored['display_name'], 'Reviewer')
                self.assertEqual(restored['restored'], dict(detail=f'resumed Claude conversation {CLAUDE_ID}', native_session=CLAUDE_ID))
                self.assertIsNone(agent(shell['id'])['exit_code'])
                wait(lambda: 'ARGV' in output(claude['id'], RESTORE_GAP))
                screen = output(claude['id'], RESTORE_GAP)
                self.assertIn(f'resumed Claude conversation {CLAUDE_ID}', screen)
                self.assertIn(json.dumps(['--resume', CLAUDE_ID]), screen)
                api('/api/terminals/input', dict(id=shell['id'], data=base64.b64encode(b"printf 'alive-%s\\n' again\n").decode()))
                wait(lambda: 'alive-again' in output(shell['id'], RESTORE_GAP))
                self.assertNotEqual(SupervisorClient(root, port, start=False).get(shell['id']).process.pid, old[shell['id']])
            finally:
                if process is not None and process.poll() is None:
                    process.send_signal(signal.SIGINT)
                    process.wait(15)
                try:
                    client = SupervisorClient(root, port, start=False)
                    for session in client.list():
                        client.get(session['id']).stop()
                    client.shutdown()
                    wait(lambda: not (client.folder / 'rpc.sock').exists())
                except (OSError, ValueError):
                    pass
                log.close()


if __name__ == '__main__':
    unittest.main()
