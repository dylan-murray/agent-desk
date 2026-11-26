"""Files a pane's editor can open: text files inside the folder the pane was started in, or, named by their
full path, anywhere in your home folder.

Every save names the version it was edited from, so a change made on disk in the meantime
(by the agent in the pane, say) is reported as a conflict instead of being overwritten.
"""
import hashlib
import os
import subprocess
import time
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


def _home():
    return Path(os.path.realpath(Path.home()))


def resolve(cwd, relative):
    """The file a path names, and how to show it: from the pane's folder when it is inside, else in full.

    A relative path stays inside the pane's folder. A full path may also name a file anywhere in your home folder."""
    if not isinstance(relative, str) or not relative.strip() or '\x00' in relative:
        raise ValueError('Name a file')
    root = _root(cwd)
    target = Path(os.path.realpath(os.path.join(root, relative)))
    if root in target.parents:
        return target, os.path.relpath(target, root)
    if os.path.isabs(relative) and _home() in target.parents:
        return target, str(target)
    raise PermissionError('Only files inside the pane\'s folder or your home folder can be opened here' if os.path.isabs(relative)
                          else 'Only files inside the pane\'s folder can be opened here')


def folder_root(cwd, folder=None):
    """The folder a listing starts from: the pane's own, one inside it, or any folder in your home folder."""
    pane = _root(cwd)
    if folder is None:
        return pane
    if not isinstance(folder, str) or not os.path.isabs(folder) or '\x00' in folder:
        raise ValueError('Name a folder by its full path')
    root = os.path.realpath(folder)
    base = str(pane) if root == str(pane) or root.startswith(os.path.join(pane, '')) else str(_home())
    if root == base:
        return Path(base)
    if not root.startswith(os.path.join(base, '')):
        raise PermissionError('Only folders in your home folder or the pane\'s folder can be browsed')
    if not os.path.isdir(root):
        raise FileNotFoundError(f'{folder} is not a folder')
    return Path(root)


def _git(root, *args):
    return subprocess.run(['git', '-C', str(root), *args], capture_output=True, timeout=10, check=True).stdout


def branch(cwd):
    """The branch checked out in the pane's folder, or None outside Git or on a detached HEAD."""
    try:
        return dict(branch=_git(_root(cwd), 'branch', '--show-current').decode(errors='replace').strip() or None)
    except (OSError, ValueError, subprocess.SubprocessError):
        return dict(branch=None)


def listing(cwd, folder=None):
    root = folder_root(cwd, folder)
    repo = branch = None
    try:
        repo = _git(root, 'rev-parse', '--show-toplevel').decode(errors='replace').strip()
        files = [name for name in _git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').decode(errors='replace').split('\x00') if name]
        files = [name for name in dict.fromkeys(files) if (root / name).is_file()]
        branch = _git(root, 'branch', '--show-current').decode(errors='replace').strip() or None
    except (OSError, subprocess.SubprocessError):
        files = []
        # A folder outside Git, such as one that holds several projects, could be huge; stop after a second and say so.
        deadline = time.monotonic() + 1
        for parent, folders, names in os.walk(root):
            folders[:] = sorted(name for name in folders if name not in SKIPPED and not name.startswith('.'))
            for name in sorted(names):
                files.append(os.path.relpath(os.path.join(parent, name), root))
            if len(files) > MAX_LISTED or time.monotonic() > deadline:
                files.append(None)
                break
    truncated = None in files or len(files) > MAX_LISTED
    files = [name for name in files if name][:MAX_LISTED]
    return dict(root=str(root), home=str(_home()), files=files, truncated=truncated, repo=repo, branch=branch)


def read(cwd, relative):
    target, shown = resolve(cwd, relative)
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
    return dict(path=shown, absolute=str(target), text=text, version=version_of(data))


def write(cwd, relative, text, version):
    if not isinstance(text, str) or len(text.encode()) > MAX_BYTES:
        raise ValueError(f'Files must be text of at most {MAX_BYTES // 1_000_000} MB')
    target, shown = resolve(cwd, relative)
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
            return dict(conflict=True, path=shown, text=theirs, version=version_of(current))
    data = text.encode()
    target.write_bytes(data)
    return dict(path=shown, absolute=str(target), version=version_of(data))


def changes(cwd, folder=None):
    """How each changed file differs from the last commit, by its path from the folder listed."""
    root = folder_root(cwd, folder)
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
