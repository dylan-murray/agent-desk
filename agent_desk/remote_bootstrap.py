"""Reviewed deployment script sent through SSH; receives only packaged app code."""
# This module is also executable via python -c without Agent Desk installed.
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
import zipfile
import fcntl


def main():
    os.umask(0o077)
    if sys.version_info < (3, 11):
        raise RuntimeError('Remote Agent Desk requires Python 3.11 or newer')
    request = json.loads(sys.stdin.readline(32_000_000))
    data = base64.b64decode(request['bundle'], validate=True)
    version = hashlib.sha256(data).hexdigest()
    if version != request['version']:
        raise RuntimeError('Runtime bundle checksum mismatch')
    base = Path.home() / '.local/share/agent-desk'
    state = base / 'remote-state'
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / 'bootstrap.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        root = base / 'remote-runtime' / version
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for name in archive.namelist():
                path = Path(name)
                if path.is_absolute() or '..' in path.parts or path.parts[0] not in ('agent_desk', 'scripts'):
                    raise RuntimeError('Invalid runtime bundle path')
            archive.extractall(root)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        def alive():
            try:
                meta = json.loads((state / 'node.json').read_text())
                req = urllib.request.Request(f"http://127.0.0.1:{meta['port']}/api/remote-node/info", headers={'X-Agent-Desk-Terminal': meta['token']})
                with opener.open(req, timeout=2) as response:
                    result = json.load(response)
                return meta, result
            except (OSError, ValueError):
                return None
        running = alive()
        if running and running[0].get('version') != version:
            raise RuntimeError('A different Agent Desk runtime is already running in this space. Stop it explicitly before upgrading; active agents were not interrupted.')
        if not running:
            env = dict(os.environ, AGENT_DESK_DATA_DIR=str(state), AGENT_DESK_REMOTE_NATIVE='1', AGENT_DESK_REMOTE_VERSION=version)
            env['PYTHONPATH'] = str(root)
            with (state / 'runtime.log').open('ab') as log:
                subprocess.Popen([sys.executable, '-m', 'agent_desk.remote_node'], cwd=root, env=env,
                    stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
            for _ in range(100):
                time.sleep(.1)
                running = alive()
                if running:
                    break
            if not running:
                raise RuntimeError('Remote runtime did not start. Inspect ~/.local/share/agent-desk/remote-state/runtime.log on the remote machine.')
        print('AGENT_DESK_REMOTE_READY ' + json.dumps({'root': str(root), 'state': str(state), **running[1]}), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Only our operational errors are surfaced, never environment contents.
        print('AGENT_DESK_REMOTE_ERROR ' + (str(error) if isinstance(error, RuntimeError) else 'Remote runtime setup failed'), flush=True)
        sys.exit(1)
