import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.control_mailbox import Mailbox
from scripts.agent_control import DeskClient


class MailboxTests(unittest.TestCase):
    def test_reply_wakes_waiter_and_survives_until_ack(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'mailbox.sqlite3';box=Mailbox(path)
            task,_=box.create('desk','controller','worker','do task')
            result=[]
            waiter=threading.Thread(target=lambda:result.append(Mailbox(path).wait('desk','controller',3)))
            waiter.start();time.sleep(.1)
            box.reply('desk',task['id'],'Done; tests passed.','completed');waiter.join(4)
            self.assertFalse(waiter.is_alive());self.assertEqual(result[0]['replies'][0]['result'],'Done; tests passed.')
            self.assertEqual(len(Mailbox(path).inbox('desk','controller')),1)
            box.reply('desk',task['id'],'Done; tests passed.','completed')
            with self.assertRaises(ValueError):box.reply('desk',task['id'],'Overwrite','completed')
            with self.assertRaises(ValueError):box.ack('desk',task['id'],'another controller')
            box.ack('desk',task['id'],'controller');self.assertEqual(box.inbox('desk','controller'),[])
            self.assertEqual(box.inbox('other desk','controller'),[])

    def test_dispatch_callback_idempotency_and_ambiguous_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            box=Mailbox(Path(tmp)/'db');client=DeskClient('http://127.0.0.1:4310')
            with patch.object(client,'terminal',return_value={'exit_code':None}),patch.object(client,'send') as send:
                first=client.dispatch('worker','controller','Run tests','task-one',box)
                self.assertIn('reply task-one --file',send.call_args.args[1]);self.assertEqual(first['task']['status'],'waiting')
                client.dispatch('worker','controller','Run tests','task-one',box);self.assertEqual(send.call_count,1)
                with self.assertRaises(ValueError):client.dispatch('worker','controller','Different','task-one',box)
                send.side_effect=OSError('connection lost')
                with self.assertRaises(ValueError):client.dispatch('worker','controller','Other task','task-two',box)
                self.assertEqual(box.get(client.desk,'task-two')['status'],'send_uncertain')
                self.assertTrue(box.wait(client.desk,'controller',0)['timed_out'])
                with self.assertRaises(ValueError):client.dispatch('controller','controller','Self',mailbox=box)
