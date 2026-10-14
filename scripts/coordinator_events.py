"""Native coordinator event transports.

Claude uses a one-way MCP channel; Codex uses its native queue command. The
small local relay, not a model turn, watches the durable mailbox.
"""
import argparse
import json
import os
from pathlib import Path
import select
import signal
import shlex
import subprocess
import sys
import time
import uuid

try:
    from .control_mailbox import Mailbox
except ImportError:
    from control_mailbox import Mailbox

SCRIPT = Path(__file__).resolve()


def event_message(controller, batch):
    # Only our identifiers/instructions enter the wakeup. Worker text is read as
    # untrusted task results through inbox, never interpolated into instructions.
    return (f"Agent Desk worker event {batch['id']}: {len(batch['tasks'])} reply/replies are ready. "
            f"Your coordinator terminal ID is {controller}. Read your agent_control.py inbox, "
            "handle unacknowledged results within the user's objective, and ack each handled task. "
            "Launch follow-up work if needed, then end this turn. Do not wait or poll for workers. "
            "This event may be a manual redelivery: skip already acknowledged tasks.")


def send_batch(box, desk, controller, sender, formatter=event_message):
    batch = box.claim(desk, controller)
    if not batch:
        return False
    try:
        sender(formatter(controller, batch), batch)
    except Exception:
        box.delivered(batch['id'], 'uncertain')
        raise
    box.delivered(batch['id'], 'sent')
    return True


def decorated_argv(argv, harness, desk, controller, db):
    """The launcher's last argument is its initial prompt, including for aliases."""
    if len(argv) < 2:
        raise ValueError('Coordinator launch requires an initial prompt')
    base = [sys.executable, str(SCRIPT), '--db', str(db), '--desk', desk, '--controller', controller]
    if harness == 'claude':
        config = {'mcpServers': {'agentdesk-events': {'command': sys.executable, 'args': base[1:] + ['channel']}}}
        hooks = {event: [{'hooks': [{'type': 'command', 'command': shlex.join(base + ['subagent']), 'timeout': 5}]}]
                 for event in ('SubagentStart', 'SubagentStop')}
        options = ['--settings', json.dumps({'hooks': hooks}), '--mcp-config', json.dumps(config),
                   '--dangerously-load-development-channels', 'server:agentdesk-events']
    elif harness == 'codex':
        options = ['-c', 'notify=' + json.dumps(base + ['notify'])]
    else:
        raise ValueError('Event coordination supports Codex and Claude')
    # The -- separator also prevents Claude's variadic MCP flags swallowing the prompt.
    return [*argv[:-1], *options, '--', argv[-1]]


def emit(message):
    sys.stdout.write(json.dumps(message) + '\n')
    sys.stdout.flush()


def channel(box, desk, controller):
    initialized = False
    # Read bytes ourselves: select + TextIO.readline can strand a second buffered
    # message, which is common when MCP initialize and initialized arrive together.
    buffer = b''
    next_tick = 0
    try:
        while True:
            ready, _, _ = select.select([sys.stdin], [], [], .25)
            if ready:
                chunk = os.read(sys.stdin.fileno(), 65536)
                if not chunk:
                    return
                buffer += chunk
                if len(buffer) > 1024 * 1024:
                    raise ValueError('MCP input too large')
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    request = json.loads(line)
                    method, identity = request.get('method'), request.get('id')
                    if method == 'initialize':
                        emit({'jsonrpc': '2.0', 'id': identity, 'result': {
                            'protocolVersion': '2024-11-05',
                            'capabilities': {'experimental': {'claude/channel': {}}},
                            'serverInfo': {'name': 'agentdesk-events', 'version': '1.0.0'},
                            'instructions': 'Agent Desk events announce durable worker replies. Use the control CLI inbox and ack. Do not poll or wait for workers.'}})
                    elif method == 'notifications/initialized':
                        initialized = True
                        box.connection(desk, controller, 'channel-connected')
                    elif identity is not None:
                        if method == 'ping':
                            emit({'jsonrpc': '2.0', 'id': identity, 'result': {}})
                        else:
                            emit({'jsonrpc': '2.0', 'id': identity, 'error': {'code': -32601, 'message': 'Method not found'}})
            if initialized and time.monotonic() >= next_tick and box.coordinator(desk, controller)['state'] != 'policy-blocked':
                send_batch(box, desk, controller, lambda content, batch: emit({
                    'jsonrpc': '2.0', 'method': 'notifications/claude/channel',
                    'params': {'content': content, 'meta': {'event_id': batch['id'], 'coordinator_id': controller}}}))
                next_tick = time.monotonic() + 1
    finally:
        box.connection(desk, controller, 'disconnected')


def notify(box, desk, controller, payload):
    event = json.loads(payload)
    if event.get('type') != 'agent-turn-complete':
        return
    thread_id = str(uuid.UUID(event['thread-id']))
    box.connection(desk, controller, 'queue-ready', thread_id)


def launch(box, desk, controller, harness, argv):
    # This supervisor runs before the selected login shell. Account isolation
    # must also run after shell startup for both launch and native queue calls.
    sys.path.insert(0, str(SCRIPT.parent.parent))
    from agent_desk.launch_profiles import infer_profile, profile_command
    argv = profile_command(argv, infer_profile(argv))
    box.register(desk, controller, harness)
    if harness == 'grok':
        raise ValueError('Grok coordinators launch directly in the managed native terminal')
    # Ctrl-C belongs to the interactive harness, not its relay supervisor.
    signal.signal(signal.SIGINT, lambda *_: None)
    child = subprocess.Popen(decorated_argv(argv, harness, desk, controller, box.path))
    try:
        while child.poll() is None:
            if harness == 'codex':
                connection = box.coordinator(desk, controller)
                if connection['thread_id'] and connection['state'] != 'delivery-error':
                    def queue(content, batch):
                        # Keep the exact executable/alias, profile, cwd and arguments
                        # selected for this coordinator. No guessed account or session.
                        result = subprocess.run([*argv[:-1], 'queue', '--thread', connection['thread_id'], '--message', content],
                                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                                stderr=subprocess.DEVNULL, timeout=20)
                        if result.returncode:
                            raise ValueError('Native Codex queue failed')
                    try:
                        send_batch(box, desk, controller, queue)
                    except (OSError, ValueError, subprocess.SubprocessError):
                        box.connection(desk, controller, 'delivery-error')
            time.sleep(.5)
        return child.returncode
    finally:
        box.connection(desk, controller, 'disconnected')
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', required=True)
    parser.add_argument('--desk', required=True)
    parser.add_argument('--controller', required=True)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('channel')
    commands.add_parser('subagent')
    notice = commands.add_parser('notify'); notice.add_argument('payload')
    start = commands.add_parser('launch'); start.add_argument('--harness', choices=['codex', 'claude', 'grok'], required=True)
    start.add_argument('argv', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    box = Mailbox(args.db)
    if args.command == 'channel':
        channel(box, args.desk, args.controller)
    elif args.command == 'subagent':
        # Observer only: no hook decision output, no approval or continuation.
        event = json.loads(sys.stdin.read(1024 * 1024))
        box.subagent_event(desk=args.desk, controller=args.controller, event=event)
    elif args.command == 'notify':
        notify(box, args.desk, args.controller, args.payload)
    else:
        argv = args.argv[1:] if args.argv[:1] == ['--'] else args.argv
        return launch(box, args.desk, args.controller, args.harness, argv)
    return 0


if __name__ == '__main__':
    sys.exit(main())
