"""Confirmed local shutdown, starting from a caller-verified process owner."""
import os
import signal
import subprocess
import time


def processes():
    try:
        result = subprocess.run(['ps', '-axo', 'pid=,ppid=,uid=,stat=,lstart='],
                                capture_output=True, text=True, timeout=3, check=True)
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError('Could not verify owned processes; shutdown remains paused') from error
    rows = {}
    for line in result.stdout.splitlines():
        parts = line.split(None, 4)
        if len(parts) == 5:
            pid, parent, uid = map(int, parts[:3])
            if uid == os.getuid() and not parts[3].startswith('Z'):
                rows[pid] = (parent, parts[4])
    return rows


class OwnedProcesses:
    """Remember descendants before their parent exits and they are reparented.

    Birth times are checked before every signal. The caller must authenticate
    the root with its existing tool/worker/supervisor ownership check first.
    """
    def __init__(self, pid):
        self.known = {}
        rows = processes()
        if pid in rows:
            self.known[pid] = rows[pid][1]
            self.capture(rows)

    def capture(self, rows):
        while True:
            added = {pid: birth for pid, (parent, birth) in rows.items()
                     if parent in self.known and parent in rows and rows[parent][1] == self.known[parent]
                     and pid not in self.known}
            if not added:break
            self.known.update(added)

    def remaining(self):
        rows = processes()
        self.capture(rows)
        return [pid for pid, birth in self.known.items() if pid in rows and rows[pid][1] == birth]

    def signal(self, sig):
        for pid in reversed(self.remaining()):
            try:os.kill(pid, sig)
            except ProcessLookupError:pass

    def stop(self, timeout=2):
        self.signal(signal.SIGTERM)
        deadline = time.monotonic() + timeout
        while self.remaining() and time.monotonic() < deadline:time.sleep(.05)
        if self.remaining():
            # Freeze parents before the final scan so they cannot spawn more
            # children between discovery and forced cleanup.
            while True:
                before = set(self.known)
                self.signal(signal.SIGSTOP)
                self.remaining()
                if set(self.known) == before:break
            self.signal(signal.SIGKILL)
            deadline = time.monotonic() + 3
            while self.remaining() and time.monotonic() < deadline:time.sleep(.05)
        if self.remaining():raise ValueError('Owned processes have not exited; shutdown remains paused')
