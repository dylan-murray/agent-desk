"""Restore managed terminals after their supervisor ends (reboot, crash or stop).

The supervisor records every running, restorable terminal. A replacement
supervisor relaunches those records under their original IDs: coding agents
resume the exact native conversation observed in their process tree, plain
shells start again in the same folder, and other commands are never re-run,
unless an agent was seen running inside them with a conversation: then
that same command runs again with the agent's resume arguments added, so a
wrapper like `ollama launch claude` comes back on its conversation.
Coordinator terminals and coordinator workers are excluded; the coordinator
runtime owns their recovery and must never see a worker relaunched behind it.
"""
from datetime import datetime
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
OPENCODE_LOG = re.compile(r'/opencode/log/[^/]+\.log$')
OPENCODE_SESSION = re.compile(r'(?:sessionID=|service=session id=)(ses_[A-Za-z0-9]{10,60})\b')
# How each agent resumes one conversation, and what its conversation IDs look like. Pi leaves no
# trace of which conversation a running process has, so it is never resumed.
RESUME = {'claude': '--resume', 'codex': 'resume', 'grok': '--resume', 'opencode': '--session', 'cortex': '--resume'}
IDS = {'claude': UUID, 'codex': UUID, 'grok': UUID, 'cortex': UUID + r'|[0-9]{6,20}', 'opencode': r'ses_[A-Za-z0-9]{10,60}'}
LOG_TAIL = 4 << 20
LOGGED_PID = re.compile(r'"pid":\s*\d')
LOGGED_GROK_SESSION = re.compile(r'"msg":\s*"session (?:created|loaded)"')
LOGGED_CORTEX_SESSION = re.compile(r'"session_id":\s*"')


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
                native_harness=session.native_harness, agent_exited=session.agent_exited)


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


def valid_id(name, identity):
    return isinstance(identity, str) and name in IDS and re.fullmatch(IDS[name], identity) is not None


def command_word(argv):
    """The command a terminal runs: the word before "$@" in a login shell launch, else its executable."""
    if len(argv) >= 4 and argv[1] == '-lic' and argv[3] == 'agent-desk':
        try:
            return Path(shlex.split(argv[2].rsplit('\n', 1)[-1])[0]).name
        except (ValueError, IndexError):
            return ''
    return Path(argv[0]).name if argv else ''


def wrapped_resume_argv(argv, name, identity):
    """A wrapper's command with the agent's resume arguments, placed where the wrapper passes them on.

    Arguments after a `--` reach the agent. `ollama launch` passes nothing else through, so it gets a `--`.
    Any other wrapper is assumed to pass its arguments on, as a script ending in "$@" does.
    """
    start = 4 if len(argv) >= 4 and argv[1] == '-lic' and argv[3] == 'agent-desk' else 1
    head, args = list(argv[:start]), list(argv[start:])
    flag = RESUME[name]
    if '--' in args:
        split = args.index('--') + 1
        agent = without_launch_selectors(args[split:], name)
        if flag in agent[:-1]:
            agent[agent.index(flag) + 1] = identity
            return [*head, *args[:split], *agent]
        return [*head, *args[:split], *agent, flag, identity]
    if command_word(argv) == 'ollama' and args[:1] == ['launch']:
        return [*head, *args, '--', flag, identity]
    if flag in args[:-1]:
        args[args.index(flag) + 1] = identity
        return [*head, *args]
    return [*head, *args, flag, identity]


def plan(item):
    """Return the launch payload, whether a conversation resumes, and what happened."""
    from agent_desk.standalone_agent import SHELL_MARKER
    from agent_desk.worker_sessions import WorkerSessions
    argv, name, native = item['argv'], harness(item['argv'], item['launch_profile']), item.get('native_session')
    payload = dict(cwd=item['cwd'], name=item['name'], launch_profile=item['launch_profile'])
    if name and item.get('agent_exited'):
        payload.update(argv=[os.environ.get('SHELL', '/bin/zsh'), '-l'], launch_profile=None)
        return payload, False, f'{NAMES[name]} had exited, so this is a new shell in the same folder'
    if name in RESUME and valid_id(name, native):
        # The standalone wrapper flag is private to Agent Desk; keep it outside the CLI's arguments.
        marker = [SHELL_MARKER] if SHELL_MARKER in argv else []
        args = without_launch_selectors([a for a in argv if a != SHELL_MARKER], name)
        payload['argv'] = [*WorkerSessions.resume_argv(args, name, native), *marker]
        return payload, True, f'resumed {NAMES[name]} conversation {native}'
    if name in SINGLE and name not in RESUME:
        payload['argv'] = argv
        return payload, False, f'{NAMES[name]} conversations are not recorded, so this is a new session'
    if name:
        payload['argv'] = argv
        return payload, False, f'no {NAMES[name]} conversation had started, so this is a new session'
    if plain_shell(argv):
        payload['argv'] = argv
        return payload, False, 'started a new shell in the same folder'
    wrapped = item.get('native_harness')
    if wrapped in RESUME and valid_id(wrapped, native):
        payload['argv'] = wrapped_resume_argv(argv, wrapped, native)
        return payload, True, f'resumed {NAMES[wrapped]} conversation {native} by running {command_word(argv)} again'
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
    return _shallowest(claude_sessions(tree, config_dirs))


def claude_sessions(tree, config_dirs):
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
    return found


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
    return _shallowest(codex_sessions(tree, files))


def codex_sessions(tree, files):
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
    return found


def _shallowest(found):
    if not found:
        return None
    depth = min(d for d, _ in found)
    identities = {identity for d, identity in found if d == depth}
    # Two agents at the same depth cannot be told apart; record neither.
    return identities.pop() if len(identities) == 1 else None


def agent_processes(pids):
    """{pid: agent name} for processes running a known agent CLI: its executable, or a script interpreter running it."""
    if not pids:
        return {}
    listing = subprocess.run(['ps', '-o', 'pid=,args=', '-p', ','.join(map(str, pids))], capture_output=True, text=True, timeout=5).stdout
    found = {}
    for line in listing.splitlines():
        fields = line.strip().split()
        if len(fields) < 2 or not fields[0].isdigit():
            continue
        name = next((Path(word).name for word in fields[1:3] if Path(word).name in RESUME), None)
        if name:
            found[int(fields[0])] = name
    return found


def _log_tail(path):
    """The last few MB of a log, whole lines only."""
    try:
        with open(path, 'rb') as stream:
            stream.seek(0, os.SEEK_END)
            end = stream.tell()
            stream.seek(max(0, end - LOG_TAIL))
            lines = stream.read().decode(errors='replace').splitlines()
    except OSError:
        return []
    return lines[1:] if end > LOG_TAIL else lines


def _logged_at(value):
    try:
        return datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
    except ValueError:
        return None


def _latest_per_process(tree, paths, read):
    """The last session each process in the tree logged after it started, as {(depth, session)}."""
    latest = {}
    for path in paths:
        for line in _log_tail(path):
            if not LOGGED_PID.search(line):
                continue
            found = read(line)
            if not found:
                continue
            pid, logged, identity = found
            if pid in tree and logged is not None and logged >= tree[pid][1] - 5 and logged >= latest.get(pid, (0, ''))[0]:
                latest[pid] = (logged, identity)
    return {(tree[pid][0], identity) for pid, (_, identity) in latest.items()}


def _json_line(line):
    try:
        value = json.loads(line)
    except ValueError:
        return None
    return value if isinstance(value, dict) and isinstance(value.get('pid'), int) else None


def grok_logs():
    from agent_desk.accounts import accounts, config_folder
    homes = {path.parent for path in Path.home().glob('.grok*/logs')}
    homes |= {config_folder(row['id']) for row in accounts() if row['harness'] == 'grok'}
    if os.environ.get('GROK_HOME'):
        homes.add(Path(os.environ['GROK_HOME']).expanduser())
    return sorted({home / 'logs' / 'unified.jsonl' for home in homes})


def grok_sessions(tree, logs=None):
    """Grok logs each session it creates or loads with its process ID."""
    def read(line):
        value = _json_line(line) if LOGGED_GROK_SESSION.search(line) else None
        if value and value.get('msg') in ('session created', 'session loaded') and isinstance(value.get('sid'), str):
            return value['pid'], _logged_at(value.get('ts')), value['sid']
    return _latest_per_process(tree, grok_logs() if logs is None else logs, read)


def cortex_logs():
    root = Path(os.environ['SNOWFLAKE_HOME']).expanduser() if os.environ.get('SNOWFLAKE_HOME') else Path.home() / '.snowflake'
    return [root / 'cortex' / 'logs' / 'coco.log']


def cortex_sessions(tree, logs=None):
    """Every Cortex Code log line names its process and, once a conversation starts, the conversation."""
    def read(line):
        value = _json_line(line) if LOGGED_CORTEX_SESSION.search(line) else None
        if value and isinstance(value.get('session_id'), str):
            return value['pid'], _logged_at(value.get('ts')), value['session_id']
    return _latest_per_process(tree, cortex_logs() if logs is None else logs, read)


def opencode_sessions(tree, files):
    """Each OpenCode process keeps its own log open, and the log names the session it is working in."""
    found = set()
    for pid, (depth, _) in tree.items():
        for path in files.get(pid, ()):
            if not OPENCODE_LOG.search(path):
                continue
            matches = OPENCODE_SESSION.findall('\n'.join(_log_tail(path)))
            if matches:
                found.add((depth, matches[-1]))
    return found


def agent_sessions(name, tree, config_dirs, files):
    """{(depth, conversation)} for one agent's own evidence in a process tree."""
    if name == 'claude':
        found = claude_sessions(tree, config_dirs)
    elif name == 'codex':
        found = codex_sessions(tree, files)
    elif name == 'grok':
        found = grok_sessions(tree)
    elif name == 'cortex':
        found = cortex_sessions(tree)
    else:
        found = opencode_sessions(tree, files)
    return {(depth, identity) for depth, identity in found if valid_id(name, identity)}


def observe(sessions, config_dirs=None):
    """Return {terminal ID: (harness, native conversation ID)} for running agent terminals.

    A custom command (not a plain shell, not an agent itself) counts when an agent runs inside it.
    """
    running = [s for s in sessions if s.process.poll() is None]
    agents = {s.id: (s, harness(s.argv, s.launch_profile)) for s in running}
    agents = {k: v for k, v in agents.items() if v[1] in RESUME}
    wrappers = {s.id: s for s in running if harness(s.argv, s.launch_profile) is None and not plain_shell(s.argv) and not s.coordinator}
    if not agents and not wrappers:
        return {}
    trees = process_tree({k: s.process.pid for k, (s, _) in agents.items()} | {k: s.process.pid for k, s in wrappers.items()})
    inside = agent_processes([pid for k in wrappers for pid, (depth, _) in trees.get(k, {}).items() if depth > 0])
    file_pids = [pid for k, (_, name) in agents.items() if name in ('codex', 'opencode') for pid in trees.get(k, {})]
    file_pids += [pid for pid, name in inside.items() if name in ('codex', 'opencode')]
    files = open_files(file_pids) if file_pids else {}
    config_dirs = claude_config_dirs() if config_dirs is None else config_dirs
    result = {}
    for identity, (session, name) in agents.items():
        native = _shallowest(agent_sessions(name, trees.get(identity, {}), config_dirs, files))
        if native:
            result[identity] = (name, native)
    for identity in wrappers:
        tree = {pid: value for pid, value in trees.get(identity, {}).items() if value[0] > 0}
        # Claude is found by its own session files; the others only when their process is in the tree.
        names = {'claude', *(inside[pid] for pid in tree if pid in inside)}
        found = _shallowest({(depth, (name, native)) for name in names for depth, native in agent_sessions(name, tree, config_dirs, files)})
        if found:
            result[identity] = found
    return result
