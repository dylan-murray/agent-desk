"""Publish scoped agent findings and review handoffs to the local Desk."""
import argparse
import json
import os
from pathlib import Path
import uuid
from agent_control import DeskClient, DeskRefused


def save_handoff(folder, operation, payload):
    handoffs = Path(folder) / 'handoff'
    handoffs.mkdir(exist_ok=True)
    path = handoffs / f'{operation}-{uuid.uuid4().hex}.json'
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(dict(payload, operation=operation)))
    os.replace(temporary, path)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--desk', default='http://127.0.0.1:4310')
    sub = parser.add_subparsers(dest='operation', required=True)
    finding = sub.add_parser('finding')
    finding.add_argument('--role', required=True)
    finding.add_argument('--run', default='')
    finding.add_argument('--event-key', required=True)
    finding.add_argument('--title', required=True)
    finding.add_argument('--url', default='')
    report = sub.add_parser('report')
    report.add_argument('--run', required=True)
    report.add_argument('--state', choices=['review', 'blocked', 'failed'], default='review')
    for command in (finding, report):
        command.add_argument('--file', required=True)
    args = parser.parse_args()
    try:
        detail = Path(args.file).read_text()
    except (OSError, ValueError) as exc:
        parser.exit(1, str(exc) + '\n')
    payload = dict(detail=detail)
    if args.operation == 'finding':
        payload.update(run_id=args.run,role_id=args.role, event_key=args.event_key, title=args.title, url=args.url)
    else:
        payload.update(run_id=args.run, state=args.state)
    try:
        print(json.dumps(DeskClient(args.desk).request('/api/special-agents/' + args.operation, payload), indent=2))
    except DeskRefused as exc:
        parser.exit(1, str(exc) + '\n')
    except (OSError, ValueError) as exc:
        if not args.run:
            parser.exit(1, str(exc) + '\n')
        try:
            saved = save_handoff(Path(args.file).parent, args.operation, payload)
        except OSError as error:
            parser.exit(1, f'{exc}\nThe {args.operation} could not be saved for Agent Desk either: {error}\n')
        print(json.dumps({'saved': str(saved), 'detail': f'Agent Desk could not be reached from here, so this {args.operation} was saved '
                          'in the run folder. Agent Desk submits it within a few seconds; nothing else is needed.'}, indent=2))


if __name__ == '__main__':
    main()
