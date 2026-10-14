"""Launch an existing skill UI and register it inside Agent Desk. Stdlib only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from agent_desk.paths import DATA_DIR


def local_url(value):
    url = urlparse(value)
    if url.scheme != 'http' or url.hostname not in ('127.0.0.1', 'localhost') or not url.port or url.username or url.password:
        raise ValueError('Use a local HTTP URL with an explicit port')
    return value.rstrip('/')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skill', required=True)
    parser.add_argument('--target', type=Path, help='File or repo consumed by the skill UI')
    parser.add_argument('--url', help='Register an already-running local UI instead of launching')
    parser.add_argument('--title')
    parser.add_argument('--id')
    parser.add_argument('--agent-id', default=os.environ.get('AGENT_DESK_AGENT_ID') or os.environ.get('AGENT_DESK_COORDINATOR_ID'), help='Originating Agent Desk session; inherited from AGENT_DESK_AGENT_ID when set, else the pane it runs in')
    parser.add_argument('--desk', default='http://127.0.0.1:4310')
    parser.add_argument('--port', type=int, help='UI server port; default chooses a free local port')
    parser.add_argument('extra', nargs=argparse.REMAINDER, help='Arguments after -- go to the known skill entrypoint')
    args = parser.parse_args()
    desk = local_url(args.desk)
    token = os.environ.get('AGENT_DESK_TOKEN')
    if not token:
        token = (DATA_DIR / f'.adapter-token-{urlparse(desk).port}').read_text().strip()
    # Check the desk before starting a process that needs it.
    with urlopen(desk + '/api/skill-uis', timeout=3) as response:
        registered_uis = json.load(response)['uis']
    from agent_desk.tool_runtime import ToolRuntime
    runtime=ToolRuntime()
    target = args.target.expanduser().resolve() if args.target else None
    identity = args.id or args.skill + '-' + hashlib.sha256(str(target or args.url).encode()).hexdigest()[:10]
    process = None
    # A tool opened from a plain pane belongs to that pane's terminal, so the desk can dock it there.
    owner = (args.agent_id or next((ui.get('agent_id') for ui in registered_uis if ui['id'] == identity), None)
             or os.environ.get('AGENT_DESK_TERMINAL_ID'))
    try:
        if args.url:
            ui_url=local_url(args.url);item={}
        else:
            extra=args.extra[1:] if args.extra[:1]==['--'] else args.extra
            os.environ['AGENT_DESK_URL'] = desk
            # A code review opened from a session sends its submitted feedback back to that session.
            if args.skill == 'code-review' and owner and '--feedback-command' not in extra:
                bridge = [sys.executable, str(ROOT / 'scripts' / 'tool_feedback.py'), '--desk', desk, '--target', owner]
                extra = [*extra, '--feedback-command', json.dumps(bridge), '--session-id', owner, '--harness', 'Agent Desk']
            item=runtime.launch(args.skill,str(target) if target else '',identity,args.title,args.port,extra)
            ui_url=item['url']
        payload = dict(id=identity, title=args.title or f'{args.skill}: {target.name if target else "UI"}',
                       skill=args.skill, url=ui_url, context=str(target or ''))
        if owner:
            payload['agent_id'] = owner
        request = Request(desk + '/api/skill-uis', data=json.dumps(payload).encode(),
                          headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
        with urlopen(request, timeout=3) as response:
            registered = json.load(response)
        print(json.dumps(dict(endpoint=desk + registered['endpoint'], url=ui_url,
                              pid=item.get('pid'), log=item.get('log'))))
    except Exception:
        if process and process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
        raise


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        sys.exit(str(error))
