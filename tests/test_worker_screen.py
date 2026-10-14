import base64
import io
import threading
import time
import unittest
from types import SimpleNamespace
from agent_desk.worker_screen import WorkerScreen, WorkerNotReady
from agent_desk.terminals import TerminalSession


class ScreenTests(unittest.TestCase):
    def setUp(self):self.screen=WorkerScreen('claude')
    def tearDown(self):self.screen.close()
    def output(self,data):self.screen.observe('output',data=base64.b64encode(data).decode())
    def wait(self):
        until=time.monotonic()+12
        while time.monotonic()<until:
            if self.screen.snapshot.get('revision')==self.screen.revision:return
            if self.screen.failed:self.fail('Screen tracker failed')
            time.sleep(.02)
        self.fail('Screen tracker never caught up')
    def test_live_screen_survives_replay_eviction_and_resize(self):
        self.output(b'\r'*(2*1024*1024+1));self.wait()
        self.screen.observe('resize',cols=100,rows=30)
        self.output(b'\x1b[2J\x1b[H\x1b[?2004h'+ '❯ '.encode());self.wait();time.sleep(.3)
        session=TerminalSession.__new__(TerminalSession);session.screen=self.screen;session.launch_profile='claude';session.argv=['claude']
        session.cols=100;session.rows=30;session.start=2*1024*1024;session.buffer=bytearray(b'truncated history')
        session.lock=threading.RLock();session.input_lock=threading.RLock();session.process=SimpleNamespace(poll=lambda:None,stdin=io.BytesIO())
        reserved=[];session.send_task('Follow up',lambda:reserved.append(True))
        self.assertEqual(reserved,[True]);self.assertEqual(len(session.process.stdin.getvalue().splitlines()),1)
        with self.assertRaises(WorkerNotReady):session.send_task('Duplicate',lambda:reserved.append(True))
        self.assertEqual(reserved,[True])
    def test_draft_hidden_cursor_and_sync_are_not_ready(self):
        for data in [b'\x1b[?2004h'+ '❯ draft'.encode(),b'\x1b[2J\x1b[H\x1b[?25l'+ '❯ '.encode(),b'\x1b[?25h\x1b[?2026h']:
            self.output(data);self.wait();time.sleep(.3)
            with self.assertRaises(WorkerNotReady):self.screen.check()
    def test_observer_failure_does_not_enable_delivery(self):
        self.screen.process.terminate();self.screen.process.wait(timeout=3)
        deadline=time.monotonic()+3
        while not self.screen.failed and time.monotonic()<deadline:time.sleep(.01)
        with self.assertRaisesRegex(ValueError,'unavailable'):self.screen.check()

    WORKING=b'\x1b[2J\x1b[H\x1b[?2004h'+'✻ Thinking… (esc to interrupt)\r\n\r\n❯ '.encode()
    IDLE=b'\x1b[2J\x1b[H\x1b[?2004h'+'Done.\r\n\r\n❯ '.encode()
    def show(self,data):self.output(data);self.wait()
    def test_turn_ends_once_the_idle_prompt_holds_after_work(self):
        self.show(self.IDLE);time.sleep(1.7)
        self.assertIsNone(self.screen.turn_ended(),'a prompt that was never busy has not finished anything')
        self.show(self.WORKING);self.assertEqual(self.screen.snapshot['state'],'working')
        before=time.time();self.show(self.IDLE)
        self.assertIsNone(self.screen.turn_ended(),'an idle frame must hold before it counts')
        time.sleep(1.7)
        ended=self.screen.turn_ended()
        self.assertIsNotNone(ended);self.assertGreaterEqual(ended,before-.5)
        time.sleep(.2);self.assertEqual(self.screen.turn_ended(),ended,'one turn ends once')
    def test_claude_title_spinner_is_working_even_with_an_empty_composer(self):
        # Current Claude draws its prompt as ❯ and a no-break space.
        prompt=b'\x1b[2J\x1b[H\x1b[?2004h'+'⏺ pineapple\r\n\r\n❯\u00a0'.encode()
        self.show(b'\x1b]0;\xe2\x97\x90 Pineapple\x07'+prompt);self.assertEqual(self.screen.snapshot['state'],'working')
        self.show(b'\x1b]0;\xe2\x9c\xb3 Pineapple\x07'+prompt);self.assertEqual(self.screen.snapshot['state'],'idle')
        time.sleep(1.7);self.assertIsNotNone(self.screen.turn_ended())
    def test_idle_flicker_between_tool_calls_is_not_a_turn_end(self):
        self.show(self.WORKING);self.show(self.IDLE);time.sleep(.4);self.show(self.WORKING);time.sleep(1.7)
        self.assertIsNone(self.screen.turn_ended())
    def test_clearing_a_draft_is_not_a_turn_end(self):
        self.show(b'\x1b[2J\x1b[H\x1b[?2004h'+'❯ draft'.encode());self.show(self.IDLE);time.sleep(1.7)
        self.assertIsNone(self.screen.turn_ended())
    def test_grok_busy_prompt_becomes_deliverable(self):
        self.screen.close();self.screen=WorkerScreen('grok')
        def screen(footer):
            return ('\x1b[2J\x1b[?2004h\x1b[17;3HWorked for 2s\x1b[19;3H╭'+'─'*72+'╮\x1b[20;3H│ ❯ '+' '*69+'│\x1b[21;3H╰'+'─'*35+' Grok 4.6 (high) ─╯\x1b[23;3H'+footer+'\x1b[20;7H').encode()
        self.output(screen('Shift+Tab:mode │ Esc:cancel │ Ctrl+x:shortcuts'));self.wait();time.sleep(.3)
        with self.assertRaises(WorkerNotReady):self.screen.check()
        self.output(screen('Shift+Tab:mode │ Ctrl+x:shortcuts'));self.wait();time.sleep(.3)
        self.screen.check()
