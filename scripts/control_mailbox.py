"""Durable task replies shared by local controller/worker CLI processes."""
from contextlib import contextmanager
import os
from pathlib import Path
import secrets
import hashlib
import sqlite3
import time

import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from agent_desk.paths import DATA_DIR

DEFAULT_DB = DATA_DIR / 'control-mailbox.sqlite3'


LEGACY_AUTO_PREFIX = 'Automatic turn-end report (task success is not verified):\n\n'


class Mailbox:
    def __init__(self, path=None):
        self.path = Path(path or DEFAULT_DB)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        os.chmod(self.path, 0o600)
        with self.connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY, desk TEXT NOT NULL, controller TEXT NOT NULL,
                worker TEXT NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL,
                result TEXT, outcome TEXT, created REAL NOT NULL, updated REAL NOT NULL,
                acknowledged INTEGER NOT NULL DEFAULT 0)''')
            # localhost and 127.0.0.1 are the same desk. Preserve callbacks created
            # before the CLI standardized its loopback URL.
            db.execute("UPDATE tasks SET desk=REPLACE(desk,'http://localhost:','http://127.0.0.1:') WHERE desk LIKE 'http://localhost:%'")
            db.execute('''CREATE TABLE IF NOT EXISTS coordinators (
                desk TEXT NOT NULL, controller TEXT NOT NULL, harness TEXT NOT NULL,
                thread_id TEXT, state TEXT NOT NULL, updated REAL NOT NULL,
                PRIMARY KEY(desk,controller))''')
            db.execute('''CREATE TABLE IF NOT EXISTS deliveries (
                task_id TEXT PRIMARY KEY, batch TEXT NOT NULL, state TEXT NOT NULL,
                updated REAL NOT NULL)''')
            db.execute('''CREATE TABLE IF NOT EXISTS harness_agents (
                id TEXT PRIMARY KEY, desk TEXT NOT NULL, parent_id TEXT NOT NULL,
                native_id TEXT NOT NULL, name TEXT NOT NULL, cwd TEXT NOT NULL,
                status TEXT NOT NULL, result TEXT NOT NULL, updated REAL NOT NULL)''')

            db.execute('CREATE TABLE IF NOT EXISTS worker_conversations (task_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, harness TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS task_progress (task_id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, harness TEXT NOT NULL, updated REAL NOT NULL)')
            # Older observers wrote this exact envelope into the final-result slot.
            # Preserve the observation but release both the result and delivery claim.
            legacy = db.execute("SELECT id,result,updated FROM tasks WHERE outcome='completed' AND substr(result,1,?)=?",
                                (len(LEGACY_AUTO_PREFIX), LEGACY_AUTO_PREFIX)).fetchall()
            for row in legacy:
                db.execute('INSERT OR IGNORE INTO task_progress VALUES (?,?,?,?,?)',
                           (row['id'], 'turn_ended', row['result'][len(LEGACY_AUTO_PREFIX):], 'legacy', row['updated']))
                db.execute("UPDATE tasks SET result=NULL,outcome=NULL,status='waiting',acknowledged=0 WHERE id=?", (row['id'],))
                db.execute('DELETE FROM deliveries WHERE task_id=?', (row['id'],))

    def remember_conversation(self, desk, task_id, session_id, harness):
        import re
        import uuid
        # OpenCode names sessions ses_…; the other CLIs use UUIDs.
        if not (harness=='opencode' and re.fullmatch(r'ses_[A-Za-z0-9]{1,60}',session_id)):session_id=str(uuid.UUID(session_id))
        self.get(desk,task_id)
        with self.connect() as db:
            previous=db.execute('SELECT session_id FROM worker_conversations WHERE task_id=?',(task_id,)).fetchone()
            if previous and previous['session_id']!=session_id:
                raise ValueError('Worker conversation changed; refusing to replace its resume identity')
            db.execute('INSERT OR IGNORE INTO worker_conversations VALUES (?,?,?)',(task_id,session_id,harness))

    def conversation(self, desk, worker):
        with self.connect() as db:
            row=db.execute('SELECT c.session_id FROM worker_conversations c JOIN tasks t ON t.id=c.task_id WHERE t.desk=? AND t.worker=? ORDER BY t.created DESC LIMIT 1',(desk,worker)).fetchone()
        return row['session_id'] if row else None

    def progress(self, desk, identity, text, harness):
        """A turn ending is evidence of activity, never a final task outcome."""
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT result FROM tasks WHERE id=? AND desk=?', (identity, desk)).fetchone()
            if not row:
                raise ValueError('Task not found for this Agent Desk instance')
            if row['result'] is not None:
                return
            db.execute('INSERT OR REPLACE INTO task_progress VALUES (?,?,?,?,?)',
                       (identity, 'turn_ended', text[:14000], harness, time.time()))
            # Do not touch result, outcome, ack, dispatch state, or deliveries.
            # In particular, this cannot wake a native or dedicated coordinator.

    def subagent_event(self, desk, controller, event):
        kind = event.get('hook_event_name')
        if kind not in ('SubagentStart', 'SubagentStop'):
            return
        native_id = event.get('agent_id')
        if not isinstance(native_id, str) or not 1 <= len(native_id) <= 200:
            raise ValueError('Invalid harness agent ID')
        if not self.coordinator(desk, controller):
            raise ValueError('Unknown hosting coordinator')
        identity = 'claude-internal-' + hashlib.sha256((desk+'\0'+controller+'\0'+native_id).encode()).hexdigest()[:24]
        name = str(event.get('agent_type') or 'Subagent')[:100]
        cwd = str(event.get('cwd') or '')[:2000]
        result = str(event.get('last_assistant_message') or '')[:16000]
        with self.connect() as db:
            previous = db.execute('SELECT status FROM harness_agents WHERE id=?', (identity,)).fetchone()
            # A delayed start hook must not resurrect a stopped subagent.
            if previous and previous['status'] == 'completed' and kind == 'SubagentStart':
                return
            db.execute('INSERT OR REPLACE INTO harness_agents VALUES (?,?,?,?,?,?,?,?,?)',
                       (identity, desk, controller, native_id, name, cwd,
                        'working' if kind == 'SubagentStart' else 'completed', result, time.time()))

    def subagents(self, desk, live_parents):
        with self.connect() as db:
            rows = db.execute('SELECT * FROM harness_agents WHERE desk=? ORDER BY updated DESC LIMIT 500', (desk,)).fetchall()
        agents = []
        for row in rows:
            record = dict(row)
            status = record['status']
            if status == 'working' and record['parent_id'] not in live_parents:
                status = 'unknown'
            agents.append(dict(id=record['id'], name=record['name']+' · '+record['native_id'][:8],
                harness='claude', source='harness', harness_internal=True, parent_id=record['parent_id'],
                archived=status=='completed' or record['parent_id'] not in live_parents, cwd=record['cwd'], status=status, updated=record['updated'], events=[], question=None,
                task=record['result'] or ('Internal subagent running; inspect its parent for task details.' if status=='working'
                    else 'Subagent response finished.' if status=='completed' else 'Parent session ended; final subagent state was not reported.'),
                launch_label='Claude internal · read-only'))
        return agents

    def register(self, desk, controller, harness):
        with self.connect() as db:
            db.execute('INSERT OR IGNORE INTO coordinators VALUES (?,?,?,NULL,?,?)',
                       (desk, controller, harness, 'connecting', time.time()))

    def connection(self, desk, controller, state, thread_id=None):
        with self.connect() as db:
            row = db.execute('SELECT thread_id,state FROM coordinators WHERE desk=? AND controller=?', (desk, controller)).fetchone()
            if not row:
                raise ValueError('Coordinator not registered')
            if row['state'] == 'policy-blocked' and state == 'channel-connected':
                return
            if thread_id and row['thread_id'] and thread_id != row['thread_id']:
                raise ValueError('Refusing to route events to a different harness session')
            db.execute('UPDATE coordinators SET state=?,thread_id=COALESCE(?,thread_id),updated=? WHERE desk=? AND controller=?',
                       (state, thread_id, time.time(), desk, controller))

    def coordinator(self, desk, controller):
        with self.connect() as db:
            row = db.execute('SELECT * FROM coordinators WHERE desk=? AND controller=?', (desk, controller)).fetchone()
        return dict(row) if row else None

    def claim(self, desk, controller):
        """Claim before I/O. An interrupted/ambiguous send must never auto-retry."""
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            rows = db.execute('''SELECT t.id FROM tasks t LEFT JOIN deliveries d ON d.task_id=t.id
                WHERE t.desk=? AND t.controller=? AND t.result IS NOT NULL
                AND t.acknowledged=0 AND d.task_id IS NULL ORDER BY t.created LIMIT 50''', (desk, controller)).fetchall()
            if not rows:
                return None
            batch = 'event-' + secrets.token_hex(10)
            db.executemany('INSERT INTO deliveries VALUES (?,?,?,?)',
                           [(r['id'], batch, 'sending', time.time()) for r in rows])
        return dict(id=batch, tasks=[r['id'] for r in rows])

    def delivered(self, batch, state):
        if state not in ('sent', 'uncertain'):
            raise ValueError('Invalid delivery state')
        with self.connect() as db:
            db.execute('UPDATE deliveries SET state=?,updated=? WHERE batch=?', (state, time.time(), batch))

    def events(self, desk):
        with self.connect() as db:
            rows = db.execute('''SELECT t.*, COALESCE(d.state,'queued') AS delivery,
                c.state AS connection, c.harness AS coordinator_harness
                FROM tasks t LEFT JOIN deliveries d ON d.task_id=t.id
                LEFT JOIN coordinators c ON c.desk=t.desk AND c.controller=t.controller
                WHERE t.desk=? ORDER BY t.created DESC LIMIT 500''', (desk,)).fetchall()
        return [dict(row) for row in rows]

    def retry(self, desk, identity, controller):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM tasks WHERE id=? AND desk=? AND controller=?', (identity, desk, controller)).fetchone()
            if not row or row['result'] is None or row['acknowledged']:
                raise ValueError('Choose an unacknowledged reply for this coordinator')
            db.execute('DELETE FROM deliveries WHERE task_id=?', (identity,))
            db.execute("UPDATE coordinators SET state='queue-ready' WHERE desk=? AND controller=? AND state='delivery-error' AND thread_id IS NOT NULL", (desk, controller))
        return {'queued': True}

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def create(self, desk, controller, worker, task, identity=None):
        identity = identity or 'task-' + secrets.token_hex(10)
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            previous = db.execute('SELECT * FROM tasks WHERE id=?', (identity,)).fetchone()
            if previous:
                if any(previous[k] != v for k, v in dict(desk=desk, controller=controller, worker=worker, task=task).items()):
                    raise ValueError('That task ID is already used for a different delegation')
                return dict(previous), False
            now = time.time()
            db.execute('INSERT INTO tasks VALUES (?,?,?,?,?,?,NULL,NULL,?,?,0)',
                       (identity, desk, controller, worker, task, 'dispatching', now, now))
            return dict(db.execute('SELECT * FROM tasks WHERE id=?', (identity,)).fetchone()), True

    def get(self, desk, identity):
        with self.connect() as db:
            row = db.execute('SELECT * FROM tasks WHERE id=? AND desk=?', (identity, desk)).fetchone()
        if not row:
            raise ValueError('Task not found for this Agent Desk instance')
        return dict(row)

    def sent(self, desk, identity, status):
        with self.connect() as db:
            db.execute("UPDATE tasks SET status=?,updated=? WHERE id=? AND desk=? AND status='dispatching'",
                       (status, time.time(), identity, desk))

    def reply(self, desk, identity, text, outcome):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM tasks WHERE id=? AND desk=?', (identity, desk)).fetchone()
            if not row:
                raise ValueError('Task not found for this Agent Desk instance')
            if row['result'] is not None:
                if row['result'] != text or row['outcome'] != outcome:
                    raise ValueError('This task already has a different reply; it was not overwritten')
            else:
                db.execute("UPDATE tasks SET status='replied',result=?,outcome=?,updated=? WHERE id=?",
                           (text, outcome, time.time(), identity))
        return self.get(desk, identity)

    def inbox(self, desk, controller, include_acknowledged=False):
        with self.connect() as db:
            rows = db.execute('SELECT * FROM tasks WHERE desk=? AND controller=?' +
                              ('' if include_acknowledged else ' AND acknowledged=0') + ' ORDER BY created',
                              (desk, controller)).fetchall()
        return [dict(row) for row in rows]

    def ack(self, desk, identity, controller):
        with self.connect() as db:
            row = db.execute('SELECT * FROM tasks WHERE id=? AND desk=? AND controller=?', (identity, desk, controller)).fetchone()
            if not row or row['result'] is None:
                raise ValueError('Choose a replied task belonging to this controller')
            db.execute('UPDATE tasks SET acknowledged=1,updated=? WHERE id=?', (time.time(), identity))
        return self.get(desk, identity)

    def wait(self, desk, controller, seconds=45):
        deadline = time.monotonic() + seconds
        while True:
            tasks = self.inbox(desk, controller)
            replies = [task for task in tasks if task['result'] is not None]
            pending = [task for task in tasks if task['result'] is None]
            if replies or not pending or time.monotonic() >= deadline:
                return {'replies': replies, 'pending': pending, 'timed_out': bool(pending) and not replies,
                        'next_action': 'Read replies, relay results to the user, then ack each task. Call wait again while pending tasks remain.'}
            time.sleep(min(.25, max(0, deadline - time.monotonic())))
