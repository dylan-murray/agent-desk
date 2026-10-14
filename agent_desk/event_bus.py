"""Local, durable event admission and dispatch, sharing the workflow transaction.

Event identities are permanent receipts. Only pending payloads occupy the bounded
queue; a receipt and its workflow are committed together, never retried separately.
"""
import hashlib
import hmac
import json
import math
import re
import secrets
import time
from pathlib import Path
from urllib.parse import urlparse

QUEUE_LIMIT = 256
MAX_BYTES = 32768
MAX_AGE = 86400
FILE_LIMIT = 2000
POLICY = ('Accepted events wait up to 24 hours, including sleep or downtime. '
          'The queue holds 256 events; a full queue returns 429 for retry with the same ID. '
          'Webhook senders must retry while Agent Desk is unavailable. Files and watches '
          'compare the latest state after waking; intermediate changes may be missed. '
          'The first matching enabled rule receives each event; use its workflow for multiple tasks. '
          'Busy configurations wait in the queue. Pausing or editing a rule discards its waiting events. '
          'Pausing a source discards its waiting events; resuming establishes a fresh observation baseline.')


class EventError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def encoded(value):
    try:
        result = json.dumps(value, allow_nan=False, sort_keys=True, separators=(',', ':'))
    except (TypeError, ValueError, RecursionError):
        raise EventError('Event must contain finite JSON values') from None
    if len(result.encode()) > MAX_BYTES:
        raise EventError('Event exceeds 32 KiB', 413)
    return result


def validate_event(value, now=None):
    now = time.time() if now is None else now
    if not isinstance(value, dict) or set(value) - {'id', 'payload', 'occurred_at'}:
        raise EventError('Expected id, payload, and optional occurred_at')
    identity = value.get('id')
    if not isinstance(identity, str) or not re.fullmatch(r'[A-Za-z0-9_.:@/\-]{1,200}', identity):
        raise EventError('Use a stable event id of 1–200 letters, digits, or . _ : @ / -')
    if not isinstance(value.get('payload'), dict):
        raise EventError('Event payload must be a JSON object')
    encoded(value)
    def depth(item, level=0):
        if level > 12:
            raise EventError('Event nesting exceeds 12 levels')
        if isinstance(item, dict):
            for key, child in item.items():
                if not isinstance(key, str):
                    raise EventError('Event keys must be strings')
                depth(child, level + 1)
        elif isinstance(item, list):
            for child in item:
                depth(child, level + 1)
    depth(value['payload'])
    occurred = value.get('occurred_at', now)
    if type(occurred) not in (int, float) or not math.isfinite(occurred) or occurred < 0 or occurred > now + 300:
        raise EventError('occurred_at must be a Unix timestamp, no more than five minutes in the future')
    return dict(id=identity, payload=value['payload'], occurred_at=occurred)


def predicate(value):
    if not isinstance(value, dict) or set(value) - {'field', 'op', 'value'}:
        raise ValueError('Choose a payload field and comparison')
    field = value.get('field', '')
    op = value.get('op')
    if not isinstance(field, str) or not re.fullmatch(r'[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){0,10}', field) or len(field) > 200:
        raise ValueError('Use a dotted payload field, such as event.type')
    if op not in ('equals', 'contains', 'exists'):
        raise ValueError('Choose equals, contains, or exists')
    if op != 'exists' and 'value' not in value:
        raise ValueError('Enter a comparison value')
    if op == 'contains' and (not isinstance(value['value'], str) or not value['value']):
        raise ValueError('Contains requires nonempty text')
    encoded(value)
    return dict(field=field, op=op, **({'value': value['value']} if op != 'exists' else {}))


def matches(payload, rule):
    current = payload
    for key in rule['field'].split('.'):
        if not isinstance(current, dict) or key not in current:
            return False
        current = current[key]
    if rule['op'] == 'exists':
        return True
    if rule['op'] == 'contains':
        return isinstance(current, str) and rule['value'] in current
    # JSON booleans must not compare equal to numbers, as they do in Python.
    return encoded(current) == encoded(rule['value'])


class EventBus:
    def __init__(self, runtime):
        self.runtime = runtime
        self.queue_limit = QUEUE_LIMIT

    @staticmethod
    def schema(db):
        db.executescript('''
        CREATE TABLE IF NOT EXISTS event_sources(
          id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,settings TEXT NOT NULL,
          token_hash TEXT,enabled INTEGER NOT NULL DEFAULT 0,last_seen REAL,last_error TEXT NOT NULL DEFAULT '',
          baseline TEXT,revision INTEGER NOT NULL DEFAULT 0,next_check REAL NOT NULL DEFAULT 0,
          failures INTEGER NOT NULL DEFAULT 0,generation TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS bus_events(
          source_id TEXT NOT NULL,event_id TEXT NOT NULL,payload TEXT,created REAL NOT NULL,expires REAL NOT NULL,
          state TEXT NOT NULL,detail TEXT NOT NULL,workflow_id TEXT,rule_version TEXT,flow_id TEXT,
          PRIMARY KEY(source_id,event_id));
        CREATE INDEX IF NOT EXISTS bus_events_pending ON bus_events(state,created);
        ''')

    def snapshot(self):
        with self.runtime.db() as db:
            sources = [dict(row) for row in db.execute('SELECT id,name,kind,settings,enabled,last_seen,last_error,next_check FROM event_sources ORDER BY rowid')]
            for source in sources:
                source['settings'] = json.loads(source['settings'])
                source['enabled'] = bool(source['enabled'])
            events = [dict(row) for row in db.execute('SELECT source_id,event_id,created,state,detail,workflow_id,flow_id FROM bus_events ORDER BY created DESC,rowid DESC LIMIT 100')]
            queued = db.execute("SELECT COUNT(*) FROM bus_events WHERE state='pending'").fetchone()[0]
        return dict(sources=sources, events=events, queued=queued, capacity=self.queue_limit, policy=POLICY)

    def save_source(self, p):
        name = p.get('name')
        kind = p.get('kind')
        settings = p.get('settings', {})
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100:
            raise ValueError('Enter a source name')
        if kind not in ('webhook', 'file', 'directory', 'pr', 'url') or not isinstance(settings, dict):
            raise ValueError('Choose webhook, file, directory, PR, or URL')
        if kind in ('file', 'directory'):
            path = settings.get('path')
            if not isinstance(path, str) or not Path(path).is_absolute():
                raise ValueError('Choose an absolute path')
            path = Path(path)
            if not (path.is_file() if kind == 'file' else path.is_dir()):
                raise ValueError('Choose an existing ' + kind)
            settings = {'path': str(path.resolve())}
        elif kind in ('pr', 'url'):
            from agent_desk.coordinator_watches import PR_URL
            url = settings.get('url', '')
            if not isinstance(url, str) or len(url) > 2000:
                raise ValueError('Choose an HTTP or HTTPS URL')
            parsed = urlparse(url)
            if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
                raise ValueError('Use an HTTP or HTTPS URL without credentials or a fragment')
            if kind == 'pr' and not PR_URL.fullmatch(url):
                raise ValueError('Use a github.com pull request URL')
            settings = {'url': url.rstrip('/') if kind == 'pr' else url}
        else:
            settings = {}
        identity = p.get('id') or secrets.token_hex(12)
        if not isinstance(identity, str) or not re.fullmatch(r'[a-f0-9]{24}', identity):
            raise ValueError('Invalid source ID')
        token = None
        with self.runtime.lock, self.runtime.db() as db:
            db.execute('BEGIN IMMEDIATE')
            prior = db.execute('SELECT * FROM event_sources WHERE id=?', (identity,)).fetchone()
            if p.get('id') and not prior:
                raise ValueError('Source no longer exists')
            if not prior and db.execute('SELECT COUNT(*) FROM event_sources').fetchone()[0] >= 64:
                raise ValueError('Source limit reached (64)')
            if prior and prior['kind'] != kind:
                raise ValueError('Create a new source to change its type')
            token_hash = prior['token_hash'] if prior else None
            if kind == 'webhook' and not prior:
                token = secrets.token_urlsafe(32)
                token_hash = hashlib.sha256(token.encode()).hexdigest()
            revision = prior['revision'] if prior else 0
            db.execute('INSERT OR REPLACE INTO event_sources(id,name,kind,settings,token_hash,revision,generation,last_seen,last_error) VALUES(?,?,?,?,?,?,?,?,?)',
                       (identity, name.strip(), kind, json.dumps(settings), token_hash, revision, secrets.token_hex(12), prior['last_seen'] if prior else None, prior['last_error'] if prior else ''))
            self.discard(db, 'source_id', identity, 'Source edited; waiting events discarded')
        return dict(id=identity, token=token)

    @staticmethod
    def discard(db, column, identity, detail):
        assert column in ('workflow_id', 'source_id')
        db.execute(f"UPDATE bus_events SET state='discarded',detail=?,payload=NULL WHERE {column}=? AND state='pending'", (detail, identity))

    def toggle_source(self, identity, enabled):
        if type(enabled) is not bool:
            raise ValueError('Choose enabled or paused')
        with self.runtime.lock, self.runtime.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if not db.execute('UPDATE event_sources SET enabled=?,baseline=NULL,next_check=0,failures=0,generation=? WHERE id=?', (enabled, secrets.token_hex(12), identity)).rowcount:
                raise ValueError('Source not found')
            if not enabled:
                self.discard(db, 'source_id', identity, 'Source paused; waiting events discarded')
        return {'ok': True}

    def rotate_token(self, identity):
        token = secrets.token_urlsafe(32)
        with self.runtime.db() as db:
            if not db.execute("UPDATE event_sources SET token_hash=? WHERE id=? AND kind='webhook'", (hashlib.sha256(token.encode()).hexdigest(), identity)).rowcount:
                raise ValueError('Webhook source not found')
        return {'token': token, 'id': identity}

    def delete_source(self, identity):
        with self.runtime.lock, self.runtime.db() as db:
            db.execute('BEGIN IMMEDIATE')
            for row in db.execute('SELECT payload FROM workflows'):
                if json.loads(row[0]).get('event', {}).get('source_id') == identity:
                    raise ValueError('Delete or edit rules using this source first')
            self.discard(db, 'source_id', identity, 'Source deleted')
            db.execute('DELETE FROM event_sources WHERE id=?', (identity,))
        return {'deleted': True}

    def authenticate(self, identity, token):
        with self.runtime.db() as db:
            row = db.execute("SELECT token_hash FROM event_sources WHERE id=? AND kind='webhook'", (identity,)).fetchone()
        if not row:
            raise EventError('Unknown webhook source', 404)
        if not isinstance(token, str) or not hmac.compare_digest(row[0], hashlib.sha256(token.encode()).hexdigest()):
            raise EventError('Invalid source token', 403)

    def error(self, identity, detail, *, seen=False):
        with self.runtime.db() as db:
            db.execute('UPDATE event_sources SET last_error=?,last_seen=CASE WHEN ? THEN ? ELSE last_seen END WHERE id=?', (detail[:500], seen, time.time(), identity))

    def ingest(self, identity, value):
        now = time.time()
        try:
            event = validate_event(value, now)
            with self.runtime.lock, self.runtime.db() as db:
                db.execute('BEGIN IMMEDIATE')
                source = db.execute('SELECT * FROM event_sources WHERE id=?', (identity,)).fetchone()
                if not source:
                    raise EventError('Unknown event source', 404)
                result = self.admit(db, source, event, now)
                db.execute("UPDATE event_sources SET last_seen=?,last_error='' WHERE id=?", (now, identity))
            return result
        except EventError as exc:
            self.error(identity, str(exc), seen=True)
            raise

    def admit(self, db, source, event, now):
        prior = db.execute('SELECT state,flow_id FROM bus_events WHERE source_id=? AND event_id=?', (source['id'], event['id'])).fetchone()
        if prior:
            return dict(duplicate=True, state=prior['state'], flow_id=prior['flow_id'])
        if not source['enabled']:
            raise EventError('Source is paused; retry only after it is enabled', 409)
        if event['occurred_at'] <= now - MAX_AGE:
            raise EventError('Event is older than 24 hours', 410)
        rule = None
        for row in db.execute('SELECT payload FROM workflows ORDER BY rowid'):
            candidate = json.loads(row[0])
            match = candidate.get('event', {})
            if candidate['trigger'] == 'event' and candidate['enabled'] and match.get('source_id') == source['id'] and matches(event['payload'], match['predicate']):
                rule = candidate
                break
        if rule and db.execute("SELECT COUNT(*) FROM bus_events WHERE state='pending'").fetchone()[0] >= self.queue_limit:
            raise EventError('Event queue is full; retry with the same event ID', 429)
        state = 'pending' if rule else 'ignored'
        context = dict(event, source_id=source['id'], source_name=source['name'], received_at=now)
        db.execute('INSERT INTO bus_events VALUES(?,?,?,?,?,?,?,?,?,NULL)',
                   (source['id'], event['id'], json.dumps(context) if rule else None, now, event['occurred_at'] + MAX_AGE,
                    state, 'Waiting to run' if rule else 'No enabled rule matched', rule['id'] if rule else None, rule['event_version'] if rule else None))
        return dict(duplicate=False, state=state, flow_id=None)

    def dispatch(self, db, now):
        db.execute("UPDATE bus_events SET state='expired',detail='24-hour queue limit reached',payload=NULL WHERE state='pending' AND expires<=?", (now,))
        for row in db.execute("SELECT * FROM bus_events WHERE state='pending' ORDER BY created,rowid LIMIT 256").fetchall():
            source = db.execute('SELECT enabled FROM event_sources WHERE id=?', (row['source_id'],)).fetchone()
            saved = db.execute('SELECT payload FROM workflows WHERE id=?', (row['workflow_id'],)).fetchone()
            rule = json.loads(saved[0]) if saved else {}
            state, detail, flow_id = 'discarded', 'Source or rule is paused, edited, or deleted', None
            if source and source[0] and rule.get('enabled') and rule.get('event_version') == row['rule_version']:
                busy = db.execute("SELECT 1 FROM flows WHERE workflow_id=? AND state='running'", (rule['id'],)).fetchone()
                for node in rule['nodes']:
                    busy = busy or db.execute("SELECT 1 FROM executions WHERE config_id=? AND state IN ('queued','starting','running','ready')", (node['config_id'],)).fetchone()
                if busy:
                    db.execute("UPDATE bus_events SET detail='Waiting for the active configuration or workflow' WHERE source_id=? AND event_id=?", (row['source_id'], row['event_id']))
                    continue
                # Failure before commit rolls back both the flow and its receipt.
                flow_id = self.runtime.enqueue_flow(db, rule['id'], event=json.loads(row['payload']))['id']
                state, detail = 'dispatched', 'Workflow started'
            db.execute('UPDATE bus_events SET state=?,detail=?,flow_id=?,payload=NULL WHERE source_id=? AND event_id=?', (state, detail, flow_id, row['source_id'], row['event_id']))

    def jobs(self, kinds, now):
        with self.runtime.db() as db:
            rows = [dict(row) for row in db.execute('SELECT * FROM event_sources WHERE enabled=1 AND next_check<=? ORDER BY next_check', (now,))]
        return [dict(row, settings=json.loads(row['settings'])) for row in rows if row['kind'] in kinds]

    def observe(self, row, payload, baseline, now):
        """Persist observation and event together; a full queue leaves the baseline intact."""
        with self.runtime.lock, self.runtime.db() as db:
            db.execute('BEGIN IMMEDIATE')
            current = db.execute('SELECT * FROM event_sources WHERE id=?', (row['id'],)).fetchone()
            if not current or not current['enabled'] or current['generation'] != row['generation'] or current['revision'] != row['revision']:
                return
            revision = current['revision']
            if current['baseline'] is not None and current['baseline'] != baseline:
                revision += 1
                self.admit(db, current, dict(id=f'{row["id"]}:{revision}', payload=payload, occurred_at=now), now)
            db.execute("UPDATE event_sources SET baseline=?,revision=?,last_seen=?,last_error='',failures=0,next_check=? WHERE id=?",
                       (baseline, revision, now, now + (5 if row['kind'] in ('file', 'directory') else 180), row['id']))

    def observation_error(self, row, exc, now):
        failures = row['failures'] + 1
        with self.runtime.db() as db:
            db.execute('UPDATE event_sources SET last_error=?,failures=?,next_check=? WHERE id=? AND generation=?',
                       (str(exc)[:500], failures, now + min(1800, 5 * 2 ** min(failures, 9)), row['id'], row['generation']))

    @staticmethod
    def file_snapshot(row):
        path = Path(row['settings']['path'])
        items = {}
        def record(entry):
            try:
                stat = entry.lstat()
            except FileNotFoundError:
                return
            items[str(entry.relative_to(path))] = [stat.st_mode, stat.st_mtime_ns, stat.st_size, stat.st_ino]
            if len(items) > FILE_LIMIT:
                raise ValueError('Directory exceeds 2,000 entries; choose a smaller directory')
        record(path)
        if row['kind'] == 'directory' and path.is_dir() and not path.is_symlink():
            # Never follow symlinked directories; an unreadable subtree is an error.
            import os
            def failed(exc):
                raise exc
            for root, dirs, files in os.walk(path, followlinks=False, onerror=failed):
                for name in dirs + files:
                    record(Path(root) / name)
        baseline = json.dumps(items, sort_keys=True, separators=(',', ':'))
        before = json.loads(row['baseline']) if row['baseline'] is not None else {}
        changed = sorted(key for key in items.keys() | before.keys() if items.get(key) != before.get(key))
        return dict(path=str(path), kind=row['kind'], change='deleted' if not items else 'created' if not before else 'modified',
                    paths=changed[:50], changed_count=len(changed)), baseline

    def poll_files(self):
        now = time.time()
        for row in self.jobs(('file', 'directory'), now):
            try:
                payload, baseline = self.file_snapshot(row)
                self.observe(row, payload, baseline, now)
            except Exception as exc:
                self.observation_error(row, exc, now)
