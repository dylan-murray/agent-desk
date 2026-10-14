"""The host side of the iOS app: `agent-desk attach` and `agent-desk mobile`.

The phone reaches this machine the way a Mosh terminal does. It signs in over SSH, runs
`mosh-server new -- agent-desk attach <id>`, and from then on talks to that terminal over
Mosh's UDP protocol, which survives network changes and sleep. Its native screens (desks,
sessions, launching) use `agent-desk mobile`, which answers in JSON over the same SSH login.

Both commands are clients of the running desk's loopback API, exactly like a browser tab:
the desk still listens only on 127.0.0.1, and nothing changes for anyone without the app.
"""
import argparse
import base64
import http.client
import json
import os
import queue
import re
import secrets
import select
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlencode

from agent_desk import desk_tokens, websocket
from agent_desk.paths import DATA_DIR

# Bumped when a reply changes shape in a way an installed app cannot ignore.
PROTOCOL = 1
# How long attach keeps retrying while the desk restarts; terminals outlive the web server.
RECONNECT_SECONDS = 120
# Matches the browser: output within this many seconds reads as "receiving output".
OUTPUT_RECENT = 4
REFRESH = 2
HEARTBEAT = 15
ROOT = Path(__file__).resolve().parents[1]
# The CLIs annotations can be typed into, and the account profiles that run Claude or Codex.
FEEDBACK_HARNESSES = ('claude', 'codex', 'grok', 'opencode', 'pi')
AGENT_PROFILE = re.compile(r'(claude|codex)(-[a-z0-9-]+)?')
COORDINATOR_HARNESSES = ('codex', 'claude', 'grok')


class DeskError(Exception):
    """The desk is not running, refused the request, or answered with an error."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class Desk:
    """The running desk's loopback API, as a local helper: authenticated with the token the desk
    keeps for helpers in an owner-only file. Protected panes refuse that token."""

    def __init__(self, port, data_dir=None):
        self.port, self.data_dir = port, data_dir
        self.token = None

    def not_running(self):
        return DeskError(f'Agent Desk is not running on port {self.port}. Start it with: agent-desk --port {self.port}')

    def read_token(self):
        path = desk_tokens.token_path('terminal', self.port, self.data_dir)
        try:
            return path.read_text().strip()
        except OSError:
            pass
        # Without a token file, say whether the desk is down or keeps its files elsewhere.
        probe = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            probe.connect()
        except ConnectionRefusedError:
            raise self.not_running() from None
        except OSError as error:
            raise DeskError(f'Could not reach Agent Desk on port {self.port}: {error}') from None
        finally:
            probe.close()
        raise DeskError(f'Agent Desk on port {self.port} has not written its helper token to {path}. Restart it if it '
                        'predates this command, or run this command with the same AGENT_DESK_DATA_DIR as the desk.')

    @staticmethod
    def pane_headers():
        # Run from inside a desk pane, say which one: the desk then keeps this command to that pane
        # and the workers it started, as it does an agent's own tools.
        pane = os.environ.get('AGENT_DESK_TERMINAL_ID')
        return {'X-Agent-Desk-Pane': pane} if pane else {}

    def request(self, path, body=None):
        if self.token is None:
            self.token = self.read_token()
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=30)
        headers = {'X-Agent-Desk-Terminal': self.token, **self.pane_headers()}
        payload = None if body is None else json.dumps(body).encode()
        if payload is not None:
            headers['Content-Type'] = 'application/json'
        try:
            connection.request('GET' if body is None else 'POST', path, payload, headers)
            response = connection.getresponse()
            data = response.read()
        except ConnectionRefusedError:
            raise self.not_running() from None
        except OSError as error:
            raise DeskError(f'Could not reach Agent Desk on port {self.port}: {error}') from None
        finally:
            connection.close()
        try:
            value = json.loads(data)
        except ValueError:
            raise DeskError(f'Agent Desk on port {self.port} sent an unreadable reply (HTTP {response.status})') from None
        if response.status == 403:
            # A restarted desk writes a new token; read it again next time.
            self.token = None
        if response.status >= 400:
            raise DeskError(value.get('error') or f'HTTP {response.status}', response.status)
        return value

    def stream(self):
        """An authenticated terminal stream, the WebSocket the browser's panes use."""
        token = self.read_token()
        try:
            socket = websocket.connect(self.port, '/api/terminals/stream', headers=self.pane_headers())
        except ConnectionRefusedError:
            raise self.not_running() from None
        except OSError as error:
            raise DeskError(f'Could not open the terminal stream on port {self.port}: {error}') from None
        socket.send_text(json.dumps(dict(type='auth', token=token)))
        return socket


def encode(data):
    return base64.b64encode(data).decode()


def write_all(fd, data):
    while data:
        data = data[os.write(fd, data):]


class Attachment:
    """Joins one desk terminal to this process's own terminal, which mosh-server provides."""

    def __init__(self, desk, identity, stdin=0, stdout=1):
        self.desk, self.identity = desk, identity
        self.stdin, self.stdout = stdin, stdout
        self.cursor = 0
        self.socket = None
        self.exit_code = None
        self.lock = threading.Lock()
        self.wake_read, self.wake_write = os.pipe()
        self.resized = threading.Event()
        self.finished = threading.Event()
        self.failure = None
        self.remote = identity.startswith('remote:')

    def size(self):
        try:
            size = os.get_terminal_size(self.stdout)
        except OSError:
            return None
        return min(max(size.columns, 2), 500), min(max(size.lines, 1), 300)

    def send_size(self):
        size = self.size()
        if size:
            self.send(dict(type='resize', id=self.identity, cols=size[0], rows=size[1]))

    def send(self, message):
        if self.remote:
            path = '/api/terminals/resize' if message['type'] == 'resize' else '/api/terminals/input'
            body = {key: value for key, value in message.items() if key != 'type'}
            try:
                self.desk.request(path, body)
            except DeskError:
                pass
            return
        with self.lock:
            socket = self.socket
        if socket is None:
            # Reconnecting: keys typed now are dropped rather than replayed late into an agent.
            return
        try:
            socket.send_text(json.dumps(message))
        except websocket.Closed:
            pass

    def output(self, message):
        data = base64.b64decode(message.get('data', ''))
        if message.get('truncated'):
            # The desk dropped bytes this view never saw; start from a clean screen, as panes do.
            data = b'\x1bc' + data
        if data:
            write_all(self.stdout, data)
        self.cursor = message['cursor']

    def follow(self):
        """Copy the terminal's output to stdout, reconnecting while the desk restarts."""
        deadline, connected = None, False
        while not self.finished.is_set():
            try:
                try:
                    socket = self.desk.stream()
                except DeskError as error:
                    if not connected:
                        # Nothing to wait for: the desk was never there.
                        self.failure = str(error)
                        return self.finish()
                    raise
                connected = True
                socket.send_text(json.dumps(dict(type='subscribe', sub='attach', id=self.identity, cursor=self.cursor)))
                with self.lock:
                    self.socket = socket
                deadline = None
                # The terminal's last size belongs to whichever view resized it last; take it back.
                self.send_size()
                while True:
                    message = json.loads(socket.receive())
                    if message.get('type') == 'output':
                        self.output(message)
                    elif message.get('type') == 'exit':
                        self.exit_code = message.get('exit_code')
                        return self.finish()
                    elif message.get('type') == 'error':
                        self.failure = message.get('message') or 'Terminal stream error'
                        return self.finish()
            except (DeskError, websocket.Closed, OSError, ValueError):
                with self.lock:
                    self.socket = None
                deadline = deadline or time.monotonic() + RECONNECT_SECONDS
                if time.monotonic() > deadline:
                    self.failure = 'Lost the connection to Agent Desk'
                    return self.finish()
                self.finished.wait(1)

    def poll(self):
        """Remote panes are not streamed yet, so follow them the way the browser does: by polling."""
        while not self.finished.is_set():
            try:
                message = self.desk.request('/api/terminals/output?' + urlencode(dict(id=self.identity, cursor=self.cursor)))
            except DeskError as error:
                self.failure = str(error)
                return self.finish()
            self.output(message)
            if message.get('exit_code') is not None and not message.get('data'):
                self.exit_code = message['exit_code']
                return self.finish()
            self.finished.wait(.05 if message.get('data') else .25)

    def finish(self):
        # Under the lock, so run() never closes the wake pipe between the check and the write.
        with self.lock:
            if not self.finished.is_set():
                self.finished.set()
                os.write(self.wake_write, b'x')

    def run(self):
        """Attach until the terminal exits, the desk goes away, or stdin closes."""
        import termios
        import tty
        saved = None
        if os.isatty(self.stdin):
            saved = termios.tcgetattr(self.stdin)
            tty.setraw(self.stdin)
        previous = signal.signal(signal.SIGWINCH, lambda *_: (self.resized.set(), os.write(self.wake_write, b'x')))
        reader = threading.Thread(target=self.poll if self.remote else self.follow, daemon=True)
        reader.start()
        if self.remote:
            self.send_size()
        try:
            while not self.finished.is_set():
                ready, _, _ = select.select([self.stdin, self.wake_read], [], [])
                if self.wake_read in ready:
                    os.read(self.wake_read, 1024)
                if self.resized.is_set():
                    self.resized.clear()
                    self.send_size()
                if self.stdin in ready:
                    data = os.read(self.stdin, 65536)
                    if not data:
                        break
                    self.send(dict(type='input', id=self.identity, data=encode(data)))
        finally:
            signal.signal(signal.SIGWINCH, previous)
            with self.lock:
                self.finished.set()
                socket, self.socket = self.socket, None
            if socket:
                socket.close()
            if saved is not None:
                termios.tcsetattr(self.stdin, termios.TCSADRAIN, saved)
            os.close(self.wake_read)
            os.close(self.wake_write)
        if self.failure:
            write_all(self.stdout, f'\r\n[Agent Desk: {self.failure}]\r\n'.encode())
            return 1
        if self.exit_code is not None:
            write_all(self.stdout, f'\r\n[Agent Desk: this terminal exited with code {self.exit_code}]\r\n'.encode())
        return 0


def launch_choices(desk):
    """The browser's launch menu, read from its own source with the desk's Claude and Codex accounts,
    so the two never disagree."""
    node = shutil.which('node')
    if not node:
        raise DeskError('Node.js is required to read the launch choices')
    accounts = [{key: row.get(key) for key in ('id', 'harness', 'name', 'label')} for row in desk.request('/api/accounts/list', {}).get('accounts', [])]
    script = (f'const m=require({json.dumps(str(ROOT / "agent_desk/static/terminal-commands.js"))});'
              'm.applyAccounts(JSON.parse(process.argv[1]));console.log(JSON.stringify(m.launchChoices))')
    result = subprocess.run([node, '-e', script, json.dumps(accounts)], capture_output=True, text=True, timeout=10)
    if result.returncode:
        raise DeskError('Could not read the launch choices: ' + result.stderr.strip())
    return json.loads(result.stdout)


def launch_command(choice, args):
    node = shutil.which('node')
    script = (f'const m=require({json.dumps(str(ROOT / "agent_desk/static/terminal-commands.js"))});'
              'const [command,mode,args]=JSON.parse(process.argv[1]);'
              'console.log(JSON.stringify(m.buildTerminalCommand(command,mode,args)))')
    result = subprocess.run([node, '-e', script, json.dumps([choice['command'], choice['mode'], args])], capture_output=True, text=True, timeout=10)
    if result.returncode:
        raise DeskError(result.stderr.strip().splitlines()[-1] if result.stderr.strip() else 'Could not build the launch command')
    return json.loads(result.stdout)


def controller_prompt(desk, objective, name, routed):
    """The browser's coordinator instructions, read from its own source, so the two never disagree."""
    script = ('const vm=require("vm"),fs=require("fs"),[file,root,origin,args]=process.argv.slice(1);'
              'const page={document:{addEventListener(){}},window:{},terminalDefaultCwd:root,location:{origin}};'
              'vm.runInNewContext(fs.readFileSync(file,"utf8"),page);'
              'console.log(JSON.stringify(page.controllerPrompt(...JSON.parse(args))))')
    result = subprocess.run([shutil.which('node') or 'node', '-e', script, str(ROOT / 'agent_desk/static/controller.js'), str(ROOT.resolve()),
                             f'http://127.0.0.1:{desk.port}', json.dumps([objective, name, routed])], capture_output=True, text=True, timeout=10)
    if result.returncode:
        raise DeskError('Could not write the coordinator instructions: ' + result.stderr.strip())
    return json.loads(result.stdout)


def router_configured(desk):
    try:
        return bool(desk.request('/api/model-router/settings', {}).get('configured'))
    except DeskError:
        return False


def info(desk):
    choices = launch_choices(desk)
    agents = desk.request('/api/agents')
    projects = desk.request('/api/projects')
    return dict(type='info', protocol=PROTOCOL, port=desk.port, desks=agents.get('desks', []),
                launch_choices=[dict(key=key, label=choice['label'], harness=choice['harness'])
                                for key, choice in choices.items() if choice['harness'] != 'custom'],
                projects=projects.get('projects', projects) if isinstance(projects, dict) else projects,
                coordinator=dict(harnesses=list(COORDINATOR_HARNESSES), router=router_configured(desk)))


def launch(desk, request):
    """Start a pane the way the browser's launch dialog does, from the same choices."""
    if not isinstance(request, dict):
        raise DeskError('Expected a JSON object')
    choices = launch_choices(desk)
    key = request.get('choice')
    choice = choices.get(key)
    if not choice or choice['harness'] == 'custom':
        raise DeskError('Choose one of: ' + ', '.join(k for k, c in choices.items() if c['harness'] != 'custom'))
    cwd = request.get('cwd')
    if not isinstance(cwd, str) or not Path(cwd).expanduser().is_absolute() or not Path(cwd).expanduser().is_dir():
        raise DeskError('Choose an existing project folder')
    prompt = request.get('prompt')
    if prompt is not None and (not isinstance(prompt, str) or choice['harness'] == 'shell'):
        raise DeskError('A first prompt needs a coding agent, not a shell')
    # An account's key is its launch profile, which selects its config folder, as in the browser.
    body = dict(cwd=str(Path(cwd).expanduser()), name=choice['label'], launch_profile=key if choice.get('account') else None)
    args = [prompt] if prompt else []
    coordinator = request.get('coordinator')
    if coordinator is not None:
        # As the browser's "Coordinate other agents": the objective is the agent's first message.
        objective = coordinator.get('objective') if isinstance(coordinator, dict) else None
        if not isinstance(objective, str) or not objective.strip() or choice['harness'] not in COORDINATOR_HARNESSES:
            raise DeskError('Choose Codex, Claude or Grok and enter a coordinator objective')
        if prompt is not None:
            raise DeskError('A coordinator takes its objective, not a separate first prompt')
        routed = coordinator.get('router') is True
        events = desk.request('/api/coordinator-events')
        if not events.get('event_delivery') or (choice['harness'] == 'grok' and not events.get('native_grok_terminal')):
            raise DeskError('Restart Agent Desk to enable event-driven coordinators.')
        if routed and not router_configured(desk):
            raise DeskError('Set up the model router at the desk before routing worker models')
        body['name'] = 'Controller · ' + choice['label'] + ' · ' + secrets.token_hex(3)
        body['coordinator_harness'] = choice['harness']
        args = [controller_prompt(desk, objective.strip(), body['name'], routed)]
    if choice['harness'] != 'shell':
        body['argv'] = launch_command(choice, args)
    if request.get('desk') is not None:
        body['desk'] = request['desk']
    session = desk.request('/api/terminals/launch', body)
    return dict(type='launched', session=session)


# The desk's own limits for a submission ID; screenshots are named after it.
SUBMISSION_ID = re.compile(r'[a-zA-Z0-9_-]{1,90}')
SCREENSHOT_LIMIT = 4 * 1024 * 1024
SCREENSHOT_TYPES = {b'\xff\xd8\xff': '.jpg', b'\x89PNG\r\n\x1a\n': '.png'}


def feedback(desk, request):
    """Hands annotations made on the phone to a coding agent, as the desk's annotation tools do.

    Each note's screenshot is saved in the desk's data directory, owner-only, and the note points
    at it, so the agent sees what the person saw. Delivery, queueing and duplicate submissions are
    the desk's: this goes through the same endpoint as its annotation tools.
    """
    if not isinstance(request, dict):
        raise DeskError('Expected a JSON object')
    submission, notes, images = request.get('request_id'), request.get('notes'), request.get('screenshots') or {}
    if not isinstance(submission, str) or not SUBMISSION_ID.fullmatch(submission):
        raise DeskError('Submission ID required')
    if not isinstance(notes, list) or not notes or not all(isinstance(n, dict) and isinstance(n.get('id'), str) for n in notes):
        raise DeskError('Choose annotations to send')
    if not isinstance(images, dict):
        raise DeskError('Screenshots must map note IDs to images')
    folder = Path(desk.data_dir or DATA_DIR) / 'feedback-submissions' / 'screenshots'
    sent = []
    for note in notes:
        image = images.get(note['id'])
        if image is not None:
            try:
                data = base64.b64decode(image, validate=True)
            except (TypeError, ValueError):
                raise DeskError('A screenshot is not valid base64') from None
            if len(data) > SCREENSHOT_LIMIT:
                raise DeskError('A screenshot is larger than 4 MB')
            suffix = next((kind for magic, kind in SCREENSHOT_TYPES.items() if data.startswith(magic)), None)
            if not suffix:
                raise DeskError('Screenshots must be JPEG or PNG images')
            folder.mkdir(mode=0o700, parents=True, exist_ok=True)
            path = folder / (submission + '-' + re.sub(r'[^a-zA-Z0-9_-]', '_', note['id'])[:60] + suffix)
            # Replaced whole, so a repeated submission names the same file with the same bytes.
            temp = path.with_suffix('.tmp')
            with os.fdopen(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'wb') as stream:
                stream.write(data)
            os.replace(temp, path)
            note = dict(note, screenshot=str(path))
        sent.append(note)
    result = desk.request('/api/coordinators/submit-feedback', dict(request_id=submission, target_id=request.get('target_id'), notes=sent))
    return dict(type='feedback', target_id=result.get('target_id'), sent=bool(result.get('sent')),
                queued=bool(result.get('queued')), duplicate=bool(result.get('duplicate')))


def feedback_targets(agents):
    """Where annotations for each session go, by the browser's rule: a top-level coding agent or
    coordinator takes them itself, and a worker's go to its coordinator. None when they cannot be sent."""
    by_id = {a['id']: a for a in agents}

    def direct(a):
        return (not a.get('remote_node') and not a.get('harness_internal') and a.get('exit_code') is None and not a.get('protected')
                and (a.get('coordinator_workspace') or (a.get('terminal_id') and (a.get('harness') in FEEDBACK_HARNESSES
                                                                                 or AGENT_PROFILE.fullmatch(a.get('launch_profile') or '')))))
    targets = {}
    for agent in agents:
        top, seen = agent, set()
        while top and top.get('parent_id') and top['id'] not in seen:
            seen.add(top['id'])
            top = by_id.get(top['parent_id'])
        targets[agent['id']] = top if top and top['id'] not in seen and direct(top) else None
    return targets


def session_record(agent, approval, now, target=None):
    live = agent.get('exit_code') is None
    status = agent.get('status')
    if live and not agent.get('runtime_status') and agent.get('remote_connected') is not False:
        last = agent.get('last_output')
        status = 'needs_input' if approval else 'output' if last and now - last < OUTPUT_RECENT else 'quiet'
    # Account agents run through a login shell, so the terminal's own command is the shell.
    profile = AGENT_PROFILE.fullmatch(agent.get('launch_profile') or '')
    return dict(id=agent['id'], name=agent.get('display_name') or agent.get('name') or agent['id'], desk=agent.get('desk'),
                harness=profile.group(1) if profile else agent.get('harness'), launch_profile=agent.get('launch_profile'), cwd=agent.get('cwd'),
                project=agent.get('project') or (Path(agent['cwd']).name if agent.get('cwd') else None),
                status=status, question=approval or agent.get('question'), exit_code=agent.get('exit_code'),
                last_output=agent.get('last_output'), active_since=agent.get('active_since'), parent_id=agent.get('parent_id'),
                remote=agent['id'].startswith('remote:'), controller=bool(agent.get('coordinator_events')),
                protected=bool(agent.get('protected')), feedback_target=target and target['id'],
                feedback_target_name=target and (target.get('display_name') or target.get('name') or target['id']))


class Watch:
    """Streams desk and session state, including approval prompts read from each terminal's screen."""

    def __init__(self, desk, out=sys.stdout):
        self.desk, self.out = desk, out
        # Guarded by lock: terminal ID -> approval prompt, and -> whether its replay has caught up.
        self.approvals = {}
        self.subscribed = {}
        self.socket = None
        self.lock = threading.Lock()
        self.changed = threading.Event()
        self.reader = None
        self.pending = queue.Queue()
        self.stopped = threading.Event()

    def start_reader(self):
        node = shutil.which('node')
        if not node:
            return
        self.reader = subprocess.Popen([node, str(ROOT / 'scripts' / 'terminal_attention.cjs')], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        threading.Thread(target=self.read_approvals, daemon=True).start()
        threading.Thread(target=self.write_reader, daemon=True).start()

    def write_reader(self):
        # Its own thread: Node can block on stdout while the approval reader waits for the lock.
        try:
            while (message := self.pending.get()) is not None:
                self.reader.stdin.write(json.dumps(message) + '\n')
        except (BrokenPipeError, OSError, ValueError):
            pass

    def read_approvals(self):
        for line in self.reader.stdout:
            message = json.loads(line)
            with self.lock:
                if message['id'] in self.subscribed:
                    self.approvals[message['id']] = message['approval']
                    if message.get('caught_up'):
                        self.subscribed[message['id']] = True
            self.changed.set()

    def tell_reader(self, **message):
        if self.reader:
            self.pending.put(message)

    def follow_stream(self, socket):
        try:
            while True:
                message = json.loads(socket.receive())
                identity = message.get('id')
                if message.get('type') == 'error':
                    with self.lock:
                        if identity in self.subscribed and not self.subscribed[identity]:
                            # A pane this command may not read, such as a protected one: nothing to wait for.
                            self.subscribed[identity] = True
                            self.changed.set()
                    continue
                if message.get('type') != 'output':
                    continue
                with self.lock:
                    if identity not in self.subscribed:
                        continue
                    self.tell_reader(op='output', id=identity, data=message['data'], truncated=message.get('truncated', False))
                    if not message['data'] and not self.subscribed[identity]:
                        # Replayed history is read before a screen is trusted, as in the browser:
                        # the reader confirms once it has drawn everything sent before this.
                        if self.reader:
                            self.tell_reader(op='caught_up', id=identity)
                        else:
                            self.subscribed[identity] = True
                            self.changed.set()
        except (websocket.Closed, ValueError, OSError):
            with self.lock:
                if self.socket is socket:
                    self.socket = None
                    self.subscribed.clear()
            self.changed.set()

    def sync_subscriptions(self, agents):
        live = {a['id']: a for a in agents if a.get('terminal_id') and a.get('exit_code') is None and not a['id'].startswith('remote:')}
        with self.lock:
            if self.socket is None and live:
                try:
                    self.socket = self.desk.stream()
                except DeskError:
                    return
                threading.Thread(target=self.follow_stream, args=(self.socket,), daemon=True).start()
            messages = []
            for identity in [i for i in self.subscribed if i not in live]:
                del self.subscribed[identity]
                self.approvals.pop(identity, None)
                self.tell_reader(op='forget', id=identity)
                messages.append(dict(type='unsubscribe', sub=identity))
            for identity, agent in live.items():
                self.tell_reader(op='size', id=identity, cols=agent.get('cols') or 80, rows=agent.get('rows') or 24)
                if identity not in self.subscribed:
                    self.subscribed[identity] = False
                    messages.append(dict(type='subscribe', sub=identity, id=identity, cursor=0))
            socket = self.socket
        try:
            for message in messages:
                socket.send_text(json.dumps(message))
        except (websocket.Closed, AttributeError):
            pass

    def snapshot(self, listing):
        now = time.time()
        with self.lock:
            approvals = {i: self.approvals.get(i) for i, caught_up in self.subscribed.items() if caught_up}
            ready = all(self.subscribed.values())
        agents = listing.get('agents', [])
        targets = feedback_targets(agents)
        sessions = [session_record(a, approvals.get(a['id']), now, targets[a['id']]) for a in agents if a.get('terminal_id')]
        sessions.sort(key=lambda s: (s['exit_code'] is not None, -(s['last_output'] or 0)))
        return dict(type='snapshot', protocol=PROTOCOL, desks=listing.get('desks', []), sessions=sessions, ready=ready)

    def stop(self):
        self.stopped.set()
        self.changed.set()

    def emit(self, value):
        self.out.write(json.dumps(value) + '\n')
        self.out.flush()

    def run(self, once=False):
        self.start_reader()
        last, last_sent = None, 0
        try:
            while not self.stopped.is_set():
                listing = self.desk.request('/api/agents')
                self.sync_subscriptions(listing.get('agents', []))
                value = self.snapshot(listing)
                if once:
                    if value['ready'] or self.reader is None:
                        return self.emit(value)
                    self.changed.wait(REFRESH)
                    self.changed.clear()
                    continue
                comparable = json.dumps(value, sort_keys=True)
                if comparable != last:
                    self.emit(value)
                    last, last_sent = comparable, time.monotonic()
                elif time.monotonic() - last_sent > HEARTBEAT:
                    self.emit(dict(type='heartbeat'))
                    last_sent = time.monotonic()
                self.changed.wait(REFRESH)
                self.changed.clear()
        finally:
            if self.socket:
                self.socket.close()
            if self.reader:
                self.pending.put(None)
                self.reader.terminate()
                self.reader.wait(5)
                self.reader.stdin.close()
                self.reader.stdout.close()


def default_port():
    try:
        return int(os.environ.get('AGENT_DESK_PORT', '4310'))
    except ValueError:
        return 4310


def attach_main(argv):
    parser = argparse.ArgumentParser(prog='agent-desk attach', description='Join a desk terminal from this terminal, as the iOS app does over Mosh.')
    parser.add_argument('--port', type=int, default=default_port())
    parser.add_argument('id', help='Terminal ID, from `agent-desk mobile watch --once`')
    args = parser.parse_args(argv)
    return Attachment(Desk(args.port), args.id).run()


def mobile_main(argv):
    parser = argparse.ArgumentParser(prog='agent-desk mobile', description='JSON answers for the iOS app, over its SSH login.')
    parser.add_argument('--port', type=int, default=default_port())
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('info', help='Protocol version, desks, launch choices and projects')
    watch = commands.add_parser('watch', help='One JSON line per change to desks and sessions')
    watch.add_argument('--once', action='store_true', help='Print one snapshot after every screen has been read, then exit')
    commands.add_parser('launch', help='Start a pane from a JSON request on stdin: {"choice", "cwd", "desk", "prompt"}')
    commands.add_parser('feedback', help='Send annotations to a coding agent, from JSON on stdin: '
                                         '{"request_id", "target_id", "notes", "screenshots": {note id: base64 image}}')
    args = parser.parse_args(argv)
    desk = Desk(args.port)
    try:
        if args.command == 'info':
            print(json.dumps(info(desk)))
        elif args.command == 'watch':
            Watch(desk).run(args.once)
        else:
            try:
                request = json.loads(sys.stdin.read())
            except ValueError:
                raise DeskError('Expected a JSON object on stdin') from None
            print(json.dumps(feedback(desk, request) if args.command == 'feedback' else launch(desk, request)))
    except DeskError as error:
        print(json.dumps(dict(type='error', protocol=PROTOCOL, message=str(error))))
        return 1
    except (BrokenPipeError, KeyboardInterrupt):
        return 0
    return 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    command, rest = argv[0], argv[1:]
    try:
        return (attach_main if command == 'attach' else mobile_main)(rest)
    except DeskError as error:
        print(f'agent-desk {command}: {error}', file=sys.stderr)
        return 1
