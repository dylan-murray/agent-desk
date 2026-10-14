"""Which sessions a local caller may read or type into.

Three kinds of caller reach the terminal API. The desk page, where the user sits,
may do anything. A helper holding the token file may not touch a protected pane.
An agent's own tools, which say which pane they run in, are further limited to
that pane and the workers under it.

This guards against an agent wandering into another session through the supported
tools. A process running as the same user can still attack the desk directly.
"""
import json
import os
import threading


class ProtectedPanes:
    """Terminal IDs only the user, at the desk, may read or type into."""

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        try:
            saved = json.loads(path.read_text())
        except (OSError, ValueError):
            saved = []
        self.ids = {item for item in saved if isinstance(item, str)} if isinstance(saved, list) else set()

    def __contains__(self, identity):
        return identity in self.ids

    def set(self, identity, protected):
        if not isinstance(identity, str) or not identity or not isinstance(protected, bool):
            raise ValueError('Choose a terminal and whether to protect it')
        with self.lock:
            (self.ids.add if protected else self.ids.discard)(identity)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp = self.path.with_suffix('.tmp')
            temp.write_text(json.dumps(sorted(self.ids)) + '\n')
            os.replace(temp, self.path)
        return {'id': identity, 'protected': protected}


def refusal(target, protected, claimed=None, parent_of=None, write=True):
    """Why a caller that is not the desk page may not reach ``target``, or None.

    ``claimed`` is the pane an agent's tool says it runs in; ``parent_of`` maps a
    terminal ID to its parent's ID.
    """
    if target in protected:
        return 'This session is protected: only the user, at the desk, can read or type into it'
    if not write or not claimed or target == claimed:
        return None
    seen, current = set(), target
    while current and current not in seen:
        seen.add(current)
        current = parent_of(current)
        if current == claimed:
            return None
    return 'That session belongs to someone else. An agent can type into its own pane and the workers it started; ask the user to do this from the desk'
