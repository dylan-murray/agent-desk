"""Local agent dashboard. Python standard library only."""
from agent_desk.paths import DATA_DIR, STATIC_DIR
import argparse
import atexit
import json
import math
import os
import re
import secrets
import subprocess
import socketserver
import threading
import time
import http.server
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from agent_desk.terminals import TerminalManager, input_event, resize_event
from agent_desk.terminal_stream import TerminalStream
from agent_desk import websocket
from agent_desk.projects import discover_projects, create_directory
from agent_desk.workflow_runtime import WorkflowRuntime
from agent_desk.event_bus import EventError, MAX_BYTES
from agent_desk import desk_tokens, pane_guard, skill_harnesses, tool_registration, web_pages
from agent_desk.conversation_bridge import ConversationBridge
from agent_desk.special_agents import SpecialAgents, launch_payload
from agent_desk.tool_runtime import ToolRuntime
from scripts.control_mailbox import Mailbox
from agent_desk.coordinator_runtime import CoordinatorRuntime
from agent_desk.feedback_delivery import submit_feedback, drain_feedback, feedback_status, cancel_feedback
from agent_desk.feedback_history import archive_feedback
from agent_desk.remote_connections import (RemoteConnections, prerequisites as remote_prerequisites,
                                  saved_connections as remote_saved, save_connection as remote_save,
                                  delete_connection as remote_delete)
from agent_desk.remote_environments import RemoteEnvironments
from agent_desk.launch_profiles import remote_native
from agent_desk import accounts, model_router
from agent_desk.desks import Desks


class ThreadingHTTPServer(http.server.ThreadingHTTPServer):
    def server_bind(self):
        # http.server names the bound address with socket.getfqdn, which stalls for about
        # 35 seconds where reverse DNS is slow (GitHub's macOS runners, some VPNs). Loopback needs no name.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]
REMOTES = RemoteEnvironments()
atexit.register(REMOTES.close)
CONNECTIONS = RemoteConnections()
CONVERSATIONS = ConversationBridge(DATA_DIR)
TOOL_RUNTIME = ToolRuntime()

ROOT = Path(__file__).resolve().parents[1]
SPECIAL_AGENTS = SpecialAgents(DATA_DIR / 'special-agents.sqlite3')
WORKFLOWS = WorkflowRuntime()
TOKEN = secrets.token_urlsafe(32)
TERMINAL_TOKEN = secrets.token_urlsafe(32)
# Local helpers get their own token, kept in an owner-only file. The page's token never touches disk,
# so the two can be told apart: see pane_guard.
HELPER_TOKEN = secrets.token_urlsafe(32)
TERMINALS_PER_DESK = 16


class DeskTerminals:
    """The terminals, with at most TERMINALS_PER_DESK running on any one desk. Every launch goes
    through here, coordinators' workers included, and a terminal started on a named desk is
    placed there before the lock is released, so the next launch counts it on the right desk."""
    def __init__(self, terminals):
        self.terminals = terminals
        self.lock = threading.Lock()

    def __getattr__(self, name):
        return getattr(self.terminals, name)

    def launch(self, payload, coordinator=None, desk=None):
        with self.lock:
            rows = self.terminals.list()
            # Not a real ID: it stands in for the new terminal, which, without a desk, follows its parent.
            arriving = dict(id='\0launching', parent_id=payload.get('parent_id'))
            desks = DESKS.annotate([*rows, arriving])
            target = desk or arriving['desk']
            if sum(row['exit_code'] is None and row['desk'] == target for row in rows) >= TERMINALS_PER_DESK:
                name = next(d['name'] for d in desks if d['id'] == target)
                raise ValueError(f'{TERMINALS_PER_DESK} terminals are already running on {name}. Stop one before launching another.')
            session = self.terminals.launch(payload, coordinator=coordinator)
            if desk:
                DESKS.place([session.id], desk)
            return session


TERMINALS = DeskTerminals(TerminalManager())
MAILBOX = Mailbox()
COORDINATORS = CoordinatorRuntime(DATA_DIR / 'coordinators.sqlite3', TERMINALS, MAILBOX)
atexit.register(COORDINATORS.close)
atexit.register(TERMINALS.close)
SESSIONS = {}
DESKS = Desks(DATA_DIR / 'desks.json')
LOCK = threading.Lock()
STATES = {'working', 'needs_input', 'idle', 'completed', 'error', 'unknown'}
FEEDBACK_FILE = DATA_DIR / 'feedback.json'
FEEDBACK_LOCK = threading.Lock()
DEVELOPMENT = True
SKILL_UIS_FILE = DATA_DIR / 'skill-uis.json'
PROTECTED_PANES = pane_guard.ProtectedPanes(DATA_DIR / 'protected-panes.json')
# Requests that read from or act on one session, named by its id (submit-feedback: target_id).
PANE_WRITES = ('/api/terminals/input', '/api/terminals/rename', '/api/terminals/stop',
               '/api/coordinators/message', '/api/coordinators/close', '/api/coordinators/pause',
               '/api/coordinators/submit-feedback')
INBOX_CLEARED_FILE = DATA_DIR / 'inbox-cleared.json'
INBOX_CLEARED_LOCK = threading.Lock()
SKILL_UIS_LOCK = threading.Lock()


def read_inbox_cleared():
    try:
        keys = json.loads(INBOX_CLEARED_FILE.read_text())
    except (OSError, ValueError):
        return []
    return [key for key in keys if isinstance(key, str)] if isinstance(keys, list) else []


def clear_inbox_history(keys):
    """Hide History items from the Inbox. Nothing is deleted: the reports, runs and results stay where they live."""
    if not isinstance(keys, list) or not all(isinstance(key, str) and 0 < len(key) <= 200 for key in keys) or len(keys) > 5000:
        raise ValueError('Invalid inbox items')
    with INBOX_CLEARED_LOCK:
        cleared = list(dict.fromkeys(read_inbox_cleared() + keys))[-20000:]
        INBOX_CLEARED_FILE.parent.mkdir(parents=True, exist_ok=True)
        temp = INBOX_CLEARED_FILE.with_suffix('.tmp')
        temp.write_text(json.dumps(cleared))
        os.replace(temp, INBOX_CLEARED_FILE)
    return cleared



def read_skill_uis():
    return json.loads(SKILL_UIS_FILE.read_text()) if SKILL_UIS_FILE.exists() else []


def skill_ui_url(text, desk_port):
    """Whether a tool's address is a local page on a port other than the desk's."""
    try:
        url = urlparse(text)
        return bool(url.scheme == 'http' and url.hostname in ('127.0.0.1', 'localhost') and url.port
                    and url.port != desk_port and not url.username and not url.password)
    except (ValueError, AttributeError, TypeError):
        return False


def register_skill_ui(payload, desk_port):
    ui_id = payload.get('id')
    if not isinstance(ui_id, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', ui_id):
        raise ValueError('Invalid skill UI ID')
    for key in ('title', 'skill', 'url'):
        if not isinstance(payload.get(key), str) or not 0 < len(payload[key]) <= 2000:
            raise ValueError('Invalid ' + key)
    for key in ('agent_id', 'context'):
        if key in payload and (not isinstance(payload[key], str) or len(payload[key]) > 10000):
            raise ValueError('Invalid ' + key)
    if not skill_ui_url(payload['url'], desk_port):
        raise ValueError('UI must use a separate local HTTP port on 127.0.0.1 or localhost')
    item = {k: payload[k] for k in ('id', 'title', 'skill', 'url', 'agent_id', 'context') if k in payload}
    item.update(updated=time.time(), endpoint=f'/apps/{ui_id}')
    with SKILL_UIS_LOCK:
        records = {record['id']: record for record in read_skill_uis()}
        # Relaunching from Tools does not name an owner; keep the pane the tool belongs to.
        if 'agent_id' not in item and records.get(ui_id, {}).get('agent_id'):
            item['agent_id'] = records[ui_id]['agent_id']
        records[ui_id] = item
        SKILL_UIS_FILE.parent.mkdir(parents=True, exist_ok=True)
        temp = SKILL_UIS_FILE.with_suffix('.tmp')
        temp.write_text(json.dumps(list(records.values()), indent=2) + '\n')
        os.replace(temp, SKILL_UIS_FILE)
    return item


def read_feedback():
    if not FEEDBACK_FILE.exists():
        return {'notes': [], 'deleted': []}
    return json.loads(FEEDBACK_FILE.read_text())


def save_feedback(payload):
    notes, deleted = payload.get('notes', []), payload.get('deleted', [])
    if not isinstance(notes, list) or not isinstance(deleted, list) or len(notes) + len(deleted) > 1000:
        raise ValueError('Expected at most 1000 notes and deletion IDs')
    def valid_id(value):
        return isinstance(value, str) and re.fullmatch(r'[\w.-]{1,100}', value)
    for note in notes:
        if not isinstance(note, dict) or not valid_id(note.get('id')):
            raise ValueError('Invalid note ID')
        for field in ('note', 'createdAt', 'url', 'page', 'mode', 'selector', 'elementText'):
            if not isinstance(note.get(field), str) or len(note[field]) > 10000:
                raise ValueError('Invalid note field: ' + field)
        kind = note.get('kind', 'element')
        if not note['note'].strip() or kind not in ('element', 'pin', 'region'):
            raise ValueError('Invalid note or annotation kind')
        boxes = {'point': ('viewportX', 'viewportY', 'documentX', 'documentY'),
                 'viewport': ('width', 'height', 'devicePixelRatio'),
                 'bounds': ('x', 'y', 'width', 'height'), 'scroll': ('x', 'y')}
        if kind == 'region':
            boxes |= {'region': ('x', 'y', 'width', 'height'), 'regionBox': ('x', 'y', 'width', 'height')}
        for field, keys in boxes.items():
            values = note.get(field)
            if not isinstance(values, dict) or any(type(values.get(k)) not in (int, float) or not math.isfinite(values[k]) for k in keys):
                raise ValueError('Invalid coordinates: ' + field)
    if any(not valid_id(value) for value in deleted):
        raise ValueError('Invalid deletion ID')
    with FEEDBACK_LOCK:
        saved = read_feedback()
        tombstones = set(saved['deleted']) | set(deleted)
        merged = {n['id']: n for n in saved['notes']}
        merged.update({n['id']: n for n in notes})
        result = {'notes': [n for key, n in merged.items() if key not in tombstones], 'deleted': sorted(tombstones)}
        archive_feedback(FEEDBACK_FILE,saved,result)
        FEEDBACK_FILE.parent.mkdir(parents=True, exist_ok=True)
        temp = FEEDBACK_FILE.with_suffix('.tmp')
        temp.write_text(json.dumps(result, indent=2, allow_nan=False) + '\n')
        os.replace(temp, FEEDBACK_FILE)
        return result


def process_directories(pids):
    """Batch cwd lookup on macOS; inaccessible or exited processes stay unknown."""
    if not pids:
        return {}
    directories = {}
    try:
        result = subprocess.run(['lsof', '-a', '-p', ','.join(map(str, pids)), '-d', 'cwd', '-Fn'],
                                capture_output=True, text=True, timeout=3)
        pid = None
        for line in result.stdout.splitlines():
            if line.startswith('p') and line[1:].isdigit():
                pid = int(line[1:])
            elif line.startswith('n/') and pid in pids:
                directories[pid] = line[1:]
    except (OSError, subprocess.SubprocessError):
        pass
    for pid in pids:
        if pid not in directories:
            try:
                directories[pid] = os.readlink(f'/proc/{pid}/cwd')
            except OSError:
                pass
    return directories


def folder_context(cwd):
    if not cwd:
        return dict(cwd=None, repo=None, project='Folder unavailable')
    path = Path(cwd)
    repo = None
    for parent in (path, *path.parents):
        try:
            if (parent / '.git').exists():
                repo = str(parent)
                break
        except OSError:
            continue
    return dict(cwd=cwd, repo=repo, project=Path(repo or cwd).name or cwd)


def discover():
    """Process existence alone never implies a semantic agent state."""
    result = subprocess.run(['ps', '-axo', 'pid=,comm='], capture_output=True, text=True, timeout=3)
    agents = []
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2:
            continue
        pid, command = parts
        name = Path(command).name.lower()
        harness = next((h for h in ('codex', 'claude', 'grok', 'opencode') if name in (h, h + '.exe')), None)
        if harness:
            agents.append(dict(id='process-' + pid, name=accounts.SINGLE.get(harness, harness.title()) + ' session', harness=harness,
                               status='unknown', task='Task unavailable — connect an event adapter',
                               project='Folder unavailable', pid=int(pid), source='discovered', updated=None,
                               events=[], question=None))
    directories = process_directories({a['pid'] for a in agents})
    for agent in agents:
        agent.update(folder_context(directories.get(agent['pid'])))
    return agents


def ingest(payload):
    agent_id = payload.get('id')
    if not isinstance(agent_id, str) or not re.fullmatch(r'[\w.-]{1,100}', agent_id):
        raise ValueError('id must contain 1–100 letters, numbers, underscores, periods, or hyphens')
    status = payload.get('status', 'unknown')
    if status not in STATES:
        raise ValueError('Invalid status')
    for field in ('name', 'harness', 'task', 'project', 'message', 'question', 'cwd'):
        if field in payload and (not isinstance(payload[field], str) or len(payload[field]) > 10000):
            raise ValueError(field + ' must be a string of at most 10000 characters')
    if 'parent_id' in payload and payload['parent_id'] is not None and (not isinstance(payload['parent_id'],str) or not re.fullmatch(r'[\w.-]{1,100}',payload['parent_id'])):
        raise ValueError('Invalid parent agent ID')
    if 'pid' in payload and (type(payload['pid']) is not int or payload['pid'] < 1):
        raise ValueError('pid must be a positive integer')
    with LOCK:
        previous = SESSIONS.get(agent_id, {})
        parent = payload.get('parent_id',previous.get('parent_id'))
        visited = {agent_id}
        cursor = parent
        while cursor:
            if cursor in visited:raise ValueError('Parent relationship would create a cycle')
            visited.add(cursor);cursor = SESSIONS.get(cursor,{}).get('parent_id')
        agent = dict(id=agent_id, name=agent_id, harness='custom', task='Untitled task',
                     project='Local workspace', events=[], question=None, **{})
        agent.update(previous)
        agent.update({k: payload[k] for k in ('name', 'harness', 'task', 'project', 'pid', 'question', 'parent_id') if k in payload})
        if 'cwd' in payload:
            if not os.path.isabs(payload['cwd']):
                raise ValueError('cwd must be an absolute path')
            agent.update(folder_context(payload['cwd']))
            if 'project' in payload:
                agent['project'] = payload['project']
        agent.update(status=status, source='adapter', updated=time.time())
        if status != 'needs_input':
            agent['question'] = None
        event = dict(time=time.time(), message=payload.get('message', 'Status changed to ' + status))
        agent['events'] = (agent['events'] + [event])[-100:]
        SESSIONS[agent_id] = agent
        return agent


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def send_json(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def log_request(self, code='-', size='-'):
        # Panes and lists poll API reads several times a second; log what changes state or fails.
        if self.command == 'GET' and self.path.startswith('/api/') and isinstance(code, int) and code < 400:
            return
        super().log_request(code, size)

    def allowed_host(self):
        return self.headers.get('Host') in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}')

    def content_security_policy(self):
        """Only the desk's own files may run as script, so injected markup cannot.

        Styles stay inline-capable (xterm and pane layout set them); web panes may
        frame any http(s) page the user opens. No other page may frame the desk.
        """
        port = self.server.server_port
        return '; '.join((
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            f"connect-src 'self' ws://127.0.0.1:{port} ws://localhost:{port}",
            "frame-src 'self' http: https:",
            "media-src 'self' blob: data:",
            "worker-src 'none'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'self'",
            "frame-ancestors 'self'",
        ))

    def end_headers(self):
        # No other page may frame the desk (clickjacking into terminals) or load its
        # responses as scripts, images or styles (config.js would otherwise leak).
        self.send_header('Content-Security-Policy', self.content_security_policy())
        self.send_header('X-Frame-Options', 'SAMEORIGIN')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def foreign_browser_request(self):
        """A browser request started by another site or another localhost port.

        Browsers label every request with Sec-Fetch-Site; other ports on
        127.0.0.1/localhost count as same-site, so both are refused. Only a plain
        top-level navigation to a page is let through, so a link to the desk still
        opens it. CLIs, adapters and webhooks send no Sec-Fetch headers.
        """
        site = self.headers.get('Sec-Fetch-Site')
        if site is None:
            # Browsers without these labels (Safari before 16.4) still say where a request came
            # from. Tools send neither header.
            own = 'http://' + self.headers.get('Host', '')
            origin, referer = self.headers.get('Origin'), self.headers.get('Referer')
            if origin is not None:
                site = 'same-origin' if origin == own else 'cross-site'
            elif referer is not None:
                site = 'same-origin' if referer == own or referer.startswith(own + '/') else 'cross-site'
        if site not in ('cross-site', 'same-site'):
            return False
        navigation = (self.command == 'GET' and self.headers.get('Sec-Fetch-Mode') == 'navigate'
                      and self.headers.get('Sec-Fetch-Dest') == 'document')
        return not navigation or urlparse(self.path).path.startswith('/api/')

    def do_HEAD(self):
        if not self.allowed_host() or self.foreign_browser_request():
            return self.send_json({'error': 'Forbidden'}, 403)
        return super().do_HEAD()

    def do_GET(self):
        if not self.allowed_host():
            return self.send_json({'error': 'Invalid host'}, 403)
        if self.foreign_browser_request():
            return self.send_json({'error': 'Cross-site requests are not allowed'}, 403)
        if remote_native() and not self.terminal_authorized():
            return self.send_json({'error': 'Remote runtime authentication required'}, 403)
        route = urlparse(self.path).path
        if route == '/api/event-bus':
            if not self.terminal_authorized():
                return self.send_json({'error': 'Terminal authentication required'}, 403)
            return self.send_json(WORKFLOWS.events.snapshot())
        if route == '/api/remote-node/info' and remote_native():
            from agent_desk.remote_node import info
            return self.send_json(info())
        if route == '/api/terminal-auth':
            # Only the desk's own page gets the token over HTTP: a browser marks its
            # same-origin fetches, and nothing else can read them. Local helpers read
            # the owner-only token file instead.
            origin = self.headers.get('Origin')
            if origin and origin != 'http://' + self.headers.get('Host', ''):
                return self.send_json({'error': 'Invalid origin'}, 403)
            own = 'http://' + self.headers.get('Host', '')
            # Safari before 16.4 sends no Sec-Fetch-Site; its page is known by the Referer instead.
            older_browser = self.headers.get('Sec-Fetch-Site') is None and (self.headers.get('Referer') or '').startswith(own + '/')
            if self.headers.get('Sec-Fetch-Site') != 'same-origin' and not older_browser:
                return self.send_json({'error': 'The terminal token is only served to the desk page; local helpers read '
                                       + str(desk_tokens.token_path('terminal', self.server.server_port))}, 403)
            return self.send_json({'token': TERMINAL_TOKEN, 'cwd': str(ROOT.resolve())})
        if route == '/api/coordinators':
            if not self.terminal_authorized():
                return self.send_json({'error':'Terminal authentication required'},403)
            identity=parse_qs(urlparse(self.path).query).get('id',[None])[0]
            node = REMOTES.identity(identity)
            if node:
                from urllib.parse import urlencode
                try:return self.send_json(REMOTES.request(node, '/api/coordinators?' + urlencode({'id': identity.split(':', 2)[2]})))
                except ValueError as error:return self.send_json({'error':str(error)}, 502)
            snapshot = COORDINATORS.snapshot(identity)
            snapshot['coordinators'] += REMOTES.records('coordinators')
            return self.send_json(snapshot)
        if route == '/api/web-pages/check':
            if not self.terminal_authorized():
                return self.send_json({'error': 'Terminal authentication required'}, 403)
            try:
                return self.send_json(web_pages.check(parse_qs(urlparse(self.path).query).get('url', [''])[0], 'http://' + self.headers['Host']))
            except ValueError as exc:
                return self.send_json({'error': str(exc)}, 400)
        if route == '/api/projects':
            if not self.terminal_authorized():
                return self.send_json({'error': 'Terminal authentication required'}, 403)
            roots = parse_qs(urlparse(self.path).query).get('root')
            if roots and (len(roots) != 1 or not Path(roots[0]).is_absolute() or not Path(roots[0]).is_dir()):
                return self.send_json({'error': 'Choose an existing absolute search folder'}, 400)
            return self.send_json(discover_projects(roots))
        if route == '/api/coordinator-events':
            if not self.terminal_authorized():
                return self.send_json({'error': 'Terminal authentication required'}, 403)
            query=parse_qs(urlparse(self.path).query)
            if query.get('task'):
                if REMOTES.identity(query['task'][0]):return self.send_json({'tasks':[t for t in REMOTES.records('tasks') if t['id']==query['task'][0]]})
                try:return self.send_json({'tasks':[MAILBOX.get(f'http://127.0.0.1:{self.server.server_port}',query['task'][0])]})
                except ValueError as error:return self.send_json({'error':str(error)},404)
            return self.send_json({'event_delivery': True, 'native_grok_terminal': True, 'supported_harnesses': ['codex','claude','grok'], 'tasks': REMOTES.records('tasks') + MAILBOX.events(f'http://127.0.0.1:{self.server.server_port}')})
        if route == '/api/terminals/stream':
            # WebSockets are exempt from CORS, so check the origin here; the token arrives as the first message.
            origin = self.headers.get('Origin')
            if origin is not None and origin != 'http://' + self.headers.get('Host', ''):
                return self.send_json({'error': 'Invalid origin'}, 403)
            problem = websocket.upgrade_error(self.headers)
            if problem:
                return self.send_json({'error': problem}, 426)
            # Local helpers, such as `agent-desk attach`, stream too, limited to what they may reach over HTTP.
            return TerminalStream(websocket.accept(self), TERMINALS, TERMINAL_TOKEN, HELPER_TOKEN, self.helper_refusal).serve()
        if route == '/api/terminals/output':
            if not self.terminal_authorized():
                return self.send_json({'error': 'Terminal authentication required'}, 403)
            try:
                query = parse_qs(urlparse(self.path).query)
                identity = query.get('id', [''])[0]
                refused = self.pane_refusal(identity, write=False)
                if refused:
                    return self.send_json({'error': refused}, 403)
                node = REMOTES.identity(identity)
                if node:
                    from urllib.parse import urlencode
                    return self.send_json(REMOTES.request(node, '/api/terminals/output?' + urlencode({'id': identity.split(':',2)[2], 'cursor': query.get('cursor',['0'])[0]})))
                cursor = int(query.get('cursor', ['0'])[0])
                if cursor < 0:
                    raise ValueError('Invalid cursor')
                return self.send_json(TERMINALS.output(query.get('id', [''])[0], cursor))
            except ValueError as exc:
                return self.send_json({'error': str(exc)}, 400)
        if route in ('/api/workflows','/api/workflows/logs'):
            if not self.terminal_authorized():
                return self.send_json({'error': 'Terminal authentication required'}, 403)
            try:
                if route.endswith('/logs'):
                    return self.send_json(WORKFLOWS.logs(parse_qs(urlparse(self.path).query).get('id',[''])[0]))
                return self.send_json(WORKFLOWS.snapshot())
            except (ValueError,OSError) as exc:
                return self.send_json({'error': str(exc)},400)
        if route == '/api/special-agents':
            if not self.terminal_authorized():
                return self.send_json({'error': 'Terminal authentication required'}, 403)
            SPECIAL_AGENTS.reconcile({t['id'] for t in TERMINALS.list() if t['exit_code'] is None})
            return self.send_json(SPECIAL_AGENTS.snapshot())
        if route == '/api/tool-launchers':
            if not self.terminal_authorized():
                return self.send_json({'error': 'Terminal authentication required'}, 403)
            return self.send_json({'launchers': [{k:v for k,v in item.items() if k not in ('script','args')} for item in TOOL_RUNTIME.catalog()]})
        if route == '/api/inbox/cleared':
            return self.send_json({'keys': read_inbox_cleared()})
        if route == '/api/skill-uis':
            try:
                with SKILL_UIS_LOCK:
                    # The file is checked again on the way out: the page frames these addresses.
                    return self.send_json({'uis': [dict(ui, **TOOL_RUNTIME.status(ui['id'])) for ui in read_skill_uis()
                                                   if isinstance(ui, dict) and skill_ui_url(ui.get('url'), self.server.server_port)]})
            except (OSError, ValueError):
                return self.send_json({'error': 'Could not read skill UI registry'}, 500)
        if route.startswith('/apps/'):
            ui_id = route.removeprefix('/apps/').rstrip('/')
            with SKILL_UIS_LOCK:
                exists = any(item['id'] == ui_id for item in read_skill_uis())
            if not exists:
                return self.send_json({'error': 'Skill UI not registered'}, 404)
            self.path = '/index.html'
            return super().do_GET()
        if route == '/config.js':
            body = ('window.AGENT_DESK_CONFIG=' + json.dumps({'development': DEVELOPMENT, 'accounts': [{k: a[k] for k in ('id', 'harness', 'name', 'label')} for a in accounts.accounts()]}) + ';').encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
            return
        if route == '/api/skills':
            try:
                return self.send_json(skill_harnesses.list_skills())
            except OSError:
                return self.send_json({'error': 'Could not read local skills'}, 500)
        if route == '/api/skills/discover':
            if not self.terminal_authorized():
                return self.send_json({'error':'Terminal authentication required'},403)
            try:
                root=parse_qs(urlparse(self.path).query).get('root',[None])[0]
                return self.send_json(skill_harnesses.find_local_skills(root))
            except (OSError,ValueError) as exc:
                return self.send_json({'error':str(exc)},400)
        if route == '/api/feedback':
            if not DEVELOPMENT:
                return self.send_json({'error': 'Development tools are disabled'}, 404)
            try:
                with FEEDBACK_LOCK:
                    return self.send_json(read_feedback())
            except (OSError, ValueError):
                return self.send_json({'error': 'Could not read workspace feedback'}, 500)
        if route == '/api/agents':
            try:
                processes = [] if remote_native() else discover()
                with LOCK:
                    reported = [dict(a) for a in SESSIONS.values()]
                by_pid = {a['pid']: a for a in processes}
                for agent in reported:
                    detected = by_pid.get(agent.get('pid'))
                    if detected and not agent.get('cwd'):
                        agent.update({k: detected[k] for k in ('cwd', 'repo')})
                        if agent.get('project') == 'Local workspace':
                            agent['project'] = detected['project']
                hidden = COORDINATORS.hidden_workers() | SPECIAL_AGENTS.hidden_terminals()
                managed = [a for a in TERMINALS.list() if a['id'] not in hidden]
                for agent in managed:
                    agent.update(folder_context(agent['cwd']))
                    if agent['id'] in PROTECTED_PANES:
                        agent['protected'] = True
                known_pids = {a.get('pid') for a in reported} | TERMINALS.child_pids()
                internal = MAILBOX.subagents(f'http://127.0.0.1:{self.server.server_port}', {a['id'] for a in managed if a['exit_code'] is None})
                for agent in internal:
                    agent.update(folder_context(agent['cwd']))
                every = REMOTES.records('agents') + COORDINATORS.agents() + managed + internal + reported + [a for a in processes if a['pid'] not in known_pids]
                return self.send_json({'agents': every, 'desks': DESKS.annotate(every)})
            except (OSError, subprocess.SubprocessError) as exc:
                return self.send_json({'error': str(exc)}, 500)
        if route.startswith('/api/'):
            return self.send_json({'error': 'Not found'}, 404)
        return super().do_GET()

    def terminal_authorized(self):
        origin = self.headers.get('Origin')
        return (self.allowed_host() and
                (origin is None or origin == 'http://' + self.headers.get('Host', '')) and
                any(secrets.compare_digest(self.headers.get('X-Agent-Desk-Terminal', '').encode(), token.encode())
                    for token in (TERMINAL_TOKEN, HELPER_TOKEN)))

    def at_the_desk(self):
        """Whether this request comes from the desk page rather than a local helper."""
        return secrets.compare_digest(self.headers.get('X-Agent-Desk-Terminal', '').encode(), TERMINAL_TOKEN.encode())

    def pane_refusal(self, target, write=True):
        """Why this caller may not reach a session, or None. The page may reach all of them."""
        if self.at_the_desk():
            return None
        return self.helper_refusal(target, write)

    def helper_refusal(self, target, write=True):
        """Why a local helper or an agent's tool may not reach a session, or None."""
        if not isinstance(target, str):
            return None
        def parent_of(identity):
            try:
                return TERMINALS.get(identity).parent_id
            except ValueError:
                return None
        protected = PROTECTED_PANES
        if REMOTES.identity(target):
            # A remote runtime keeps its own lock list and reports it with each session.
            protected = PROTECTED_PANES.ids | {a['id'] for a in REMOTES.records('agents') if a.get('protected')}
        return pane_guard.refusal(target, protected, self.headers.get('X-Agent-Desk-Pane'), parent_of, write)

    def set_readouts(self):
        # Pane processes authenticate with their own pane's token, never the desk-wide ones.
        origin = self.headers.get('Origin')
        if not self.allowed_host() or origin not in (None, 'http://' + self.headers.get('Host', '')):
            return self.send_json({'error': 'Invalid host or origin'}, 403)
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 8192:
                raise ValueError('Request must contain 1–8192 bytes')
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError('Expected an object')
            try:
                session = TERMINALS.get(payload.get('id'))
            except ValueError:
                return self.send_json({'error': 'Terminal not found; it may have been closed'}, 404)
            authorization = self.headers.get('Authorization', '')
            shown = session.set_readouts(authorization.removeprefix('Bearer ') if authorization.startswith('Bearer ') else None, payload)
            return self.send_json({'ok': True, 'readouts': shown})
        except PermissionError as exc:
            return self.send_json({'error': str(exc)}, 403)
        except (ValueError, TypeError) as exc:
            return self.send_json({'error': str(exc)}, 400)
        except OSError as exc:
            return self.send_json({'error': 'Terminal supervisor unavailable: ' + str(exc)}, 503)

    def human_event_action(self):
        # Browser-mediated activation is separate from agent-friendly save APIs.
        # Like the rest of this local app, this is not a boundary against a hostile local process.
        return (self.terminal_authorized() and
                self.headers.get('Origin') == 'http://' + self.headers.get('Host', '') and
                self.headers.get('Sec-Fetch-Site') == 'same-origin')

    def event_webhook(self):
        identity = self.path.removeprefix('/api/event-bus/webhook/')
        authenticated = False
        try:
            if not self.allowed_host() or self.client_address[0] not in ('127.0.0.1', '::1') or self.headers.get('Origin') is not None:
                raise EventError('Webhook requires a loopback adapter request without a browser Origin', 403)
            authorization = self.headers.get('Authorization', '')
            token = authorization[7:] if authorization.startswith('Bearer ') else ''
            WORKFLOWS.events.authenticate(identity, token)
            authenticated = True
            if self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
                raise EventError('Use Content-Type: application/json', 415)
            try:
                size = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                raise EventError('Invalid request size') from None
            if self.headers.get('Transfer-Encoding') or not 0 < size <= MAX_BYTES:
                raise EventError('Expected a JSON body of at most 32 KiB', 413)
            try:
                payload = json.loads(self.rfile.read(size))
            except (ValueError, RecursionError):
                raise EventError('Malformed JSON event') from None
            result = WORKFLOWS.events.ingest(identity, payload)
            return self.send_json(result, 200 if result['duplicate'] else 202)
        except EventError as exc:
            if authenticated:WORKFLOWS.events.error(identity, str(exc), seen=True)
            return self.send_json({'error': str(exc)}, exc.status)

    def do_POST(self):
        if self.foreign_browser_request():
            return self.send_json({'error': 'Cross-site requests are not allowed'}, 403)
        if self.path == '/api/readouts':
            return self.set_readouts()
        if self.path.startswith('/api/event-bus/webhook/'):
            return self.event_webhook()
        if self.path.startswith('/api/event-bus/') or self.path.startswith('/api/remote/') or self.path.startswith('/api/accounts/') or self.path.startswith('/api/conversations/') or self.path.startswith('/api/terminals/') or self.path == '/api/projects/create' or self.path.startswith('/api/inbox/') or self.path.startswith('/api/tools/') or self.path.startswith('/api/special-agents/') or self.path.startswith('/api/skills/') or self.path.startswith('/api/workflows/') or self.path.startswith('/api/coordinator-events/') or self.path.startswith('/api/coordinators/') or self.path.startswith('/api/model-router/') or self.path.startswith('/api/desks/'):
            if not self.terminal_authorized():
                return self.send_json({'error': 'Terminal authentication required'}, 403)
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 100000:
                    raise ValueError('Invalid request size')
                payload = json.loads(self.rfile.read(size))
                if not isinstance(payload, dict):
                    raise ValueError('Expected an object')
                if self.path.startswith('/api/event-bus/'):
                    actions = {'save-source': WORKFLOWS.events.save_source,
                               'toggle-source': lambda p: WORKFLOWS.events.toggle_source(p.get('id'), p.get('enabled')),
                               'delete-source': lambda p: WORKFLOWS.events.delete_source(p.get('id')),
                               'rotate-token': lambda p: WORKFLOWS.events.rotate_token(p.get('id'))}
                    action = actions.get(self.path.rsplit('/', 1)[-1])
                    if not action:return self.send_json({'error': 'Not found'}, 404)
                    return self.send_json(action(payload))
                if self.path == '/api/accounts/list':return self.send_json({'accounts': accounts.listing()})
                if self.path == '/api/accounts/save':return self.send_json(accounts.save_account(payload))
                if self.path == '/api/accounts/delete':return self.send_json(accounts.delete_account(payload))
                if self.path == '/api/conversations/list':return self.send_json(CONVERSATIONS.catalog(payload.get('offset',0)))
                if self.path == '/api/conversations/import':return self.send_json(CONVERSATIONS.import_source(payload))
                if self.path == '/api/conversations/prepare':return self.send_json(CONVERSATIONS.prepare(payload))
                if self.path == '/api/remote/nodes':
                    return self.send_json({'nodes': REMOTES.list()})
                if self.path == '/api/remote/attach':
                    if remote_native():raise ValueError('Nested remote runtimes are not supported')
                    return self.send_json(REMOTES.attach(CONNECTIONS.consume(payload)))
                if self.path == '/api/terminals/protect' and not self.at_the_desk():
                    return self.send_json({'error': 'Only the user, at the desk, can change which sessions are protected'}, 403)
                # Checked before a remote request is forwarded: the bridge itself may do anything.
                if self.path in PANE_WRITES:
                    refused = self.pane_refusal(payload.get('target_id' if self.path.endswith('/submit-feedback') else 'id'))
                    if refused:
                        return self.send_json({'error': refused}, 403)
                node = REMOTES.identity(payload.get('id')) or payload.get('remote_node')
                if node and self.path.startswith(('/api/coordinators/', '/api/terminals/', '/api/coordinator-events/')):
                    # Desks are this desk's, not the remote's: place what it starts here.
                    desk = DESKS.desk_for(payload.pop('desk')) if 'desk' in payload else None
                    result = REMOTES.request(node, self.path, payload)
                    if self.path == '/api/terminals/protect' and REMOTES.identity(payload.get('id')):
                        PROTECTED_PANES.set(payload.get('id'), payload.get('protected'))
                    if desk and self.path in ('/api/coordinators/create', '/api/terminals/launch'):
                        result = placed(result, desk)
                    return self.send_json(result)
                if self.path == '/api/remote/prerequisites':
                    return self.send_json(remote_prerequisites())
                if self.path == '/api/remote/test-environment':
                    return self.send_json(CONNECTIONS.test_runtime(payload))
                if self.path == '/api/remote/test':
                    return self.send_json(CONNECTIONS.test(payload))
                if self.path == '/api/remote/connections':
                    return self.send_json({'connections': remote_saved()})
                if self.path == '/api/remote/connections/save':
                    return self.send_json(remote_save(payload))
                if self.path == '/api/remote/connections/delete':
                    return self.send_json(remote_delete(payload))
                if self.path == '/api/remote/connect':
                    desk = DESKS.desk_for(payload.pop('desk', None))
                    return self.send_json(CONNECTIONS.connect(payload, TERMINALS, desk) | {'desk': desk})
                if self.path.startswith('/api/coordinators/'):
                    action=self.path.rsplit('/',1)[-1]
                    if action=='feedback-status':return self.send_json(feedback_status(COORDINATORS,payload))
                    if action=='cancel-feedback':return self.send_json(cancel_feedback(COORDINATORS,payload))
                    if action=='submit-feedback':return self.send_json(submit_feedback(COORDINATORS,payload))
                    if action=='create':
                        desk = DESKS.desk_for(payload.pop('desk', None))
                        return self.send_json(placed(COORDINATORS.create(payload), desk))
                    if action=='rename':return self.send_json(COORDINATORS.rename(payload))
                    if action=='message':return self.send_json(COORDINATORS.message(payload))
                    if action=='cancel-delivery':return self.send_json(COORDINATORS.cancel_delivery(payload))
                    if action=='publish-check':return self.send_json(COORDINATORS.publish_check(payload))
                    if action=='hooks':return self.send_json(COORDINATORS.hooks(payload))
                    if action=='reviewers':return self.send_json(COORDINATORS.reviewers(payload))
                    if action=='second-opinion':return self.send_json(COORDINATORS.second_opinion(payload))
                    if action=='review-projects':return self.send_json(COORDINATORS.review_projects(payload))
                    if action=='save-review-project':return self.send_json(COORDINATORS.save_review_project(payload))
                    if action=='save-hook':return self.send_json(COORDINATORS.save_hook(payload))
                    if action=='configure':return self.send_json(COORDINATORS.configure(payload))
                    if action=='close':return self.send_json(COORDINATORS.close_conversation(payload.get('id')))
                    if action=='reopen':return self.send_json(COORDINATORS.reopen(payload.get('id')))
                    if action=='models':
                        from agent_desk.coordinator_models import model_options
                        return self.send_json(model_options(payload.get('profile')))
                    if action=='pause':return self.send_json(COORDINATORS.pause(payload.get('id')))
                    if action=='attach-worker':return self.send_json(COORDINATORS.attach_worker(payload.get('id'),payload.get('worker_id')))
                    if action=='review-worker':return self.send_json(COORDINATORS.review_worker(payload))
                    if action=='retire-worker':return self.send_json(COORDINATORS.retire_worker(payload))
                    if action=='resume-worker':return self.send_json(COORDINATORS.resume_worker(payload))
                    if action=='context':return self.send_json(COORDINATORS.context_state(payload.get('id')) | {'watches':COORDINATORS.watches(payload.get('id'))})
                    if action=='retrieve':return self.send_json(COORDINATORS.retrieve(payload.get('id'),payload.get('reference',''),payload.get('query',''),payload.get('offset',0)))
                    if action=='save-memory':return self.send_json(COORDINATORS.save_memory(payload))
                    if action=='delete-memory':return self.send_json(COORDINATORS.delete_memory(payload))
                    if action=='quota' and remote_native():
                        return self.send_json({'state':'unsupported','label':'Remote','windows':[],'message':'Remote harness credentials are used here. Local account quota is not queried; per-turn token usage remains available.'})
                    if action=='quota':return self.send_json(COORDINATORS.account_quota.read(COORDINATORS.get(payload.get('id'))['profile'],refresh=payload.get('refresh') is True))
                    if action=='configure-reader':return self.send_json(COORDINATORS.configure_reader(payload))
                    if action=='analyze':
                        c=COORDINATORS.get(payload.get('id'))
                        return self.send_json(COORDINATORS.analyze_files(c,payload.get('question'),payload.get('paths'), 'helper-'+secrets.token_hex(12),COORDINATORS.stopping))
                    if action=='watch-pr':return self.send_json(COORDINATORS.watch_pr(payload))
                    if action=='stop-watch':return self.send_json(COORDINATORS.stop_watch(payload))
                    return self.send_json({'error':'Not found'},404)
                if self.path.startswith('/api/model-router/'):
                    return self.send_json(model_router_action(self.path.rsplit('/', 1)[-1], payload))
                if self.path.startswith('/api/desks/'):
                    return self.send_json(desk_action(self.path.rsplit('/', 1)[-1], payload, self.pane_refusal))
                if self.path.startswith('/api/coordinator-events/'):
                    desk = f'http://127.0.0.1:{self.server.server_port}'
                    if self.path.endswith('/retry'):
                        return self.send_json(MAILBOX.retry(desk, payload.get('id'), payload.get('controller')))
                    if self.path.endswith('/ack'):
                        return self.send_json(MAILBOX.ack(desk, payload.get('id'), payload.get('controller')))
                    return self.send_json({'error': 'Not found'}, 404)
                if self.path.startswith('/api/workflows/'):
                    actions={'cancel':lambda p:WORKFLOWS.cancel_flow(p.get('id')),'review':WORKFLOWS.review,'save-config':WORKFLOWS.save_config,'save':WORKFLOWS.save_workflow,
                        'run':lambda p:WORKFLOWS.start_flow(p.get('id')),
                        'launch':lambda p:WORKFLOWS.start(p.get('id')),
                        'toggle':lambda p:WORKFLOWS.toggle(p.get('id'),p.get('enabled'),human=self.human_event_action()),
                        'delete':lambda p:WORKFLOWS.delete_workflow(p.get('id')),
                        'delete-config':lambda p:WORKFLOWS.delete_config(p.get('id')),
                        'stop':lambda p:WORKFLOWS.stop(p.get('id'))}
                    action=actions.get(self.path.rsplit('/',1)[-1])
                    if not action:return self.send_json({'error':'Not found'},404)
                    return self.send_json(action(payload))
                if self.path == '/api/special-agents/save':
                    return self.send_json(SPECIAL_AGENTS.save_role(payload))
                if self.path == '/api/skills/preview':
                    return self.send_json(skill_harnesses.skill_document(payload))
                if self.path == '/api/skills/create':
                    return self.send_json(skill_harnesses.create_skill(payload))
                if self.path == '/api/skills/sync':
                    return self.send_json(skill_harnesses.make_available_everywhere())
                if self.path == '/api/skills/add':
                    return self.send_json(skill_harnesses.add_local_skill(payload.get('path')))
                if self.path == '/api/special-agents/delete':
                    identity = SPECIAL_AGENTS.text(payload, 'id', 100)
                    used = [c['name'] for c in WORKFLOWS.snapshot()['configs'] if c.get('role_id') == identity]
                    if used:
                        raise ValueError('Run & Schedule still uses this automation as a task (' + ', '.join(sorted(set(used))[:3]) + '). Remove that launch configuration first.')
                    return self.send_json(SPECIAL_AGENTS.delete_role(identity))
                if self.path == '/api/special-agents/finding':
                    return self.send_json(SPECIAL_AGENTS.publish(payload))
                if self.path == '/api/special-agents/review':
                    return self.send_json(SPECIAL_AGENTS.review(payload))
                if self.path == '/api/special-agents/report':
                    return self.send_json(SPECIAL_AGENTS.report(payload))
                if self.path == '/api/special-agents/context':
                    return self.send_json(SPECIAL_AGENTS.run_context(payload.get('run_id')))
                if self.path == '/api/special-agents/launch':
                    role = SPECIAL_AGENTS.role(SPECIAL_AGENTS.text(payload, 'id', 100))
                    desk = DESKS.desk_for(payload.get('desk'))
                    SPECIAL_AGENTS.close_completed(TERMINALS)
                    live = {t['id'] for t in TERMINALS.list() if t['exit_code'] is None}
                    SPECIAL_AGENTS.reconcile(live)
                    if any(r['role_id'] == role['id'] and r['terminal_id'] in live for r in SPECIAL_AGENTS.snapshot()['runs']):
                        raise ValueError('This role still has a running terminal. Open or stop it before another pass.')
                    run = SPECIAL_AGENTS.start_run(role['id'],payload.get('event_context'))
                    try:
                        session = TERMINALS.launch(launch_payload(role, run, 'http://' + self.headers['Host'], ROOT, payload.get('event_context')), desk=desk).info()
                    except Exception as exc:
                        SPECIAL_AGENTS.update_run(run['id'], 'failed', str(exc))
                        raise
                    session = session | {'desk': desk}
                    SPECIAL_AGENTS.update_run(run['id'], 'running', terminal_id=session['id'])
                    return self.send_json(dict(session=session, run_id=run['id']))
                if self.path == '/api/tools/launch':
                    item = TOOL_RUNTIME.launch(payload.get('skill'), payload.get('target'), payload.get('id'), payload.get('title'))
                    # Launching from Skills names the agent session the tool is opened beside.
                    owner = {'agent_id': payload['agent_id']} if payload.get('agent_id') else {}
                    item = register_skill_ui({k:v for k,v in item.items() if k in ('id','title','skill','url','context')} | owner, self.server.server_port)
                    return self.send_json(dict(item, **TOOL_RUNTIME.status(item['id'])))
                if self.path == '/api/tools/stop':
                    return self.send_json(TOOL_RUNTIME.stop(payload.get('id','')))
                if self.path == '/api/tools/forget':
                    identity = payload.get('id','')
                    if TOOL_RUNTIME.status(identity)['status'] == 'running':
                        raise ValueError('Stop the tool before removing it')
                    with SKILL_UIS_LOCK:
                        records = [ui for ui in read_skill_uis() if ui['id'] != identity]
                        temp = SKILL_UIS_FILE.with_suffix('.tmp')
                        temp.write_text(json.dumps(records, indent=2) + '\n')
                        os.replace(temp, SKILL_UIS_FILE)
                    return self.send_json({'ok': True})
                if self.path == '/api/inbox/clear-history':
                    return self.send_json({'keys': clear_inbox_history(payload.get('keys'))})
                if self.path == '/api/projects/create':
                    return self.send_json(create_directory(payload.get('parent'), payload.get('name')))
                if self.path == '/api/terminals/launch':
                    # A child started without a desk (agent_control.py launch --parent) is left
                    # unplaced, so it goes, and keeps going, wherever its parent is.
                    desk = DESKS.desk_for(payload.pop('desk', None)) if 'desk' in payload or not payload.get('parent_id') else None
                    # Readouts are opt in per terminal: only this agent is given the set_readouts tool.
                    if payload.pop('readouts', False):
                        if not isinstance(payload.get('argv'), list):
                            raise ValueError('Readouts work with Claude and Codex agents')
                        payload['argv'] = tool_registration.with_readouts(payload['argv'])
                    coordinator = None
                    if payload.get('coordinator_harness') is not None:
                        harness = payload['coordinator_harness']
                        if harness not in ('codex', 'claude', 'grok') or not isinstance(payload.get('argv'), list) or len(payload['argv']) < 2:
                            raise ValueError('Choose Codex, Claude or Grok with an initial coordinator prompt')
                        coordinator = dict(harness=harness, desk=f'http://127.0.0.1:{self.server.server_port}', db=str(MAILBOX.path))
                    if coordinator is None:
                        from agent_desk.standalone_agent import launch_payload as standalone_payload
                        payload=standalone_payload(payload)
                    session = TERMINALS.launch(payload, coordinator=coordinator, desk=desk).info()
                    return self.send_json(session | {'desk': desk} if desk else session)
                if self.path == '/api/terminals/protect':
                    TERMINALS.get(payload.get('id', ''))
                    return self.send_json(PROTECTED_PANES.set(payload.get('id'), payload.get('protected')))
                if self.path == '/api/terminals/input':
                    TERMINALS.send(payload.get('id', ''), input_event(payload.get('data')))
                    return self.send_json({'ok': True})
                if self.path == '/api/terminals/resize':
                    TERMINALS.send(payload.get('id', ''), resize_event(payload.get('cols'), payload.get('rows')))
                    return self.send_json({'ok': True})
                session = TERMINALS.get(payload.get('id', ''))
                if self.path == '/api/terminals/rename':
                    return self.send_json(session.rename(payload.get('name')))
                if self.path == '/api/terminals/stop':
                    stop_terminal(session)
                else:
                    return self.send_json({'error': 'Not found'}, 404)
                return self.send_json({'ok': True})
            except (ValueError, TypeError) as exc:
                return self.send_json({'error': str(exc)}, 400)
            except OSError as exc:
                return self.send_json({'error': str(exc)}, 500)
        feedback_route = self.path == '/api/feedback'
        if feedback_route and not DEVELOPMENT:
            return self.send_json({'error': 'Development tools are disabled'}, 404)
        # A custom header requires a browser preflight for cross-origin writes.
        # No CORS permissions are served. Also reject an explicitly foreign Origin.
        origin = self.headers.get('Origin')
        local_origin = origin is None or origin == 'http://' + self.headers.get('Host', '')
        authorized = (self.headers.get('X-Agent-Desk') == 'feedback' and local_origin) if feedback_route else self.headers.get('Authorization') == 'Bearer ' + TOKEN
        if not self.allowed_host() or not authorized:
            return self.send_json({'error': 'A valid adapter token is required'}, 403)
        if self.path not in ('/api/events', '/api/feedback', '/api/skill-uis'):
            return self.send_json({'error': 'Not found'}, 404)
        try:
            size = int(self.headers.get('Content-Length', '0'))
            limit = 4 * 1024 * 1024 if feedback_route else 65536
            if not 0 < size <= limit:
                raise ValueError(f'Request must contain 1–{limit} bytes')
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError('Expected an object')
            if self.path == '/api/skill-uis':
                return self.send_json(register_skill_ui(payload, self.server.server_port))
            return self.send_json(save_feedback(payload) if feedback_route else ingest(payload))
        except (ValueError, TypeError) as exc:
            return self.send_json({'error': str(exc)}, 400)
        except OSError:
            return self.send_json({'error': 'Could not save workspace feedback'}, 500)


def placed(agent, desk):
    """Put a just-started agent on the desk it was started from, before any list shows it."""
    DESKS.place([agent['id']], desk)
    return agent | {'desk': desk}


def stop_terminal(session):
    # A coordinator's worker is saved for Resume before it stops; anything else just stops.
    if session.parent_id and session.parent_id in {c['id'] for c in COORDINATORS.snapshot()['coordinators']}:
        COORDINATORS.stop_worker(dict(id=session.parent_id, worker_id=session.id, confirmed=True))
    else:
        session.stop()


def every_agent():
    """Everything a desk can hold, without the slow process discovery /api/agents also does."""
    with LOCK:
        reported = [dict(a) for a in SESSIONS.values()]
    return REMOTES.records('agents') + COORDINATORS.agents() + TERMINALS.list() + reported


def shutdown_desk(payload, refusal=lambda identity: None):
    """Stop the sessions the user was shown for one desk. Only ids that were listed and are
    still on that desk are touched, so nothing started after the confirmation is stopped and
    nothing on another desk ever is. Every session is attempted; failures are reported, not hidden.
    ``refusal`` names sessions this caller may not stop, such as protected ones for a helper."""
    desk, ids = DESKS.desk_for(payload.get('id')), payload.get('ids')
    if not isinstance(ids, list) or len(ids) > 500 or any(not isinstance(i, str) for i in ids):
        raise ValueError('List the sessions to shut down')
    every = every_agent()
    DESKS.annotate(every)
    chosen = [a for a in every if a['id'] in set(ids) and a.get('desk') == desk]
    result = dict(stopped=[], closed=[], skipped=[i for i in ids if i not in {a['id'] for a in chosen}], failed=[])
    # Terminals first, so a coordinator closing afterwards saves workers that have already stopped.
    for agent in sorted(chosen, key=lambda a: bool(a.get('coordinator_workspace'))):
        identity, node = agent['id'], agent.get('remote_node')
        refused = refusal(identity)
        if refused:
            result['failed'].append(dict(id=identity, error=refused))
            continue
        try:
            if agent.get('coordinator_workspace'):
                REMOTES.request(node, '/api/coordinators/close', {'id': identity}) if node else COORDINATORS.close_conversation(identity)
                result['closed'].append(identity)
            elif agent.get('terminal_id') and agent.get('exit_code') is None:
                REMOTES.request(node, '/api/terminals/stop', {'id': identity}) if node else stop_terminal(TERMINALS.get(identity))
                result['stopped'].append(identity)
            else:
                result['skipped'].append(identity)
        except (ValueError, KeyError, OSError) as exc:
            result['failed'].append(dict(id=identity, error=str(exc)))
    return result


def desk_action(action, payload, refusal=lambda identity: None):
    if action == 'create':
        return DESKS.create(payload.get('name'))
    if action == 'rename':
        return DESKS.rename(payload.get('id'), payload.get('name'))
    if action == 'place':
        return DESKS.place(payload.get('ids'), payload.get('desk'))
    if action == 'delete':
        return {'desks': DESKS.delete(payload.get('id'), payload.get('move_to'), every_agent())}
    if action == 'shutdown':
        return shutdown_desk(payload, refusal)
    raise ValueError('Unknown desk action')


def model_router_action(action, payload):
    router = COORDINATORS.model_router
    harness = payload.get('harness') or None
    if harness is not None and harness not in model_router.HARNESS_LABELS:
        raise ValueError('Harness must be claude, codex or grok')
    if action == 'settings':
        return router.status()
    if action == 'save':
        return router.save(payload)
    if action == 'decide':
        return router.decide(payload.get('task'), harness)
    if action == 'launch':
        # Terminal controllers: route the task, then open the matching harness with that model.
        # The task itself is dispatched afterwards so it carries its callback.
        parent_id = payload.get('parent_id')
        # TERMINALS is the supervisor proxy in a running server; its rows carry each terminal's account profile.
        parent = next((t for t in TERMINALS.list() if t['id'] == parent_id), None) if parent_id else None
        routing = router.decide(payload.get('task'), harness)
        profile = model_router.worker_profile(routing['harness'], parent['launch_profile'] if parent else None, remote_native(), routing['account'])
        launch = dict(cwd=payload.get('cwd'), name=payload.get('name') or 'Agent', parent_id=parent_id,
                      argv=model_router.harness_argv(profile, routing['model']), launch_profile=None if profile == 'grok' else profile)
        if not parent_id:
            from agent_desk.standalone_agent import launch_payload as standalone_payload
            launch = standalone_payload(launch)
        session = TERMINALS.launch(launch)
        return dict(session.info(), routing=routing, profile=profile, summary=model_router.summary(routing))
    raise ValueError('Not found')


def main():
    global COORDINATORS, DESKS, DEVELOPMENT, TERMINALS
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=4310)
    parser.add_argument('--production', action='store_true', help='Hide development tools and disable the feedback API')
    parser.add_argument('--attach-only',action='store_true',help='Require an existing terminal supervisor; never create a replacement during a backend restart')
    args = parser.parse_args()
    from agent_desk.terminal_owners import TerminalOwners
    TERMINALS = DeskTerminals(TerminalOwners.attach(DATA_DIR, args.port,start=not args.attach_only))
    TERMINALS.call('hello')
    coordinator_file = 'coordinators.sqlite3' if args.port == 4310 else f'coordinators-{args.port}.sqlite3'
    COORDINATORS = CoordinatorRuntime(DATA_DIR / coordinator_file, TERMINALS, MAILBOX)
    DESKS = Desks(DATA_DIR / ('desks.json' if args.port == 4310 else f'desks-{args.port}.json'))
    atexit.register(COORDINATORS.close)
    DEVELOPMENT = not args.production
    WORKFLOWS.desk = f'http://127.0.0.1:{args.port}'
    COORDINATORS.desk = WORKFLOWS.desk
    COORDINATORS.event_bus = WORKFLOWS.events
    def automation_terminals():
        with SPECIAL_AGENTS.db() as db:return {r[0] for r in db.execute('SELECT terminal_id FROM runs WHERE terminal_id IS NOT NULL')}
    COORDINATORS.attachment_exclusions = automation_terminals
    COORDINATORS.protected_panes = lambda: set(PROTECTED_PANES.ids)
    COORDINATORS.tool_catalog = TOOL_RUNTIME.catalog
    def launch_hook_ui(skill,target,identity,coordinator,extra):
        item=TOOL_RUNTIME.launch(skill,target,identity,extra=extra)
        return register_skill_ui({k:v for k,v in item.items() if k in ('id','title','skill','url','context')} | {'agent_id':coordinator},args.port)
    COORDINATORS.tool_launcher = launch_hook_ui
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    cleanup_stop = threading.Event()
    def cleanup_automations():
        while not cleanup_stop.is_set():
            try:SPECIAL_AGENTS.close_completed(TERMINALS)
            except Exception:
                import logging
                logging.exception('Automation terminal cleanup will retry')
            try:drain_feedback(COORDINATORS)
            except Exception:
                import logging
                logging.exception('Queued feedback delivery will retry')
            cleanup_stop.wait(2)
    cleanup_thread = threading.Thread(target=cleanup_automations, daemon=True)
    cleanup_thread.start()
    WORKFLOWS.start_scheduler()
    COORDINATORS.start()
    def retire_tool_registrations():
        result = tool_registration.retire()
        for label in result['removed']:
            print(f'Removed the account-wide agent-desk tool server from {label}; readouts are now chosen per terminal', flush=True)
        for error in result['errors']:
            print(f'Could not remove an agent-desk tool server registration: {error}', flush=True)
    # Only the main desk edits account configuration; test and side desks on other ports never do.
    if args.port == 4310:
        threading.Thread(target=retire_tool_registrations, daemon=True).start()
    desk_tokens.write_token('adapter', args.port, TOKEN)
    # Local helpers (agent_control, feedback forwarders) read this file; the
    # HTTP endpoint only serves the desk's own page.
    desk_tokens.write_token('terminal', args.port, HELPER_TOKEN)
    print(f'Agent Desk → http://127.0.0.1:{args.port}', flush=True)
    print(f'Adapter token (this run only): {TOKEN}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        cleanup_stop.set()
        cleanup_thread.join(timeout=15)
        WORKFLOWS.stopping.set()
        COORDINATORS.close()
        TERMINALS.close()
        server.server_close()


if __name__ == "__main__":
    main()
