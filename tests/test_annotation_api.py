"""Authenticated route checks. Run with an isolated AGENT_DESK_DATA_DIR."""
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from unittest.mock import patch


class AnnotationAPITests(unittest.TestCase):
    def test_skill_and_conversation_routes_are_reachable_and_authenticated(self):
        from agent_desk import server
        with tempfile.TemporaryDirectory() as directory:
            http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
            thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
            def post(path,payload,auth=True):
                headers={'Content-Type':'application/json'}
                if auth:headers['X-Agent-Desk-Terminal']=server.TERMINAL_TOKEN
                with urlopen(Request(f'http://127.0.0.1:{http.server_port}'+path,data=json.dumps(payload).encode(),headers=headers)) as response:return json.load(response)
            try:
                with patch.object(server.skill_harnesses,'_home',return_value=Path(directory)):
                    payload=dict(name='api-fixture',purpose='Review APIs',trigger='reviewing changes',steps='Compare response schemas.')
                    for route in ('preview','create','add'):
                        with self.assertRaises(HTTPError) as caught:post('/api/skills/'+route,payload,False)
                        self.assertEqual(caught.exception.code,403);caught.exception.close()
                    preview=post('/api/skills/preview',payload)
                    result=post('/api/skills/create',payload)
                    self.assertEqual(Path(result['created']).read_text(),preview['content'])
                    added=post('/api/skills/add',{'path':str(Path(result['created']).parent)})
                    self.assertIn('skills',added)
                with patch.object(server.CONVERSATIONS,'catalog',return_value={'conversations':[]}):
                    self.assertEqual(post('/api/conversations/list',{}),{'conversations':[]})
                self.assertIn('ssh',post('/api/remote/prerequisites',{})['tools'])
                with patch.object(server,'TERMINALS') as terminals:
                    terminals.launch.return_value.info.return_value={'id':'fixture'}
                    post('/api/terminals/launch',{'argv':['claude'],'cwd':directory})
                    wrapped=terminals.launch.call_args.args[0]
                    self.assertEqual(wrapped['argv'],['claude','--agent-desk-shell-on-exit'])
                    self.assertEqual(wrapped['launch_profile'],'claude')
                    payload={'argv':['claude','fixture goal'],'cwd':directory,'coordinator_harness':'claude'}
                    post('/api/terminals/launch',payload)
                    self.assertEqual(terminals.launch.call_args.args[0],payload)
                    self.assertEqual(terminals.launch.call_args.kwargs['coordinator']['harness'],'claude')
            finally:http.shutdown();http.server_close();thread.join(2)
