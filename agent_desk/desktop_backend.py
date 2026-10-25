"""Desktop-only Unix HTTP listener and authenticated lifecycle operations."""
import fcntl
import atexit
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import socketserver
import threading
import time

from agent_desk.local_transport import (PROTOCOL, desk_url, private_directory,
                                       runtime_directory, write_private_json, workspace_key)


class DesktopHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, data_dir, workspace, handler):
        self.workspace_key = workspace_key(workspace)
        self.desk_url = desk_url(workspace)
        self.server_name = 'app'
        self.server_port = 0  # no TCP socket; callers use workspace_key for identity
        self.desktop = True
        self.folder = runtime_directory(data_dir, workspace)
        self.owner = (self.folder / 'backend.lock').open('a')
        try:
            fcntl.flock(self.owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.owner.close()
            raise OSError('A desktop backend already owns this workspace; reconnect or recover it') from None
        self.socket_path = self.folder / 'backend.sock'
        # Holding the lifetime lock is required before removing a stale endpoint.
        if self.socket_path.is_symlink():
            self.owner.close()
            raise PermissionError('Refusing a symlink at the backend socket')
        self.socket_path.unlink(missing_ok=True)
        try:
            super().__init__(str(self.socket_path), handler)
            os.chmod(self.socket_path, 0o600)
        except BaseException:
            self.owner.close()
            raise
        self.lifecycle = threading.RLock()
        self.paused_path = Path(data_dir) / 'desktop-shutdown.json'
        self.paused = self.paused_path.exists()
        if self.paused:
            try:
                if json.loads(self.paused_path.read_text()).get('state') == 'stopped':
                    self.paused_path.unlink()
                    self.paused = False
            except (OSError, ValueError, AttributeError):
                pass  # An interrupted or unreadable shutdown still needs recovery.

    def ready(self, app):
        self.app = app
        write_private_json(self.folder / 'connection.json', {
            'protocol': PROTOCOL, 'workspace': self.workspace_key, 'pid': os.getpid(),
            'socket': str(self.socket_path), 'user_token': app.TERMINAL_TOKEN,
            'started': time.time(), 'process_start': subprocess.check_output(['ps', '-p', str(os.getpid()), '-o', 'lstart='], text=True).strip(), 'runtime': str(Path(__file__).resolve().parents[1]),
        })
        signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=self.shutdown, daemon=True).start())

    def server_close(self):
        super().server_close()
        self.socket_path.unlink(missing_ok=True)
        (self.folder / 'connection.json').unlink(missing_ok=True)
        self.owner.close()


def status(app, server):
    snapshot = app.WORKFLOWS.snapshot()
    sessions = [row for row in app.TERMINALS.list() if row.get('exit_code') is None]
    tools = []
    for path in app.TOOL_RUNTIME.state.glob('*.json'):
        try:
            item = json.loads(path.read_text())
            if app.TOOL_RUNTIME.owned(item):tools.append({'id': item['id'], 'title': item['title']})
        except (OSError, ValueError, KeyError):
            continue
    enabled = sum(bool(item.get('enabled')) for item in snapshot['workflows'])
    running = app.WORKFLOWS.shutdown_jobs()
    # Status is product data: do not expose saved prompts/argv from database rows.
    running = [{key: row[key] for key in ('id', 'state', 'pid', 'detail')} for row in running]
    coordinators = app.COORDINATORS.shutdown_activity()
    return dict(protocol=PROTOCOL, workspace=server.workspace_key, pid=os.getpid(),
                paused=server.paused, sessions=sessions, tools=tools, schedules=enabled,
                executions=running, coordinators=coordinators,
                active=bool(sessions or tools or enabled or running or any(coordinators.values())))


def lifecycle_request(handler, app):
    """This is a desktop-user capability, never available to helper tokens."""
    server = handler.server
    if not getattr(server, 'desktop', False) or not handler.at_the_desk():
        return handler.send_json({'error': 'Desktop user authorization required'}, 403)
    route = handler.path
    if handler.command == 'GET' and route == '/api/desktop/tools':
        tools=[]
        for path in app.TOOL_RUNTIME.state.glob('*.json'):
            item=app.TOOL_RUNTIME.read_record(path)
            if item and item.get('transport')=='unix-http-v1' and app.TOOL_RUNTIME.owned(item):
                tools.append({k:item[k] for k in ('id','url','socket')})
        return handler.send_json({'tools': tools})
    if handler.command == 'GET' and route == '/api/desktop/status':
        return handler.send_json(status(app, server))
    if handler.command != 'POST':
        return handler.send_json({'error': 'Not found'}, 404)
    with server.lifecycle:
        if route == '/api/desktop/resume':
            coordinators = app.COORDINATORS
            if coordinators.stopping.is_set() and (coordinators.running or any(thread and thread.is_alive() for thread in (coordinators.scheduler, coordinators.watch_thread))):
                return handler.send_json({'error': 'Coordinator work is still stopping; retry when it has exited'}, 409)
            try:
                if coordinators.stopping.is_set() or coordinators.scheduler is None:
                    coordinators.stopping.clear()
                    coordinators.scheduler = None
                    coordinators.start()
            except (OSError, ValueError) as error:
                return handler.send_json({'error': str(error), 'paused': True}, 409)
            server.paused_path.unlink(missing_ok=True)
            server.paused = False
            with app.TERMINALS.lock:app.TERMINALS.desktop_paused = False
            app.WORKFLOWS.desktop_paused.clear()
            return handler.send_json(status(app, server))
        if route != '/api/desktop/shutdown':
            return handler.send_json({'error': 'Not found'}, 404)
        server.paused = True
        with app.TERMINALS.lock:
            app.TERMINALS.desktop_paused = True
        write_private_json(server.paused_path, {'state': 'incomplete', 'started': time.time()})
        with app.WORKFLOWS.lock:
            app.WORKFLOWS.desktop_paused.set()
        # Launchers also run in helper processes. This shared file lock waits
        # for launches that passed their pause check before shutdown began.
        with app.TOOL_RUNTIME.locked():
            tools = list(app.TOOL_RUNTIME.state.glob('*.json'))
        failures = []
        # Cancel pending planner turns before taking the stable set of terminals.
        try:
            app.COORDINATORS.close(strict=True)
            app.COORDINATORS.checkpoint_workers(resolve_native=True)
        except (OSError, ValueError, sqlite3.Error) as exc:failures.append({'id': 'coordinators', 'error': str(exc)})
        for row in app.WORKFLOWS.shutdown_jobs():
            try:app.WORKFLOWS.stop_confirmed(row['id'])
            except (OSError, ValueError, KeyError) as exc:failures.append({'id': row['id'], 'error': str(exc)})
        for path in tools:
            try:
                item = json.loads(path.read_text())
                if app.TOOL_RUNTIME.owned(item):app.TOOL_RUNTIME.stop(item['id'])
            except (OSError, ValueError, KeyError) as exc:failures.append({'id': path.stem, 'error': str(exc)})
        # Shared supervisor teardown preserves its restore records. Per-terminal
        # Stop is a user action and must not be applied implicitly during quit.
        if not failures:
            try:
                for owner in app.TERMINALS.clients:owner.shutdown(for_restart=True)
            except (OSError, ValueError) as exc:failures.append({'id': 'supervisor', 'error': str(exc)})
        if failures:
            return handler.send_json({'stopped': False, 'failed': failures, 'paused': True}, 409)
        server.supervisor_drained = True
        atexit.unregister(app.COORDINATORS.close)
        write_private_json(server.paused_path, {'state': 'stopped', 'finished': time.time()})
        handler.send_json({'stopped': True})
        threading.Thread(target=server.shutdown, daemon=True).start()


def main():
    # The shell sets this before import so module-level stores never touch a checkout.
    if not os.environ.get('AGENT_DESK_DATA_DIR'):
        raise SystemExit('Desktop mode requires AGENT_DESK_DATA_DIR')
    private_directory(Path(os.environ['AGENT_DESK_DATA_DIR']).resolve())
    if os.environ.get('AGENT_DESK_LOG_DIR'):
        from agent_desk.desktop_logging import configure
        configure(os.environ['AGENT_DESK_LOG_DIR'])
    from agent_desk.server import main as serve
    serve()


if __name__ == '__main__':
    main()
