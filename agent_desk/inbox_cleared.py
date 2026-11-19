"""Inbox History items you cleared: their keys, in SQLite. Nothing they point at is deleted."""
import json
import os
import sqlite3
import threading
import time
from contextlib import closing, contextmanager
from pathlib import Path

LIMIT = 20000


class InboxCleared:
    def __init__(self, path, legacy=None):
        self.path = Path(path)
        self.legacy = Path(legacy) if legacy else None
        self.lock = threading.Lock()
        self.imported = False

    @contextmanager
    def db(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        os.close(os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600))
        self.path.chmod(0o600)
        with closing(sqlite3.connect(self.path, timeout=10)) as connection:
            connection.execute('CREATE TABLE IF NOT EXISTS cleared (key TEXT PRIMARY KEY, at REAL NOT NULL)')
            with connection:
                if not self.imported:
                    self.import_legacy(connection)
                yield connection

    def import_legacy(self, connection):
        """Bring the old inbox-cleared.json in once, oldest first, and keep it beside the database as .imported."""
        self.imported = True
        if not self.legacy or not self.legacy.exists():
            return
        try:
            keys = json.loads(self.legacy.read_text())
        except (OSError, ValueError):
            keys = []
        keys = [key for key in keys if isinstance(key, str)] if isinstance(keys, list) else []
        start = time.time() - len(keys)
        connection.executemany('INSERT OR IGNORE INTO cleared VALUES (?, ?)', [(key, start + index) for index, key in enumerate(keys)])
        os.replace(self.legacy, self.legacy.with_name(self.legacy.name + '.imported'))

    def keys(self):
        with self.lock, self.db() as connection:
            return [row[0] for row in connection.execute('SELECT key FROM cleared ORDER BY at, rowid')]

    def clear(self, keys):
        """Hide History items from the Inbox. Nothing is deleted: the reports, runs and results stay where they live."""
        if not isinstance(keys, list) or not all(isinstance(key, str) and 0 < len(key) <= 200 for key in keys) or len(keys) > 5000:
            raise ValueError('Invalid inbox items')
        with self.lock, self.db() as connection:
            now = time.time()
            connection.executemany('INSERT OR IGNORE INTO cleared VALUES (?, ?)', [(key, now + index / 1e6) for index, key in enumerate(keys)])
            connection.execute('DELETE FROM cleared WHERE rowid NOT IN (SELECT rowid FROM cleared ORDER BY at DESC, rowid DESC LIMIT ?)', (LIMIT,))
            return [row[0] for row in connection.execute('SELECT key FROM cleared ORDER BY at, rowid')]
