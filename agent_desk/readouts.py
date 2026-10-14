"""Readouts: labeled values that a pane's own process shows under the pane header.

Shared by the server, the agent-desk-readout CLI and the agent-desk tool server. The CLI may run
under an older python3 and the tool server starts once per agent session, so this module stays
stdlib-only, Python 3.8 compatible and cheap to import.
"""
import json
import os
import stat
import sys
import time

TONES = ('neutral', 'good', 'warn', 'bad')
MAX_FIELDS, MAX_LABEL, MAX_VALUE = 8, 32, 64
MIN_TTL, MAX_TTL = 5, 7 * 86400


def validate(payload, published=None):
    """Normalize a publish ({"fields": [...], "ttl_seconds": n}); None means clear the readouts."""
    fields, ttl = payload.get('fields'), payload.get('ttl_seconds')
    if not isinstance(fields, list) or len(fields) > MAX_FIELDS:
        raise ValueError('fields must be a list of at most %d items' % MAX_FIELDS)
    clean, labels = [], set()
    for field in fields:
        if not isinstance(field, dict) or set(field) - {'label', 'value', 'tone'}:
            raise ValueError('Each field needs only label, value, and an optional tone')
        label, value, tone = field.get('label'), field.get('value'), field.get('tone', 'neutral')
        if type(value) in (int, float) and value == value and abs(value) != float('inf'):
            value = str(value)
        for text, limit, name in ((label, MAX_LABEL, 'label'), (value, MAX_VALUE, 'value')):
            if not isinstance(text, str) or len(text) > limit or any(ord(c) < 32 or ord(c) == 127 for c in text):
                raise ValueError('Each %s must be text of at most %d characters without control characters' % (name, limit))
        label = label.strip()
        if not label or label in labels:
            raise ValueError('Labels must be non-empty and unique')
        if tone not in TONES:
            raise ValueError('tone must be one of ' + ', '.join(TONES))
        labels.add(label)
        clean.append(dict(label=label, value=value.strip(), tone=tone))
    if ttl is not None and (type(ttl) not in (int, float) or not MIN_TTL <= ttl <= MAX_TTL):
        raise ValueError('ttl_seconds must be between %d seconds and 7 days' % MIN_TTL)
    return dict(fields=clean, ttl_seconds=ttl, published=time.time() if published is None else published) if clean else None


# Coding-agent sandboxes such as Codex's workspace-write deny network, loopback included, but
# allow writes under /tmp. A pane process can always hand a publish to its desk through the desk's
# private folder there. Each desk has its own folder so two running desks never consume each
# other's files.
def drop_root():
    return '/tmp/agent-desk-%d' % os.getuid()


def private_dir(path, create=False):
    """Return path if it and its parent are real directories only this user can enter."""
    for directory in (os.path.dirname(path), path):
        if create:
            try:
                os.mkdir(directory, 0o700)
            except FileExistsError:
                pass
        info = os.lstat(directory)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise PermissionError('%s is not a private directory owned by this user' % directory)
    return path


IDENTITY = ('AGENT_DESK_TERMINAL_ID', 'AGENT_DESK_PANE_TOKEN', 'AGENT_DESK_PANE_PID', 'AGENT_DESK_READOUTS_DIR')


def pane():
    """This process's pane from the environment Agent Desk gives it, or None outside a pane."""
    terminal, token, folder = (os.environ.get(k) for k in ('AGENT_DESK_TERMINAL_ID', 'AGENT_DESK_PANE_TOKEN', 'AGENT_DESK_READOUTS_DIR'))
    return (terminal, token, folder) if terminal and token and folder else None


ELSEWHERE = ("This process is not running inside the Agent Desk pane named in its environment; it inherited that pane's "
             "identity from somewhere else, most likely Codex's shared background service. Start Codex in the pane with "
             "`codex --no-daemon` (Agent Desk's Codex launcher does this) so its tools run inside the pane.")


def _parent(pid):
    """Parent process ID, or None where this system or sandbox will not say."""
    try:
        with open('/proc/%d/stat' % pid) as stream:
            return int(stream.read().rsplit(')', 1)[1].split()[1])
    except (OSError, ValueError, IndexError):
        pass
    if sys.platform == 'darwin':
        try:
            import ctypes
            libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
            # PROC_PIDT_SHORTBSDINFO: struct proc_bsdshortinfo, pid then ppid. Unlike the full BSD info it
            # is also answered for root-owned ancestors such as /usr/bin/login.
            info = ctypes.create_string_buffer(64)
            if libc.proc_pidinfo(pid, 13, ctypes.c_uint64(0), info, 64) == 64:
                return int.from_bytes(info.raw[4:8], sys.byteorder)
        except (OSError, AttributeError):
            pass
    return None


def outside_pane():
    """Why this process must not set the readouts of the pane in its environment, or None if it may.

    Codex can run tool servers and commands in a shared background service that inherited some other
    pane's environment. Only a process that descends from the pane's own root process may write to it.
    Where the process tree cannot be read (some sandboxes), the check passes rather than block a real pane.
    """
    missing = [k for k in IDENTITY if not os.environ.get(k)]
    if missing:
        return ('This process is missing %s, part of its Agent Desk pane identity. Codex passes a tool server only the '
                "variables its agent-desk registration names, so the usual cause is a registration from an older Agent Desk: "
                'restart Agent Desk (it updates its own registrations), then start a new Codex session. Otherwise the terminal '
                "predates this Agent Desk, or Codex's shared background service started this process; open a new Agent Desk "
                'terminal, where Codex runs with --no-daemon.') % ', '.join(missing)
    root = os.environ['AGENT_DESK_PANE_PID']
    if not root.isdigit():
        return 'AGENT_DESK_PANE_PID is not a process ID.'
    pid, root = os.getpid(), int(root)
    for _ in range(64):
        if pid == root:
            return None
        if pid <= 1:
            return ELSEWHERE
        parent = _parent(pid)
        if parent is None:
            return None
        pid = parent
    return None


def drop(terminal, token, folder, payload):
    """Validate, then hand a publish to the desk; it appears on the pane's next refresh."""
    readouts = validate(payload)
    if not (terminal.startswith('terminal-') and len(terminal) == 25 and all(c in '0123456789abcdef' for c in terminal[9:])):
        raise ValueError('AGENT_DESK_TERMINAL_ID is not an Agent Desk terminal ID')
    private_dir(folder)
    temporary = os.path.join(folder, '.publish-' + os.urandom(8).hex())
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(dict(fields=payload.get('fields'), ttl_seconds=payload.get('ttl_seconds'), token=token), stream)
        os.replace(temporary, os.path.join(folder, terminal + '.json'))
    except BaseException:
        os.unlink(temporary)
        raise
    return readouts
