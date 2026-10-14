import tempfile
import uuid
from scripts.worker_report import report
import unittest
from pathlib import Path
from test_coordinator_runtime import FakeTerminals
from agent_desk.coordinator_runtime import CoordinatorRuntime
from agent_desk.worker_screen import WorkerNotReady
from scripts.control_mailbox import Mailbox


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();root=Path(self.temp.name)
        self.box=Mailbox(root/'mail.db');self.terminals=FakeTerminals()
        self.runtime=CoordinatorRuntime(root/'coord.db',self.terminals,self.box,lambda *args:{'message':'','actions':[]})
        self.c=self.runtime.create({'cwd':str(root),'profile':'claude'})
        self.runtime.action(self.c,dict(kind='launch',name='Worker',profile='claude',task='Inspect changes'),'launch')
        self.worker=next(iter(self.terminals.sessions.values()));self.task=self.box.inbox(self.runtime.desk,self.c['id'])[0]
        self.send=self.worker.send_task
        self.worker.send_task=lambda *args,**kw:(_ for _ in ()).throw(WorkerNotReady('busy'))
    def tearDown(self):self.runtime.close();self.temp.cleanup()
    def action(self,kind='nudge'):return dict(kind=kind,worker_id=self.worker.id,task='Report progress')
    def drain(self):self.runtime.delivery_check_at=0;self.runtime.drain_deliveries()
    def state(self):return next(a for a in self.runtime.snapshot(self.c['id'])['actions'] if a['id']=='queued')['state']
    def test_busy_nudge_delivers_once_without_new_model_turn_or_task(self):
        self.assertEqual(self.runtime.action(self.c,self.action(),'queued'),'queued')
        for _ in range(3):self.drain()
        self.assertEqual(self.state(),'queued');self.assertEqual(self.worker.followups,[])
        self.worker.send_task=self.send;self.drain();self.drain()
        self.assertEqual(self.state(),'done');self.assertEqual(len(self.worker.followups),1)
        self.assertIn(self.task['id'],self.worker.followups[0])
        with self.runtime.db() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM turns').fetchone()[0],0)
        self.assertEqual(len(self.box.inbox(self.runtime.desk,self.c['id'],True)),1)
    def test_late_final_report_cancels_stale_nudge(self):
        self.runtime.action(self.c,self.action(),'queued')
        self.box.reply(self.runtime.desk,self.task['id'],'Done','completed')
        self.worker.send_task=self.send;self.drain()
        self.assertEqual(self.state(),'cancelled');self.assertEqual(self.worker.followups,[])
    def test_pause_and_cancel_preserve_worker_input(self):
        self.runtime.action(self.c,self.action(),'queued');self.runtime.pause(self.c['id'])
        self.worker.send_task=self.send;self.drain();self.assertEqual(self.state(),'queued')
        self.runtime.cancel_delivery({'id':self.c['id'],'action_id':'queued'})
        self.assertEqual(self.state(),'cancelled');self.assertEqual(self.worker.followups,[])
    def test_uncertain_write_is_never_retried(self):
        self.runtime.action(self.c,self.action(),'queued')
        def broken(text,before_send):before_send();raise OSError('write uncertain')
        self.worker.send_task=broken;self.drain();self.drain()
        self.assertEqual(self.state(),'uncertain');self.assertEqual(self.box.get(self.runtime.desk,self.task['id'])['status'],'nudge_uncertain')
    def test_send_waits_for_final_report_then_uses_new_task(self):
        self.runtime.action(self.c,self.action('send'),'queued');self.worker.send_task=self.send;self.drain()
        self.assertEqual(self.state(),'queued');self.assertEqual(self.worker.followups,[])
        self.box.reply(self.runtime.desk,self.task['id'],'Done','completed');self.drain();self.drain()
        self.assertEqual(len(self.worker.followups),1);self.assertEqual(len(self.box.inbox(self.runtime.desk,self.c['id'],True)),2)
    def test_queue_survives_runtime_recreation_and_no_duplicate_queue(self):
        self.runtime.action(self.c,self.action(),'queued')
        with self.assertRaisesRegex(ValueError,'already queued'):self.runtime.action(self.c,self.action(),'duplicate')
        replacement=CoordinatorRuntime(self.runtime.path,self.terminals,self.box,lambda *args:None)
        try:
            self.worker.send_task=self.send;replacement.drain_deliveries()
            self.assertEqual(self.state(),'done');self.assertEqual(len(self.worker.followups),1)
        finally:replacement.close()

    def save_worker(self,worker,task):
        report(self.box,self.runtime.desk,task['id'],{'hook_event_name':'Stop','session_id':str(uuid.uuid4()),'last_assistant_message':'Done'},'claude')
        if task['result'] is None:self.box.reply(self.runtime.desk,task['id'],'Done','completed')
        self.runtime.retire_worker(dict(id=self.c['id'],worker_id=worker.id,task_id=task['id'],confirmed=True))

    def test_queued_send_resumes_saved_conversation_and_delivers_once(self):
        self.runtime.action(self.c,self.action('send'),'queued')
        self.save_worker(self.worker,self.task)
        self.drain();self.drain()
        latest=self.terminals.get(self.runtime.canonical_worker_id(self.c['id'],self.worker.id))
        self.assertNotEqual(latest.id,self.worker.id)
        self.assertEqual(self.state(),'done');self.assertEqual(len(latest.followups),1)
        self.assertEqual(len(self.terminals.launched),2)
        self.assertIn('--resume',latest.argv)
        self.assertEqual(len(self.box.inbox(self.runtime.desk,self.c['id'],True)),2)

    def test_old_id_follows_multiple_resumes_and_rejects_foreign_owner(self):
        self.save_worker(self.worker,self.task)
        self.runtime.action(self.c,self.action('send'),'second-task')
        second=self.terminals.get(self.runtime.canonical_worker_id(self.c['id'],self.worker.id))
        task=next(t for t in self.box.inbox(self.runtime.desk,self.c['id'],True) if t['result'] is None)
        self.save_worker(second,task)
        self.runtime.action(self.c,self.action('send'),'third-task')
        third=self.terminals.get(self.runtime.canonical_worker_id(self.c['id'],self.worker.id))
        self.assertNotEqual(second.id,third.id);self.assertEqual(len(third.followups),1)
        self.runtime.action(self.c,dict(kind='read',worker_id=self.worker.id),'read-old')
        self.assertEqual(len(self.terminals.launched),3)
        other=self.runtime.create(dict(cwd=self.c['cwd'],profile='claude'))
        with self.assertRaisesRegex(ValueError,'another coordinator'):
            self.runtime.delivery_worker(other['id'],self.worker.id)
        with self.runtime.db() as db:
            db.execute('UPDATE saved_workers SET resumed_worker=? WHERE worker=?',(self.worker.id,second.id))
        with self.assertRaisesRegex(ValueError,'cycle'):
            self.runtime.canonical_worker_id(self.c['id'],self.worker.id)

    def test_alias_cannot_queue_duplicate_followup(self):
        self.save_worker(self.worker,self.task)
        resumed=self.runtime.resume_worker(dict(id=self.c['id'],worker_id=self.worker.id))['worker_id']
        latest=self.terminals.get(resumed)
        latest.send_task=lambda *a,**kw:(_ for _ in ()).throw(WorkerNotReady('busy'))
        self.runtime.action(self.c,self.action('send'),'queued')
        with self.assertRaisesRegex(ValueError,'already queued'):
            self.runtime.action(self.c,dict(kind='send',worker_id=resumed,task='duplicate'),'duplicate')

    def test_intentional_close_cancels_queue_and_does_not_report_failure(self):
        self.runtime.action(self.c,self.action('send'),'queued')
        result=self.runtime.stop_worker(dict(id=self.c['id'],worker_id=self.worker.id,confirmed=True))
        self.assertTrue(result['stopped']);self.assertFalse(result['can_resume'])
        self.assertEqual(self.state(),'cancelled')
        self.assertEqual(self.box.get(self.runtime.desk,self.task['id'])['status'],'cancelled')
        self.assertIsNone(self.box.get(self.runtime.desk,self.task['id'])['result'])
        self.runtime.ingest();self.drain()
        self.assertEqual(len(self.terminals.launched),1)
        self.assertFalse(any('ended without reporting' in m['text'] for m in self.runtime.snapshot(self.c['id'])['messages']))
        self.assertIn(self.worker.id,self.runtime.hidden_workers())
        self.runtime.stop_worker(dict(id=self.c['id'],worker_id=self.worker.id,confirmed=True))

    def test_unexpected_exit_still_reports_missing_result(self):
        self.worker.stop();self.runtime.ingest()
        self.assertTrue(any('ended without reporting' in m['text'] for m in self.runtime.snapshot(self.c['id'])['messages']))

    def test_close_preserves_native_session_and_cancelled_work_is_not_replayed(self):
        report(self.box,self.runtime.desk,self.task['id'],{'hook_event_name':'Stop','session_id':str(uuid.uuid4()),'last_assistant_message':'Interim'},'claude')
        self.runtime.action(self.c,dict(kind='close_worker',worker_id=self.worker.id),'close')
        self.runtime.action(self.c,dict(kind='resume',worker_id=self.worker.id),'resume')
        latest=self.terminals.launched[-1]
        self.assertIn('--resume',latest['argv']);self.assertNotIn('Agent Desk is resuming this existing conversation',' '.join(latest['argv']))
        self.runtime.action(self.c,self.action('send'),'new-work')
        self.assertEqual(len(self.terminals.sessions[ self.runtime.canonical_worker_id(self.c['id'],self.worker.id)].followups),1)
