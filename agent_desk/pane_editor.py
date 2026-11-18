"""Edits a pane's process hands to the page: `$EDITOR` inside a pane is agent-desk-edit, so
Claude Code's ctrl+g (or git, or anything else that opens an editor from a terminal) shows the
file in the page's editor and waits there until it is saved or cancelled.

An edit lives only while its editor process keeps waiting on it, and is accepted only while a
page is listening, so a closed browser falls back to the terminal's own editor instead of
leaving the process waiting on nobody.
"""
import secrets
import threading
import time

MAX_BYTES = 90_000
ABANDONED = 45
LISTENING = 40


class PaneEdits:
    def __init__(self):
        self.condition = threading.Condition()
        self.edits = {}
        self.revision = 0
        self.listened = 0.0

    def _prune(self, now):
        stale = [key for key, edit in self.edits.items() if now - edit['polled'] > ABANDONED]
        for key in stale:
            del self.edits[key]
        if stale:
            self.revision += 1
            self.condition.notify_all()

    def _public(self):
        return [dict(id=edit['id'], terminal_id=edit['terminal_id'], name=edit['name'], text=edit['text'])
                for edit in self.edits.values() if edit['result'] is None]

    def open(self, terminal_id, name, text):
        if not isinstance(text, str) or len(text.encode()) > MAX_BYTES:
            raise ValueError(f'Files over {MAX_BYTES // 1000} KB open in the terminal\'s own editor')
        if not isinstance(name, str) or not 0 < len(name) <= 200:
            raise ValueError('Name the file being edited')
        with self.condition:
            now = time.time()
            if now - self.listened > LISTENING:
                raise LookupError('No Agent Desk page is open to edit in')
            for key in [key for key, edit in self.edits.items() if edit['terminal_id'] == terminal_id]:
                del self.edits[key]
            edit = dict(id='edit-' + secrets.token_hex(8), terminal_id=terminal_id, name=name, text=text, result=None, polled=now)
            self.edits[edit['id']] = edit
            self.revision += 1
            self.condition.notify_all()
            return dict(id=edit['id'])

    def pending(self, since, timeout):
        """The page's long poll: the open edits once the revision moves past `since`."""
        deadline = time.time() + max(0.0, min(float(timeout), 25.0))
        with self.condition:
            while True:
                now = time.time()
                self.listened = now
                self._prune(now)
                if self.revision != since or now >= deadline:
                    return dict(revision=self.revision, edits=self._public())
                self.condition.wait(min(deadline - now, 5.0))

    def finish(self, edit_id, text):
        """The page saved (text) or cancelled (None) an edit."""
        if text is not None and (not isinstance(text, str) or len(text.encode()) > MAX_BYTES):
            raise ValueError(f'Text must be at most {MAX_BYTES // 1000} KB')
        with self.condition:
            edit = self.edits.get(edit_id)
            if not edit or edit['result'] is not None:
                raise LookupError('That edit has already closed; its terminal stopped waiting for it')
            edit['result'] = dict(saved=text is not None, text=text)
            self.revision += 1
            self.condition.notify_all()
        return dict(ok=True)

    def wait(self, terminal_id, edit_id, timeout):
        """The editor process's poll: the result once the page has one, else done=False."""
        deadline = time.time() + max(0.0, min(float(timeout), 25.0))
        with self.condition:
            while True:
                edit = self.edits.get(edit_id)
                if not edit or edit['terminal_id'] != terminal_id:
                    raise LookupError('Unknown edit')
                now = time.time()
                edit['polled'] = now
                if edit['result'] is not None:
                    del self.edits[edit_id]
                    return dict(done=True, **edit['result'])
                if now >= deadline:
                    return dict(done=False)
                self.condition.wait(min(deadline - now, 5.0))

    def abandon(self, terminal_id, edit_id):
        with self.condition:
            edit = self.edits.get(edit_id)
            if edit and edit['terminal_id'] == terminal_id:
                del self.edits[edit_id]
                self.revision += 1
                self.condition.notify_all()
        return dict(ok=True)
