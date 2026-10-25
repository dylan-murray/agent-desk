"""Authenticated HTTP semantics over private Unix sockets for desktop workspaces.

The agent-desk URL identifies a workspace, never a filesystem path. Browser URLs
remain ordinary loopback HTTP URLs. This module has no server-start side effects.
"""
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import stat
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import BaseHandler, ProxyHandler, Request, build_opener
from urllib.response import addinfourl

PROTOCOL = 1
WORKSPACE_RE = re.compile(r'[a-f0-9]{32}\Z')


def workspace_key(value):
    if isinstance(value, str) and WORKSPACE_RE.fullmatch(value):
        return value
    if isinstance(value, int) or str(value).isdigit():
        port = int(value)
        if not 1 <= port <= 65535:
            raise ValueError('Invalid browser port')
        return port
    if not WORKSPACE_RE.fullmatch(str(value)):
        raise ValueError('Invalid workspace ID')
    return str(value)


def desktop_id(desk):
    parts = urlparse(desk)
    if (parts.scheme != 'agent-desk' or not WORKSPACE_RE.fullmatch(parts.netloc)
            or parts.username or parts.password or parts.fragment):
        raise ValueError('Invalid desktop workspace address')
    return parts.netloc


def desk_url(key):
    key = workspace_key(key)
    return f'http://127.0.0.1:{key}' if isinstance(key, int) else f'agent-desk://{key}'


def endpoint_key(desk):
    if desk.startswith('agent-desk:'):
        return desktop_id(desk)
    parts = urlparse(desk)
    if (parts.scheme != 'http' or parts.hostname not in ('localhost', '127.0.0.1')
            or not parts.port or parts.username or parts.password):
        raise ValueError('Use a loopback Agent Desk URL with an explicit port, or a desktop workspace address')
    return workspace_key(parts.port)


def private_directory(path):
    path = Path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise PermissionError(f'{path} must be a private directory owned by you')
    return path


def runtime_directory(data_dir, workspace):
    workspace = workspace_key(workspace)
    if isinstance(workspace, int):
        raise ValueError('Desktop connections require a workspace ID')
    # A short stable path, independent of installed app versions and /tmp purges.
    root = private_directory(Path(os.environ.get('AGENT_DESK_SOCKET_ROOT', str(Path.home() / '.agent-desk'))))
    root = private_directory(root / 'run')
    identity = hashlib.sha256((str(Path(data_dir).resolve()) + ':' + workspace).encode()).hexdigest()[:20]
    folder = private_directory(root / identity)
    if len(os.fsencode(folder / 'backend.sock')) >= 100:
        raise ValueError('Home path is too long for a desktop Unix socket')
    return folder


def write_private_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.' + os.urandom(8).hex() + '.tmp')
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def read_private_json(path):
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(path, flags)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise PermissionError('Connection record is not private')
        return json.load(stream)


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout=15):
        super().__init__('app', timeout=timeout)
        self.socket_path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        try:
            self.sock.connect(self.socket_path)
        except BaseException:
            self.sock.close()
            raise


class DesktopHandler(BaseHandler):
    def agent_desk_open(self, request):
        from agent_desk.paths import DATA_DIR
        workspace = desktop_id(request.full_url)
        folder = runtime_directory(DATA_DIR, workspace)
        connection = UnixHTTPConnection(folder / 'backend.sock', request.timeout)
        headers = dict(request.header_items())
        headers['Host'] = 'app'
        parts = urlparse(request.full_url)
        path = parts.path or '/'
        if parts.query:
            path += '?' + parts.query
        connection.request(request.get_method(), path, body=request.data, headers=headers)
        response = connection.getresponse()
        wrapped = addinfourl(response, response.headers, request.full_url, response.status)
        wrapped.msg = response.reason
        # The response owns the socket until close; do not follow redirects into
        # another workspace or leak local credentials to a network destination.
        if response.status >= 300:
            raise HTTPError(request.full_url, response.status, response.reason, response.headers, wrapped)
        return wrapped

    def agent_tool_open(self, request):
        from agent_desk.paths import DATA_DIR
        parts = urlparse(request.full_url)
        if not re.fullmatch(r't[a-f0-9]{32}', parts.netloc) or request.get_method() not in ('GET', 'HEAD', 'POST'):
            raise ValueError('Invalid managed tool request')
        workspace = os.environ.get('AGENT_DESK_WORKSPACE_ID')
        if not workspace:
            raise ValueError('Managed desktop tools require a workspace connection')
        folder = runtime_directory(DATA_DIR, workspace)
        found = None
        for path in (DATA_DIR / 'tool-runtime').glob('*.json'):
            item = read_private_json(path)
            if item.get('url') == 'agent-tool://' + parts.netloc:
                found = item
                break
        if not found or found.get('transport') != 'unix-http-v1':
            raise ValueError('Unknown managed tool instance')
        socket_path = Path(found['socket'])
        info = socket_path.lstat()
        if socket_path.parent != folder or not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise PermissionError('Unsafe tool socket')
        connection = UnixHTTPConnection(socket_path, request.timeout)
        headers = dict(request.header_items())
        # The registry and socket checks choose the destination; callers may send
        # application authentication headers but cannot choose the virtual host.
        for key in list(headers):
            if key.lower() in ('host', 'connection', 'transfer-encoding', 'content-length'):
                del headers[key]
        headers['Host'] = '127.0.0.1:0'
        connection.request(request.get_method(), (parts.path or '/') + ('?' + parts.query if parts.query else ''),
                           body=request.data, headers=headers)
        response = connection.getresponse()
        wrapped = addinfourl(response, response.headers, request.full_url, response.status)
        wrapped.msg = response.reason
        if response.status >= 300:
            raise HTTPError(request.full_url, response.status, response.reason, response.headers, wrapped)
        return wrapped

    # urllib dispatch preserves hyphens in custom scheme names.


setattr(DesktopHandler, 'agent-desk_open', DesktopHandler.agent_desk_open)
setattr(DesktopHandler, 'agent-tool_open', DesktopHandler.agent_tool_open)


def urlopen(url, data=None, timeout=15):
    """Open a desk request without a proxy or automatic credential redirects."""
    request = url if isinstance(url, Request) else Request(url, data=data)
    if request.type in ('agent-desk', 'agent-tool'):
        return build_opener(ProxyHandler({}), DesktopHandler()).open(request, timeout=timeout)
    return build_opener(ProxyHandler({})).open(request, timeout=timeout)
