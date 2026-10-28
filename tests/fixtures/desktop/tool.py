"""Port-free stdlib skill fixture; no model services or private documents."""
import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
import json

parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, default=0)
parser.add_argument('--no-browser', action='store_true')
args = parser.parse_args()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'<!doctype html><title>Fixture review</title><p>Review fixture</p><button id="send">Submit feedback</button><p id="result"></p><script>document.querySelector("#send").onclick=async()=>{const r=await fetch("/submit",{method:"POST",body:JSON.stringify({note:"fixture feedback"}),headers:{"Content-Type":"application/json"}});document.querySelector("#result").textContent=(await r.json()).saved?"Saved":"Failed";}</script>'
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        value = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        body = json.dumps({'saved': value.get('note') == 'fixture feedback'}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


HTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
