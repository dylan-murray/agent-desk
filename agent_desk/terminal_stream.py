"""One WebSocket per browser tab carries output, input and resizes for every local pane.

Client messages: auth {token} first, then subscribe {sub, id, cursor}, unsubscribe {sub},
input {id, data} and resize {id, cols, rows}. Server messages: output {sub, id, data, cursor,
truncated, exit_code}, exit {sub, id, cursor, exit_code} and error {sub?, id?, message}.
Cursors mean what they do for GET /api/terminals/output, so a reconnecting tab re-subscribes
from the last cursor it received and nothing is lost or repeated.

The desk page's token reaches every pane. A local helper's token, such as `agent-desk attach`,
reaches only what it could over HTTP: ``refusal(id, write)`` says why a pane is off limits.
"""
import json
import secrets
import threading

from agent_desk.terminals import input_event, resize_event
from agent_desk.websocket import Closed

WAIT = 20
MAX_SUBSCRIPTIONS = 64


class TerminalStream:
    def __init__(self, socket, terminals, token, helper_token=None, refusal=None):
        self.socket, self.terminals, self.token = socket, terminals, token
        self.helper_token, self.helper_refusal = helper_token, refusal
        # Set once a helper authenticates; the page is never refused.
        self.refusal = None
        self.subscriptions = {}
        self.lock = threading.Lock()

    def authenticate(self, message):
        token = str(message.get('token', '')) if message.get('type') == 'auth' else ''
        if token and secrets.compare_digest(token, self.token):
            return True
        if token and self.helper_token and self.helper_refusal and secrets.compare_digest(token, self.helper_token):
            self.refusal = self.helper_refusal
            return True
        return False

    def check(self, identity, write):
        refused = self.refusal and self.refusal(identity, write)
        if refused:
            raise ValueError(refused)

    def serve(self):
        try:
            if not self.authenticate(self.receive()):
                return self.socket.close(1008, 'Terminal authentication required')
            while True:
                self.handle(self.receive())
        except Closed:
            pass
        finally:
            with self.lock:
                for cancelled in self.subscriptions.values():
                    cancelled.set()
                self.subscriptions.clear()
            self.socket.close()

    def receive(self):
        try:
            message = json.loads(self.socket.receive())
        except ValueError:
            message = None
        if not isinstance(message, dict):
            self.socket.close(1007, 'Expected a JSON object')
            raise Closed('Invalid message')
        return message

    def send(self, **message):
        self.socket.send_text(json.dumps(message))

    def handle(self, message):
        kind, identity = message.get('type'), message.get('id')
        try:
            if kind == 'subscribe':
                self.check(identity, write=False)
                self.subscribe(message.get('sub'), identity, message.get('cursor'))
            elif kind == 'unsubscribe':
                with self.lock:
                    cancelled = self.subscriptions.pop(message.get('sub'), None)
                if cancelled:
                    cancelled.set()
            elif kind == 'input':
                self.check(identity, write=True)
                self.terminals.send(identity, input_event(message.get('data')))
            elif kind == 'resize':
                self.check(identity, write=True)
                self.terminals.send(identity, resize_event(message.get('cols'), message.get('rows')))
            else:
                raise ValueError('Unknown terminal stream message')
        except (ValueError, TypeError, OSError) as error:
            self.send(type='error', sub=message.get('sub'), id=identity, message=str(error))

    def subscribe(self, sub, identity, cursor):
        if not isinstance(sub, str) or not 0 < len(sub) <= 64 or not isinstance(identity, str):
            raise ValueError('Invalid subscription')
        if type(cursor) is not int or cursor < 0:
            raise ValueError('Invalid cursor')
        cancelled = threading.Event()
        with self.lock:
            if sub in self.subscriptions or len(self.subscriptions) >= MAX_SUBSCRIPTIONS:
                raise ValueError('Too many or duplicate terminal subscriptions')
            self.subscriptions[sub] = cancelled
        threading.Thread(target=self.follow, args=(sub, identity, cursor, cancelled), daemon=True).start()

    def follow(self, sub, identity, cursor, cancelled):
        # An empty reply tells the pane it has caught up, after subscribing or after a gap that
        # made it redraw; otherwise only new bytes are sent.
        caught_up = False
        try:
            while not cancelled.is_set():
                output = self.terminals.output(identity, cursor, WAIT if caught_up else 0)
                if cancelled.is_set():
                    return
                if output['truncated']:
                    caught_up = False
                if output['data'] or not caught_up:
                    self.send(type='output', sub=sub, id=identity, **output)
                caught_up = caught_up or not output['data']
                cursor = output['cursor']
                if output['exit_code'] is not None and not output['data']:
                    return self.send(type='exit', sub=sub, id=identity, cursor=cursor, exit_code=output['exit_code'])
        except Closed:
            pass
        except (ValueError, TypeError, OSError) as error:
            try:
                self.send(type='error', sub=sub, id=identity, message=str(error))
            except Closed:
                pass
        finally:
            with self.lock:
                if self.subscriptions.get(sub) is cancelled:
                    del self.subscriptions[sub]
