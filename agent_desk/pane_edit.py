"""The editor inside an Agent Desk pane: opens a file in the page's editor and waits for it.

Claude Code's ctrl+g, git and anything else that runs $VISUAL or $EDITOR from a terminal end up
here, through the launcher agent_desk.terminals writes. It runs on the desk's own Python and sends
through the desk's transport, so it reaches a browser desk on its port and the desktop app on its
socket. Saving in the page writes the file and exits; Cancel leaves it as it was. Without a
terminal (an agent's own command), without an open page, or for a file too large to send, the
editor you had before Agent Desk runs instead.
"""
import json
import os
import shlex
import signal
import sys
from pathlib import Path

if __package__ in (None, ''):
    # Run by path from the launcher: the desk's package sits one folder up.
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from urllib.error import HTTPError, URLError  # noqa: E402
from urllib.request import Request  # noqa: E402

from agent_desk.local_transport import urlopen  # noqa: E402

NAME = 'agent-desk-edit'


def fallback(args, reason=None):
    if reason:
        print(f'{NAME}: {reason}; using your own editor', file=sys.stderr)
    command = shlex.split(os.environ.get('AGENT_DESK_FALLBACK_EDITOR') or '') or ['vi']
    if Path(command[0]).name == NAME:
        command = ['vi']
    os.execvp(command[0], command + args)


def call(desk, token, route, payload, timeout):
    request = Request(desk.rstrip('/') + route, data=json.dumps(payload).encode(),
                      headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except HTTPError as error:
        try:
            message = json.load(error).get('error')
        except ValueError:
            message = None
        raise RuntimeError(message or f'HTTP {error.code}') from None


def main():
    args = sys.argv[1:]
    terminal, token, desk = (os.environ.get(k) for k in ('AGENT_DESK_TERMINAL_ID', 'AGENT_DESK_PANE_TOKEN', 'AGENT_DESK_URL'))
    files = [arg for arg in args if not arg.startswith(('-', '+'))]
    if not (terminal and token and desk) or len(files) != 1 or not (sys.stdin.isatty() and sys.stdout.isatty()):
        fallback(args)
    path = Path(files[0])
    try:
        text = path.read_text(encoding='utf-8') if path.exists() else ''
    except (OSError, UnicodeDecodeError) as error:
        fallback(args, f'could not read {path} ({error})')
    try:
        edit = call(desk, token, '/api/pane-editor/open', dict(id=terminal, name=path.name, text=text), 10)['id']
    except (RuntimeError, URLError, OSError, ValueError, KeyError) as error:
        fallback(args, str(getattr(error, 'reason', error)))
    print('\nEditing in Agent Desk · save or cancel there · ctrl+c here cancels', file=sys.stderr, flush=True)

    def abandon(*_):
        try:
            call(desk, token, '/api/pane-editor/abandon', dict(id=terminal, edit=edit), 5)
        except Exception:
            pass
        sys.exit(130)
    signal.signal(signal.SIGINT, abandon)
    signal.signal(signal.SIGTERM, abandon)
    signal.signal(signal.SIGHUP, abandon)
    while True:
        try:
            result = call(desk, token, '/api/pane-editor/wait', dict(id=terminal, edit=edit), 35)
        except (URLError, OSError) as error:
            print(f'{NAME}: lost Agent Desk ({getattr(error, "reason", error)}); the file is unchanged', file=sys.stderr)
            sys.exit(1)
        except RuntimeError as error:
            print(f'{NAME}: {error}; the file is unchanged', file=sys.stderr)
            sys.exit(1)
        if not result.get('done'):
            continue
        if result.get('saved'):
            path.write_text(result['text'], encoding='utf-8')
        sys.exit(0)


if __name__ == '__main__':
    main()
