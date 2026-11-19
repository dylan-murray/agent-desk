"""Inbox History items you cleared: their keys, in SQLite. Nothing they point at is deleted."""
import json
import os
import sqlite3
import threading
import time
from contextlib import closing
from pathlib import Path

from agent_desk import schema

LIMIT = 20000
# Schema changes, in order; see agent_desk.schema. Add a step, never edit one that has shipped.
MIGRATIONS = ('CREATE TABLE cleared (key TEXT PRIMARY KEY, at REAL NOT NULL);',)


class InboxCleared:
    def __init__(self, path, legacy=None):
        """path is the SQLite file. legacy is the JSON file earlier versions kept, read once into a new database."""
        self.path = Path(path)
        self.legacy = Path(legacy) if legacy else None
        self.lock = threading.Lock()
        self.ready = False

    def open(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        os.close(os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600))
        self.path.chmod(0o600)
        return sqlite3.connect(self.path, timeout=10)

    def prepare(self):
        """Open the database on first use, so building this touches nothing on disk. Call holding self.lock."""
        if self.ready:
            return
        with closing(self.open()) as db, db:
            if schema.migrate(db, MIGRATIONS) and self.legacy:
                self.import_legacy(db)
        self.ready = True

    def import_legacy(self, db):
        """Bring the keys from the old inbox-cleared.json in, oldest first. The file is left as it was."""
        try:
            keys = json.loads(self.legacy.read_text())
        except (OSError, ValueError):
            return
        keys = [key for key in keys if isinstance(key, str)] if isinstance(keys, list) else []
        start = time.time() - len(keys)
        db.executemany('INSERT OR IGNORE INTO cleared VALUES (?, ?)', [(key, start + index) for index, key in enumerate(keys)])

    def keys(self):
        with self.lock:
            self.prepare()
            with closing(self.open()) as db:
                return [row[0] for row in db.execute('SELECT key FROM cleared ORDER BY at, rowid')]

    def clear(self, keys):
        """Hide History items from the Inbox. Nothing is deleted: the reports, runs and results stay where they live."""
        if not isinstance(keys, list) or not all(isinstance(key, str) and 0 < len(key) <= 200 for key in keys) or len(keys) > 5000:
            raise ValueError('Invalid inbox items')
        with self.lock:
            self.prepare()
            with closing(self.open()) as db, db:
                now = time.time()
                db.executemany('INSERT OR IGNORE INTO cleared VALUES (?, ?)', [(key, now + index / 1e6) for index, key in enumerate(keys)])
                db.execute('DELETE FROM cleared WHERE rowid NOT IN (SELECT rowid FROM cleared ORDER BY at DESC, rowid DESC LIMIT ?)', (LIMIT,))
                return [row[0] for row in db.execute('SELECT key FROM cleared ORDER BY at, rowid')]
