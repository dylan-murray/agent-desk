"""Commands that run a desk helper script on the desk's own Python.

A python3 found on an agent's PATH may be too old for the desk or someone else's: login shells put the user's
own interpreter back in front, and the desktop app's bundled Python is never on it. Shells and agents run these
commands as text, so each launcher lives at a path with no spaces. The desktop app's data folder is under
Application Support, so its launchers go under ~/.agent-desk there, where its sockets live."""
import hashlib
import logging
import os
from pathlib import Path
import shlex
import sys

_launchers = {}


def python_launcher(script, name):
    """An executable that runs ``script`` with this interpreter, or None when one cannot be written."""
    script = Path(script).resolve()
    key = (str(script), name)
    if key not in _launchers:
        from agent_desk.local_transport import private_directory
        from agent_desk.paths import DATA_DIR
        body = f'#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(script))} "$@"\n'
        try:
            root = DATA_DIR if ' ' not in str(DATA_DIR) else private_directory(Path(os.environ.get('AGENT_DESK_SOCKET_ROOT', str(Path.home() / '.agent-desk'))))
            folder = root / 'bin' / hashlib.sha256(body.encode()).hexdigest()[:12]
            folder.mkdir(mode=0o700, parents=True, exist_ok=True)
            path = folder / name
            if not path.is_file() or path.read_text() != body:
                temporary = folder / f'.{name}.{os.getpid()}'
                temporary.write_text(body)
                temporary.chmod(0o700)
                temporary.replace(path)
            _launchers[key] = path
        except OSError as error:
            logging.getLogger(__name__).warning('No launcher for %s: %s', name, error)
            _launchers[key] = None
    return _launchers[key]


def python_command(script, name):
    """Shell text that runs ``script`` on this interpreter, through its launcher when one can be written."""
    launcher = python_launcher(script, name)
    if launcher:
        return shlex.quote(str(launcher))
    return shlex.quote(sys.executable) + ' ' + shlex.quote(str(Path(script).resolve()))
