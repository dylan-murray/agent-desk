import tempfile
import unittest
from pathlib import Path
from agent_desk.coordinator_runtime import CoordinatorRuntime
from scripts.control_mailbox import Mailbox
from test_coordinator_runtime import FakeTerminals


class HookTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.box=Mailbox(self.root/'mail.db');self.terminals=FakeTerminals()
        self.runtime=CoordinatorRuntime(self.root/'coord.db',self.terminals,self.box,lambda *a: {'message':'Ready','actions':[]})
        self.c=self.create()

    def create(self):return self.runtime.create({'cwd':str(self.root),'name':'Hooks','profile':'claude'})
    def tearDown(self):self.runtime.close();self.tmp.cleanup()
    def save(self,**kw):return self.runtime.save_hook({'id':self.c['id'],'event':'worker_report','instruction':'When a worker finishes code, review its diff.','enabled':True,**kw})
    def runs(self,c=None):return self.runtime.hooks({'id':(c or self.c)['id']})['runs']

    def test_defaults_apply_live_to_existing_sessions_and_disable_globally(self):
        result=self.save(defaults=True,event='user_message');hook=result['hooks'][0]
        self.assertEqual(len(self.runtime.hook_policies(self.c['id'])),1)
        self.runtime.message({'id':self.c['id'],'text':'Test','request_id':'global'})
        self.assertEqual(len(self.runs()),1)
        other=self.create()
        self.assertEqual(self.runtime.hooks({'id':other['id']})['hooks'],[])
        self.assertEqual(len(self.runtime.hook_policies(other['id'])),1)
        self.save(defaults=True,hook_id=hook['id'],event='user_message',enabled=False)
        self.assertEqual(self.runtime.hook_policies(other['id']),[])
        self.assertEqual(self.runtime.hook_policies(self.c['id']),[])
        self.runtime.message({'id':self.c['id'],'text':'Again','request_id':'disabled'})
        self.assertEqual(len(self.runs()),1)
        self.save(defaults=True,hook_id=hook['id'],delete=True)
        self.assertEqual(self.runtime.hook_policies(self.c['id']),[])

    def test_legacy_default_snapshot_is_not_double_fired(self):
        result=self.save(defaults=True);hook=result['hooks'][0]
        with self.runtime.db() as db:
            db.execute('DROP TABLE inherited_hook_snapshots')
            db.execute('INSERT INTO coordinator_hooks VALUES(?,?,?,?,?,?)',('legacy-copy',self.c['id'],hook['event'],hook['instruction'],1,''))
        self.runtime.init_hooks()
        self.assertEqual([h['id'] for h in self.runtime.hook_policies(self.c['id'])],[hook['id']])
        self.save(defaults=True,hook_id=hook['id'],delete=True)
        self.assertEqual(self.runtime.hook_policies(self.c['id']),[])

    def test_report_dedup_pause_and_task_context(self):
        self.save();self.runtime.pause(self.c['id'])
        self.box.create(self.runtime.desk,self.c['id'],'fixture','Review PR 459','task-hooks')
        self.box.reply(self.runtime.desk,'task-hooks','Verified final diff','completed')
        self.runtime.ingest();self.runtime.ingest()
        self.assertEqual(len(self.runs()),1)
        self.assertTrue(self.runtime.get(self.c['id'])['paused'])
        messages=self.runtime.snapshot(self.c['id'])['messages']
        self.assertEqual(sum(m['kind']=='worker' for m in messages),1)
        self.assertTrue(any('Review PR 459' in m['text'] for m in messages))
        with self.runtime.db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM turns WHERE state='pending'").fetchone()[0],2)
        self.runtime.step();self.assertFalse(self.runtime.running)

    def test_disable_delete_and_scope_checks(self):
        result=self.save(event='user_message');hook=result['hooks'][0]
        self.runtime.message({'id':self.c['id'],'text':'First','request_id':'1'})
        self.runtime.message({'id':self.c['id'],'text':'First','request_id':'1'})
        self.assertEqual(len(self.runs()),1)
        self.save(hook_id=hook['id'],event='user_message',enabled=False)
        self.runtime.message({'id':self.c['id'],'text':'Second','request_id':'2'})
        self.assertEqual(len(self.runs()),1)
        with self.assertRaises(ValueError):self.save(id=self.create()['id'],hook_id=hook['id'])
        self.save(hook_id=hook['id'],delete=True)
        self.assertEqual(self.runtime.hooks({'id':self.c['id']})['hooks'],[])
        with self.assertRaises(ValueError):self.save(event='made_up')
        with self.assertRaises(ValueError):self.save(instruction='')

    def test_reopen_only_fires_on_closed_transition(self):
        self.save(event='resumed');self.runtime.reopen(self.c['id']);self.assertEqual(self.runs(),[])
        self.runtime.close_conversation(self.c['id']);self.runtime.reopen(self.c['id']);self.runtime.reopen(self.c['id'])
        self.assertEqual(len(self.runs()),1)
        self.assertTrue(self.runtime.get(self.c['id'])['paused'])

    def test_active_hooks_only_in_triggering_turn(self):
        self.save(event='user_message')
        self.runtime.message({'id':self.c['id'],'text':'Inspect code','request_id':'once'})
        with self.runtime.db() as db:
            db.execute("UPDATE turns SET state='running' WHERE id LIKE '%:hook:%'")
        active=self.runtime.active_hooks(self.c['id'])
        self.assertEqual(len(active),1)
        self.assertEqual(active[0]['event'],'user_message')
        self.assertEqual(active[0]['source_excerpt'],'Inspect code')
        with self.runtime.db() as db:db.execute("UPDATE turns SET state='done'")
        self.assertEqual(self.runtime.active_hooks(self.c['id']),[])
        self.assertEqual(len(self.runs()),1)
