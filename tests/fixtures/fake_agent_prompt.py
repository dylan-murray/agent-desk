"""A stand-in coding agent for browser checks: an empty Claude-style prompt that saves each pasted task.

    fake_agent_prompt.py RECEIVED_FILE

Agent Desk only types a task into a prompt it recognizes as empty, so this draws one
(bracketed paste on, the cursor after "❯ "), then appends every pasted task to
RECEIVED_FILE as a JSON line and draws the prompt again.
"""
import json
import os
import sys
import tty

PROMPT = '\r\n❯ '


def main():
    received = sys.argv[1]
    tty.setraw(0)
    os.write(1, ('\x1b[?2004h' + PROMPT).encode())
    pending = b''
    while chunk := os.read(0, 65536):
        pending += chunk
        while b'\x1b[201~\r' in pending:
            pasted, pending = pending.split(b'\x1b[201~\r', 1)
            text = pasted.split(b'\x1b[200~', 1)[-1].decode(errors='replace')
            with open(received, 'a') as handle:
                handle.write(json.dumps({'task': text}) + '\n')
            os.write(1, ('\r\nGot it.' + PROMPT).encode())


if __name__ == '__main__':
    main()
