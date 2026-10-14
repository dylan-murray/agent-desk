"""Publish scoped agent findings and review handoffs to the local Desk."""
import argparse
import json
from pathlib import Path
from agent_control import DeskClient


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
        payload = dict(detail=detail)
        if args.operation == 'finding':
            payload.update(run_id=args.run,role_id=args.role, event_key=args.event_key, title=args.title, url=args.url)
        else:
            payload.update(run_id=args.run, state=args.state)
        print(json.dumps(DeskClient(args.desk).request('/api/special-agents/' + args.operation, payload), indent=2))
    except (OSError, ValueError) as exc:
        parser.exit(1, str(exc) + '\n')


if __name__ == '__main__':
    main()
