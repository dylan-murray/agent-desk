"""Local registry and namespaced API transport for remote Agent Desk runtimes."""
import base64
from concurrent.futures import Future
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import shlex
import subprocess
import threading
import zipfile

from agent_desk.paths import DATA_DIR, PACKAGE_DIR, SCRIPTS_DIR
from agent_desk.remote_connections import environment, ssh_command, target_identity, target_name

ID_FIELDS = {'id', 'parent_id', 'worker_id', 'worker', 'controller', 'coordinator', 'task_id', 'resumed_worker', 'terminal_id'}


def translate(value, node, outward=True, key=None):
    """Translate identifiers, never task text, CLI session IDs, paths, or code."""
    prefix = 'remote:' + node + ':'
    if isinstance(value, dict):
        return {k: translate(v, node, outward, k) for k, v in value.items()}
    if isinstance(value, list):
        return [translate(v, node, outward, key) for v in value]
    if key in ID_FIELDS and isinstance(value, str) and value:
        if outward:
            return prefix + value
        if value.startswith(prefix):
            return value[len(prefix):]
        if value.startswith('remote:'):
            raise ValueError('Cannot send identifiers from a different remote environment')
    return value


def bundle():
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for folder in (PACKAGE_DIR, SCRIPTS_DIR):
            for path in sorted(folder.rglob('*')):
                relative = path.relative_to(folder)
                if not path.is_file() or path.is_symlink() or '__pycache__' in relative.parts:
                    continue
                if path.suffix not in ('.py', '.js', '.cjs', '.css', '.html', '.svg'):
                    continue
                if folder == PACKAGE_DIR and relative.parts[0] != 'static' and path.suffix != '.py':
                    continue
                item = zipfile.ZipInfo(folder.name + '/' + relative.as_posix())
                item.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(item, path.read_bytes())
    data = output.getvalue()
    return {'version': hashlib.sha256(data).hexdigest(), 'bundle': base64.b64encode(data).decode()}


class SSHBridge:
    def __init__(self, config, info):
        command = shlex.join(['env', 'AGENT_DESK_DATA_DIR=' + info['state'], 'PYTHONPATH=' + info['root'], 'python3', '-m', 'agent_desk.remote_node', '--bridge'])
        self.process = subprocess.Popen([*ssh_command(config), 'bash -lc ' + shlex.quote(command)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding='utf-8', env=environment(), start_new_session=True)
        self.lock = threading.Lock()
        self.pending = {}
        self.closed = False
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        try:
            for line in self.process.stdout:
                try:
                    reply = json.loads(line)
                except ValueError:
                    continue  # Remote shell banners are not protocol responses.
                if not isinstance(reply, dict):
                    continue
                with self.lock:
                    future = self.pending.pop(reply.get('id'), None)
                if future:
                    future.set_result(reply)
        finally:
            self.close()
            self.process.stdout.close()

    def request(self, path, payload=None):
        identity = secrets.token_hex(12)
        future = Future()
        with self.lock:
            if self.closed:
                raise ValueError('Remote environment disconnected. Reconnect the environment; remote work may still be running.')
            self.pending[identity] = future
            try:
                self.process.stdin.write(json.dumps({'id': identity, 'path': path, 'payload': payload}) + '\n')
                self.process.stdin.flush()
            except OSError:
                self.pending.pop(identity, None)
                raise ValueError('SSH disconnected. Check the remote session before retrying an action.') from None
        try:
            reply = future.result(timeout=160)
        except TimeoutError:
            with self.lock:
                self.pending.pop(identity, None)
            raise ValueError('Remote response timed out. The action may have run; inspect the session before retrying.') from None
        if reply['status'] >= 400:
            raise ValueError(reply['data'].get('error', 'Remote request failed'))
        return reply['data']

    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            pending, self.pending = self.pending, {}
        for future in pending.values():
            future.set_exception(ValueError('SSH disconnected. Remote work may continue; reconnect before retrying.'))
        if self.process.poll() is None:
            self.process.terminate()
            try:self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill();self.process.wait(timeout=2)
        self.process.stdin.close()
        # Only the SSH bridge stops. The runtime and its workers remain remote.


class RemoteEnvironments:
    def __init__(self, path=None):
        self.path = Path(path or DATA_DIR / 'remote-environments.json')
        self.lock = threading.RLock()
        self.bridges = {}
        self.connecting = set()
        self.stopping = threading.Event()
        try:
            self.nodes = json.loads(self.path.read_text())
        except FileNotFoundError:
            self.nodes = {}
        for node in self.nodes.values():
            node['connected'] = False

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temp = self.path.with_suffix('.tmp')
        with os.fdopen(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as stream:
            json.dump(self.nodes, stream)
        os.replace(temp, self.path)

    def list(self):
        with self.lock:
            return [{k: v for k, v in n.items() if k not in ('agents', 'coordinators', 'tasks')} for n in self.nodes.values()]

    def attach(self, config):
        identity = hashlib.sha256(target_identity(config).encode()).hexdigest()[:16]
        with self.lock:
            if identity in self.connecting:
                raise ValueError('This remote environment is already connecting')
            self.connecting.add(identity)
        try:
            from agent_desk import remote_bootstrap
            code = Path(remote_bootstrap.__file__).read_text()
            result = subprocess.run([*ssh_command(config), 'bash -lc ' + shlex.quote('python3 -c ' + shlex.quote(code))],
                input=json.dumps(bundle()) + '\n', capture_output=True, text=True, env=environment(), timeout=120)
            ready = [line.removeprefix('AGENT_DESK_REMOTE_READY ') for line in result.stdout.splitlines() if line.startswith('AGENT_DESK_REMOTE_READY ')]
            if result.returncode or not ready:
                errors = [line.removeprefix('AGENT_DESK_REMOTE_ERROR ') for line in result.stdout.splitlines() if line.startswith('AGENT_DESK_REMOTE_ERROR ')]
                raise ValueError(errors[-1] if errors else 'Could not prepare remote runtime. The remote machine needs Python 3.11+, Node, and an installed agent CLI.')
            info = json.loads(ready[-1])
            bridge = SSHBridge(config, info)
            try:
                bridge.request('/api/remote-node/info')
            except Exception:
                bridge.close()
                raise
            with self.lock:
                old = self.bridges.get(identity)
                self.bridges[identity] = bridge
                prior = self.nodes.get(identity, {})
                self.nodes[identity] = dict(prior, id=identity, name=target_name(config), config=config, connected=True,
                    home=info['home'], profiles=info['profiles'], node=info['node'], credentials='remote-environment')
                self._save()
            if old:
                old.close()
            self._poll(identity, bridge)
            threading.Thread(target=self._watch, args=(identity, bridge), daemon=True).start()
            return next(n for n in self.list() if n['id'] == identity)
        except subprocess.TimeoutExpired:
            raise ValueError('Remote setup timed out. Reconnect to inspect the runtime; setup is safe to retry.') from None
        finally:
            with self.lock:
                self.connecting.discard(identity)

    def _poll(self, identity, bridge):
        agents = [a for a in bridge.request('/api/agents')['agents'] if a.get('coordinator_workspace') or a.get('terminal_id') or a.get('harness_internal')]
        coordinators = bridge.request('/api/coordinators')['coordinators']
        tasks = bridge.request('/api/coordinator-events')['tasks']
        with self.lock:
            if self.bridges.get(identity) is not bridge:
                return
            self.nodes[identity].update(agents=agents, coordinators=coordinators, tasks=tasks, connected=True)
            self._save()

    def _watch(self, identity, bridge):
        while not self.stopping.wait(3):
            try:
                self._poll(identity, bridge)
            except (ValueError, OSError):
                with self.lock:
                    if self.bridges.get(identity) is bridge:
                        self.nodes[identity]['connected'] = False
                        self._save()
                return
            with self.lock:
                if self.bridges.get(identity) is not bridge:
                    return

    @staticmethod
    def identity(value):
        if isinstance(value, str) and value.startswith('remote:'):
            parts = value.split(':', 2)
            if len(parts) == 3:
                return parts[1]
        return None

    def request(self, node, path, payload=None):
        with self.lock:
            bridge = self.bridges.get(node)
        if not bridge or not self.nodes.get(node, {}).get('connected'):
            raise ValueError('Reconnect this remote environment first. Remote work may still be running.')
        if path == '/api/coordinators/create':
            info = self.nodes[node]
            if not info.get('node') or payload.get('profile') not in info.get('profiles', []):
                raise ValueError('Choose an installed remote harness; Node must also be available on the remote machine')
        forwarded = translate(payload, node, False)
        if isinstance(forwarded, dict):forwarded.pop('remote_node', None)
        raw = bridge.request(path, forwarded)
        result = translate(raw, node)
        with self.lock:
            info = self.nodes[node]
            def located(record):
                record.update(remote_node=node, remote_name=info['name'], remote_connected=info['connected'])
                return record
            if isinstance(result, dict):
                if 'coordinators' in result:
                    result['coordinators'] = [located(c) for c in result['coordinators']]
                if path == '/api/coordinators/create':
                    located(result)
                    info.setdefault('coordinators', []).append(raw)
                    info.setdefault('agents', []).append(dict(raw, coordinator_workspace=True, controller=True,
                        source='coordinator', harness=raw['profile'].split('-')[0], status=raw['state'],
                        project=Path(raw['cwd']).name, exit_code=None, events=[]))
        if payload is not None and path.startswith('/api/coordinators/') and path.rsplit('/',1)[-1] in ('create','close','reopen','rename','retire-worker','resume-worker'):
            try:self._poll(node, bridge)
            except (ValueError, OSError):
                # A successful action must not become a failed create just because
                # the follow-up refresh disconnected. Preserve its returned ID.
                with self.lock:
                    self.nodes[node]['connected'] = False
                    self._save()
        return result

    def records(self, field):
        with self.lock:
            rows = []
            for identity, node in self.nodes.items():
                for record in node.get(field, []):
                    row = translate(record, identity)
                    row.update(remote_node=identity, remote_name=node['name'], remote_connected=node['connected'])
                    if field == 'agents':
                        # The page shows this beside the name; a remote may only supply a number.
                        if type(row.get('pid')) is not int:
                            row.pop('pid', None)
                        row['launch_label'] = 'Remote · ' + node['name'] + ' · ' + str(row.get('harness', 'agent'))
                        if not node['connected']:
                            row.update(status='unknown', task='Remote environment disconnected · remote work may continue')
                    rows.append(row)
            return rows

    def close(self):
        self.stopping.set()
        for bridge in list(self.bridges.values()):
            bridge.close()
