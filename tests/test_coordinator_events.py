import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from scripts.control_mailbox import Mailbox
from scripts.coordinator_events import SCRIPT, decorated_argv, notify, send_batch

DESK = 'http://127.0.0.1:4329'
THREAD = '00000000-0000-4000-8000-000000000001'


class CoordinatorEventsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.box = Mailbox(self.root / 'mailbox.sqlite3')
        self.box.register(DESK, 'controller', 'codex')

    def tearDown(self):
        self.tmp.cleanup()

    def reply(self, identity='task-one', controller='controller', desk=DESK):
        self.box.create(desk, controller, 'worker', 'Do the task', identity)
        self.box.reply(desk, identity, 'Done; tests passed', 'completed')

    def test_batched_single_claim_across_concurrent_relays(self):
        self.reply(); self.reply('task-two'); self.reply('foreign', desk='other')
        results = []
        threads = [threading.Thread(target=lambda: results.append(Mailbox(self.box.path).claim(DESK, 'controller'))) for _ in range(6)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        claimed = [r for r in results if r]
        self.assertEqual(len(claimed), 1)
        self.assertEqual(claimed[0]['tasks'], ['task-one', 'task-two'])
        self.assertEqual(self.box.events('other')[0]['delivery'], 'queued')

    def test_notification_is_not_ack_and_crashes_do_not_auto_retry(self):
        self.reply()
        def failed(*args): raise OSError('Ambiguous transport write')
        with self.assertRaises(OSError): send_batch(self.box, DESK, 'controller', failed)
        self.assertEqual(self.box.events(DESK)[0]['delivery'], 'uncertain')
        self.assertIsNone(Mailbox(self.box.path).claim(DESK, 'controller'))
        self.box.retry(DESK, 'task-one', 'controller')
        sent = []
        self.assertTrue(send_batch(self.box, DESK, 'controller', lambda *args: sent.append(args)))
        self.assertNotIn('Done; tests passed', sent[0][0])
        self.assertEqual(self.box.inbox(DESK, 'controller')[0]['acknowledged'], 0)
        self.box.ack(DESK, 'task-one', 'controller')
        self.assertEqual(self.box.inbox(DESK, 'controller'), [])
        with self.assertRaises(ValueError): self.box.retry(DESK, 'task-one', 'controller')
        self.reply('task-two')
        self.box.claim(DESK, 'controller')  # process dies before sending
        self.assertIsNone(Mailbox(self.box.path).claim(DESK, 'controller'))

    def test_subagent_lifecycle_identity_scope_and_lost_parent(self):
        event = {'hook_event_name': 'SubagentStart', 'agent_id': 'worker-1', 'agent_type': 'Explore', 'cwd': str(self.root)}
        self.box.subagent_event(DESK, 'controller', event)
        first = self.box.subagents(DESK, {'controller'})[0]
        self.assertEqual(first['status'], 'working')
        self.assertEqual(first['parent_id'], 'controller')
        self.assertNotIn('terminal_id', first)
        self.assertTrue(first['harness_internal'])
        self.assertEqual(self.box.subagents(DESK, set())[0]['status'], 'unknown')
        self.box.subagent_event(DESK, 'controller', {**event, 'hook_event_name': 'SubagentStop', 'last_assistant_message': 'Found two issues'})
        self.box.subagent_event(DESK, 'controller', event)
        stopped = Mailbox(self.box.path).subagents(DESK, {'controller'})[0]
        self.assertEqual(stopped['status'], 'completed')
        self.assertEqual(stopped['task'], 'Found two issues')
        self.assertEqual(stopped['id'], first['id'])
        self.assertEqual(self.box.subagents('other-desk', {'controller'}), [])
        self.box.register(DESK, 'second', 'claude')
        self.box.subagent_event(DESK, 'second', event)
        self.assertEqual(len({a['id'] for a in self.box.subagents(DESK, {'controller','second'})}), 2)

    def test_real_observer_hook_has_no_decision_output(self):
        argv = decorated_argv(['claude', 'goal'], 'claude', DESK, 'controller', self.box.path)
        hooks = json.loads(argv[argv.index('--settings')+1])['hooks']
        import shlex
        command = shlex.split(hooks['SubagentStart'][0]['hooks'][0]['command'])
        result = subprocess.run(command, input=json.dumps({'hook_event_name':'SubagentStart', 'agent_id':'native-child', 'agent_type':'Explore', 'cwd':str(self.root)}), text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertEqual(self.box.subagents(DESK, {'controller'})[0]['status'], 'working')

    def test_policy_block_cannot_be_mistaken_for_channel_registration(self):
        self.box.connection(DESK, 'controller', 'policy-blocked')
        self.box.connection(DESK, 'controller', 'channel-connected')
        self.assertEqual(self.box.coordinator(DESK, 'controller')['state'], 'policy-blocked')

    def test_terminal_detects_real_policy_warning(self):
        from agent_desk.terminals import TerminalManager
        fixture=self.root/'blocked-claude'
        fixture.write_text('#!'+sys.executable+'\nimport time\nprint("Channels are not enabled for your org",flush=True)\ntime.sleep(20)\n')
        fixture.chmod(0o700)
        manager=TerminalManager()
        try:
            session=manager.launch({'cwd':str(self.root),'argv':[str(fixture),'goal'],'name':'Controller fixture'},coordinator={'harness':'claude','desk':DESK,'db':str(self.box.path)})
            deadline=time.time()+4
            while time.time()<deadline and not session.channel_blocked:time.sleep(.05)
            self.assertTrue(session.channel_blocked)
            self.assertEqual(session.info()['status'],'needs_input')
            self.assertIn('organization policy',session.info()['question'])
            self.assertEqual(self.box.coordinator(DESK,session.id)['state'],'policy-blocked')
        finally:manager.close()

    def test_notify_binds_exact_thread_and_ignores_unrelated_events(self):
        notify(self.box, DESK, 'controller', json.dumps({'type': 'other'}))
        self.assertIsNone(self.box.coordinator(DESK, 'controller')['thread_id'])
        notify(self.box, DESK, 'controller', json.dumps({'type': 'agent-turn-complete', 'thread-id': THREAD}))
        self.assertEqual(self.box.coordinator(DESK, 'controller')['thread_id'], THREAD)
        with self.assertRaises(ValueError):
            notify(self.box, DESK, 'controller', json.dumps({'type': 'agent-turn-complete', 'thread-id': THREAD[:-1]+'2'}))

    def test_launch_preserves_alias_arguments_and_permissions(self):
        argv = ['/bin/zsh', '-lic', 'codex-personal "$@"', 'agent-desk', '-s', 'workspace-write', 'goal with quotes']
        result = decorated_argv(argv, 'codex', DESK, 'controller', self.box.path)
        self.assertEqual(result[:6], argv[:6])
        self.assertEqual(result[-2:], ['--', argv[-1]])
        notice = json.loads(result[-3].removeprefix('notify='))
        self.assertEqual(notice[-1], 'notify')
        claude = decorated_argv(['claude', 'goal'], 'claude', DESK, 'controller', self.box.path)
        self.assertNotIn('--dangerously-skip-permissions', claude)
        config = json.loads(claude[claude.index('--mcp-config')+1])['mcpServers']['agentdesk-events']
        self.assertEqual(config['args'][-1], 'channel')
        self.assertEqual(claude[-2:], ['--', 'goal'])

    def test_real_mcp_transport_waits_for_initialization_and_receives_late_reply(self):
        self.box.register(DESK, 'claude', 'claude')
        command = [sys.executable, str(SCRIPT), '--db', str(self.box.path), '--desk', DESK, '--controller', 'claude', 'channel']
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        try:
            self.assertEqual(select.select([process.stdout], [], [], .2)[0], [])
            process.stdin.write((json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2024-11-05'}})+'\n'+json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'})+'\n').encode())
            self.assertTrue(select.select([process.stdout], [], [], 3)[0])
            initialized = json.loads(process.stdout.readline())
            self.assertEqual(initialized['result']['capabilities'], {'experimental': {'claude/channel': {}}})
            # No permission relay or tools that can approve actions.
            self.reply('claude-task', 'claude')
            self.assertTrue(select.select([process.stdout], [], [], 3)[0])
            event = json.loads(process.stdout.readline())
            self.assertEqual(event['method'], 'notifications/claude/channel')
            self.assertEqual(event['params']['meta']['coordinator_id'], 'claude')
            self.assertEqual(select.select([process.stdout], [], [], 1.1)[0], [])
            self.assertEqual(self.box.inbox(DESK, 'claude')[0]['acknowledged'], 0)
        finally:
            process.stdin.close(); process.wait(3)
            process.stdout.close(); process.stderr.close()
        self.assertEqual(self.box.coordinator(DESK, 'claude')['state'], 'disconnected')

    def test_native_queue_late_reply_without_terminal_input_and_preserves_profile(self):
        fake = self.root/'fake_codex.py'
        output = self.root/'queued.json'
        fake.write_text('''import json, subprocess, sys, time
from pathlib import Path
args=sys.argv[1:]
if 'queue' in args:
    Path(__file__).with_name('queued.json').write_text(json.dumps(args))
else:
    option=next(a for a in args if a.startswith('notify='))
    command=json.loads(option.split('=',1)[1])
    subprocess.run(command+[json.dumps({'type':'agent-turn-complete','thread-id':'00000000-0000-4000-8000-000000000001'})],check=True)
    time.sleep(15)
''')
        argv = [sys.executable, str(fake), '--profile', 'personal', 'objective']
        process = subprocess.Popen([sys.executable, str(SCRIPT), '--db', str(self.box.path), '--desk', DESK,
            '--controller', 'controller', 'launch', '--harness', 'codex', '--', *argv],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
        try:
            deadline = time.time()+4
            while time.time()<deadline and self.box.coordinator(DESK, 'controller')['thread_id'] is None: time.sleep(.05)
            self.assertEqual(self.box.coordinator(DESK, 'controller')['thread_id'], THREAD)
            self.assertFalse(output.exists())
            self.reply()
            deadline = time.time()+4
            while time.time()<deadline and not output.exists(): time.sleep(.05)
            queued = json.loads(output.read_text())
            self.assertEqual(queued[:3], ['--profile', 'personal', 'queue'])
            self.assertEqual(queued[queued.index('--thread')+1], THREAD)
            self.assertNotIn('objective', queued)
            os.kill(process.pid, signal.SIGINT)
            time.sleep(.1)
            self.assertIsNone(process.poll(), 'Ctrl-C must not kill the relay')
        finally:
            os.killpg(process.pid, signal.SIGTERM); process.wait(3); process.stderr.close()


if __name__ == '__main__': unittest.main()
