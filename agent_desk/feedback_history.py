"""Local annotation revision history, separate from the active pin workspace."""
from contextlib import closing
import hashlib
import json
import os
import sqlite3
import time


def archive_feedback(feedback_file, before, after):
    path=feedback_file.with_name('feedback-history.sqlite3')
    path.parent.mkdir(parents=True,exist_ok=True)
    fd=os.open(path,os.O_CREAT|os.O_RDWR,0o600);os.close(fd)
    with closing(sqlite3.connect(path,timeout=10)) as db, db:
        db.executescript('''
            CREATE TABLE IF NOT EXISTS revisions(
                digest TEXT PRIMARY KEY,note_id TEXT NOT NULL,payload TEXT NOT NULL,recorded REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS cleared(note_id TEXT PRIMARY KEY,recorded REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS revisions_by_note ON revisions(note_id,recorded);
        ''')
        # Archive the old version before an edit or clear. Repeated syncs are idempotent.
        # Never archive stale client notes rejected by the active workspace's tombstones.
        for note in before.get('notes',[])+after.get('notes',[]):
            source=json.dumps(note,sort_keys=True,ensure_ascii=False,allow_nan=False)
            digest=hashlib.sha256(source.encode()).hexdigest()
            db.execute('INSERT OR IGNORE INTO revisions VALUES(?,?,?,?)',(digest,note['id'],source,time.time()))
        for identity in after.get('deleted',[]):
            db.execute('INSERT OR IGNORE INTO cleared VALUES(?,?)',(identity,time.time()))
