"""Fictional prompt: capture exact PTY input without interpreting or submitting it."""
import os
import sys
import tty

tty.setraw(sys.stdin.fileno())
with open(sys.argv[1], "ab", buffering=0) as capture:
    os.write(sys.stdout.fileno(), b"\x1b[?2004hFixture prompt ready\r\n> ")
    while True:
        chunk = os.read(sys.stdin.fileno(), 65536)
        if not chunk:
            break
        capture.write(chunk)
