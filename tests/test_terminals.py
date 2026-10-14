import base64
import json
import tempfile
import sys
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch
import threading

from agent_desk import server
from agent_desk.terminals import TerminalManager, TerminalSession, _cpu_seconds
from types import SimpleNamespace
import io


class TerminalTests(unittest.TestCase):
    def setUp(self):
        self.manager = TerminalManager()
        self.temp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.manager.close()
        self.temp.cleanup()

    def test_followup_validates_prompt_before_reserving_and_sends_one_input(self):
        session=TerminalSession.__new__(TerminalSession)
        session.launch_profile='claude';session.argv=['claude'];session.cols=80;session.rows=24
        session.lock=threading.Lock();session.input_lock=threading.RLock();session.start=0
        session.buffer=bytearray(b'\x1b[?2004h'+ '❯ '.encode())
        session.process=SimpleNamespace(poll=lambda:None,stdin=io.BytesIO())
        reserved=[]
        session.send_task('Open the PR\nReport the URL',before_send=lambda:reserved.append(True))
        self.assertEqual(reserved,[True])
        events=session.process.stdin.getvalue().splitlines();self.assertEqual(len(events),1)
        data=base64.b64decode(json.loads(events[0])['data'])
        self.assertEqual(data,b'\x1b[200~Open the PR\nReport the URL\x1b[201~\r')
        session.buffer.extend(b'user draft')
        with self.assertRaisesRegex(ValueError,'draft'):
            session.send_task('Another task',before_send=lambda:reserved.append(True))
        self.assertEqual(reserved,[True])
        self.assertEqual(len(session.process.stdin.getvalue().splitlines()),1)

    def launch(self):
        return self.manager.launch(dict(cwd=self.temp.name, argv=['/bin/sh'], name='Test shell'))

    def wait_for(self, session, expected):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            data = base64.b64decode(session.output(0)['data']).decode(errors='replace')
            if expected in data:
                return data
            time.sleep(.03)
        self.fail(f'Missing {expected!r} in {data!r}')

    def send(self, session, text):
        session.send(dict(op='input', data=base64.b64encode(text.encode()).decode()))

    def test_real_pty_input_unicode_resize_interrupt_and_exit(self):
        session = self.launch()
        session.send(dict(op='resize', rows=31, cols=97))
        self.send(session, "stty size; printf '\\143af\\303\\251\\n'\n")
        self.wait_for(session, '31 97')
        self.wait_for(session, 'café')
        self.send(session, 'sleep 30\n')
        time.sleep(.15)
        self.send(session, '\x03')
        self.send(session, "printf 'interrupt-%s\\n' ok\n")
        self.wait_for(session, 'interrupt-ok')
        replay = session.output(0)
        self.assertEqual(session.output(replay['cursor'])['data'], '')
        self.send(session, 'exit 7\n')
        session.process.wait(timeout=5)
        self.assertEqual(session.info()['exit_code'], 7)
        self.assertEqual(session.info()['status'], 'error')

    def test_usage_reports_memory_and_cpu_for_the_whole_agent_tree(self):
        self.assertEqual([_cpu_seconds(v) for v in ('0:05.42','01:02:03','2-03:04:05','bogus')],[5.42,3723.0,183845.0,0.0])
        manager = TerminalManager()
        try:
            busy = manager.launch(dict(cwd='/tmp', name='Busy', argv=['/bin/sh','-c','python3 -c "\nwhile True: pass\n" & sleep 30']))
            idle = manager.launch(dict(cwd='/tmp', name='Idle', argv=['/bin/sh','-c','sleep 30']))
            ready = time.time() + 20
            while time.time() < ready and manager.usage().get(busy.id, {}).get('processes', 0) < 2:
                time.sleep(.2)
            # The first sample has no earlier one to compare against, so CPU is unknown, not zero.
            manager.reset_usage()
            first = manager.usage()
            self.assertIsNone(first[busy.id]['cpu_percent'])
            self.assertGreater(first[busy.id]['memory_kb'], 0)
            deadline, second = time.time() + 20, {}
            while time.time() < deadline:
                time.sleep(.5)
                second = manager.usage()
                if second.get(busy.id, {}).get('processes', 0) >= 2 and (second[busy.id]['cpu_percent'] or 0) > 20:
                    break
            self.assertGreater(second[busy.id]['cpu_percent'], 20, 'a spinning child should show CPU on its parent terminal')
            self.assertLess(second[idle.id]['cpu_percent'], 5)
            self.assertIn('memory_kb', [row for row in manager.list() if row['id'] == busy.id][0])
            manager.get(busy.id).stop(); manager.get(idle.id).stop()
            for _ in range(50):
                if not manager.usage():
                    break
                time.sleep(.1)
            self.assertEqual(manager.usage(), {}, 'stopped terminals still report usage')
        finally:
            manager.close()

    def test_parent_metadata_is_explicit_and_validated(self):
        parent=self.launch()
        child=self.manager.launch(dict(cwd=self.temp.name,argv=['/bin/sh'],name='Child',parent_id=parent.id))
        self.assertEqual(child.info()['parent_id'],parent.id)
        self.assertIsNone(parent.info()['parent_id'])
        with self.assertRaises(ValueError):
            self.manager.launch(dict(cwd=self.temp.name,argv=['/bin/sh'],name='Bad parent',parent_id='missing'))

    def test_launcher_no_color_does_not_disable_interactive_terminal(self):
        code = "import os; assert 'NO_COLOR' not in os.environ; assert os.environ['TERM'] == 'xterm-256color'; assert os.environ['COLORTERM'] == 'truecolor'; print('\\x1b[32mcolor-enabled\\x1b[0m')"
        with patch.dict('os.environ', {'NO_COLOR': '1', 'TERM': 'dumb'}):
            session = self.manager.launch(dict(cwd=self.temp.name, argv=[sys.executable, '-c', code], name='Color test'))
        data = self.wait_for(session, 'color-enabled')
        self.assertIn('\x1b[32mcolor-enabled\x1b[0m', data)
        session.process.wait(timeout=5)
        self.assertEqual(session.process.returncode, 0)

    def test_output_isolation_replay_and_stop(self):
        one, two = self.launch(), self.launch()
        self.send(one, "printf 'one-%s\\n' only\n")
        self.send(two, "printf 'two-%s\\n' only\n")
        self.wait_for(one, 'one-only')
        self.wait_for(two, 'two-only')
        self.assertNotIn('two-only', base64.b64decode(one.output(0)['data']).decode())
        one.stop()
        self.assertIsNotNone(one.process.poll())
        self.assertIsNone(two.process.poll())
        with self.assertRaises(ValueError):
            self.send(one, 'ignored')

    def test_working_and_idle_times_follow_output(self):
        # A pane reports time spent working, and idle time when nothing is going on.
        from agent_desk import terminals
        session = self.launch()
        self.send(session, "printf 'first\\n'\n")
        self.wait_for(session, 'first')
        info = session.info()
        self.assertIsNotNone(info['last_output']);self.assertLessEqual(info['active_since'], info['last_output'])
        started = info['active_since']
        # Output within the gap continues the same run of work.
        self.send(session, "printf 'second\\n'\n")
        self.wait_for(session, 'second')
        self.assertEqual(session.info()['active_since'], started)
        # After a quiet gap, the next output starts a new run.
        with patch.object(terminals, 'ACTIVE_GAP', 0):
            time.sleep(.05)
            self.send(session, "printf 'third\\n'\n")
            self.wait_for(session, 'third')
        later = session.info()
        self.assertGreater(later['active_since'], started);self.assertGreaterEqual(later['last_output'], later['active_since'])
        # A resize makes the app repaint; that repaint is not counted as work.
        session.resize(100, 30) if hasattr(session, 'resize') else session.send(terminals.resize_event(100, 30))
        before = session.info()['last_output']
        self.send(session, "printf 'repaint\\n'\n")
        self.wait_for(session, 'repaint')
        self.assertEqual(session.info()['last_output'], before, 'output right after a resize must not count as work')

    def test_launch_validation_and_bounded_replay(self):
        for payload in ({'cwd':'relative'}, {'argv':'sh'}, {'argv':['/definitely/missing']}, {'name':[]}, {'argv':['sh', '\0']}):
            with self.assertRaises(ValueError):
                self.manager.launch(payload)
        session = self.launch()
        self.send(session, "python3 -c 'import sys; sys.stdout.write(\"x\"*2200000)'\n")
        deadline = time.monotonic() + 5
        while session.start == 0 and time.monotonic() < deadline:
            time.sleep(.03)
        self.assertLessEqual(len(session.buffer), 2 * 1024 * 1024)
        self.assertTrue(session.output(0)['truncated'])

    def test_terminal_http_authentication_and_roundtrip(self):
        http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{http.server_port}'
        try:
            with patch.object(server, 'TERMINALS', server.DeskTerminals(self.manager)):
                payload = dict(cwd=self.temp.name, argv=['/bin/sh'], name='HTTP terminal')
                for headers in ({}, {'X-Agent-Desk-Terminal':server.TERMINAL_TOKEN, 'Origin':'https://evil.example'}):
                    with self.assertRaises(HTTPError) as caught:
                        urlopen(Request(base+'/api/terminals/launch',data=json.dumps(payload).encode(),headers=headers))
                    self.assertEqual(caught.exception.code, 403)
                    caught.exception.close()
                headers={'X-Agent-Desk-Terminal':server.TERMINAL_TOKEN}
                with urlopen(Request(base+'/api/terminals/launch',data=json.dumps(payload).encode(),headers=headers)) as response:
                    identity=json.load(response)['id']
                with self.assertRaises(HTTPError) as caught:
                    urlopen(base+'/api/terminals/output?id='+identity)
                self.assertEqual(caught.exception.code,403)
                caught.exception.close()
                for body in ({'id':identity,'rows':0,'cols':80},{'id':identity,'rows':24,'cols':True}):
                    with self.assertRaises(HTTPError) as caught:
                        urlopen(Request(base+'/api/terminals/resize',data=json.dumps(body).encode(),headers=headers))
                    self.assertEqual(caught.exception.code,400)
                    caught.exception.close()
                body={'id':identity,'data':base64.b64encode(b"printf 'http-%s\\n' ok\n").decode()}
                with urlopen(Request(base+'/api/terminals/input',data=json.dumps(body).encode(),headers=headers)) as response:
                    self.assertTrue(json.load(response)['ok'])
                self.wait_for(self.manager.get(identity),'http-ok')
                with urlopen(Request(base+'/api/terminals/output?id='+identity,headers=headers)) as response:
                    self.assertIn(b'http-ok',base64.b64decode(json.load(response)['data']))
        finally:
            http.shutdown()
            http.server_close()
            thread.join()
