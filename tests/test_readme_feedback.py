import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from agent_desk.tool_runtime import ToolRuntime

ROOT = Path(__file__).resolve().parents[1]


def request(url, payload=None, headers=None):
    with urlopen(Request(url, data=json.dumps(payload).encode() if payload is not None else None,
                         headers={'Content-Type':'application/json', **(headers or {})})) as response:
        return json.load(response)


class ReadmeFeedbackTests(unittest.TestCase):
    def test_standalone_delivery_and_revision_checked_completion(self):
        try:
            from playwright.sync_api import sync_playwright, expect
        except ImportError:
            self.skipTest('Install playwright to run the annotator browser check')
        skill = Path.home() / '.claude/skills/readme-review'
        if not (skill / 'readme_annotate.py').exists():
            self.skipTest('README annotator skill is not installed')
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp).resolve(); doc = folder / 'README.md'
            doc.write_text('# Fixture README\n\nA sentence to review.\n')
            registry = folder / 'skill-uis.json'
            registry.write_text('[]')
            deliveries = []; fail = [False]

            class Desk(SimpleHTTPRequestHandler):
                def __init__(self, *args, **kwargs):
                    super().__init__(*args, directory=str(ROOT / 'agent_desk/static'), **kwargs)
                def log_message(self, *args):
                    pass
                def send_json(self, value, status=200):
                    body=json.dumps(value).encode(); self.send_response(status)
                    self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(body)
                def do_GET(self):
                    if self.path == '/config.js':
                        self.send_response(200); self.send_header('Content-Type','application/javascript')
                        self.end_headers(); self.wfile.write(b'window.AGENT_DESK_CONFIG={development:false};'); return
                    if self.path.startswith('/api/'):
                        data={'/api/skill-uis':{'uis':json.loads(registry.read_text())},
                              '/api/terminal-auth':{'token':'fixture', 'cwd':str(folder)},
                              '/api/agents':{'agents':[]}, '/api/skills':{'skills':[]},
                              '/api/tool-launchers':{'launchers':[]},
                              '/api/web-pages/check':{'reachable':True,'embeddable':True},
                              '/api/special-agents':{'roles':[],'inbox':[],'runs':[]},
                              '/api/workflows':{'configs':[],'workflows':[],'flows':[],'executions':[]}}
                        return self.send_json(data.get(self.path.split('?')[0], {}))
                    super().do_GET()
                def do_POST(self):
                    if self.path != '/api/coordinators/submit-feedback':
                        return self.send_json({'error':'Unknown endpoint'},404)
                    if self.headers.get('X-Agent-Desk-Terminal') != 'fixture':
                        return self.send_json({'error':'Invalid token'},403)
                    deliveries.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                    self.send_json({'error':'Fixture delivery unavailable'} if fail[0] else {'sent':True},503 if fail[0] else 200)

            desk = ThreadingHTTPServer(('127.0.0.1', 0), Desk)
            thread = threading.Thread(target=desk.serve_forever, daemon=True); thread.start()
            # The forwarder reads the desk's terminal token file, never the HTTP endpoint.
            (folder / f'.terminal-token-{desk.server_port}').write_text('fixture')
            env = dict(AGENT_DESK_DATA_DIR=str(folder), README_ANNOTATOR_HOME=str(folder/'notes'),
                       AGENT_DESK_URL=f'http://127.0.0.1:{desk.server_port}')
            runtime = ToolRuntime(folder/'runtime')
            with patch.dict(os.environ, env):
                tool = runtime.launch('readme-review',str(doc),'readme-test')
            ui = dict(tool,endpoint='/apps/readme-test',status='running',agent_id='coordinator-fixture')
            registry.write_text(json.dumps([ui]))
            url = tool['url']
            try:
                request(url+'/annotate',dict(kind='sentence',block=1,sentence=0,quote='A sentence to review.',start=3,end=3,section='Fixture README',comment='Original comment'))
                with sync_playwright() as p:
                    browser=p.chromium.launch()
                    page=browser.new_page(viewport={'width':1400,'height':900})
                    errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
                    page.goto(url)
                    send=page.locator('#desk-send-notes');status=page.locator('#desk-send-status')
                    expect(send).to_be_enabled();expect(send).to_have_text('Send to coordinator')
                    page.locator('#n1 textarea').fill('Newest edit, sent before the debounce')
                    send.click();expect(status).to_have_text('Sent. The coordinator will mark implemented changes done.')
                    self.assertEqual(len(deliveries),1)
                    note=deliveries[0]['notes'][0]
                    self.assertEqual(note['note'],'Newest edit, sent before the debounce')
                    self.assertEqual(note['quote'],'A sentence to review.')
                    self.assertEqual(note['start'],3);self.assertEqual(note['document'],str(doc))
                    expect(page.locator('#n1 .desk-sent')).to_have_text('Sent to coordinator')
                    self.assertEqual(request(url+'/state')['annotations'][0]['status'],'open')
                    embedded=browser.new_page(viewport={'width':1400,'height':900})
                    embedded.goto(env['AGENT_DESK_URL'])
                    # No agent on this desk owns the tool, so it opens as a web pane on the desk.
                    embedded.wait_for_function('typeof openDeskTool==="function"');embedded.evaluate("openDeskTool('/apps/readme-test')")
                    frame=embedded.frame_locator('.web-pane-frame')
                    expect(frame.locator('#desk-send-notes')).to_be_enabled()
                    frame.locator('#desk-send-notes').click()
                    expect(frame.locator('#desk-send-status')).to_have_text('Sent. The coordinator will mark implemented changes done.')
                    self.assertEqual(len(deliveries),1,'Opening another tab must not duplicate delivery')
                    command=shlex.split(note['completion']['command'])
                    command[0]=sys.executable
                    pending=subprocess.run(command,env=dict(os.environ,**env),capture_output=True,text=True)
                    self.assertNotEqual(pending.returncode,0);self.assertIn('has not changed',pending.stderr)
                    doc.write_text('# Fixture README\n\nThe requested revision.\n')
                    completed=subprocess.run(command,env=dict(os.environ,**env),capture_output=True,text=True)
                    self.assertEqual(completed.returncode,0,completed.stderr)
                    expect(page.locator('#n1')).to_have_class('note done',timeout=5000)
                    expect(frame.locator('#n1')).to_have_class('note done',timeout=5000)
                    request(url+'/reopen',{'id':1})
                    expect(page.locator('#n1')).not_to_have_class('note done')
                    page.locator('#n1 textarea').fill('A newer request')
                    fail[0]=True;send.click();expect(status).to_have_text('Fixture delivery unavailable')
                    retry=deliveries[-1]['request_id'];fail[0]=False
                    send.click();expect(status).to_have_text('Sent. The coordinator will mark implemented changes done.')
                    self.assertEqual(deliveries[-1]['request_id'],retry)
                    refused=subprocess.run(command,env=dict(os.environ,**env),capture_output=True,text=True)
                    self.assertNotEqual(refused.returncode,0);self.assertIn('changed since submission',refused.stderr)
                    self.assertEqual(request(url+'/state')['annotations'][0]['status'],'open')
                    page.screenshot(path='/tmp/readme-standalone-after-fixture.png')
                    page.set_viewport_size({'width':600,'height':800});expect(send).to_be_in_viewport()
                    page.screenshot(path='/tmp/readme-standalone-mobile-fixture.png')
                    config=request(url+'/desk-feedback/config')
                    payload={'target_id':ui['agent_id'],'notes':request(url+'/state')['annotations']}
                    count=len(deliveries)
                    for headers in [{},{'X-Readme-Feedback':config['token'],'Origin':'http://evil.test'}]:
                        with self.assertRaises(HTTPError) as caught:request(url+'/desk-feedback/submit',payload,headers)
                        self.assertEqual(caught.exception.code,403)
                        caught.exception.close()
                    self.assertEqual(len(deliveries),count)
                    ui.pop('agent_id');registry.write_text(json.dumps([ui]))
                    expect(send).to_be_disabled(timeout=5000)
                    self.assertFalse(errors,errors)
                    browser.close()
            finally:
                runtime.stop(tool['id']);desk.shutdown();desk.server_close();thread.join()
