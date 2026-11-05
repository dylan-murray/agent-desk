"""The page's annotate-anything notes, kept in the same shape as its own file store.

The browser owns what a note says and where it points; the desk and the agent own its
lifecycle (status, sentAt, pickedUpAt, reply, resolvedAt), so a browser sync never
overwrites an agent's progress. Writes take a file lock, so the server and an agent
running ``scripts/annotation_status.py`` can both update the same file.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import math
import os
from pathlib import Path
import re
import tempfile
import threading
import uuid

KINDS = ('pin', 'element', 'area')
STATUSES = ('open', 'sent', 'working', 'resolved')
LIFECYCLE = ('status', 'sentAt', 'pickedUpAt', 'reply', 'resolvedAt', 'agent')
MAX_NOTES = 1000
MAX_DELETED = 5000
ID = re.compile(r'[\w.-]{1,100}\Z')
LINE_BREAKS = re.compile('[\u0000-\u001f\u007f-\u009f  ]+')
CONTROL = re.compile('[\u0000-\u0008\u000b-\u001f\u007f-\u009f  ]')


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _text(value, limit):
    return value[:limit] if isinstance(value, str) else ''


def _line(value, limit):
    """Single-line fields can't carry line breaks, so they can't pass for the desk's own output."""
    return LINE_BREAKS.sub(' ', _text(value, limit)).strip()


def _prose(value, limit):
    return CONTROL.sub('', _text(value, limit))


def _number(value):
    return round(value, 1) if type(value) in (int, float) and math.isfinite(value) else 0


def _when(value):
    if not isinstance(value, str):
        return None
    try:
        datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    return value[:40]


def _box(value):
    value = value if isinstance(value, dict) else {}
    return {k: _number(value.get(k)) for k in ('x', 'y', 'width', 'height')}


def _stamp(value):
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (AttributeError, ValueError):
        return 0


def clean_note(raw):
    """A note as annotate-anything's server keeps it, or None when it isn't one."""
    if not isinstance(raw, dict) or not isinstance(raw.get('id'), str) or not ID.match(raw['id']):
        return None
    comment = _prose(raw.get('comment'), 20000).strip()
    if raw.get('kind') not in KINDS or not comment:
        return None
    context = raw.get('context')
    if not isinstance(context, dict) or len(json.dumps(context, default=str)) > 4000:
        context = {}
    n = raw.get('n')
    scroll, viewport = raw.get('scroll'), raw.get('viewport')
    note = {
        'id': raw['id'],
        'n': min(n, 1000000) if type(n) is int and n > 0 else 0,
        'kind': raw['kind'],
        'route': _line(raw.get('route'), 500) or '/',
        'comment': comment,
        'createdAt': _when(raw.get('createdAt')) or now(),
        'updatedAt': _when(raw.get('updatedAt')) or now(),
        'status': raw.get('status') if raw.get('status') in STATUSES else 'open',
        'selector': _line(raw.get('selector'), 1000),
        'tag': _line(raw.get('tag'), 40),
        'targetText': _line(raw.get('targetText'), 400),
        'x': _number(raw.get('x')),
        'y': _number(raw.get('y')),
        'bounds': _box(raw.get('bounds')),
        'scroll': {k: _number((scroll if isinstance(scroll, dict) else {}).get(k)) for k in ('x', 'y')},
        'viewport': {k: _number((viewport if isinstance(viewport, dict) else {}).get(k)) for k in ('width', 'height')},
        'inDialog': raw.get('inDialog') is True,
        'context': context,
    }
    for key, limit in (('origin', 300), ('testId', 200), ('agent', 60)):
        if value := _line(raw.get(key), limit):
            note[key] = value
    if raw.get('offset'):
        note['offset'] = _box(raw['offset'])
    for key in ('sentAt', 'pickedUpAt', 'resolvedAt'):
        if value := _when(raw.get(key)):
            note[key] = value
    if reply := _prose(raw.get('reply'), 20000):
        note['reply'] = reply
    return note


class AnnotationStore:
    def __init__(self, path, archive=None):
        self.path = Path(path)
        self.archive = archive
        self.thread_lock = threading.Lock()

    @contextmanager
    def locked(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.thread_lock, open(self.path.with_name(self.path.name + '.lock'), 'a') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def load(self):
        try:
            saved = json.loads(self.path.read_text())
        except FileNotFoundError:
            saved = {}
        notes = [n for n in map(clean_note, saved.get('notes') or []) if n]
        deleted = [d for d in saved.get('deleted') or [] if isinstance(d, str)]
        agent = _line(saved.get('agent'), 60)
        return {'notes': notes, 'deleted': deleted, **({'agent': agent} if agent else {})}

    def _write(self, before, state):
        if self.archive:
            self.archive(self.path, before, state)
        fd, temp = tempfile.mkstemp(dir=self.path.parent, prefix='.feedback-')
        try:
            with os.fdopen(fd, 'w') as handle:
                handle.write(json.dumps(state, indent=1, allow_nan=False) + '\n')
            os.replace(temp, self.path)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)

    def read(self):
        with self.locked():
            state = self.load()
        return {**state, 'watching': False, 'picks': True}

    def sync(self, incoming, deleted):
        if not isinstance(incoming, list) or not isinstance(deleted, list):
            raise ValueError('Send notes and deleted as lists')
        if len(incoming) > MAX_NOTES:
            raise ValueError(f'At most {MAX_NOTES} notes')
        with self.locked():
            state = self.load()
            gone = list(dict.fromkeys(state['deleted'] + [d for d in deleted if isinstance(d, str) and ID.match(d)]))
            dropped = set(gone)
            by_id = {n['id']: n for n in state['notes']}
            used = {n['n'] for n in state['notes']}
            for raw in incoming:
                note = clean_note(raw)
                if not note or note['id'] in dropped:
                    continue
                stored = by_id.get(note['id'])
                if not stored:
                    # Two tabs can pick the same number; agents refer to notes by it, so keep it unique.
                    if not note['n'] or note['n'] in used:
                        note['n'] = max(used, default=0) + 1
                    used.add(note['n'])
                    for key in LIFECYCLE:
                        note.pop(key, None)
                    note['status'] = 'open'
                    by_id[note['id']] = note
                    continue
                if _stamp(stored['updatedAt']) > _stamp(note['updatedAt']):
                    continue
                note['n'] = stored['n']
                for key in LIFECYCLE:
                    if key in stored:
                        note[key] = stored[key]
                    else:
                        note.pop(key, None)
                by_id[note['id']] = note
            notes = [n for n in by_id.values() if n['id'] not in dropped]
            if len(notes) > MAX_NOTES:
                raise ValueError(f'At most {MAX_NOTES} notes; clear the finished ones')
            result = {**state, 'notes': notes, 'deleted': gone[-MAX_DELETED:]}
            self._write(state, result)
        return {**result, 'watching': False, 'picks': True}

    def take(self, ids):
        """The open notes among ``ids``, ready to send, without changing them yet."""
        want = set(i for i in ids if isinstance(i, str))
        with self.locked():
            return [n for n in self.load()['notes'] if n['id'] in want and n['status'] == 'open']

    def mark_sent(self, ids, agent=None, picked_up=False):
        want, stamp, agent = set(ids), now(), _line(agent, 60)
        with self.locked():
            state = self.load()
            result = {**state, 'notes': [dict(n) for n in state['notes']]}
            for note in result['notes']:
                if note['id'] in want and note['status'] == 'open':
                    note.update(status='sent', sentAt=stamp)
                    if agent:
                        note['agent'] = agent
                    if picked_up:
                        note['pickedUpAt'] = stamp
            if agent:
                result['agent'] = agent
            self._write(state, result)
        return stamp

    def _waiting(self, ids, change):
        """Apply ``change`` to the sent notes among ``ids`` that no agent has picked up yet."""
        want = set(ids)
        with self.locked():
            state = self.load()
            waiting = lambda n: n['id'] in want and n['status'] == 'sent' and 'pickedUpAt' not in n  # noqa: E731
            if any(map(waiting, state['notes'])):
                self._write(state, {**state, 'notes': [change(dict(n)) if waiting(n) else n for n in state['notes']]})

    def pick_up(self, ids):
        stamp = now()
        self._waiting(ids, lambda n: n | {'pickedUpAt': stamp})

    def reopen_undelivered(self, ids):
        """A queued delivery that failed hands its notes back, so they can be sent again."""
        def reopen(note):
            note.pop('sentAt', None)
            note.pop('agent', None)
            return note | {'status': 'open'}
        self._waiting(ids, reopen)

    def set_status(self, refs, status, reply=None):
        if status not in STATUSES:
            raise ValueError('status must be open, sent, working or resolved')
        if reply is not None and not isinstance(reply, str):
            raise ValueError('reply must be a string')
        want = {str(r).lstrip('#') for r in refs if r is not None}
        if not want:
            raise ValueError('Name the notes by number or id')
        stamp = now()
        with self.locked():
            state = self.load()
            result = {**state, 'notes': [dict(n) for n in state['notes']]}
            changed = [n for n in result['notes'] if n['id'] in want or str(n['n']) in want]
            for note in changed:
                note.update(status=status, updatedAt=stamp)
                if status == 'open':
                    note.pop('sentAt', None)
                    note.pop('pickedUpAt', None)
                    note.pop('agent', None)
                if status == 'resolved':
                    note['resolvedAt'] = stamp
                else:
                    note.pop('resolvedAt', None)
                if reply is not None:
                    if text := _prose(reply, 20000).strip():
                        note['reply'] = text
                    else:
                        note.pop('reply', None)
            if changed:
                self._write(state, result)
        return changed


def submission(notes, page, stamp):
    return {'id': uuid.uuid4().hex, 'submittedAt': stamp,
            'route': _line(page.get('route'), 500), 'url': _line(page.get('url'), 2000), 'title': _line(page.get('title'), 300),
            'noteIds': [n['id'] for n in notes], 'count': len(notes),
            'excerpts': ['#%d %s' % (n['n'], ' '.join(n['comment'].split())[:140]) for n in notes]}
