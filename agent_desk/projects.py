"""Bounded local Git-folder discovery and explicit empty workspace creation."""
from collections import deque
import os
from pathlib import Path
import time

SKIP = {'node_modules', 'vendor', 'venv', '__pycache__', 'dist', 'build', 'Library', 'Applications'}


def default_roots():
    home = Path.home()
    return [str(home / name) for name in ('personal', 'projects', 'github_projects', 'github-projects', 'code', 'dev', 'Developer', 'src', 'repos', 'github') if (home / name).is_dir()]


def discover_projects(roots=None, max_depth=4, max_directories=10000, seconds=3):
    roots = default_roots() if roots is None else roots
    queue = deque((Path(root).expanduser().resolve(), 0) for root in roots)
    seen, projects = set(), []
    limited = False
    deadline = time.monotonic() + seconds
    while queue and len(seen) < max_directories and time.monotonic() < deadline:
        path, depth = queue.popleft()
        if path in seen:
            continue
        seen.add(path)
        try:
            if not path.is_dir():
                continue
            marker = path / '.git'
            if marker.is_dir() or marker.is_file():
                projects.append({'name': path.name, 'path': str(path)})
            if depth < max_depth:
                with os.scandir(path) as entries:
                    for entry in entries:
                        if not entry.name.startswith('.') and entry.name not in SKIP and entry.is_dir(follow_symlinks=False):
                            queue.append((Path(entry.path), depth + 1))
                            if len(queue) + len(seen) >= max_directories:
                                limited = True
                                break
        except OSError:
            continue
    return {'projects': sorted(projects, key=lambda p: (p['name'].casefold(), p['path'])),
            'roots': [str(root) for root in roots], 'limited': limited or bool(queue)}


def create_directory(parent, name):
    if not isinstance(parent, str) or not Path(parent).is_absolute() or not Path(parent).is_dir():
        raise ValueError('Choose an existing absolute parent directory')
    if not isinstance(name, str) or not name.strip() or name != name.strip() or name in ('.', '..') or '/' in name or '\\' in name or any(ord(c) < 32 for c in name) or len(name) > 100:
        raise ValueError('Enter a folder name without slashes or control characters')
    target = Path(parent).resolve() / name
    try:
        target.mkdir()
    except FileExistsError:
        raise ValueError('That folder already exists. Choose it as an existing directory instead.') from None
    return {'path': str(target), 'name': name}
