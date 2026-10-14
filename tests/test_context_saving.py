from pathlib import Path
import tempfile
import threading
import time
import unittest

from agent_desk.coordinator_runtime import CoordinatorRuntime
from agent_desk.coordinator_efficiency import PlanningReply, encoded_size
from scripts.control_mailbox import Mailbox
from tests.test_coordinator_runtime import FakeTerminals
from account_fixtures import use_accounts


def setUpModule():
    use_accounts()


class ContextSavingTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.box=Mailbox(self.root/'mail.sqlite3');self.terminals=FakeTerminals()
        self.runtime=CoordinatorRuntime(self.root/'desk.sqlite3',self.terminals,self.box,lambda *args:dict(message='Ready',actions=[]))
        self.c=self.runtime.create(dict(cwd=str(self.root),name='Test',profile='claude'))
    def tearDown(self):self.runtime.close();self.tmp.cleanup()
    def message(self,text,kind='user'):
        with self.runtime.db() as db:
            self.runtime.append(db,self.c['id'],kind,text)
            return db.execute('SELECT MAX(id) FROM messages').fetchone()[0]

    def test_history_retrieval_and_artifacts_are_lossless_and_scoped(self):
        old=self.message('Never merge without approval. UNIQUE-old-decision')
        for i in range(310):self.message('old message '+str(i),'assistant')
        matches=self.runtime.retrieve(self.c['id'],query='UNIQUE-old-decision')['matches']
        self.assertEqual(matches[0]['reference'],'message:'+str(old))
        body='report output\n'*3000
        ref=self.runtime.artifact(self.c['id'],'Large test report',body)
        self.assertEqual(ref,self.runtime.artifact(self.c['id'],'Same content',body))
        chunks=[];offset=0
        while True:
            result=self.runtime.retrieve(self.c['id'],ref,offset=offset);chunks.append(result['text'])
            if result['next_offset'] is None:break
            offset=result['next_offset']
        self.assertEqual(''.join(chunks),body)
        other=self.runtime.create(dict(cwd=str(self.root),name='Other',profile='claude'))
        for source in (ref,'message:'+str(old),'artifact:../../secret'):
            with self.assertRaises(ValueError):self.runtime.retrieve(other['id'],source)
        file=next((self.root/'coordinator-artifacts').glob('*.txt'))
        self.assertEqual(file.stat().st_mode&0o777,0o600)

    def test_memory_source_validation_and_user_pins(self):
        source=self.message('Keep all changes local')
        payload={'id':self.c['id'],'name':'Publishing','text':'Do not push','source':'message:'+str(source)}
        self.runtime.save_memory(payload,from_model=True)
        self.assertEqual(self.runtime.memory_notes(self.c['id'])[0]['source'],payload['source'])
        self.runtime.save_memory({**payload,'text':'Ask me before any push'})
        with self.assertRaisesRegex(ValueError,'User-pinned'):self.runtime.save_memory(payload,from_model=True)
        with self.assertRaises(ValueError):self.runtime.save_memory({**payload,'name':'Forged','source':'message:999999'},from_model=True)
        self.assertEqual(self.runtime.context(self.c)['memory'][0]['text'],'Ask me before any push')

    def test_compact_context_reduces_repeated_reports_and_keeps_latest_user(self):
        self.message('Original goal: fix the renderer')
        self.message('Do not restart the server')
        report='Complete output and diagnostics. '*3000
        for i in range(40):self.message(report,'worker')
        ctx=self.runtime.context(self.c)
        self.assertIn('Do not restart the server',[m['text'] for m in ctx['conversation']])
        self.assertLess(encoded_size(ctx),30000)
        self.assertGreater(len(self.runtime.snapshot(self.c['id'])['messages'][-1]['text']),80000)
        self.assertIn('artifact:',ctx['conversation'][-1]['text'])
        with self.runtime.db() as db:before=db.execute('SELECT COUNT(*) FROM context_artifacts').fetchone()[0]
        self.runtime.context(self.c)
        with self.runtime.db() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM context_artifacts').fetchone()[0],before)

    def test_retrieved_page_reaches_next_planning_turn_without_retruncation(self):
        self.message('Read exact report')
        ref=self.runtime.artifact(self.c['id'],'Output','x'*5500+'THE-END')
        self.runtime.action(self.c,dict(kind='recall',worker_id=ref,name='',task=''),'read-ref')
        ctx=self.runtime.context(self.c)
        self.assertIn('THE-END',ctx['conversation'][-1]['text'])

    def enable_reader(self,model='small-test'):
        self.runtime.configure_reader({'id':self.c['id'],'enabled':True,'profile':'claude-personal','model':model})
        self.calls=[]
        def read(c,ctx,cancel):
            self.calls.append(ctx)
            reply=PlanningReply(message='app.py: value is defined.',actions=[])
            reply.usage={'reported':True,'input_tokens':100,'output_tokens':10}
            return reply
        self.runtime.reader_planner=read

    def test_reader_cache_invalidates_content_question_and_model_and_counts_usage(self):
        self.enable_reader();file=self.root/'app.py';file.write_text('value = 1\n')
        run=lambda question,key:self.runtime.analyze_files(self.c,question,['app.py'],key,threading.Event())
        self.assertFalse(run('What is defined?','one')['cached'])
        self.assertTrue(run('What is defined?','two')['cached']);self.assertEqual(len(self.calls),1)
        file.write_text('value = 2\n');self.assertFalse(run('What is defined?','three')['cached'])
        self.assertFalse(run('Explain value','four')['cached'])
        self.runtime.configure_reader({'id':self.c['id'],'enabled':True,'profile':'claude-personal','model':'another-test'})
        self.assertFalse(run('What is defined?','five')['cached'])
        self.assertEqual(len(self.calls),4)
        self.assertEqual(self.runtime.usage_summary(self.c['id'])['totals']['input_tokens'],400)
        self.assertEqual(self.runtime.context_state(self.c['id'])['cache_hits'],1)

    def test_reader_disabled_and_escaping_paths_are_rejected(self):
        with self.assertRaisesRegex(ValueError,'Enable'):self.runtime.analyze_files(self.c,'Q',['a.py'],'one',threading.Event())
        self.enable_reader()
        (self.root/'outside.py').symlink_to('/etc/hosts')
        for path in ('../outside.py','outside.py','.env','secret.key'):
            with self.assertRaises(ValueError):self.runtime.analyze_files(self.c,'Q',[path],path,threading.Event())
        self.assertEqual(self.calls,[])

    def test_reader_cannot_execute_returned_actions(self):
        self.enable_reader();(self.root/'a.py').write_text('x=1')
        self.runtime.reader_planner=lambda *args:dict(message='Do it',actions=[{'kind':'launch'}])
        with self.assertRaisesRegex(ValueError,'actions'):self.runtime.analyze_files(self.c,'Q',['a.py'],'bad',threading.Event())
        self.assertEqual(self.terminals.launched,[])

    def test_pr_monitor_only_wakes_on_changes_and_does_not_complete_worker(self):
        self.runtime.action(self.c,dict(kind='launch',name='Existing watcher',profile='claude',task='Watch'),'launch')
        task=self.box.inbox(self.runtime.desk,self.c['id'])[0]
        self.runtime.watch_pr({'id':self.c['id'],'url':'https://github.com/example/repo/pull/12'})
        self.assertTrue(self.runtime.watch_pr({'id':self.c['id'],'url':'https://github.com/example/repo/pull/12'})['reused'])
        data={'state':'OPEN','headRefOid':'abc','comments':[],'reviews':[],'inlineComments':[],'statusCheckRollup':[]}
        self.runtime.fetch_pr=lambda *args:data.copy();now=time.time()
        self.runtime.poll_watches(now);self.runtime.poll_watches(now+181)
        def events():
            with self.runtime.db() as db:return db.execute('SELECT COUNT(*) FROM turns').fetchone()[0]
        self.assertEqual(events(),0)
        data['comments']=[{'id':'c1','body':'Please fix','updatedAt':'today'}]
        self.runtime.poll_watches(now+362);self.assertEqual(events(),1)
        self.runtime.poll_watches(now+543);self.assertEqual(events(),1)
        data['state']='MERGED';self.runtime.poll_watches(now+724);self.assertEqual(events(),2)
        self.runtime.poll_watches(now+1000);self.assertEqual(events(),2)
        self.assertEqual(self.runtime.watches(self.c['id'])[0]['state'],'merged')
        self.assertIsNone(self.box.get(self.runtime.desk,task['id'])['result'])

    def test_pr_monitor_errors_back_off_and_idle_monitor_stops(self):
        self.runtime.watch_pr({'id':self.c['id'],'url':'https://github.com/example/repo/pull/12'})
        self.runtime.fetch_pr=lambda *args:(_ for _ in ()).throw(ValueError('Login failure'))
        now=time.time();self.runtime.poll_watches(now);self.runtime.poll_watches(now+361)
        with self.runtime.db() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM turns').fetchone()[0],1)
        self.assertEqual(self.runtime.watches(self.c['id'])[0]['failures'],2)
        self.runtime.fetch_pr=lambda *args:{'state':'OPEN','headRefOid':'abc'}
        self.runtime.poll_watches(now+1200);self.runtime.poll_watches(now+8500)
        self.assertEqual(self.runtime.watches(self.c['id'])[0]['state'],'idle')

    def test_stopped_monitor_does_not_emit_inflight_result(self):
        watch=self.runtime.watch_pr({'id':self.c['id'],'url':'https://github.com/example/repo/pull/12'})
        def fetch(*args):
            self.runtime.stop_watch({'id':self.c['id'],'watch_id':watch['id']})
            return {'state':'MERGED'}
        self.runtime.fetch_pr=fetch;self.runtime.poll_watches(time.time())
        with self.runtime.db() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM turns').fetchone()[0],0)
        self.assertEqual(self.runtime.watches(self.c['id'])[0]['state'],'stopped')

if __name__=='__main__':unittest.main()
