"""Files a pane's editor can open: text files inside the folder the pane was started in.

Every save names the version it was edited from, so a change made on disk in the meantime
(by the agent in the pane, say) is reported as a conflict instead of being overwritten.
"""
import hashlib
import os
import subprocess
from pathlib import Path

MAX_BYTES = 2_000_000
MAX_LISTED = 20_000
SKIPPED = {'.git', 'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox', 'dist', 'build', '.next', '.cache'}


def version_of(data):
    return hashlib.sha256(data).hexdigest()[:16]


def _root(cwd):
    root = Path(cwd).resolve()
    if not root.is_dir():
        raise ValueError('The pane\'s folder no longer exists')
    return root


def resolve(cwd, relative):
    if not isinstance(relative, str) or not relative.strip() or '\x00' in relative:
        raise ValueError('Name a file')
    root = _root(cwd)
    target = os.path.realpath(os.path.join(root, relative))
    if target != str(root) and not target.startswith(os.path.join(root, '')):
        raise PermissionError('Only files inside the pane\'s folder can be opened here')
    return root, Path(target)


def listing(cwd):
    root = _root(cwd)
    try:
        result = subprocess.run(['git', '-C', str(root), 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
                                capture_output=True, timeout=10, check=True)
        files = [name for name in result.stdout.decode(errors='replace').split('\x00') if name]
        files = [name for name in dict.fromkeys(files) if (root / name).is_file()]
    except (OSError, subprocess.SubprocessError):
        files = []
        for folder, folders, names in os.walk(root):
            folders[:] = sorted(name for name in folders if name not in SKIPPED and not name.startswith('.'))
            for name in sorted(names):
                files.append(os.path.relpath(os.path.join(folder, name), root))
                if len(files) >= MAX_LISTED:
                    break
            if len(files) >= MAX_LISTED:
                break
    return dict(root=str(root), files=files[:MAX_LISTED], truncated=len(files) > MAX_LISTED)


def read(cwd, relative):
    root, target = resolve(cwd, relative)
    if not target.is_file():
        raise FileNotFoundError(f'{relative} does not exist')
    if target.stat().st_size > MAX_BYTES:
        raise ValueError(f'{relative} is over {MAX_BYTES // 1_000_000} MB')
    data = target.read_bytes()
    if b'\x00' in data[:8192]:
        raise ValueError(f'{relative} looks like a binary file')
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        raise ValueError(f'{relative} is not UTF-8 text') from None
    return dict(path=os.path.relpath(target, root), absolute=str(target), text=text, version=version_of(data))


def write(cwd, relative, text, version):
    if not isinstance(text, str) or len(text.encode()) > MAX_BYTES:
        raise ValueError(f'Files must be text of at most {MAX_BYTES // 1_000_000} MB')
    root, target = resolve(cwd, relative)
    if version is None:
        if target.exists():
            raise FileExistsError(f'{relative} already exists')
        target.parent.mkdir(parents=True, exist_ok=True)
    else:
        current = target.read_bytes() if target.is_file() else b''
        if version_of(current) != version:
            try:
                theirs = current.decode('utf-8')
            except UnicodeDecodeError:
                theirs = None
            return dict(conflict=True, path=os.path.relpath(target, root), text=theirs, version=version_of(current))
    data = text.encode()
    target.write_bytes(data)
    return dict(path=os.path.relpath(target, root), absolute=str(target), version=version_of(data))


def changes(cwd):
    """How each changed file differs from the last commit, by its path from the pane's folder."""
    root = _root(cwd)
    try:
        prefix = subprocess.run(['git', '-C', str(root), 'rev-parse', '--show-prefix'], capture_output=True, text=True, timeout=10, check=True).stdout.strip()
        result = subprocess.run(['git', '-C', str(root), 'status', '--porcelain=v1', '-z', '--untracked-files=all'], capture_output=True, timeout=10, check=True)
    except (OSError, subprocess.SubprocessError):
        return dict(changes={}, git=False)
    entries, found = result.stdout.decode(errors='replace').split('\x00'), {}
    skip = False
    for entry in entries:
        if skip or len(entry) < 4:
            skip = False
            continue
        code, path = entry[:2], entry[3:]
        # A rename is followed by the name it had, which is not a file any more.
        skip = 'R' in code or 'C' in code
        # Git names paths from the top of the repository; the pane sees them from its own folder.
        if not path.startswith(prefix):
            continue
        kind = ('untracked' if code == '??' else 'conflict' if 'U' in code or code in ('AA', 'DD') else 'deleted' if 'D' in code
                else 'added' if 'A' in code else 'renamed' if 'R' in code else 'modified')
        found[path[len(prefix):]] = kind
        if len(found) >= MAX_LISTED:
            break
    return dict(changes=found, lines=line_counts(root, prefix, found), git=True)


def line_counts(root, prefix, found):
    """Lines added and removed in each changed file since the last commit. Binary files have none."""
    counts = {}
    try:
        result = subprocess.run(['git', '-C', str(root), 'diff', '--numstat', '-z', 'HEAD', '--', '.'], capture_output=True, timeout=10, check=True)
    except (OSError, subprocess.SubprocessError):
        result = None
    fields = result.stdout.decode(errors='replace').split('\x00') if result else []
    at = 0
    while at < len(fields):
        head = fields[at].split('\t')
        if len(head) < 3:
            at += 1
            continue
        # A rename leaves the path empty and names the old and new paths in the next two fields.
        path = head[2] if head[2] else (fields[at + 2] if at + 2 < len(fields) else '')
        at += 1 if head[2] else 3
        if path.startswith(prefix) and head[0].isdigit() and head[1].isdigit():
            counts[path[len(prefix):]] = [int(head[0]), int(head[1])]
    # Files Git doesn't track yet are all new lines.
    for path, kind in found.items():
        if kind == 'untracked' and path not in counts:
            target = Path(root) / path
            try:
                if target.is_file() and target.stat().st_size <= MAX_BYTES:
                    data = target.read_bytes()
                    if b'\x00' not in data[:8192]:
                        counts[path] = [data.count(b'\n') + (0 if not data or data.endswith(b'\n') else 1), 0]
            except OSError:
                continue
    return counts
