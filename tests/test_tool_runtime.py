from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import socket
import tempfile
import unittest
from urllib.request import urlopen
from agent_desk.tool_runtime import ToolRuntime

SCRIPT='''import argparse
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
p=argparse.ArgumentParser();p.add_argument('target');p.add_argument('--port',type=int);p.add_argument('--no-browser',action='store_true');a=p.parse_args()
ThreadingHTTPServer(('127.0.0.1',a.port),SimpleHTTPRequestHandler).serve_forever()
'''

class RuntimeTests(unittest.TestCase):
    def test_a_tool_can_open_on_nothing(self):
        # The agent that builds a tool decides what it opens on, including nothing at all.
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);skill=root/'skills'/'dashboard';skill.mkdir(parents=True)
            (skill/'server.py').write_text(SCRIPT.replace("p.add_argument('target');",''))
            (skill/'agent-desk-ui.json').write_text(json.dumps({'runtime':'python-http','entrypoint':'server.py','title':'Dashboard','target':'none'}))
            runtime=ToolRuntime(root/'state',[root/'skills'])
            self.assertEqual([(t['id'],t['target'],t['args']) for t in runtime.catalog()],[('dashboard','none',['--port','{port}','--no-browser'])])
            item=runtime.launch('dashboard',None)
            try:
                self.assertEqual((item['title'],item['context']),('Dashboard',''))
                self.assertEqual(urlopen(item['url'],timeout=3).status,200)
                self.assertEqual(runtime.launch('dashboard','')['pid'],item['pid'],'launching again reuses the running tool')
            finally:runtime.stop(item['id'])

    def test_ports_duplicate_launch_and_owned_stop(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);skill=root/'skills'/'fixture';skill.mkdir(parents=True)
            (skill/'server.py').write_text(SCRIPT)
            (skill/'agent-desk-ui.json').write_text(json.dumps({'runtime':'python-http','entrypoint':'server.py','title':'Fixture','target':'file'}))
            target=root/'document.md';target.write_text('fixture')
            runtime=ToolRuntime(root/'state',[root/'skills']);instances=[]
            try:
                with ThreadPoolExecutor(max_workers=2) as pool:
                    instances=list(pool.map(lambda identity:runtime.launch('fixture',str(target),identity),['one','two']))
                self.assertNotEqual(instances[0]['url'],instances[1]['url'])
                for item in instances:self.assertEqual(urlopen(item['url'],timeout=3).status,200)
                again=runtime.launch('fixture',str(target),'one');self.assertEqual(again['pid'],instances[0]['pid'])
                with socket.socket() as occupied:
                    occupied.bind(('127.0.0.1',0))
                    with self.assertRaises(OSError):runtime.launch('fixture',str(target),'collision',port=occupied.getsockname()[1])
                self.assertEqual(runtime.status('one')['status'],'running')
                runtime.stop('one');self.assertEqual(runtime.status('one')['status'],'stopped')
                self.assertEqual(runtime.status('two')['status'],'running')
                with self.assertRaises(ValueError):runtime.stop('external')
                replacement=runtime.launch('fixture',str(target),'one');instances.append(replacement)
                self.assertNotEqual(replacement['instance'],instances[0]['instance'])
            finally:
                for identity in ('one','two'):
                    if runtime.read(identity):runtime.stop(identity)
