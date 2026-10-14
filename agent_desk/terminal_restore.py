"""Restore managed terminals after their supervisor ends (reboot, crash or stop).

The supervisor records every running, restorable terminal. A replacement
supervisor relaunches those records under their original IDs: coding agents
resume the exact native conversation observed in their process tree, plain
shells start again in the same folder, and other commands are never re-run.
Coordinator terminals and coordinator workers are excluded; the coordinator
runtime owns their recovery and must never see a worker relaunched behind it.
"""
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time

from agent_desk.accounts import harness_of, SINGLE
from agent_desk.terminals import _cpu_seconds

# A restored terminal keeps its ID but is a new process. Its byte cursors start
# past anything the previous process could have produced (1 TiB), so every
# browser pane or CLI reader holding an old cursor sees a gap and resets.
RESTORE_GAP = 1 << 40
SHELLS = {'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh'}
SHELL_FLAGS = {'-l', '-i', '-il', '-li', '--login'}
NAMES = {'claude': 'Claude', 'codex': 'Codex', **SINGLE}
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
ROLLOUT = re.compile(r'/sessions/.*rollout-.*(' + UUID + r')\.jsonl$')


def harness(argv, launch_profile):
    """An account's CLI, or an executable named exactly like the CLI."""
    profile = launch_profile or Path(argv[0]).name
    return profile if profile in NAMES else harness_of(profile)


def plain_shell(argv):
    return Path(argv[0]).name in SHELLS and all(arg in SHELL_FLAGS for arg in argv[1:])


def restorable(session, external_parents):
    return (session.process.poll() is None and not session.coordinator
            and session.parent_id not in external_parents)


def record(session):
    return dict(id=session.id, name=session.name, display_name=session.display_name, cwd=session.cwd,
                argv=session.argv, launch_profile=session.launch_profile, parent_id=session.parent_id,
                created=session.created, origin=session.origin, native_session=session.native_session,
                agent_exited=session.agent_exited)


class SessionStore:
    """The running restorable terminals, atomically replaced on every change."""

    def __init__(self, path):
        self.path = Path(path)

    def load(self):
        try:
            value = json.loads(self.path.read_text())
            if value.get('version') != 1 or not isinstance(value.get('sessions'), list):
                raise ValueError('unsupported terminal session record')
            return value['sessions']
        except FileNotFoundError:
            return []
        except (OSError, ValueError, AttributeError) as error:
            # Keep the original bytes for inspection instead of discarding them.
            kept = self.path.with_name(f'{self.path.stem}.unreadable-{int(time.time())}.json')
            self.path.replace(kept)
            print(f'Terminal session record was unreadable ({error}); moved to {kept}', file=sys.stderr, flush=True)
            return []

    def save(self, sessions):
        temporary = self.path.with_name(self.path.name + '.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(dict(version=1, sessions=sessions), stream)
        os.replace(temporary, self.path)


def without_launch_selectors(argv, name):
    """Drop flags that pick a conversation by recency; resume names it exactly."""
    args, skip = [], False
    for arg in argv:
        if skip:
            skip = False
        elif name == 'claude' and arg in ('--continue', '-c'):
            continue
        elif name == 'claude' and arg == '--session-id':
            skip = True
        elif name == 'claude' and arg.startswith('--session-id='):
            continue
        else:
            args.append(arg)
    return args


def plan(item):
    """Return the launch payload, whether a conversation resumes, and what happened."""
    from agent_desk.standalone_agent import SHELL_MARKER
    from agent_desk.worker_sessions import WorkerSessions
    argv, name, native = item['argv'], harness(item['argv'], item['launch_profile']), item.get('native_session')
    payload = dict(cwd=item['cwd'], name=item['name'], launch_profile=item['launch_profile'])
    if name and item.get('agent_exited'):
        payload.update(argv=[os.environ.get('SHELL', '/bin/zsh'), '-l'], launch_profile=None)
        return payload, False, f'{NAMES[name]} had exited, so this is a new shell in the same folder'
    if name in ('claude', 'codex') and native:
        # The standalone wrapper flag is private to Agent Desk; keep it outside the CLI's arguments.
        marker = [SHELL_MARKER] if SHELL_MARKER in argv else []
        args = without_launch_selectors([a for a in argv if a != SHELL_MARKER], name)
        payload['argv'] = [*WorkerSessions.resume_argv(args, name, native), *marker]
        return payload, True, f'resumed {NAMES[name]} conversation {native}'
    if name in SINGLE:
        payload['argv'] = argv
        return payload, False, f'{NAMES[name]} conversations are not recorded, so this is a new session'
    if name:
        payload['argv'] = argv
        return payload, False, f'no {NAMES[name]} conversation had started, so this is a new session'
    if plain_shell(argv):
        payload['argv'] = argv
        return payload, False, 'started a new shell in the same folder'
    payload.update(argv=[os.environ.get('SHELL', '/bin/zsh'), '-l'], launch_profile=None)
    return payload, False, 'started a shell instead of re-running ' + shlex.join([Path(argv[0]).name, *argv[1:]])[:160]


def banner(detail):
    return f'\x1b[2m[Agent Desk restored this terminal after a restart: {detail}]\x1b[0m\r\n'.encode()


def restore(manager, store):
    """Relaunch recorded terminals once, under their original IDs."""
    items = sorted(store.load(), key=lambda item: item.get('created') or 0)
    restored = []
    for item in items:
        try:
            payload, resumed, detail = plan(item)
            if item.get('parent_id') in {r['id'] for r in restored}:
                payload['parent_id'] = item['parent_id']
            origin = int(item.get('origin') or 0) + RESTORE_GAP
            try:
                session = manager.launch(payload, identity=item['id'], origin=origin, banner=banner(detail), persist=False)
            except ValueError as error:
                # Keep the pane and say why, rather than silently losing it.
                folder = item['cwd'] if Path(item['cwd']).is_dir() else str(Path.home())
                resumed, detail = False, f'could not relaunch ({error}); started a shell in {folder}'
                session = manager.launch(dict(cwd=folder, name=item['name'], launch_profile=None,
                                              argv=[os.environ.get('SHELL', '/bin/zsh'), '-l']),
                                         identity=item['id'], origin=origin, banner=banner(detail), persist=False)
            if item.get('display_name'):
                session.rename(item['display_name'])
            session.restored = dict(detail=detail, native_session=item['native_session'] if resumed else None)
            restored.append(dict(id=session.id, detail=detail))
            print(f'Restored terminal {session.id}: {detail}', file=sys.stderr, flush=True)
        except (OSError, ValueError, KeyError, TypeError) as error:
            print(f'Could not restore terminal {item.get("id")}: {error}', file=sys.stderr, flush=True)
    manager.persist()
    return restored


def process_tree(roots):
    """Map each root PID to {descendant pid: (depth, start time)}."""
    listing = subprocess.run(['ps', '-axo', 'pid=,ppid=,etime='], capture_output=True, text=True, timeout=5).stdout
    now, children, started = time.time(), {}, {}
    for line in listing.splitlines():
        fields = line.split()
        if len(fields) != 3:
            continue
        try:
            pid, parent = int(fields[0]), int(fields[1])
        except ValueError:
            continue
        children.setdefault(parent, []).append(pid)
        started[pid] = now - _cpu_seconds(fields[2])
    trees = {}
    for identity, root in roots.items():
        found, queue = {}, [(root, 0)]
        while queue:
            pid, depth = queue.pop(0)
            if pid in found or pid not in started:
                continue
            found[pid] = (depth, started[pid])
            queue.extend((child, depth + 1) for child in children.get(pid, ()))
        trees[identity] = found
    return trees


def claude_config_dirs():
    dirs = {path.parent for path in Path.home().glob('.claude*/sessions')}
    if os.environ.get('CLAUDE_CONFIG_DIR'):
        dirs.add(Path(os.environ['CLAUDE_CONFIG_DIR']).expanduser())
    return dirs


def claude_session(tree, config_dirs):
    """Claude Code writes CONFIG/sessions/PID.json for each interactive process."""
    found = set()
    for pid, (depth, started) in tree.items():
        for folder in config_dirs:
            try:
                value = json.loads((Path(folder) / 'sessions' / f'{pid}.json').read_text())
            except (OSError, ValueError):
                continue
            # A file left by an earlier process with a reused PID predates this one.
            if not isinstance(value, dict) or value.get('kind', 'interactive') != 'interactive':
                continue
            if not isinstance(value.get('sessionId'), str) or value.get('startedAt', 0) / 1000 < started - 5:
                continue
            found.add((depth, value['sessionId']))
    return _shallowest(found)


def open_files(pids):
    files = {}
    if Path('/proc/self/fd').is_dir():
        for pid in pids:
            try:
                files[pid] = [os.readlink(f'/proc/{pid}/fd/{fd}') for fd in os.listdir(f'/proc/{pid}/fd')]
            except OSError:
                continue
        return files
    if not pids:
        return files
    result = subprocess.run(['lsof', '-n', '-P', '-F', 'n', '-p', ','.join(map(str, pids))],
                            capture_output=True, text=True, timeout=10)
    current = None
    for line in result.stdout.splitlines():
        if line.startswith('p'):
            current = int(line[1:])
        elif line.startswith('n') and current is not None:
            files.setdefault(current, []).append(line[1:])
    return files


def codex_session(tree, files):
    """Codex keeps its own rollout file open; subagent threads are excluded."""
    found = set()
    for pid, (depth, _) in tree.items():
        for path in files.get(pid, ()):
            match = ROLLOUT.search(path)
            if not match:
                continue
            try:
                with open(path) as stream:
                    meta = json.loads(stream.readline()).get('payload', {})
            except (OSError, ValueError, AttributeError):
                continue
            source = meta.get('source')
            if meta.get('thread_source', 'user') != 'user' or isinstance(source, dict) and 'subagent' in source:
                continue
            found.add((depth, match.group(1)))
    return _shallowest(found)


def _shallowest(found):
    if not found:
        return None
    depth = min(d for d, _ in found)
    identities = {identity for d, identity in found if d == depth}
    # Two agents at the same depth cannot be told apart; record neither.
    return identities.pop() if len(identities) == 1 else None


def observe(sessions, config_dirs=None):
    """Return {terminal ID: native conversation ID} for running agent terminals."""
    agents = {s.id: (s, harness(s.argv, s.launch_profile)) for s in sessions}
    agents = {k: v for k, v in agents.items() if v[1] in ('claude', 'codex') and v[0].process.poll() is None}
    if not agents:
        return {}
    trees = process_tree({k: s.process.pid for k, (s, _) in agents.items()})
    codex_pids = [pid for k, (_, name) in agents.items() if name == 'codex' for pid in trees.get(k, {})]
    files = open_files(codex_pids) if codex_pids else {}
    config_dirs = claude_config_dirs() if config_dirs is None else config_dirs
    result = {}
    for identity, (session, name) in agents.items():
        tree = trees.get(identity, {})
        native = claude_session(tree, config_dirs) if name == 'claude' else codex_session(tree, files)
        if native:
            result[identity] = native
    return result
