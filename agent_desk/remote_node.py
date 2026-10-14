"""Private remote runtime and SSH stdio bridge. No public listener required."""
import json
import os
from pathlib import Path
import shutil
import signal
import sys
import threading
import urllib.error
import urllib.request


def info():
    return {'home': str(Path.home()), 'python': sys.version.split()[0],
            'node': bool(shutil.which('node')), 'profiles': [p for p in ('claude', 'codex', 'grok') if shutil.which(p)],
            'credentials': 'remote-environment'}


def serve():
    # Set before importing any runtime modules; all credentials stay on this host.
    os.environ['AGENT_DESK_REMOTE_NATIVE'] = '1'
    from agent_desk import server as app
    from agent_desk.paths import DATA_DIR
    try:port = json.loads((DATA_DIR / 'node.json').read_text())['port']
    except (OSError, ValueError, KeyError):port = 0
    server = app.ThreadingHTTPServer(('127.0.0.1', port), app.Handler)
    port = server.server_port
    app.DEVELOPMENT = False
    app.COORDINATORS.desk = f'http://127.0.0.1:{port}'
    app.WORKFLOWS.desk = app.COORDINATORS.desk
    app.TERMINALS.terminals.desk = app.COORDINATORS.desk
    DATA_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    # agent_control's worker replies use the runtime's current adapter token.
    for name, value in [(f'.adapter-token-{port}', app.TOKEN), ('node.json', json.dumps({'port': port, 'pid': os.getpid(), 'token': app.TERMINAL_TOKEN, 'version': os.environ.get('AGENT_DESK_REMOTE_VERSION', '')}))]:
        path = DATA_DIR / name
        with os.fdopen(os.open(path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600), 'w') as stream:
            stream.write(value)
    app.COORDINATORS.start()
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    try:
        server.serve_forever()
    finally:
        app.COORDINATORS.close()
        app.TERMINALS.close()
        server.server_close()


def bridge():
    """One authenticated SSH stream; remote API requests retain HTTP status codes."""
    from agent_desk.paths import DATA_DIR
    metadata = json.loads((DATA_DIR / 'node.json').read_text())
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    output_lock = threading.Lock()
    def respond(request):
        try:
            path = request['path']
            if not path.startswith(('/api/coordinators', '/api/terminals/', '/api/coordinator-events', '/api/agents', '/api/remote-node/info')):
                raise ValueError('Unsupported remote operation')
            data = json.dumps(request['payload']).encode() if request.get('payload') is not None else None
            target = urllib.request.Request(f"http://127.0.0.1:{metadata['port']}" + path, data=data,
                headers={'X-Agent-Desk-Terminal': metadata['token'], 'Content-Type': 'application/json'})
            try:
                with opener.open(target, timeout=150) as result:
                    status, body = result.status, result.read(8_000_000)
            except urllib.error.HTTPError as error:
                status, body = error.code, error.read(100000)
            response = {'id': request['id'], 'status': status, 'data': json.loads(body)}
        except Exception:
            response = {'id': request.get('id'), 'status': 502, 'data': {'error': 'Remote runtime unavailable. Reconnect this remote environment.'}}
        with output_lock:
            print(json.dumps(response), flush=True)
    # Bounded concurrency allows terminal polling while a reader request runs.
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=8) as pool:
        for line in sys.stdin:
            if len(line) > 200000:
                break
            try:
                request = json.loads(line)
                pool.submit(respond, request)
            except ValueError:
                break


if __name__ == '__main__':
    bridge() if '--bridge' in sys.argv else serve()
