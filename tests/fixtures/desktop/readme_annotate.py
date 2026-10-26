"""Minimal annotator storage contract for testing the real feedback bridge."""
import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import threading

PAGE = '<!doctype html><body>Fictional README annotator</body>'


class Annotations:
    def __init__(self, path):
        self.path = path
        self._lock = threading.RLock()

    def load(self):
        return json.loads(self.path.read_text())

    def save(self, notes):
        self.path.write_text(json.dumps(notes))

    def round(self):
        return 1


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', 'http://127.0.0.1:1/credential-must-not-follow')
            self.end_headers()
            return
        self._send(200, json.dumps({'annotations': self.ann.load()}).encode())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('target', type=Path)
    parser.add_argument('--port', type=int)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    Handler.doc = args.target
    Handler.ann = Annotations(args.target.with_suffix('.notes.json'))
    HTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
