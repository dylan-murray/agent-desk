"""Managed local terminals with bounded in-memory replay and ordered input."""
import base64
import json
import logging
import os
from pathlib import Path
import secrets
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
from agent_desk.accounts import harness_of, HARNESSES, SINGLE
from agent_desk.worker_screen import WorkerScreen, WorkerNotReady
from agent_desk import readouts

PANE_BIN = Path(__file__).with_name('bin')


PANE_VARIABLES = ('AGENT_DESK_TERMINAL_ID', 'AGENT_DESK_PANE_TOKEN', 'AGENT_DESK_PANE_PID', 'AGENT_DESK_URL', 'AGENT_DESK_READOUTS_DIR')


def pane_environment(parent, terminal_id, token, desk, readouts_dir=None):
    """Let any process in a pane set that pane's readouts, and only that pane's."""
    env = {k: v for k, v in parent.items() if k not in PANE_VARIABLES}
    env.update(AGENT_DESK_TERMINAL_ID=terminal_id, AGENT_DESK_PANE_TOKEN=token,
               PATH=os.pathsep.join(filter(None, (str(PANE_BIN), parent.get('PATH')))))
    if desk:
        env['AGENT_DESK_URL'] = desk
    if readouts_dir:
        env['AGENT_DESK_READOUTS_DIR'] = readouts_dir
    return env


def input_event(data):
    if not isinstance(data, str) or len(data) > 90000:
        raise ValueError('Invalid terminal input')
    base64.b64decode(data, validate=True)
    return dict(op='input', data=data)


def resize_event(cols, rows):
    if type(cols) is not int or type(rows) is not int or not 2 <= cols <= 500 or not 1 <= rows <= 300:
        raise ValueError('Invalid terminal size')
    return dict(op='resize', cols=cols, rows=rows)


AGENT_EXITED = b'\x1b]777;agent-desk;shell\x07'
# Agents redraw continuously while they work; this long without output, a terminal counts as idle.
ACTIVE_GAP = 6
# A resize makes a terminal app repaint; that repaint is not work.
REDRAW_QUIET = 1.5
# CLIs whose empty prompt worker_prompt.cjs can recognize.
PROMPTS = (*HARNESSES, *SINGLE)


def _cpu_seconds(value):
    """Parse ps TIME, which is [[DD-]HH:]MM:SS[.ss] depending on the platform and how long it ran."""
    days = 0
    if '-' in value:
        days, value = value.split('-', 1)
        days = int(days)
    parts = value.split(':')
    try:
        numbers = [float(part) for part in parts]
    except ValueError:
        return 0.0
    seconds = 0.0
    for number in numbers:
        seconds = seconds * 60 + number
    return days * 86400 + seconds


class TerminalSession:
    def __init__(self, cwd, argv, name, parent_id=None, coordinator=None, launch_profile=None, desk=None, readouts_dir=None,
                 identity=None, origin=0, banner=b'', on_exit=None):
        self.id = identity or 'terminal-' + secrets.token_hex(8)
        self.pane_token = secrets.token_urlsafe(32)
        self.readouts, self.readouts_published = None, 0
        self.cwd, self.argv, self.name = cwd, argv, name
        self.display_name = None
        self.parent_id = parent_id
        self.coordinator = coordinator
        self.launch_profile = launch_profile
        self.channel_blocked = False
        self.created = self.updated = time.time()
        # When output last arrived, and when the current run of output began; a quiet gap ends a run.
        self.last_output = self.active_since = None
        self.redraw_until = 0
        self.native_session = self.restored = None
        self.agent_exited = False
        self.on_exit = on_exit
        # Cursors are byte offsets since `origin`; a restored process starts past its predecessor.
        self.origin = self.start = origin
        self.buffer = bytearray(banner)
        self.lock = threading.RLock()
        # Signalled whenever bytes arrive or the reader ends, so output() can wait instead of being polled.
        self.changed = threading.Condition(self.lock)
        self.input_lock = threading.RLock()
        self.cols, self.rows = 80, 24
        launch_argv = argv
        if coordinator:
            from scripts.control_mailbox import Mailbox
            from scripts.coordinator_events import SCRIPT
            box = Mailbox(coordinator['db'])
            box.register(coordinator['desk'], self.id, coordinator['harness'])
            if coordinator['harness'] != 'grok':
                launch_argv = [sys.executable, str(SCRIPT), '--db', str(box.path), '--desk', coordinator['desk'],
                               '--controller', self.id, 'launch', '--harness', coordinator['harness'], '--', *argv]
        native = dict(coordinator, controller=self.id) if coordinator and coordinator['harness']=='grok' else None
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name('terminal_worker.py')), cwd, json.dumps(launch_argv), launch_profile or '', *([json.dumps(native)] if native else [])],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            start_new_session=True, bufsize=0, env=pane_environment(os.environ, self.id, self.pane_token, desk, readouts_dir))
        profile=launch_profile or (Path(argv[0]).name if Path(argv[0]).name in SINGLE else '')
        harness=harness_of(profile) or profile
        self.screen=WorkerScreen(harness) if harness in PROMPTS else None
        if banner and self.screen:self.screen.observe('output',data=base64.b64encode(banner).decode())
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def read(self):
        try:
            while data := self.process.stdout.read(32768):
                with self.lock:
                    now = time.time()
                    if now >= self.redraw_until:
                        if self.last_output is None or now - self.last_output > ACTIVE_GAP:
                            self.active_since = now
                        self.last_output = now
                    exited = not self.agent_exited and AGENT_EXITED in bytes(self.buffer[-len(AGENT_EXITED):]) + data
                    self.buffer.extend(data)
                    if self.screen:self.screen.observe('output',data=base64.b64encode(data).decode())
                    overflow = max(0, len(self.buffer) - 2 * 1024 * 1024)
                    if overflow:
                        del self.buffer[:overflow]
                        self.start += overflow
                    self.changed.notify_all()
                if exited:
                    # A standalone agent returned its pane to a shell; restore it as one.
                    self.agent_exited = True
                    if self.on_exit:self.on_exit()
                if self.coordinator and self.coordinator['harness'] == 'claude' and not self.channel_blocked:
                    with self.lock:
                        tail = bytes(self.buffer[-16000:]).decode('utf-8', errors='replace')
                    tail = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', tail)
                    if 'Channels are not enabled for your org' in tail or 'blocked by org policy' in tail:
                        from scripts.control_mailbox import Mailbox
                        Mailbox(self.coordinator['db']).connection(self.coordinator['desk'], self.id, 'policy-blocked')
                        self.channel_blocked = True
        finally:
            self.process.wait()
            self.process.stdout.close()
            with self.changed:
                self.changed.notify_all()
            if self.screen:self.screen.close()
            if self.on_exit:self.on_exit()

    def info(self):
        code = self.process.poll()
        runtime = None
        if self.coordinator and code is None:
            from scripts.control_mailbox import Mailbox
            runtime = Mailbox(self.coordinator['db']).coordinator(self.coordinator['desk'], self.id)
        state = runtime['state'] if runtime else None
        status = {'needs-input':'needs_input','policy-blocked':'needs_input','delivery-error':'needs_input'}.get(state)
        if self.coordinator and self.coordinator['harness']=='grok':
            status = status or {'working':'working','queue-ready':'idle','editing':'idle','delivery-paused':'idle','unknown':'unknown','connecting':'unknown'}.get(state)
        question = ('Claude channels are blocked by organization policy. Replies are saved in Inbox; ask this coordinator to read them manually.' if state=='policy-blocked'
                    else 'Grok needs your response. Open its terminal to use the native approval controls.' if state=='needs-input'
                    else 'Coordinator event delivery failed. Inspect the terminal and Inbox before retrying.' if state=='delivery-error' else None)
        return dict(id=self.id, name=self.name, cwd=self.cwd, harness=Path(self.argv[0]).name,
                    display_name=self.display_name, launch_profile=self.launch_profile,
                    status=status or ('unknown' if code is None else 'completed' if code == 0 else 'error'),
                    source='terminal', task='Interactive terminal', terminal_id=self.id, parent_id=self.parent_id,
                    updated=self.updated, last_output=self.last_output, active_since=self.active_since,
                    turn_ended=self.screen.turn_ended() if getattr(self, 'screen', None) else None,
                    events=[], question=question, exit_code=code, runtime_status=bool(status),
                    event_delivery_error='Claude channels are blocked by organization policy. Worker replies remain in Inbox.' if self.channel_blocked else None,
                    coordinator_events=bool(self.coordinator), readouts=self.readouts_info(), restored=self.restored,
                    cols=self.cols, rows=self.rows)

    def set_readouts(self, token, payload, published=None):
        if not isinstance(token, str) or not secrets.compare_digest(token, self.pane_token):
            raise PermissionError('Invalid pane token')
        published = time.time() if published is None else published
        with self.lock:
            # A dropped file is read on the next poll; never let it replace a newer HTTP publish.
            if published < self.readouts_published:
                return self.readouts_info()
            self.readouts, self.readouts_published = readouts.validate(payload, published), published
        return self.readouts_info()

    def readouts_info(self):
        # Age, not a timestamp: a remote node's clock may disagree with the browser's.
        shown = self.readouts
        return shown and dict(fields=shown['fields'], ttl_seconds=shown['ttl_seconds'], age=max(0, time.time() - shown['published']))

    def output(self, cursor, wait=0):
        """Bytes from `cursor`, waiting up to `wait` seconds for some to arrive or for the process to end."""
        with self.changed:
            if wait:
                self.changed.wait_for(lambda: cursor < self.start + len(self.buffer) or self.process.poll() is not None, wait)
            offset = max(self.start, min(cursor, self.start + len(self.buffer)))
            data = bytes(self.buffer[offset - self.start:offset - self.start + 131072])
            return dict(data=base64.b64encode(data).decode(), cursor=offset + len(data),
                        truncated=cursor < self.start, exit_code=self.process.poll())

    def rename(self, name):
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100 or any(ord(c) < 32 or ord(c) == 127 for c in name):
            raise ValueError('Enter a name of 1–100 characters without control characters')
        self.display_name = name.strip()
        return self.info()

    def send(self, event):
        with self.input_lock:
            if self.process.poll() is not None:
                raise ValueError('This terminal has exited')
            try:
                with self.lock:
                    self.process.stdin.write(json.dumps(event).encode() + b'\n')
                    self.process.stdin.flush()
                    screen=getattr(self,'screen',None)
                    if event.get('op') == 'resize':
                        self.cols, self.rows = event['cols'], event['rows']
                        self.redraw_until = time.time() + REDRAW_QUIET
                        if screen:screen.observe('resize',cols=self.cols,rows=self.rows)
                    elif event.get('op')=='input' and screen:screen.observe('input')
            except (BrokenPipeError, OSError):
                raise ValueError('This terminal has exited') from None

    def send_task(self, text, before_send=None):
        """Submit only into a recognizable empty coding-agent prompt."""
        import shutil
        node = shutil.which('node')
        if not node:
            raise ValueError('Node.js is required to check the worker prompt before sending')
        if not text or len(text.encode()) > 16000 or any(ord(c)<32 and c not in '\n\t' for c in text):
            raise ValueError('Invalid worker follow-up text')
        profile = self.launch_profile or (Path(self.argv[0]).name if Path(self.argv[0]).name in SINGLE else '')
        harness = harness_of(profile) or profile
        if harness not in PROMPTS:
            raise ValueError('This worker does not have a supported coding-agent prompt')
        with self.input_lock:
            if self.process.poll() is not None:
                raise ValueError('This worker has exited')
            tracker=getattr(self,'screen',None)
            if tracker:
                with self.lock:
                    tracker.check()
                    if before_send:before_send()
                    self.submit(text,harness)
                return
            with self.lock:
                screen=bytes(self.buffer);start=self.start
            if start>getattr(self,'origin',0):
                raise ValueError('Worker screen history is incomplete. Send the follow-up manually in its terminal')
            result=subprocess.run([node,str(Path(__file__).resolve().parents[1]/'scripts'/'worker_prompt.cjs')],
                input=json.dumps(dict(data=base64.b64encode(screen).decode(),cols=self.cols,rows=self.rows,harness=harness)),
                text=True,capture_output=True,timeout=4)
            if result.returncode or not json.loads(result.stdout).get('ready'):
                raise WorkerNotReady('Worker prompt is busy, contains a draft, or is not recognized. Inspect its terminal; no follow-up was sent')
            with self.lock:
                if self.start!=start or bytes(self.buffer)!=screen:
                    raise WorkerNotReady('Worker output changed while checking its prompt. No follow-up was sent')
            # One ordered supervisor input event prevents user keystrokes from
            # interleaving between the paste and submission.
            if before_send:
                before_send()
            self.submit(text,harness)

    def submit(self, text, harness):
        paste=b'\x1b[200~'+text.encode()+b'\x1b[201~'
        if harness!='opencode':
            return self.send(dict(op='input',data=base64.b64encode(paste+b'\r').decode()))
        # OpenCode drops an Enter that arrives with the paste. The caller holds
        # the input lock, so nothing typed can land between the two writes.
        self.send(dict(op='input',data=base64.b64encode(paste).decode()))
        time.sleep(.5)
        self.send(dict(op='input',data=base64.b64encode(b'\r').decode()))

    def stop(self):
        from agent_desk.managed_processes import OwnedProcesses
        owned = OwnedProcesses(self.process.pid) if self.process.poll() is None else None
        if self.process.poll() is None:
            try:
                self.send(dict(op='stop'))
            except ValueError:
                pass
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
        if owned:owned.stop()
        self.reader.join(timeout=2)
        self.process.stdin.close()


class TerminalManager:
    def __init__(self, desk=None, store=None):
        self.desk = desk
        self.readouts_dir = None
        self.sessions = {}
        self.external_parents = set()
        self.lock = threading.Lock()
        self.usage_sample = None
        self.usage_cache = None
        # Optional terminal_restore.SessionStore; only the supervisor records sessions.
        self.store, self.store_lock, self.closing = store, threading.Lock(), False

    def launch(self, payload, coordinator=None, identity=None, origin=0, banner=b'', persist=True):
        from agent_desk.accounts import account
        from agent_desk.launch_profiles import infer_profile
        if coordinator and coordinator['harness']=='grok' and not shutil.which('node'):
            raise ValueError('Native Grok coordination requires Node.js for background terminal observation')
        launch_profile = payload.get('launch_profile')
        if launch_profile is not None and (not isinstance(launch_profile,str) or not account(launch_profile)):
            raise ValueError('Unknown launch account profile')
        cwd = payload.get('cwd', str(Path.home()))
        argv = payload.get('argv', [os.environ.get('SHELL', '/bin/zsh'), '-l'])
        name = payload.get('name', 'Terminal')
        if not isinstance(cwd, str) or not os.path.isabs(cwd) or not Path(cwd).is_dir():
            raise ValueError('Choose an existing absolute working directory')
        if not isinstance(argv, list) or not 1 <= len(argv) <= 100 or any(not isinstance(s, str) or not s or '\0' in s or len(s) > 10000 for s in argv):
            raise ValueError('Command must be a list of executable and arguments')
        if 'launch_profile' not in payload:
            launch_profile = infer_profile(argv)
        if not isinstance(name, str) or not 1 <= len(name) <= 100:
            raise ValueError('Name must contain 1–100 characters')
        executable = shutil.which(argv[0])
        if not executable:
            raise ValueError('Executable not found: ' + argv[0])
        with self.lock:
            for key in list(self.sessions):
                if len(self.sessions) >= 64 and self.sessions[key].process.poll() is not None:
                    self.sessions.pop(key).stop()
            parent_id = payload.get('parent_id')
            if parent_id is not None and (not isinstance(parent_id,str) or parent_id not in self.sessions and parent_id not in self.external_parents):
                raise ValueError('Parent must be an existing managed terminal')
            if identity in self.sessions:
                raise ValueError('Terminal ID is already in use')
            session = TerminalSession(cwd, [executable, *argv[1:]], name, parent_id, coordinator, launch_profile, self.desk,
                                      self.readouts_folder(), identity, origin, banner, self.persist)
            self.sessions[session.id] = session
        if persist:
            self.persist()
        return session

    def persist(self):
        """Record the running terminals a replacement supervisor should restore."""
        if self.store is None or self.closing:
            return
        from agent_desk.terminal_restore import record, restorable
        with self.lock:
            records = [record(s) for s in self.sessions.values() if restorable(s, self.external_parents)]
        with self.store_lock:
            if not self.closing:
                self.store.save(records)

    def capture_conversations(self, config_dirs=None):
        """Record each agent terminal's current native conversation ID."""
        from agent_desk.terminal_restore import observe
        with self.lock:
            sessions = list(self.sessions.values())
        changed = False
        observed = observe(sessions, config_dirs)
        for session in sessions:
            native = observed.get(session.id)
            if native and session.native_session != native:
                session.native_session, changed = native, True
        if changed:
            self.persist()
        return observed

    def watch_conversations(self, interval=5, stopped=None):
        stopped = stopped or threading.Event()
        while not stopped.wait(interval):
            try:
                self.capture_conversations()
            except Exception as error:  # Keep observing; a missed sample only delays capture.
                print(f'Native conversation capture failed: {error!r}', file=sys.stderr, flush=True)

    def get(self, identity):
        with self.lock:
            if identity not in self.sessions:
                raise ValueError('Terminal not found')
            return self.sessions[identity]

    def output(self, identity, cursor, wait=0):
        return self.get(identity).output(cursor, wait)

    def send(self, identity, event):
        return self.get(identity).send(event)

    def list(self):
        self.collect_dropped_readouts()
        usage = self.usage()
        with self.lock:
            sessions = list(self.sessions.values())
        return [dict(session.info(), **usage.get(session.id, {})) for session in sessions]

    def reset_usage(self):
        """Forget both the CPU baseline and the cached reading, so the next call samples afresh."""
        with self.lock:
            self.usage_sample = None
            self.usage_cache = None

    def usage(self, now=None):
        """Memory and CPU for each live terminal, counting the agent and everything it started.

        CPU is the share of one core used since the previous sample, so it reads like `top` rather
        than `ps`, whose percentage is an average over the whole life of the process.
        """
        now = time.monotonic() if now is None else now
        with self.lock:
            roots = {session.id: session.process.pid for session in self.sessions.values() if session.process.poll() is None}
            cached = self.usage_cache
        # Several callers can ask within one poll; one `ps` per second is plenty for a status line.
        if cached and now - cached[0] < 1 and set(cached[1]) == set(roots):
            return cached[1]
        if not roots:
            self.usage_sample = None
            self.usage_cache = None
            return {}
        try:
            listing = subprocess.run(['ps', '-axo', 'pid=,ppid=,rss=,time='], capture_output=True, text=True, timeout=3)
        except (OSError, subprocess.SubprocessError):
            return {}
        processes = {}
        children = {}
        for line in listing.stdout.splitlines():
            fields = line.split()
            if len(fields) != 4:
                continue
            try:
                pid, parent, rss = int(fields[0]), int(fields[1]), int(fields[2])
            except ValueError:
                continue
            processes[pid] = (rss, _cpu_seconds(fields[3]))
            children.setdefault(parent, []).append(pid)
        previous = self.usage_sample
        elapsed = now - previous[0] if previous else 0
        totals, sample = {}, {}
        for identity, pid in roots.items():
            if pid not in processes:
                continue
            memory = seconds = 0
            queue, seen = [pid], set()
            while queue:
                current = queue.pop()
                if current in seen or current not in processes:
                    continue
                seen.add(current)
                queue.extend(children.get(current, ()))
                rss, cpu_seconds = processes[current]
                memory += rss
                seconds += cpu_seconds
            sample[identity] = seconds
            entry = {'memory_kb': memory, 'processes': len(seen), 'cpu_percent': None}
            if previous and identity in previous[1] and elapsed > 0:
                # A restarted pid can report less CPU time than the last sample; report nothing rather than a negative.
                used = seconds - previous[1][identity]
                entry['cpu_percent'] = round(max(0.0, used) / elapsed * 100, 1)
            totals[identity] = entry
        self.usage_sample = (now, sample)
        with self.lock:
            self.usage_cache = (now, totals)
        return totals

    def readouts_folder(self):
        """This desk's private folder for readouts from pane processes whose network is sandboxed."""
        try:
            if self.readouts_dir is None:
                self.readouts_dir = os.path.join(readouts.drop_root(), secrets.token_hex(8))
            return readouts.private_dir(self.readouts_dir, create=True)
        except OSError:
            logging.warning('Readouts folder is unavailable; sandboxed panes can only set readouts over HTTP', exc_info=True)
            return None

    def collect_dropped_readouts(self):
        """Apply readouts that pane processes handed over on disk."""
        with self.lock:
            folder = self.readouts_dir
        if folder is None:
            return
        # Only a launch creates the folder, so a poll after close() cannot leave one behind.
        try:
            names = [n for n in os.listdir(readouts.private_dir(folder)) if n.startswith('terminal-') and n.endswith('.json')]
        except FileNotFoundError:
            return
        except OSError:
            logging.warning('Readouts folder is unavailable', exc_info=True)
            return
        for name in names:
            path = os.path.join(folder, name)
            try:
                info = os.lstat(path)
                data = None
                if stat.S_ISREG(info.st_mode):  # never open a FIFO or follow a symlink someone left here
                    with open(path, 'rb') as stream:
                        data = stream.read(8192)
                os.unlink(path)  # consumed once, even if it turns out to be invalid
                payload = json.loads(data) if data is not None else None
                with self.lock:
                    session = self.sessions.get(name[:-len('.json')])
                if session and isinstance(payload, dict):
                    session.set_readouts(payload.get('token'), payload, min(info.st_mtime, time.time()))
            except (OSError, ValueError):
                # Writers validate first; anything rejected here was not written by Agent Desk's tools.
                logging.warning('Ignored readouts file %s', name, exc_info=True)

    def child_pids(self):
        with self.lock:
            owned = {s.process.pid for s in self.sessions.values() if s.process.poll() is None}
        if not owned:
            return set()
        try:
            result = subprocess.run(['ps', '-axo', 'pid=,ppid='], capture_output=True, text=True, timeout=2)
            tree = [tuple(map(int, line.split())) for line in result.stdout.splitlines() if len(line.split()) == 2]
            while True:
                expanded = owned | {pid for pid, parent in tree if parent in owned}
                if expanded == owned:
                    return owned
                owned = expanded
        except (OSError, ValueError, subprocess.SubprocessError):
            return owned

    def close(self):
        # Supervisor teardown is not a user stop: keep records for restore.
        self.closing = True
        with self.lock:
            sessions = list(self.sessions.values())
        for session in sessions:
            session.stop()
        if self.readouts_dir is not None:
            shutil.rmtree(self.readouts_dir, ignore_errors=True)
