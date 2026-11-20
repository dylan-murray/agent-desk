"""What to call a terminal session: the title its agent gives the terminal, or its conversation's own.

Agents set the terminal title with an OSC 0/2 escape; scan() finds the last one in the output,
across chunk boundaries. ConversationTitles reads each CLI's own record of a conversation's title:
Claude Code's transcript (ai-title, or custom-title once renamed), Codex's session index or else
the first real prompt in its rollout, and Cortex Code's conversation file.
"""
import json
import os
from pathlib import Path
import re
import threading

OSC_TITLE = re.compile(rb'\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)')
OSC_START = b'\x1b]'
CARRY_LIMIT = 1024
SPINNER = re.compile(r'^[◐◑◒◓✳✶✻✽✢⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*')
GENERIC = {'claude', 'claude code', 'codex', 'cortex', 'cortex code', 'grok', 'opencode', 'pi', 'terminal',
           'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'login'}
TITLE_LIMIT = 240
PROMPT_LIMIT = 80
INJECTED = ('<', '# AGENTS.md')


def clean(title):
    if isinstance(title, bytes):
        title = title.decode('utf-8', errors='replace')
    if not isinstance(title, str):
        return None
    title = SPINNER.sub('', re.sub(r'[\x00-\x1f\x7f]', '', title).strip()).strip()[:TITLE_LIMIT]
    return title if title and title.lower() not in GENERIC else None


def scan(carry, data):
    chunk = carry + data
    found, end = None, 0
    for match in OSC_TITLE.finditer(chunk):
        found, end = match.group(1), match.end()
    rest = chunk[end:]
    start = rest.rfind(OSC_START)
    unfinished = start != -1 and b'\x07' not in rest[start:] and b'\x1b\\' not in rest[start + 2:]
    return found, rest[start:][-CARRY_LIMIT:] if unfinished else b''


def first_line(text, limit=PROMPT_LIMIT):
    line = ' '.join(text.strip().split('\n', 1)[0].split())
    return line if len(line) <= limit else line[:limit - 1].rstrip() + '…'


class _Tail:

    def __init__(self, path, fold):
        self.path, self.fold = path, fold
        self.identity, self.offset, self.state = None, 0, {}

    def read(self):
        stat = self.path.stat()
        if self.identity != stat.st_ino or stat.st_size < self.offset:
            self.identity, self.offset, self.state = stat.st_ino, 0, {}
        if stat.st_size == self.offset:
            return self.state
        with self.path.open('rb') as stream:
            stream.seek(self.offset)
            data = stream.read(stat.st_size - self.offset)
        complete = data.rfind(b'\n') + 1
        for line in data[:complete].splitlines():
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if isinstance(entry, dict):
                self.fold(self.state, entry)
        self.offset += complete
        return self.state


def _claude_fold(state, entry):
    if entry.get('type') == 'custom-title' and isinstance(entry.get('customTitle'), str):
        state['custom'] = entry['customTitle']
    elif entry.get('type') == 'ai-title' and isinstance(entry.get('aiTitle'), str):
        state['ai'] = entry['aiTitle']


def _codex_index_fold(state, entry):
    if isinstance(entry.get('id'), str) and isinstance(entry.get('thread_name'), str):
        state[entry['id']] = entry['thread_name']


def _codex_rollout_fold(state, entry):
    if 'prompt' in state:
        return
    payload = entry.get('payload')
    if entry.get('type') != 'response_item' or not isinstance(payload, dict) or payload.get('role') != 'user':
        return
    for part in payload.get('content') or []:
        text = part.get('text') if isinstance(part, dict) else None
        if isinstance(text, str) and text.strip() and not text.lstrip().startswith(INJECTED):
            state['prompt'] = first_line(text)
            return


def claude_homes():
    homes = {path.parent for path in Path.home().glob('.claude*/projects')}
    if os.environ.get('CLAUDE_CONFIG_DIR'):
        homes.add(Path(os.environ['CLAUDE_CONFIG_DIR']).expanduser())
    return homes


def codex_homes():
    homes = {path.parent for path in Path.home().glob('.codex*/sessions')}
    homes |= {path.parent for path in Path.home().glob('.codex*/session_index.jsonl')}
    if os.environ.get('CODEX_HOME'):
        homes.add(Path(os.environ['CODEX_HOME']).expanduser())
    return homes


def cortex_homes():
    root = Path(os.environ['SNOWFLAKE_HOME']).expanduser() if os.environ.get('SNOWFLAKE_HOME') else Path.home() / '.snowflake'
    return [root / 'cortex']


def _cortex_title(path):
    value = json.loads(path.read_text())
    title = value.get('title') if isinstance(value, dict) else None
    # Cortex Code names a conversation this way until it has a real title.
    return None if not isinstance(title, str) or title.startswith('Chat for session: ') else title


class ConversationTitles:

    UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')

    def __init__(self, claude=None, codex=None, cortex=None):
        self.claude_dirs, self.codex_dirs, self.cortex_dirs = claude, codex, cortex
        self.tails, self.paths, self.files = {}, {}, {}
        self.lock = threading.Lock()

    def _tail(self, path, fold):
        tail = self.tails.get(path)
        if tail is None:
            tail = self.tails[path] = _Tail(path, fold)
        return tail.read()

    def _find(self, native):
        for home in self.claude_dirs if self.claude_dirs is not None else claude_homes():
            for path in (Path(home) / 'projects').glob(f'*/{native}.jsonl'):
                self.paths[native] = ('claude', path)
                return self.paths[native]
        for home in self.codex_dirs if self.codex_dirs is not None else codex_homes():
            for path in (Path(home) / 'sessions').glob(f'*/*/*/rollout-*{native}.jsonl'):
                self.paths[native] = ('codex', path, Path(home) / 'session_index.jsonl')
                return self.paths[native]
        for home in self.cortex_dirs if self.cortex_dirs is not None else cortex_homes():
            path = Path(home) / 'conversations' / f'{native}.json'
            if path.is_file():
                self.paths[native] = ('cortex', path)
                return self.paths[native]
        return None

    def _file(self, path, read):
        """read(path), again only when the file changes."""
        stat = path.stat()
        key = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
        if self.files.get(path, (None,))[0] != key:
            self.files[path] = (key, read(path))
        return self.files[path][1]

    def title(self, native):
        if not isinstance(native, str) or not self.UUID.match(native):
            return None
        with self.lock:
            try:
                found = self.paths.get(native)
                if not found or not found[1].exists():
                    self.paths.pop(native, None)
                    found = self._find(native)
                if not found:
                    return None
                if found[0] == 'claude':
                    state = self._tail(found[1], _claude_fold)
                    return clean(state.get('custom')) or clean(state.get('ai'))
                if found[0] == 'cortex':
                    return clean(self._file(found[1], _cortex_title))
                index = found[2]
                named = clean(self._tail(index, _codex_index_fold).get(native)) if index.exists() else None
                return named or clean(self._tail(found[1], _codex_rollout_fold).get('prompt'))
            except (OSError, ValueError):
                return None
