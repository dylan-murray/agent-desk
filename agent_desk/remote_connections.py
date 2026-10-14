"""Tested SSH connections: remote shells and remote coordinator environments.

A connection must pass a test bound to its exact selection before it is used.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import signal
import subprocess
import threading
import time

from agent_desk.paths import DATA_DIR
from agent_desk.ssh_connections import selection, ssh_command, target_identity, target_name

__all__ = ['RemoteConnections', 'prerequisites', 'saved_connections', 'save_connection', 'delete_connection',
    'environment', 'ssh_command', 'target_identity', 'target_name']

CONNECTIONS_FILE = DATA_DIR / 'remote-connections.json'


def environment():
    return dict(os.environ)


def prerequisites():
    return {'tools': {'ssh': bool(shutil.which('ssh'))}}


def saved_connections():
    """Saved connections, so a host is entered once rather than every time."""
    try:
        rows = json.loads(CONNECTIONS_FILE.read_text())
    except (OSError, ValueError):
        return []
    return [row for row in rows if isinstance(row, dict) and isinstance(row.get('id'), str) and row.get('transport') == 'ssh'][:50]


def save_connection(payload):
    config = selection(payload)
    label = payload.get('label') or target_name(config)
    if not isinstance(label, str) or not 1 <= len(label.strip()) <= 80:
        raise ValueError('Name this connection with 1-80 characters')
    identity = hashlib.sha256(target_identity(config).encode()).hexdigest()[:16]
    entry = dict(config, id=identity, label=label.strip(), updated=time.time())
    rows = [entry] + [row for row in saved_connections() if row['id'] != identity]
    _write_connections(rows[:50])
    return {'connections': rows[:50], 'saved': entry}


def delete_connection(payload):
    identity = payload.get('id')
    if not isinstance(identity, str) or not identity:
        raise ValueError('Choose a saved connection to remove')
    rows = [row for row in saved_connections() if row['id'] != identity]
    _write_connections(rows)
    return {'connections': rows}


def _write_connections(rows):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp = CONNECTIONS_FILE.with_suffix('.tmp')
    temp.write_text(json.dumps(rows, indent=2) + '\n')
    os.replace(temp, CONNECTIONS_FILE)


class RemoteConnections:
    def __init__(self):
        self.lock = threading.Lock()
        self.tickets = {}
        self.testing = threading.BoundedSemaphore(2)

    def test(self, payload):
        config = selection(payload)
        command = ssh_command(config)
        if not self.testing.acquire(blocking=False):
            raise ValueError('Two connection tests are already running. Try again shortly.')
        try:
            marker = 'agentdesk-'+secrets.token_hex(16)
            process = subprocess.Popen([*command, 'printf '+shlex.quote(marker)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment(), start_new_session=True)
            try:
                output, error = process.communicate(timeout=40)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL); process.communicate()
                raise ValueError('SSH test timed out. Check the host, your network, and your VPN.') from None
            if process.returncode or output.strip() != marker.encode():
                raise ValueError('SSH connection failed: '+error.decode(errors='replace')[-2000:])
            return self._ticket(config, 'Connected successfully. Remote shell responded; test connection closed.')
        finally:
            self.testing.release()

    def _ticket(self, config, message):
        ticket = secrets.token_urlsafe(32)
        with self.lock:
            self.tickets = {k:v for k,v in self.tickets.items() if v[1] > time.monotonic()}
            self.tickets[ticket] = (config, time.monotonic()+300)
        return {'ticket': ticket, 'message': message, 'expires_in': 300}

    def test_runtime(self, payload):
        result = self.test(payload)
        config = selection(payload)
        probe = "import json,sys,shutil; print('AGENT_DESK_PROBE '+json.dumps({'python_ok':sys.version_info>=(3,11),'node':bool(shutil.which('node')),'profiles':[p for p in ('claude','codex','grok') if shutil.which(p)]}))"
        try:
            check = subprocess.run([*ssh_command(config), 'bash -lc '+shlex.quote('python3 -c '+shlex.quote(probe))], capture_output=True, text=True, env=environment(), timeout=40)
            rows = [line.removeprefix('AGENT_DESK_PROBE ') for line in check.stdout.splitlines() if line.startswith('AGENT_DESK_PROBE ')]
            if check.returncode or not rows:
                raise ValueError('Remote runtime check failed. Install Python 3.11+, Node, and your agent CLI in the remote login environment.')
            info = json.loads(rows[-1])
            if not info['python_ok'] or not info['node'] or not info['profiles']:
                raise ValueError('The remote machine needs Python 3.11+, Node, and at least one of claude, codex, or grok on its login PATH.')
            result['message'] = 'SSH and remote prerequisites passed. Found: '+', '.join(info['profiles'])+'. Harness logins are used remotely and have not been changed or verified with a model call.'
            return result
        except (ValueError, subprocess.TimeoutExpired):
            with self.lock:self.tickets.pop(result['ticket'], None)
            raise ValueError('Remote runtime prerequisites did not pass. Check Python 3.11+, Node, and an installed agent CLI on the remote login PATH.') from None

    def consume(self, payload):
        config = selection(payload)
        with self.lock:
            prior = self.tickets.pop(str(payload.get('ticket', '')), None)
        if not prior or prior[0] != config or prior[1] <= time.monotonic():
            raise ValueError('Test this connection first. A successful test is valid for five minutes and one connection.')
        return config

    def connect(self, payload, terminals, desk=None):
        config = self.consume(payload)
        return terminals.launch({'cwd': str(Path.home()), 'argv': ssh_command(config, True), 'name': 'SSH · '+target_name(config)}, desk=desk).info()
