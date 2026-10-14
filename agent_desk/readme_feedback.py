"""Local delivery and revision-checked completion for managed README annotators."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import shlex
import tempfile
import threading
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from agent_desk.desk_tokens import read_terminal_token
from agent_desk.paths import DATA_DIR, PROJECT_DIR


def request_json(url, payload=None, headers=None):
    request = Request(url, data=json.dumps(payload).encode() if payload is not None else None,
                      headers={'Content-Type': 'application/json', **(headers or {})})
    try:
        with urlopen(request, timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        try:
            message = json.load(error).get('error', 'Feedback request failed')
        except (ValueError, OSError):
            message = 'Feedback request failed'
        finally:
            error.close()
        raise ValueError(message) from None


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def file_digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as file:
            json.dump(value, file, ensure_ascii=False, indent=2)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class ReadmeFeedback:
    def __init__(self, registry=None, state=None, desk=None):
        self.registry = Path(registry or DATA_DIR / 'skill-uis.json')
        self.state = Path(state or DATA_DIR / 'readme-feedback')
        self.desk = desk or os.environ.get('AGENT_DESK_URL', 'http://127.0.0.1:4310')
        parsed = urlparse(self.desk)
        if parsed.scheme != 'http' or parsed.hostname not in ('localhost', '127.0.0.1') or not parsed.port:
            raise ValueError('Feedback destination must be a local Agent Desk URL')
        self.token = secrets.token_urlsafe(32)
        self.lock = threading.Lock()

    def owner(self, handler):
        records = json.loads(self.registry.read_text()) if self.registry.exists() else []
        matches = [item for item in records
                   if item.get('skill') == 'readme-review'
                   and Path(item.get('context', '')).resolve() == handler.doc.resolve()
                   and urlparse(item.get('url', '')).port == handler.server.server_port]
        if len(matches) != 1 or not matches[0].get('agent_id'):
            raise ValueError('No launching session linked')
        return matches[0]

    def folder(self, handler):
        return self.state / digest(str(handler.doc.resolve()))

    def config(self, handler):
        try:
            owner = self.owner(handler)
            target = owner['agent_id']
        except ValueError:
            target = None
        sent = []
        folder = self.folder(handler)
        with handler.ann._lock:
            current, round_number = handler.ann.load(), handler.ann.round()
        for path in folder.glob('*.json'):
            snapshot = json.loads(path.read_text())
            if snapshot.get('state') != 'sent' or snapshot['round'] != round_number:
                continue
            for note in current:
                if note.get('status') != 'addressed' and note in snapshot['notes']:
                    sent.append(note['id'])
        return dict(token=self.token, target_id=target, sent_ids=sorted(set(sent)),
                    label='Send to coordinator' if target and target.startswith('coordinator-') else 'Send to agent')

    def submit(self, handler, payload):
        with self.lock:
            owner = self.owner(handler)
            if payload.get('target_id') != owner['agent_id']:
                raise ValueError('The launching session link changed. Try again.')
            with handler.ann._lock:
                notes = [note for note in handler.ann.load() if note.get('status') != 'addressed']
                round_number = handler.ann.round()
            if not notes:
                raise ValueError('Add an open note before sending.')
            if payload.get('notes') != notes:
                raise ValueError('Notes changed in another tab. Review them and send again.')
            identity = 'readme-' + digest([owner['agent_id'], str(handler.doc.resolve()), round_number, notes])
            path = self.folder(handler) / (identity + '.json')
            if path.exists():
                snapshot = json.loads(path.read_text())
                if snapshot['state'] == 'sent':
                    return dict(sent=True, duplicate=True, request_id=identity)
            else:
                snapshot = dict(state='pending', request_id=identity, tool_id=owner['id'],
                                document=str(handler.doc.resolve()), round=round_number,
                                notes=notes, document_hash=file_digest(handler.doc))
                save_json(path, snapshot)
            command = shlex.join(['python3', str(PROJECT_DIR / 'scripts/complete_readme_feedback.py'),
                                  '--snapshot', str(path.resolve()), '--ids'])
            forwarded = [dict(note, id=str(note['id']), note=note['comment'],
                              document=str(handler.doc.resolve()), source='readme-review',
                              completion={
                                  'instruction': 'After implementing and verifying this requested document change, run the command below to mark this exact annotation done. Do not wait for user acceptance, and do not mark an unimplemented request done. Include this command in the worker handoff. The command refuses notes edited or replaced since submission.',
                                  'command': command + ' ' + str(note['id']),
                              }) for note in notes]
            result = request_json(self.desk + '/api/coordinators/submit-feedback',
                                  dict(target_id=owner['agent_id'], request_id=identity, notes=forwarded),
                                  {'X-Agent-Desk-Terminal': read_terminal_token(self.desk)})
            if result.get('sent') is not True:
                raise ValueError('Delivery was not confirmed. Try again.')
            snapshot['state'] = 'sent'
            save_json(path, snapshot)
            return dict(sent=True, duplicate=result.get('duplicate', False), request_id=identity)

    def complete(self, handler, payload):
        identity, ids = payload.get('request_id'), payload.get('ids')
        if not isinstance(identity, str) or not identity.startswith('readme-') or len(identity) != 71 or not all(c in '0123456789abcdef' for c in identity[7:]):
            raise ValueError('Invalid submission ID')
        if not isinstance(ids, list) or not ids or any(type(i) is not int for i in ids):
            raise ValueError('Choose annotation IDs to mark done')
        with self.lock, handler.ann._lock:
            snapshot = json.loads((self.folder(handler) / (identity + '.json')).read_text())
            if snapshot['state'] != 'sent' or snapshot['round'] != handler.ann.round():
                raise ValueError('This annotation round is no longer current')
            originals = {note['id']: note for note in snapshot['notes']}
            notes = handler.ann.load()
            current = {note['id']: note for note in notes}
            for identity in ids:
                old, new = originals.get(identity), current.get(identity)
                if not old or not new or dict(new, status=old.get('status')) != old:
                    raise ValueError(f'Annotation {identity} changed since submission; review its current request')
            if file_digest(handler.doc) == snapshot['document_hash']:
                raise ValueError('The document has not changed since this submission')
            for note in notes:
                if note['id'] in ids:
                    note['status'] = 'addressed'
            handler.ann.save(notes)
        return dict(resolved=ids)

    def allowed(self, handler, mutation=False):
        port = handler.server.server_port
        host = handler.headers.get('Host')
        if handler.client_address[0] not in ('127.0.0.1', '::1') or host not in (f'127.0.0.1:{port}', f'localhost:{port}'):
            return False
        origin = handler.headers.get('Origin')
        if origin and origin != 'http://' + host:
            return False
        if handler.headers.get('Sec-Fetch-Site') == 'cross-site':
            return False
        return not mutation or secrets.compare_digest(handler.headers.get('X-Readme-Feedback', ''), self.token)


def install(namespace, bridge=None):
    bridge = bridge or ReadmeFeedback()
    original = namespace['Handler']

    class Handler(original):
        def do_GET(self):
            if urlparse(self.path).path != '/desk-feedback/config':
                return super().do_GET()
            if not bridge.allowed(self):
                return self._send(403, b'{"error":"Local annotator access required"}')
            try:
                self._send(200, json.dumps(bridge.config(self)).encode())
            except (ValueError, OSError):
                self._send(503, b'{"error":"Could not read the feedback connection"}')

        def do_POST(self):
            path = urlparse(self.path).path
            if path not in ('/desk-feedback/submit', '/desk-feedback/complete'):
                return super().do_POST()
            if not bridge.allowed(self, mutation=True):
                return self._send(403, b'{"error":"Local annotator token required"}')
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 80000:
                    raise ValueError('Select fewer annotations per submission (80 KB maximum)')
                payload = json.loads(self.rfile.read(size))
                if not isinstance(payload, dict):
                    raise ValueError('Expected a feedback request')
                action = bridge.submit if path.endswith('/submit') else bridge.complete
                self._send(200, json.dumps(action(self, payload)).encode())
            except ValueError as error:
                self._send(400, json.dumps({'error': str(error)}).encode())
            except (OSError, TimeoutError):
                self._send(503, b'{"error":"Feedback connection unavailable. Try again."}')

    namespace['Handler'] = Handler
