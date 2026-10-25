"""Persistent local terminal owner; HTTP servers are reconnectable clients.

The private Unix socket is scoped to a data directory and HTTP port. No input or
launch request is retried after an ambiguous disconnect. Protocol changes must
remain compatible with a running supervisor, or require explicitly draining it.
"""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import socketserver
import stat
import subprocess
import sys
import threading
import time

from agent_desk.terminals import TerminalManager
from agent_desk.local_transport import desk_url, workspace_key, runtime_directory
from agent_desk.worker_screen import WorkerNotReady

VERSION = 1
MAX_MESSAGE = 4 * 1024 * 1024
# Additive operations a client must not assume: an older supervisor outlives backend updates.
FEATURES = ('wait_output',)
# Below both ends' 30 second socket timeout.
MAX_WAIT = 20


def location(data_dir, port):
    # Keep the socket beside durable workspace state when its path fits the
    # platform limit. macOS can purge /tmp while a supervisor is still alive;
    # a replacement then binds a new socket and strands the old terminals.
    if isinstance(port, str):
        return runtime_directory(data_dir, port) / 'supervisor'
    stable = Path(data_dir).resolve() / f'.supervisor-{port}'
    if len(os.fsencode(stable / 'rpc.sock')) < 100:
        return stable
    compact = Path(data_dir).resolve() / f'.{port:x}'
    if len(os.fsencode(compact / 'rpc.sock')) < 100:
        return compact
    # A long checkout still needs a short path, but it must not live in a
    # purgeable temporary directory while terminals are running.
    identity = hashlib.sha256((str(Path(data_dir).resolve()) + ':' + str(port)).encode()).hexdigest()[:24]
    fallback = Path.home() / '.agent-desk-supervisors' / identity
    if len(os.fsencode(fallback / 'rpc.sock')) >= 100:
        raise ValueError('Home directory is too long for a durable terminal socket; use a shorter AGENT_DESK_DATA_DIR')
    return fallback


def legacy_location(data_dir, port):
    identity = hashlib.sha256((str(Path(data_dir).resolve()) + ':' + str(port)).encode()).hexdigest()[:24]
    return Path('/tmp') / f'agent-desk-{os.getuid()}-{identity}'


def existing_owners(data_dir, port):
    """Detect an orphaned socket owner before accidentally replacing its terminals."""
    import shlex
    result = subprocess.run(['ps', '-axo', 'pid=,command='], capture_output=True, text=True, timeout=5, check=True)
    owners=[]
    manifest=Path(data_dir)/f'.terminal-owner-{port}.json'
    if manifest.exists():
        try:
            pid=int(json.loads(manifest.read_text())['pid'])
            os.kill(pid,0)
            owners.append(pid)
        except ProcessLookupError:pass
        except (ValueError,KeyError):raise OSError('Terminal owner record is unreadable; inspect it before starting a replacement') from None
    for line in result.stdout.splitlines():
        try:
            pid, command=line.strip().split(None,1)
            args=shlex.split(command)
            if '-m' not in args or args[args.index('-m')+1] != 'agent_desk.terminal_supervisor':continue
            if '--shutdown' in args:continue
            if Path(args[args.index('--data-dir')+1]).resolve()!=Path(data_dir).resolve():continue
            if workspace_key(args[args.index('--port')+1])!=port:continue
            if int(pid) not in owners:owners.append(int(pid))
        except (ValueError,IndexError):continue
    return owners


def private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Terminal supervisor directory must be owned by you with mode 0700')


def write_message(stream, value):
    data = json.dumps(value).encode() + b'\n'
    if len(data) > MAX_MESSAGE:
        raise ValueError('Terminal supervisor message too large')
    stream.write(data)
    stream.flush()


def read_message(stream):
    data = stream.readline(MAX_MESSAGE + 1)
    if not data or len(data) > MAX_MESSAGE or not data.endswith(b'\n'):
        raise OSError('Terminal supervisor disconnected or sent an invalid message; input was not retried')
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError('Invalid terminal supervisor message')
    return value


def metadata(session):
    return dict(session.info(), argv=session.argv, coordinator=session.coordinator,
                pid=session.process.pid, start=session.start, cols=session.cols, rows=session.rows)


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(30)
        try:
            request = read_message(self.rfile)
            if not secrets.compare_digest(str(request.get('token', '')), self.server.token):
                raise ValueError('Terminal supervisor authentication failed')
            if request.get('version') != VERSION:
                raise ValueError('Incompatible terminal supervisor; finish sessions before updating it')
            operation = request.get('op')
            manager = self.server.manager
            if operation == 'hello':
                result = dict(version=VERSION, pid=os.getpid(), features=list(FEATURES))
            elif operation == 'list':
                result = manager.list()
            elif operation == 'parents':
                parents = request['ids']
                if not isinstance(parents, list) or any(not isinstance(p, str) for p in parents):
                    raise ValueError('Invalid coordinator identities')
                with manager.lock:
                    manager.external_parents.update(parents)
                result = None
            elif operation == 'launch':
                with self.server.lifecycle_lock:
                    if self.server.draining:
                        raise ValueError('Terminal supervisor is shutting down')
                    result = metadata(manager.launch(request['payload'], coordinator=request.get('coordinator')))
            elif operation == 'child_pids':
                result = list(manager.child_pids())
            elif operation == 'shutdown':
                # Never turn a backend update into an implicit "stop all".
                with self.server.lifecycle_lock, manager.lock:
                    if any(s.process.poll() is None for s in manager.sessions.values()):
                        raise ValueError('Terminal supervisor still has running sessions; stop them explicitly first')
                    self.server.draining = True
                result = None
            else:
                session = manager.get(request.get('id'))
                if operation == 'get':
                    result = metadata(session)
                elif operation == 'output':
                    result = session.output(int(request.get('cursor', 0)))
                elif operation == 'wait_output':
                    result = session.output(int(request.get('cursor', 0)), min(max(float(request.get('timeout', 0)), 0), MAX_WAIT))
                elif operation == 'buffer':
                    with session.lock:
                        result = base64.b64encode(session.buffer).decode()
                elif operation == 'rename':
                    result = session.rename(request.get('name'))
                    manager.persist()
                elif operation == 'readouts':
                    result = session.set_readouts(request.get('pane_token'), request.get('payload'))
                elif operation == 'parent':
                    parent = request.get('parent')
                    with manager.lock:
                        if parent not in manager.external_parents:
                            raise ValueError('Unknown coordinator')
                        session.parent_id = parent
                    manager.persist()
                    result = None
                elif operation == 'send':
                    event = request['event']
                    if event.get('op') not in ('input', 'resize'):
                        raise ValueError('Unsupported terminal input operation')
                    session.send(event)
                    result = None
                elif operation == 'stop':
                    session.stop()
                    result = None
                elif operation == 'send_task':
                    def reserve():
                        # send_task holds the input/screen locks while the web
                        # process durably records its intent. EOF aborts input.
                        write_message(self.wfile, {'reserve': True})
                        if read_message(self.rfile).get('commit') is not True:
                            raise ValueError('Terminal delivery cancelled before input')
                    session.send_task(request.get('text'), before_send=reserve)
                    result = None
                else:
                    raise ValueError('Unknown terminal supervisor operation')
            write_message(self.wfile, {'result': result})
            if operation == 'shutdown':
                threading.Thread(target=self.server.shutdown, daemon=True).start()
        except (OSError, ValueError, TypeError, KeyError) as error:
            try:
                kind = ('not_ready' if isinstance(error, WorkerNotReady) else 'permission' if isinstance(error, PermissionError)
                        else 'os_error' if isinstance(error, OSError) else 'error')
                write_message(self.wfile, {'error': str(error), 'kind': kind})
            except OSError:
                pass


class SupervisorServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True

    def verify_request(self, request, address):
        return not self.draining


def serve(data_dir, port):
    folder = location(data_dir, port)
    private_directory(folder)
    with (folder / 'owner.lock').open('a') as owner:
        try:
            fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        sock = folder / 'rpc.sock'
        sock.unlink(missing_ok=True)
        token = secrets.token_urlsafe(32)
        fd = os.open(folder / 'token', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(token)
        from agent_desk.terminal_restore import SessionStore, restore
        # Panes reach this port's web backend for readouts; the supervisor outlives backend restarts.
        manager = TerminalManager(desk=desk_url(port), store=SessionStore(Path(data_dir) / f'terminal-sessions-{port}.json'))
        # Holding owner.lock guarantees the previous owner, and so its terminals, are gone.
        restore(manager, manager.store)
        stopped = threading.Event()
        threading.Thread(target=manager.watch_conversations, kwargs=dict(stopped=stopped), daemon=True).start()
        server = SupervisorServer(str(sock), Handler)
        os.chmod(sock, 0o600)
        server.token, server.manager, server.draining = token, manager, False
        server.lifecycle_lock = threading.Lock()
        manifest=Path(data_dir)/f'.terminal-owner-{port}.json'
        fd=os.open(manifest,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
        with os.fdopen(fd,'w') as stream:json.dump({'pid':os.getpid(),'socket':str(sock)},stream)
        try:
            server.serve_forever(poll_interval=.1)
        finally:
            stopped.set()
            server.server_close()
            server.manager.close()
            sock.unlink(missing_ok=True)
            manifest.unlink(missing_ok=True)


class ExternalParents:
    def __init__(self, client):
        self.client = client

    def update(self, identities):
        self.client.call('parents', ids=list(identities))

    def add(self, identity):
        self.update([identity])


class RemoteProcess:
    def __init__(self, session, pid):
        self.session, self.pid = session, pid

    def poll(self):
        return self.session.info()['exit_code']


class RemoteSession:
    def __init__(self, client, item):
        self.client, self.id = client, item['id']
        self.cwd, self.argv, self.name = item['cwd'], item['argv'], item['name']
        self.launch_profile, self.coordinator = item['launch_profile'], item['coordinator']
        self.process = RemoteProcess(self, item['pid'])

    @property
    def parent_id(self):
        return self.info()['parent_id']

    @parent_id.setter
    def parent_id(self, parent):
        self.client.call('parent', id=self.id, parent=parent)

    @property
    def start(self):
        return self.client.call('get', id=self.id)['start']

    @property
    def buffer(self):
        return base64.b64decode(self.client.call('buffer', id=self.id))

    def info(self):
        item = self.client.call('get', id=self.id)
        return {key: value for key, value in item.items()
                if key not in ('argv', 'coordinator', 'pid', 'start', 'cols', 'rows')}

    def output(self, cursor):
        return self.client.call('output', id=self.id, cursor=cursor)

    def rename(self, name):
        return self.client.call('rename', id=self.id, name=name)

    def set_readouts(self, token, payload):
        # 'token' is the supervisor's own authentication field, so the pane's travels as pane_token.
        return self.client.call('readouts', id=self.id, pane_token=token, payload=payload)

    def send(self, event):
        return self.client.call('send', id=self.id, event=event)

    def send_task(self, text, before_send=None):
        try:return self.client.call('send_task', id=self.id, text=text, before_send=before_send)
        except WorkerNotReady as error:
            # Older owners already understand the observer's ready=false
            # result but classify every such state as retryable.
            if 'worker is shell;' in str(error):
                raise ValueError('The agent exited to a shell. Open a new agent terminal for automatic task delivery') from None
            raise
        except ValueError as error:
            if 'Worker screen observer is unavailable' in str(error):
                raise ValueError('Automatic delivery is unavailable for this pane. Your terminal is still usable manually; use Copy for agent and paste the feedback, or choose a new agent pane.') from None
            raise

    def stop(self):
        return self.client.call('stop', id=self.id)


class SupervisorClient:
    def __init__(self, data_dir, port, start=True):
        self.data_dir, self.port = Path(data_dir).resolve(), port
        self.folder = location(data_dir, port)
        # Upgrade by attaching to a reachable legacy owner. Never migrate live
        # sessions by silently choosing a new socket directory.
        legacy=legacy_location(data_dir, port)
        if not (self.folder/'rpc.sock').exists() and (legacy/'rpc.sock').exists():
            self.folder=legacy
            try:
                self.token=(legacy/'token').read_text()
                self.call('hello')
            except (FileNotFoundError,ConnectionRefusedError):
                self.folder=location(data_dir,port)
        private_directory(self.folder)
        self.external_parents = ExternalParents(self)
        self.features = None
        if start:
            self.ensure_started()
        else:
            self.token = (self.folder / 'token').read_text()

    def ensure_started(self):
        # A launch lock serializes clients; the daemon holds a separate lifetime
        # lock. Never remove a live socket or replace an incompatible daemon.
        with (self.folder / 'launch.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                self.token = (self.folder / 'token').read_text()
                self.call('hello')
                return
            except (FileNotFoundError, ConnectionRefusedError):
                pass
            owners=existing_owners(self.data_dir,self.port)
            if owners:
                raise OSError('Existing terminal supervisor is unreachable (PID '+', '.join(map(str,owners))+'). Keep it running; restore its socket before restarting Agent Desk. A replacement was not launched.')
            with (self.folder / 'owner.lock').open('a') as owner:
                try:
                    fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise OSError('Terminal supervisor is starting or unavailable; retry the backend without stopping your sessions') from None
            self.data_dir.mkdir(parents=True, exist_ok=True)
            log_path = self.data_dir / f'terminal-supervisor-{self.port}.log'
            fd = os.open(log_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            with os.fdopen(fd, 'ab') as log:
                process = subprocess.Popen([sys.executable, '-m', 'agent_desk.terminal_supervisor',
                                            '--data-dir', str(self.data_dir), '--port', str(self.port)],
                                           cwd=Path(__file__).resolve().parents[1], stdin=subprocess.DEVNULL,
                                           stdout=log, stderr=log, start_new_session=True, close_fds=True)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise OSError('Terminal supervisor failed to start; inspect ' + str(log_path))
                try:
                    self.token = (self.folder / 'token').read_text()
                    self.call('hello')
                    # Reap the detached process if it later drains while this
                    # client is still alive; backend exit does not stop it.
                    threading.Thread(target=process.wait, daemon=True).start()
                    return
                except (FileNotFoundError, ConnectionRefusedError):
                    time.sleep(.05)
            raise OSError('Timed out starting terminal supervisor; inspect ' + str(log_path))

    def call(self, operation, before_send=None, socket_timeout=30, **fields):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(socket_timeout)
            connection.connect(str(self.folder / 'rpc.sock'))
            with connection.makefile('rwb') as stream:
                write_message(stream, dict(token=self.token, version=VERSION, op=operation, **fields))
                response = read_message(stream)
                if response.get('reserve') is True:
                    # If the callback fails, closing this connection prevents
                    # the supervisor from injecting the task into the terminal.
                    if before_send:
                        before_send()
                    write_message(stream, {'commit': True})
                    response = read_message(stream)
                if 'error' in response:
                    error = {'not_ready': WorkerNotReady, 'permission': PermissionError, 'os_error': OSError}.get(response.get('kind'), ValueError)
                    raise error(response['error'])
                return response['result']

    def launch(self, payload, coordinator=None):
        if coordinator:
            coordinator = dict(coordinator, db=str(coordinator['db']))
        return RemoteSession(self, self.call('launch', payload=payload, coordinator=coordinator))

    def get(self, identity):
        return RemoteSession(self, self.call('get', id=identity))

    def output(self, identity, cursor, wait=0):
        if wait and self.features is None:
            self.features = set(self.call('hello').get('features', ()))
        if wait and 'wait_output' in self.features:
            try:
                return self.call('wait_output', id=identity, cursor=cursor, timeout=wait)
            except ValueError as error:
                # Replaced by an older supervisor since this client asked.
                if 'Unknown terminal supervisor operation' not in str(error):
                    raise
                self.features = set()
        # An older supervisor cannot wait, so poll it here rather than from every browser tab.
        deadline = time.monotonic() + wait
        while True:
            output = self.call('output', id=identity, cursor=cursor)
            if output['data'] or output['truncated'] or output['exit_code'] is not None or time.monotonic() >= deadline:
                return output
            time.sleep(.05)

    def send(self, identity, event):
        return self.call('send', id=identity, event=event)

    def list(self):
        return self.call('list')

    def child_pids(self):
        return set(self.call('child_pids'))

    def close(self):
        """Detach only. Stopping sessions always requires an explicit stop."""

    def shutdown(self):
        from agent_desk.managed_processes import OwnedProcesses
        pid = self.call('hello', socket_timeout=2)['pid']  # authenticated over the private socket
        owned = OwnedProcesses(pid)
        try:
            result = self.call('shutdown', socket_timeout=2)  # refuses if any session is still alive
        except OSError:
            # A verified owner that stops responding still belongs to this
            # explicit shutdown. ValueError (live sessions) never takes this path.
            owned.stop()
            return None
        deadline = time.monotonic() + 2
        while owned.remaining() and time.monotonic() < deadline:time.sleep(.05)
        if owned.remaining():owned.stop()
        return result


def main():
    from agent_desk.paths import DATA_DIR
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', default=str(DATA_DIR))
    parser.add_argument('--port', type=workspace_key, default=4310)
    parser.add_argument('--shutdown', action='store_true', help='Stop an idle supervisor; refuses while sessions are running')
    args = parser.parse_args()
    if args.shutdown:
        try:
            SupervisorClient(args.data_dir, args.port, start=False).shutdown()
        except (OSError, ValueError) as error:
            parser.exit(1, str(error) + '\n')
    else:
        serve(args.data_dir, args.port)


if __name__ == '__main__':
    main()
