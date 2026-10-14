"""Deliver a tool's submitted feedback to the Agent Desk session that opened it. Stdlib plus agent_desk's token reader.

Reads one JSON envelope on stdin, as `--feedback-command` bridges receive it, and prints the acknowledgment.
"""
import argparse
import json
import sys
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent_desk.desk_tokens import read_terminal_token  # noqa: E402


def prompt(event):
    """Word the request so the agent sees each comment and where it was left."""
    lines = []
    for note in event.get('annotations') or []:
        if not isinstance(note, dict) or note.get('status') == 'addressed' or not str(note.get('comment') or '').strip():
            continue
        where = str(note.get('file') or 'whole change')
        if note.get('start'):
            where += ':' + str(note['start']) + ('-' + str(note['end']) if note.get('end') not in (None, note['start']) else '')
        lines.append('- ' + where + ' ' + ' '.join(str(note['comment']).split())
                     + (' (with a suggested replacement)' if note.get('suggestion') is not None else ''))
    listed = '\n'.join(lines)
    if not lines or len(listed) > 4000:
        return event['message']
    return ('Review feedback on ' + str(event.get('target') or 'your change') + ':\n' + listed
            + '\nThe full comments, with the quoted lines, are saved at ' + str(event.get('snapshot_path'))
            + '. Make the requested changes, verify them and report back.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--desk', required=True)
    parser.add_argument('--target', required=True, help='Agent Desk session that receives the feedback')
    args = parser.parse_args()
    event = json.load(sys.stdin)
    # Loopback only: never route the desk token through a proxy.
    opener = build_opener(ProxyHandler({}))
    token = read_terminal_token(args.desk)
    payload = dict(request_id=event['submission_id'], target_id=args.target, prompt=prompt(event),
                   notes=[dict(id=event['submission_id'], note=event['message'])])
    request = Request(args.desk + '/api/coordinators/submit-feedback', data=json.dumps(payload).encode(),
                      headers={'Content-Type': 'application/json', 'X-Agent-Desk-Terminal': token})
    try:
        with opener.open(request, timeout=8) as response:
            result = json.load(response)
    except HTTPError as error:
        try:
            sys.exit(json.load(error).get('error', 'Agent Desk refused the feedback'))
        finally:
            error.close()
    # A busy agent gets the feedback when its prompt is next ready; the desk holds it until then.
    accepted = result.get('sent') is True or result.get('queued') is True
    print(json.dumps(dict(accepted=accepted, submission_id=event['submission_id'], session_id=args.target)))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError) as error:
        sys.exit(str(error))
