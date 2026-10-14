"""The agent-desk MCP tool server: lets an agent set the readouts on the Agent Desk pane it runs in.

Registered once per harness (Agent Desk's Skills page), so every agent session starts one copy.
Keep it cheap: stdlib only, launched with ``python -I -S``, blocking reads on stdin (no CPU while
idle), and no tools at all outside an Agent Desk pane, so other sessions pay no prompt tokens.
Stdio transport: one JSON-RPC message per line.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import readouts  # noqa: E402  (a sibling module; importing the agent_desk package would load far more)

VERSION = '1'
# Sent with every request in every pane session, so it stays short. Limits are not repeated here:
# readouts.validate() enforces them and a rejected call returns the exact reason.
SET_READOUTS = {
    'name': 'set_readouts',
    'description': ("Show values on your Agent Desk pane's header. Replaces what is shown; [] clears. "
                    'Use real values from tool output; ttl_seconds about 2x your update interval. Only when asked.'),
    'inputSchema': {
        'type': 'object',
        'properties': {
            'fields': {'type': 'array', 'items': {'type': 'object', 'properties': {
                'label': {'type': 'string'}, 'value': {'type': 'string'}, 'tone': {'enum': list(readouts.TONES)}},
                'required': ['label', 'value']}},
            'ttl_seconds': {'type': 'number'}},
        'required': ['fields']},
}


_outside = []


def offered():
    # Any hint of a pane offers the tool, so a misplaced session hears why it cannot use it.
    return bool(os.environ.get('AGENT_DESK_TERMINAL_ID'))


def call(name, arguments):
    if name != 'set_readouts' or not offered():
        raise ValueError('Unknown tool: ' + str(name))
    if not _outside:
        _outside.append(readouts.outside_pane())  # the process tree above this server does not change
    if _outside[0]:
        raise ValueError(_outside[0])
    shown = readouts.drop(*readouts.pane(), payload=arguments if isinstance(arguments, dict) else {})
    # The agent knows what it sent, and every result stays in its context for the rest of the session.
    return 'Cleared.' if shown is None else 'Shown.'



def handle(message):
    method, params = message.get('method'), message.get('params') or {}
    if method == 'initialize':
        return {'protocolVersion': params.get('protocolVersion', '2025-06-18'), 'capabilities': {'tools': {}},
                'serverInfo': {'name': 'agent-desk', 'version': VERSION}}
    if method == 'tools/list':
        return {'tools': [SET_READOUTS] if offered() else []}
    if method == 'tools/call':
        try:
            return {'content': [{'type': 'text', 'text': call(params.get('name'), params.get('arguments'))}]}
        except (OSError, ValueError) as error:
            return {'content': [{'type': 'text', 'text': str(error)}], 'isError': True}
    if method == 'ping':
        return {}
    raise LookupError(method)


def main():
    for line in sys.stdin:
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if not isinstance(message, dict) or 'id' not in message:
            continue  # notifications need no reply
        try:
            reply = {'jsonrpc': '2.0', 'id': message['id'], 'result': handle(message)}
        except LookupError:
            reply = {'jsonrpc': '2.0', 'id': message['id'], 'error': {'code': -32601, 'message': 'Method not found'}}
        sys.stdout.write(json.dumps(reply) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
