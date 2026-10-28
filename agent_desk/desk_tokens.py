"""Where local helpers find a running desk's tokens.

Tokens live in owner-only (0600) files in the desk's data directory, keyed by
port. They are never handed out over HTTP to anything but the desk's own page,
so a process that can only reach 127.0.0.1 cannot pick them up.
"""
import os
from pathlib import Path

from agent_desk.paths import DATA_DIR
from agent_desk.local_transport import endpoint_key, workspace_key


def token_path(kind, port, data_dir=None):
    return Path(data_dir or DATA_DIR) / f'.{kind}-token-{workspace_key(port)}'


def write_token(kind, port, value, data_dir=None):
    path = token_path(kind, port, data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    with os.fdopen(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as stream:
        stream.write(value)
    os.chmod(temp, 0o600)
    os.replace(temp, path)
    return path


def read_terminal_token(desk, data_dir=None):
    """The terminal token of the desk at ``desk`` (a loopback URL with a port)."""
    port = endpoint_key(desk)
    if not port:
        raise ValueError('Use an Agent Desk URL with an explicit port')
    path = token_path('terminal', port, data_dir)
    try:
        return path.read_text().strip()
    except OSError:
        raise ValueError(f'No terminal token for the desk on port {port} at {path}; is that desk running from this data directory?') from None
