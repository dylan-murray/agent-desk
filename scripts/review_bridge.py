"""Deliver a code review submission to the Agent Desk pane it was opened from.

Code review runs this as its host bridge: the submission arrives as JSON on stdin and the reply
on stdout acknowledges that exact submission and session. The desk sends it through the same
route as annotations, so a busy agent gets it queued rather than typed over.
Usage: review_bridge.py DESK_URL
"""
import json
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent_desk.desk_tokens import read_terminal_token  # noqa: E402


def deliver(desk, event):
    submission, session = event.get('submission_id'), event.get('destination', {}).get('session_id')
    message = event.get('message')
    if not isinstance(submission, str) or not isinstance(session, str) or not isinstance(message, str) or not message.strip():
        raise ValueError('The review sent an incomplete submission')
    payload = {'request_id': submission, 'target_id': session, 'prompt': message,
               'notes': [{'id': submission, 'note': message}]}
    request = Request(desk.rstrip('/') + '/api/coordinators/submit-feedback', data=json.dumps(payload).encode(),
                      headers={'Content-Type': 'application/json', 'X-Agent-Desk-Terminal': read_terminal_token(desk)})
    with build_opener(ProxyHandler({})).open(request, timeout=10) as response:
        result = json.load(response)
    if result.get('target_id') != session or not (result.get('sent') or result.get('queued')):
        raise ValueError('Agent Desk did not confirm the pane')
    return {'accepted': True, 'submission_id': submission, 'session_id': session, 'queued': bool(result.get('queued'))}


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__.strip().splitlines()[-1])
    try:
        print(json.dumps(deliver(sys.argv[1], json.load(sys.stdin))))
    except HTTPError as error:
        try:
            reason = json.load(error).get('error')
        except ValueError:
            reason = None
        sys.exit(f'Agent Desk refused the review: {reason or error.code}')
    except (URLError, OSError, ValueError) as error:
        sys.exit(f'Could not reach Agent Desk: {error}')
