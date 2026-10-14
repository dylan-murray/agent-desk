"""Grok native-terminal delivery, owned by the PTY supervisor, not a model turn."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

from scripts.control_mailbox import Mailbox
from scripts.coordinator_events import send_batch


def notification(controller, batch):
    count = len(batch['tasks'])
    return (f"Agent Desk: {count} worker {'reply' if count==1 else 'replies'} ready. "
            f"Read agent_control.py inbox --controller {controller}, report the results, "
            "and ack handled replies. End your turn when done.")


class NativeDelivery:
    def __init__(self, config):
        self.box = Mailbox(config['db'])
        self.desk, self.controller = config['desk'], config['controller']
        self.revision = 0
        self.snapshot = {}
        self.pending = b''
        self.stable_since = self.last_input = time.monotonic()
        self.paused = self.failed = self.awaiting_activity = False
        self.output_after_input = True
        self.state = None
        self.observer = subprocess.Popen([shutil.which('node'), str(Path(__file__).with_name('native_terminal_screen.cjs'))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        self.set_state('connecting')

    def set_state(self, state):
        if state != self.state:
            self.box.connection(self.desk, self.controller, state)
            self.state = state

    def observe(self, event):
        self.revision += 1
        if event['op']=='output':
            self.output_after_input = True
        if event['op']=='resize':
            self.stable_since = time.monotonic()
        if self.failed:
            return
        try:
            pending = json.dumps(dict(event, revision=self.revision)).encode()+b'\n'
            while pending:
                written = self.observer.stdin.write(pending)
                if not written:
                    raise OSError('Screen observer closed')
                pending = pending[written:]
        except (OSError, ValueError):
            self.failed = True
            self.set_state('delivery-error')

    def read(self):
        data = os.read(self.observer.stdout.fileno(), 65536)
        if not data:
            self.failed = True
            self.set_state('delivery-error')
            return
        self.pending += data
        while b'\n' in self.pending:
            line, self.pending = self.pending.split(b'\n', 1)
            try:
                snapshot = json.loads(line)
                if not isinstance(snapshot.get('revision'), int) or snapshot.get('state') not in ('idle','typing','unknown','working','needs-input'):
                    raise ValueError('Invalid screen observation')
            except (ValueError, AttributeError):
                self.failed = True
                self.set_state('delivery-error')
                return
            if (snapshot.get('ready'), snapshot.get('state')) != (self.snapshot.get('ready'), self.snapshot.get('state')):
                self.stable_since = time.monotonic()
            if self.awaiting_activity and snapshot['state'] in ('working','needs-input'):
                self.awaiting_activity = False
            self.snapshot = snapshot

    def user_input(self, data):
        # Focus and device responses are not editing. No mouse/keyboard input
        # is manufactured here, and uncertain input always delays delivery.
        if re.fullmatch(rb'\x1b\[(?:[IO]|\??[0-9;]*[cRn])', data):
            return
        self.last_input = time.monotonic()
        self.output_after_input = False
        if data in (b'\x03', b'\x1b'):
            self.paused = True
        elif b'\r' in data and self.snapshot.get('state') in ('idle','typing'):
            self.paused = False
        self.observe({'op':'input'})

    def tick(self, writer, now=None):
        now = time.monotonic() if now is None else now
        if self.failed:
            return
        state = self.snapshot.get('state','unknown')
        self.set_state('delivery-paused' if self.paused else 'working' if self.awaiting_activity else
                       {'idle':'queue-ready','typing':'editing'}.get(state,state))
        if (self.paused or self.awaiting_activity or not self.output_after_input or not self.snapshot.get('ready') or
            self.snapshot.get('revision') != self.revision or now-self.stable_since < 1 or now-self.last_input < 5):
            return
        try:
            def deliver(content, batch):
                # A single ordered write keeps user keystrokes out of the paste.
                writer(b'\x1b[200~'+content.encode()+b'\x1b[201~\r')
            if send_batch(self.box,self.desk,self.controller,deliver,notification):
                self.awaiting_activity = True
                self.set_state('working')
        except Exception:
            self.failed = True
            self.set_state('delivery-error')

    def close(self):
        self.observer.stdin.close()
        try:
            self.observer.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.observer.kill()
            self.observer.wait()
        self.observer.stdout.close()
        self.set_state('disconnected')
