import base64
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest

from scripts.control_mailbox import Mailbox
from scripts.native_terminal_events import NativeDelivery
from agent_desk.terminals import TerminalManager


class GrokTests(unittest.TestCase):
    def test_delivery_gates_and_uncertain_write_are_durable(self):
        with tempfile.TemporaryDirectory() as tmp:
            box=Mailbox(Path(tmp)/'mail.sqlite3');desk='http://127.0.0.1:4328';controller='grok-test'
            box.register(desk,controller,'grok')
            relay=NativeDelivery(dict(db=str(box.path),desk=desk,controller=controller))
            try:
                task,_=box.create(desk,controller,'worker','Task')
                box.reply(desk,task['id'],'Done','completed')
                relay.snapshot=dict(state='idle',ready=True,revision=0)
                future=time.monotonic()+10;sent=[]
                for flag in ('paused','awaiting_activity'):
                    setattr(relay,flag,True);relay.tick(sent.append, future);setattr(relay,flag,False)
                relay.snapshot['revision']=-1;relay.tick(sent.append,future);relay.snapshot['revision']=0
                relay.snapshot['ready']=False;relay.tick(sent.append,future);relay.snapshot['ready']=True
                relay.output_after_input=False;relay.tick(sent.append,future);relay.output_after_input=True
                self.assertEqual(sent,[]);self.assertEqual(box.events(desk)[0]['delivery'],'queued')
                def broken(_):raise OSError('ambiguous write')
                relay.tick(broken,future)
                self.assertEqual(box.events(desk)[0]['delivery'],'uncertain')
                relay.tick(sent.append,future+10)
                self.assertEqual(sent,[]);self.assertFalse(box.get(desk,task['id'])['acknowledged'])
            finally:relay.close()

    def test_native_pty_keeps_ui_and_arguments_and_delivers_without_browser(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);box=Mailbox(root/'mail.sqlite3');desk='http://127.0.0.1:4328'
            fixture=root/'native.py';mode=root/'mode';mode.write_text('blocked')
            fixture.write_text('''import os,sys,tty,select,time,json
from pathlib import Path
root=Path(__file__).parent
(root/'argv.json').write_text(json.dumps(sys.argv[1:]))
tty.setraw(0)
def draw(mode):
 footer='1/3:select │ Ctrl+o:yolo │ Ctrl+c:cancel' if mode=='blocked' else 'Shift+Tab:mode │ Esc:cancel │ Ctrl+x:shortcuts' if mode=='working' else 'Shift+Tab:mode │ Ctrl+x:shortcuts'
 draft='My draft' if mode=='draft' else ''
 sys.stdout.write('\\x1b[2J\\x1b[?2004h\\x1b[?25h\\x1b[19;3H╭'+'─'*72+'╮\\x1b[20;3H│ ❯ '+draft.ljust(69)+'│\\x1b[21;3H╰'+'─'*35+' Grok 4.6 (high) ─╯\\x1b[23;3H'+footer+'\\x1b[20;7H');sys.stdout.flush()
previous=None;pending=b''
while True:
 mode=(root/'mode').read_text()
 if mode!=previous:draw(mode);previous=mode
 if select.select([0],[],[],.03)[0]:
  data=os.read(0,65536)
  if b'\\x04' in data:break
  pending+=data
  if b'\\r' in pending:
   with (root/'received').open('ab') as f:f.write(pending+b'\\n')
   pending=b'';draw('working');time.sleep(.3);draw('idle')
''')
            manager=TerminalManager()
            try:
                argv=[sys.executable,str(fixture),'--model','selected','--reasoning-effort','high','Initial task']
                session=manager.launch(dict(cwd=tmp,argv=argv,name='Native Grok'),coordinator=dict(harness='grok',desk=desk,db=str(box.path)))
                def wait(predicate,timeout=8):
                    end=time.monotonic()+timeout
                    while time.monotonic()<end:
                        if predicate():return
                        time.sleep(.04)
                    self.fail('Native session did not reach expected state: '+str(session.info()))
                wait(lambda:session.info()['status']=='needs_input')
                self.assertEqual(json.loads((root/'argv.json').read_text()),argv[2:])
                self.assertIn('Ctrl+o:yolo',base64.b64decode(session.output(0)['data']).decode())
                task,_=box.create(desk,session.id,'worker','Work');box.reply(desk,task['id'],'Result','completed')
                time.sleep(1.1);self.assertEqual(box.events(desk)[0]['delivery'],'queued')
                mode.write_text('draft');wait(lambda:box.coordinator(desk,session.id)['state']=='editing')
                time.sleep(1.1);self.assertFalse((root/'received').exists())
                mode.write_text('idle');wait(lambda:(root/'received').exists())
                received=(root/'received').read_bytes()
                self.assertTrue(received.startswith(b'\x1b[200~Agent Desk:'))
                self.assertIn(b'\x1b[201~\r',received)
                self.assertEqual(box.events(desk)[0]['delivery'],'sent')
                self.assertFalse(box.get(desk,task['id'])['acknowledged'])
                time.sleep(1.3);self.assertEqual((root/'received').read_bytes(),received)
                session.send(dict(op='input',data=base64.b64encode(b'\x03').decode()))
                wait(lambda:box.coordinator(desk,session.id)['state']=='delivery-paused')
                task2,_=box.create(desk,session.id,'worker2','Next');box.reply(desk,task2['id'],'Result','completed')
                time.sleep(1.1);self.assertEqual((root/'received').read_bytes(),received)
                session.send(dict(op='input',data=base64.b64encode(b'continue\r').decode()))
                wait(lambda:b'continue' in (root/'received').read_bytes())
                wait(lambda:box.get(desk,task2['id']) and any(t['id']==task2['id'] and t['delivery']=='sent' for t in box.events(desk)))
                session.send(dict(op='input',data=base64.b64encode(b'\x04').decode()))
                session.process.wait(5)
                self.assertEqual(session.process.returncode,0)
                self.assertEqual(box.coordinator(desk,session.id)['state'],'disconnected')
            finally:manager.close()
