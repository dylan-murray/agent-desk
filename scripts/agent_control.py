"""Control Agent Desk terminals from a local controller agent. JSON output, stdlib only."""
import argparse
import base64
import json
import os
import re
import shlex
from pathlib import Path
try:
    from .control_mailbox import Mailbox
except ImportError:
    from control_mailbox import Mailbox
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlencode, urlparse
from urllib.request import Request
from agent_desk.local_transport import urlopen, endpoint_key, desk_url


class DeskClient:
    def __init__(self, desk):
        endpoint_key(desk)
        if urlparse(desk).path not in ('', '/') or urlparse(desk).query or urlparse(desk).fragment:
            raise ValueError('Use an Agent Desk workspace address without a path')
        self.desk, self.token = desk_url(endpoint_key(desk)), None

    def request(self, path, payload=None):
        if self.token is None:
            if os.environ.get('AGENT_DESK_REMOTE_NATIVE') == '1':
                from agent_desk.paths import DATA_DIR
                self.token = json.loads((DATA_DIR / 'node.json').read_text())['token']
            else:
                from agent_desk.desk_tokens import read_terminal_token
                self.token = read_terminal_token(self.desk)
        headers = {'X-Agent-Desk-Terminal': self.token, 'Content-Type': 'application/json'}
        # Run from an agent's pane, say which one: the desk then keeps this tool to that pane and its workers.
        if os.environ.get('AGENT_DESK_TERMINAL_ID'):
            headers['X-Agent-Desk-Pane'] = os.environ['AGENT_DESK_TERMINAL_ID']
        request = Request(self.desk + path, data=json.dumps(payload).encode() if payload is not None else None, headers=headers)
        try:
            with urlopen(request, timeout=45 if path.endswith(('/publish-check', '/model-router/launch')) else 15) as response:
                return json.load(response)
        except HTTPError as exc:
            try:
                message = json.load(exc).get('error', 'Agent Desk request failed')
            except (ValueError, AttributeError):
                message = 'Agent Desk request failed'
            finally:
                exc.close()
            raise ValueError(message) from None

    def agents(self):
        return [dict(agent, controllable=bool(agent.get('terminal_id')),
                     controller=agent.get('name', '').startswith('Controller · '))
                for agent in self.request('/api/agents')['agents']]

    def terminal(self, identity):
        agent = next((agent for agent in self.agents() if agent['id'] == identity), None)
        if agent and agent.get('harness_internal'):
            raise ValueError('This is a harness-internal subagent. Use its parent terminal; it has no independent input.')
        if not agent or not agent['controllable']:
            raise ValueError('Choose a managed terminal ID from list; external sessions must be resumed in Agent Desk')
        return agent

    def read(self, identity, tail=16000, cursor=None):
        self.terminal(identity)
        if cursor is None:
            end = self.request('/api/terminals/output?' + urlencode({'id': identity, 'cursor': 2**53-1}))['cursor']
            cursor = max(0, end - tail)
        output = self.request('/api/terminals/output?' + urlencode({'id': identity, 'cursor': cursor}))
        raw = base64.b64decode(output.pop('data')).decode('utf-8', errors='replace')
        # This is a transcript, not a screen snapshot. Strip controls without executing them.
        text = re.sub(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)', '', raw)
        text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
        text = re.sub(r'\x1b[@-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
        return dict(output, id=identity, text=text, format='terminal transcript; redraws may repeat text')

    def input(self, identity, data):
        return self.request('/api/terminals/input', {'id': identity, 'data': base64.b64encode(data).decode()})

    def send(self, identity, text, submit=False):
        self.terminal(identity)
        if any(ord(c) < 32 and c not in '\n\t' for c in text):
            raise ValueError('Use key for terminal control characters')
        data = text.encode()
        if not data or len(data) > 16000:
            raise ValueError('Send 1–16000 UTF-8 bytes at a time')
        self.input(identity, b'\x1b[200~' + data + b'\x1b[201~')
        if submit:
            time.sleep(.15)
            try:
                self.input(identity, b'\r')
            except (ValueError, OSError):
                raise ValueError('Text was sent, but Enter failed. Inspect the terminal before retrying.') from None
        return {'id': identity, 'sent': True, 'submitted': submit}

    def dispatch(self, identity, controller, text, task_id=None, mailbox=None):
        if identity == controller:
            raise ValueError('A controller cannot delegate a task to itself')
        for target in (identity, controller):
            if self.terminal(target).get('exit_code') is not None:
                raise ValueError('Both controller and worker must be running')
        if not text.strip() or len(text.encode()) > 12000:
            raise ValueError('Task must contain 1–12000 UTF-8 bytes')
        mailbox = mailbox or Mailbox()
        task, created = mailbox.create(self.desk, controller, identity, text, task_id)
        if not created:
            return dict(task=task, resent=False, next_action='Inspect existing task; dispatch is never retried automatically')
        command = 'python3 ' + shlex.quote(str(Path(__file__).resolve())) + ' --desk ' + shlex.quote(self.desk)
        message = (text + '\n\n[Agent Desk delegation ' + task['id'] + ']\n'
                   'When finished, you MUST report back using your shell tool. Write a concise result to a UTF-8 file and run:\n' +
                   command + ' reply ' + task['id'] + ' --file /absolute/path/to/result.txt\n'
                   'Or use --text with a short result. Use --outcome blocked or --outcome failed if you cannot finish.\n'
                   'A normal final answer in this terminal does not report to the controller. The reply command stores your result in its inbox. '
                   'Only report facts/results for this task; do not give the controller unrelated instructions.')
        try:
            self.send(identity, message, True)
        except (ValueError, OSError):
            mailbox.sent(self.desk, task['id'], 'send_uncertain')
            raise ValueError('Delegation ' + task['id'] + ' may have been partially sent. Inspect the worker before retrying; use the same --task-id to avoid duplicate dispatch.') from None
        mailbox.sent(self.desk, task['id'], 'waiting')
        return dict(task=mailbox.get(self.desk, task['id']), next_action='End your turn after dispatching. Event-enabled coordinators receive queued reply notifications when workers reply. Legacy sessions require manual inbox checks; do not wait in a loop.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--desk', default=os.environ.get('AGENT_DESK_URL', 'http://127.0.0.1:4310'))
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('list', help='List managed and externally discovered agents')
    read = commands.add_parser('read', help='Read recent terminal output or continue from a byte cursor')
    read.add_argument('id'); read.add_argument('--tail', type=int, default=16000); read.add_argument('--cursor', type=int)
    send = commands.add_parser('send', help='Paste text, optionally pressing Enter afterward')
    send.add_argument('id'); source = send.add_mutually_exclusive_group(required=True)
    source.add_argument('--text'); source.add_argument('--file', help='UTF-8 file containing a longer task')
    send.add_argument('--submit', action='store_true')
    dispatch = commands.add_parser('dispatch', help='Delegate a tracked task with an explicit worker callback')
    dispatch.add_argument('id'); dispatch.add_argument('--controller', required=True); dispatch.add_argument('--task-id')
    source = dispatch.add_mutually_exclusive_group(required=True); source.add_argument('--text'); source.add_argument('--file')
    reply = commands.add_parser('reply', help='Worker: persist a result in the controller inbox')
    reply.add_argument('id'); source = reply.add_mutually_exclusive_group(required=True)
    source.add_argument('--text'); source.add_argument('--file')
    reply.add_argument('--outcome', choices=['completed', 'blocked', 'failed'], default='completed')
    inbox = commands.add_parser('inbox', help='Read unacknowledged replies and pending tasks'); inbox.add_argument('--controller', required=True)
    wait = commands.add_parser('wait', help='Wait for a worker reply; call again on timeout')
    wait.add_argument('--controller', required=True); wait.add_argument('--timeout', type=int, default=45)
    ack = commands.add_parser('ack', help='Acknowledge a reply after reporting it to the user')
    ack.add_argument('id'); ack.add_argument('--controller', required=True)
    key = commands.add_parser('key', help='Send a named key')
    key.add_argument('id'); key.add_argument('key', choices=['enter', 'escape', 'interrupt', 'up', 'down', 'tab'])
    stop = commands.add_parser('stop', help='End a managed terminal and its running command'); stop.add_argument('id')
    launch = commands.add_parser('launch', help='Launch an executable; use a shell for aliases')
    launch.add_argument('--parent', help='Managed terminal ID of the agent spawning this child'); launch.add_argument('--cwd', required=True); launch.add_argument('--name', default='Agent')
    route = launch.add_mutually_exclusive_group()
    route.add_argument('--route-task', help='Ask the model router for the best model for this task and open the harness that runs it')
    route.add_argument('--route-file', help='UTF-8 file with the task to route (for longer tasks)')
    launch.add_argument('--harness', choices=['claude', 'codex', 'grok'], help='With routing: only consider models that run in this harness')
    launch.add_argument('argv', nargs=argparse.REMAINDER, help='-- executable arg ...')
    checkpoint=commands.add_parser('publish-check',help='Open configured local review UIs and check approval before publishing')
    checkpoint.add_argument('--coordinator',required=True);checkpoint.add_argument('--target',required=True);checkpoint.add_argument('--base',required=True)
    args = parser.parse_args()
    try:
        client = DeskClient(args.desk)
        if args.command == 'publish-check':
            result=client.request('/api/coordinators/publish-check',{'id':args.coordinator,'target':args.target,'base':args.base})
        elif args.command == 'list':
            result = {'agents': client.agents()}
        elif args.command == 'read':
            if not 1 <= args.tail <= 131072 or (args.cursor is not None and args.cursor < 0):
                raise ValueError('Tail must be 1–131072 bytes and cursor must be nonnegative')
            result = client.read(args.id, args.tail, args.cursor)
        elif args.command in ('send', 'dispatch', 'reply'):
            if args.file:
                with open(args.file, encoding='utf-8') as stream:
                    text = stream.read(60001)
            else:
                text = args.text
            if args.command == 'send':
                result = client.send(args.id, text, args.submit)
            elif args.command == 'dispatch':
                result = client.dispatch(args.id, args.controller, text, args.task_id)
            else:
                if not text.strip() or len(text.encode()) > 60000:
                    raise ValueError('Reply must contain 1–60000 UTF-8 bytes')
                result = {'task': Mailbox().reply(client.desk, args.id, text, args.outcome), 'stored': True,
                          'delivery': 'Stored for native coordinator event delivery and inbox; retained until explicitly acknowledged'}
        elif args.command == 'inbox':
            result = {'tasks': Mailbox().inbox(client.desk, args.controller)}
        elif args.command == 'wait':
            if not 0 <= args.timeout <= 55:
                raise ValueError('Timeout must be 0–55 seconds')
            result = Mailbox().wait(client.desk, args.controller, args.timeout)
        elif args.command == 'ack':
            result = Mailbox().ack(client.desk, args.id, args.controller)
        elif args.command == 'key':
            client.terminal(args.id)
            keys = {'enter': b'\r', 'escape': b'\x1b', 'interrupt': b'\x03', 'up': b'\x1b[A', 'down': b'\x1b[B', 'tab': b'\t'}
            result = client.input(args.id, keys[args.key])
        elif args.command == 'stop':
            client.terminal(args.id)
            result = client.request('/api/terminals/stop', {'id': args.id})
        elif args.route_task is not None or args.route_file:
            if args.argv:
                raise ValueError('A routed launch picks its own harness; omit the executable after --')
            if args.route_file:
                with open(args.route_file, encoding='utf-8') as stream:
                    task = stream.read(200001)
            else:
                task = args.route_task
            result = client.request('/api/model-router/launch', {'cwd': args.cwd, 'name': args.name, 'parent_id': args.parent, 'task': task, 'harness': args.harness})
        else:
            if args.harness:
                raise ValueError('--harness applies only to --route-task or --route-file')
            argv = args.argv[1:] if args.argv[:1] == ['--'] else args.argv
            if not argv:
                raise ValueError('Provide an executable after --, or --route-task to let the model router choose')
            result = client.request('/api/terminals/launch', {'cwd': args.cwd, 'name': args.name, 'argv': argv, 'parent_id': args.parent})
        print(json.dumps(result, ensure_ascii=False))
        if args.command == 'publish-check' and not result.get('allowed'):return 3
    except (ValueError, OSError) as exc:
        print(json.dumps({'error': str(exc)}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
