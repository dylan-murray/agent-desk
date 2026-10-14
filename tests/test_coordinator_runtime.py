import base64
import os
import json
from pathlib import Path
import tempfile
import threading
import time
import shlex
import unittest
import sys
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from unittest.mock import patch
from types import SimpleNamespace

from agent_desk.coordinator_runtime import CoordinatorRuntime
from scripts.control_mailbox import Mailbox, LEGACY_AUTO_PREFIX
from agent_desk.terminals import TerminalManager
from scripts.worker_report import report
from account_fixtures import use_accounts


def setUpModule():
    use_accounts()


class FakeTerminals:
    def __init__(self):self.external_parents=set();self.sessions={};self.launched=[]
    def launch(self,payload):
        self.launched.append(payload);identity='terminal-'+str(len(self.launched))
        session=SimpleNamespace(id=identity,name=payload.get('name','Worker'),cwd=payload.get('cwd','/tmp'),argv=payload.get('argv',['claude']),launch_profile=payload.get('launch_profile'),parent_id=payload['parent_id'],process=SimpleNamespace(poll=lambda:None),
            start=0,buffer=b'test output',output=lambda cursor:dict(data=base64.b64encode(b'test output').decode()))
        session.followups=[]
        session.stop=lambda:setattr(session.process,'poll',lambda:0)
        def send_task(text,before_send=None):
            if before_send:before_send()
            session.followups.append(text)
        session.send_task=send_task
        self.sessions[identity]=session;return session
    def get(self,identity):
        if identity not in self.sessions:raise ValueError('Terminal not found')
        return self.sessions[identity]
    def list(self):return [dict(id=s.id,parent_id=s.parent_id,exit_code=s.process.poll()) for s in self.sessions.values()]


class CoordinatorTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.box=Mailbox(self.root/'mail.sqlite3');self.terminals=FakeTerminals();self.calls=[]
        self.handler=lambda c,ctx,cancel:dict(message='Ready',actions=[])
        def planner(c,ctx,cancel):self.calls.append(ctx);return self.handler(c,ctx,cancel)
        self.runtime=CoordinatorRuntime(self.root/'coordinator.sqlite3',self.terminals,self.box,planner)
        self.c=self.runtime.create(dict(cwd=str(self.root),name='Coordinator',profile='claude'))
    def tearDown(self):self.runtime.close();self.temp.cleanup()
    def wait(self,predicate):
        end=time.monotonic()+5
        while time.monotonic()<end:
            if predicate():return
            time.sleep(.025)
        self.fail(str(self.runtime.snapshot(self.c['id'])))
    def message(self,text='Task',request='one'):
        return self.runtime.message(dict(id=self.c['id'],text=text,request_id=request))
    def test_activity_tracks_planning_elapsed_and_pause(self):
        self.message()
        self.assertEqual(self.runtime.activity(self.c['id'])['phase'],'queued')
        with self.runtime.db() as db:
            turn=db.execute('SELECT id FROM turns WHERE coordinator=?',(self.c['id'],)).fetchone()[0]
            db.execute("UPDATE turns SET state='running' WHERE id=?",(turn,))
            db.execute('INSERT INTO turn_started VALUES(?,?)',(turn,time.time()-82))
        activity=self.runtime.snapshot(self.c['id'])['activity']
        self.assertEqual(activity['phase'],'planning')
        self.assertGreaterEqual(activity['elapsed_seconds'],82)
        self.assertEqual(activity['turn_id'],turn)
        self.runtime.pause(self.c['id'])
        self.assertEqual(self.runtime.activity(self.c['id'])['phase'],'paused')

    def test_activity_waits_for_results_not_open_terminals(self):
        self.runtime.action(self.c,dict(kind='launch',name='Worker',profile='claude',task='Read the project'),'activity-launch')
        activity=self.runtime.activity(self.c['id'])
        self.assertEqual(activity['phase'],'waiting')
        self.assertEqual(activity['count'],1)
        with self.box.connect() as db:
            db.execute("UPDATE tasks SET status='cancelled' WHERE controller=?",(self.c['id'],))
        self.assertEqual(self.runtime.activity(self.c['id'])['phase'],'idle')

    def test_invalid_optional_memory_does_not_pause_or_skip_work(self):
        self.message()
        def plan(c,ctx,cancel):
            if self.terminals.launched:return dict(message='Worker is running',actions=[])
            return dict(message='Saving context and assigning work',actions=[
                dict(kind='remember',name='notes',task='x'*1501,worker_id='message:1'),
                dict(kind='launch',name='Continue work',profile='claude',task='Inspect project')])
        self.handler=plan
        self.runtime.step();self.wait(lambda:not self.runtime.running)
        self.assertEqual(len(self.terminals.launched),1)
        self.assertFalse(self.runtime.get(self.c['id'])['paused'])
        self.runtime.step();self.wait(lambda:not self.runtime.running)
        self.assertEqual(len(self.terminals.launched),1)
        with self.runtime.db() as db:
            self.assertEqual(db.execute("SELECT state FROM actions WHERE kind='remember'").fetchone()[0],'failed')
        self.assertEqual(self.runtime.get(self.c['id'])['state'],'idle')

    def test_attach_existing_agent_preserves_process_and_can_receive_first_task(self):
        worker=self.terminals.launch(dict(name='Existing research',cwd=str(self.root),argv=['claude'],launch_profile='claude',parent_id=None))
        process=worker.process
        self.assertEqual(self.runtime.attachable_workers()[0]['worker_id'],worker.id)
        self.runtime.action(self.c,dict(kind='attach_worker',worker_id=worker.id),'attach-one')
        self.runtime.attach_worker(self.c['id'],worker.id)
        self.assertIs(worker.process,process);self.assertEqual(len(self.terminals.launched),1)
        self.assertEqual(worker.followups,[]);self.assertEqual(worker.parent_id,self.c['id'])
        self.assertEqual(self.runtime.attachable_workers(),[])
        self.assertEqual(self.box.inbox(self.runtime.desk,self.c['id'],True),[])
        self.runtime.action(self.c,dict(kind='send',worker_id=worker.id,task='Continue the research'),'first-send')
        self.assertEqual(len(worker.followups),1)
        self.assertEqual(len(self.terminals.launched),1)
        task=self.box.inbox(self.runtime.desk,self.c['id'])[0]
        self.assertEqual(task['worker'],worker.id)
        self.assertIn('reply '+task['id'],worker.followups[0])
        with patch('agent_desk.native_session_lookup.find_conversation',return_value='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'):
            self.assertEqual(self.runtime.resolve_worker_session(worker),'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')

    def test_attached_busy_agent_queues_without_overwriting_input(self):
        from agent_desk.worker_screen import WorkerNotReady
        worker=self.terminals.launch(dict(name='Busy',cwd=str(self.root),argv=['claude'],launch_profile='claude',parent_id=None))
        self.runtime.attach_worker(self.c['id'],worker.id)
        with patch.object(worker,'send_task',side_effect=WorkerNotReady('Draft exists')):
            result=self.runtime.action(self.c,dict(kind='send',worker_id=worker.id,task='Next task'),'busy-send')
        self.assertEqual(result,'queued');self.assertEqual(worker.followups,[])
        self.assertEqual(self.box.inbox(self.runtime.desk,self.c['id'],True),[])
        self.runtime.drain_deliveries()
        self.assertEqual(len(worker.followups),1)
        self.assertEqual(len(self.terminals.launched),1)

    def test_attach_rejects_owned_automation_exited_and_nonagent_terminals(self):
        other=self.runtime.create(dict(cwd=str(self.root),name='Other',profile='claude'))
        for name,parent,profile,exited in [('owned',other['id'],'claude',False),('automation',None,'claude',False),('exited',None,'claude',True),('shell',None,None,False)]:
            worker=self.terminals.launch(dict(name=name,cwd=str(self.root),argv=['claude' if profile else '/bin/zsh'],launch_profile=profile,parent_id=parent))
            if name=='automation':self.runtime.attachment_exclusions=lambda:{worker.id}
            else:self.runtime.attachment_exclusions=lambda:set()
            if exited:worker.stop()
            with self.assertRaises(ValueError):self.runtime.attach_worker(self.c['id'],worker.id)
            self.assertEqual(worker.parent_id,parent)

    def test_a_protected_session_is_never_adopted_read_or_messaged(self):
        worker=self.terminals.launch(dict(name='Prod',cwd=str(self.root),argv=['claude'],launch_profile='claude',parent_id=None))
        self.runtime.attach_worker(self.c['id'],worker.id)
        self.runtime.protected_panes=lambda:{worker.id}
        for kind in ('read','send','nudge','close_worker'):
            with self.assertRaisesRegex(ValueError,'protected'):
                self.runtime.action(self.c,dict(kind=kind,worker_id=worker.id,task='Look at this'),'protected-'+kind)
        self.assertEqual(worker.followups,[])
        loose=self.terminals.launch(dict(name='Loose',cwd=str(self.root),argv=['claude'],launch_profile='claude',parent_id=None))
        self.runtime.protected_panes=lambda:{worker.id,loose.id}
        self.assertEqual(self.runtime.attachable_workers(),[])
        with self.assertRaisesRegex(ValueError,'protected'):
            self.runtime.action(self.c,dict(kind='attach_worker',worker_id=loose.id),'protected-attach')
        self.assertIsNone(loose.parent_id)

    def test_inspection_budget_finishes_with_summary_without_looping(self):
        self.handler=lambda c,ctx,cancel:dict(message='Findings summarized' if 'inspection_budget' in ctx else 'Inspecting',actions=[dict(kind='recall',task='history')])
        self.message()
        for _ in range(6):
            self.runtime.step();self.wait(lambda:not self.runtime.running)
        self.assertEqual(len(self.calls),5)
        self.assertIn('inspection_budget',self.calls[-1])
        self.assertEqual(self.runtime.snapshot(self.c['id'])['messages'][-1]['text'],'Findings summarized')
        self.assertEqual(self.runtime.get(self.c['id'])['state'],'idle')

    def test_worker_launch_directory_is_explicit_for_every_profile(self):
        from agent_desk.coordinator_planners import validate_reply
        target=self.root/'actual-project';target.mkdir()
        alias=self.root/'project-alias';alias.symlink_to(target,target_is_directory=True)
        for profile in ('claude','claude-personal','codex','codex-personal','grok'):
            action=dict(kind='launch',name='Project worker',profile=profile,model='',task='Inspect project',worker_id='',cwd=str(alias))
            validate_reply(dict(message='Launching',actions=[action]))
            self.runtime.action(self.c,action,'cwd-'+profile)
            launched=self.terminals.launched[-1]
            self.assertEqual(launched['cwd'],str(target.resolve()))
            self.assertEqual(launched['launch_profile'],None if profile=='grok' else profile)
            self.assertFalse(any(flag in launched['argv'] for flag in ('--always-approve','--dangerously-skip-permissions','--yolo')))
            with self.runtime.db() as db:
                self.assertEqual(db.execute('SELECT cwd FROM worker_registry WHERE worker=?',(next(reversed(self.terminals.sessions)),)).fetchone()[0],str(target.resolve()))
        self.runtime.action(self.c,dict(kind='launch',name='Default',profile='claude',task='Inspect'),'cwd-default')
        self.assertEqual(self.terminals.launched[-1]['cwd'],str(self.root.resolve()))

    def test_invalid_worker_directory_does_not_launch_or_reserve_task(self):
        for i,cwd in enumerate(('relative',str(self.root/'missing'),None,5)):
            with self.assertRaisesRegex(ValueError,'worker directory'):
                self.runtime.action(self.c,dict(kind='launch',name='Invalid',profile='claude',task='Inspect',cwd=cwd),'invalid-cwd-'+str(i))
        self.assertEqual(self.terminals.launched,[])
        self.assertEqual(self.box.inbox(self.runtime.desk,self.c['id'],True),[])

    def test_resume_live_worker_reuses_it_without_a_saved_record(self):
        worker=self.terminals.launch({'parent_id':self.c['id']})
        self.runtime.action(self.c,dict(kind='resume',worker_id=worker.id),'reuse-live')
        self.assertEqual(len(self.terminals.sessions),1)
        action=self.runtime.snapshot(self.c['id'])['actions'][0]
        self.assertEqual(action['worker'],worker.id)
        self.assertIn('already running',action['detail'])
        worker.parent_id='other'
        with self.assertRaisesRegex(ValueError,'another coordinator'):
            self.runtime.resume_worker({'id':self.c['id'],'worker_id':worker.id})
        worker.parent_id=self.c['id'];worker.stop()
        with self.assertRaisesRegex(ValueError,'exited but has not been saved'):
            self.runtime.resume_worker({'id':self.c['id'],'worker_id':worker.id})

    def test_memory_error_names_actual_source_kind(self):
        with self.runtime.db() as db:
            self.runtime.append(db,self.c['id'],'error','Resume failed')
            source=db.execute('SELECT MAX(id) FROM messages').fetchone()[0]
        with self.assertRaisesRegex(ValueError,'source type is error'):
            self.runtime.save_memory(dict(id=self.c['id'],name='goal',text='Do work',source='message:'+str(source)),from_model=True)

    def test_recall_label_is_not_mistaken_for_a_page_offset(self):
        with patch.object(self.runtime,'retrieve',return_value={'matches':[]}) as retrieve:
            self.runtime.action(self.c,dict(kind='recall',name='hooks-diagnosis',task='default hooks',worker_id=''),'recall-label')
            retrieve.assert_called_once_with(self.c['id'],'','default hooks',0)
        self.assertEqual(self.runtime.snapshot(self.c['id'])['actions'][0]['state'],'done')

    def test_provider_accepts_hook_launch_action(self):
        from agent_desk.coordinator_planners import validate_reply
        reply=dict(message='Opening review',actions=[dict(kind='launch_hook_tool',name='hook-example',profile='',model='main',task='/tmp/project',worker_id='')])
        self.assertEqual(validate_reply(reply),reply)

    def test_action_failure_is_not_a_question_and_is_not_duplicated(self):
        self.handler=lambda *args:dict(message='I will nudge the worker.',actions=[dict(kind='nudge',worker_id='missing',task='Report back')])
        self.message();self.runtime.step()
        self.wait(lambda:self.runtime.get(self.c['id'])['state']=='error')
        self.wait(lambda:not self.runtime.running)
        agent=self.runtime.agents()[0]
        self.assertIsNone(agent['question'])
        self.assertEqual(agent['status'],'error')
        self.assertIn('save its exact conversation',agent['activity_description'])
        errors=[m for m in self.runtime.snapshot(self.c['id'])['messages'] if m['kind']=='error']
        self.assertEqual(len(errors),1)

    def test_explicit_ask_exposes_the_actual_question(self):
        self.runtime.action(self.c,dict(kind='ask',task='Which branch should I use?'),'ask-question')
        agent=self.runtime.agents()[0]
        self.assertEqual(agent['status'],'needs_input')
        self.assertEqual(agent['question'],'Which branch should I use?')

    def test_legacy_error_status_is_reclassified_on_restart(self):
        with self.runtime.db() as db:
            db.execute("UPDATE coordinators SET state='needs_input',paused=1 WHERE id=?",(self.c['id'],))
            self.runtime.append(db,self.c['id'],'error','Worker prompt is busy')
        restored=CoordinatorRuntime(self.runtime.path,self.terminals,self.box,lambda *args:None)
        self.assertEqual(restored.get(self.c['id'])['state'],'error')
        self.assertTrue(restored.get(self.c['id'])['paused'])
        restored.close()

    def test_models_persist_and_forward_to_new_workers(self):
        self.runtime.configure({'id':self.c['id'],'model':'opus'})
        c=self.runtime.get(self.c['id'])
        self.assertEqual(c['model'],'opus')
        for index,(profile,model,expected) in enumerate([('claude-personal','','opus'),('codex','',''),('codex','custom-codex','custom-codex'),('grok','custom-grok','custom-grok')]):
            self.runtime.action(c,dict(kind='launch',name='Worker',profile=profile,model=model,task='Test fixture',worker_id=''),f'model-{index}')
            argv=self.terminals.launched[-1]['argv']
            if expected:self.assertEqual(argv[argv.index('--model')+1],expected)
            else:self.assertNotIn('--model',argv)
        with self.runtime.db() as db:db.execute('DELETE FROM coordinator_settings WHERE id=?',(c['id'],))
        self.runtime.configure({'id':c['id'],'model':'sonnet'})
        self.assertEqual(self.runtime.get(c['id'])['model'],'sonnet')
        with self.assertRaises(ValueError):self.runtime.configure({'id':c['id'],'model':'--unsafe'})

    def test_close_and_reopen_preserve_history_workers_and_pause(self):
        self.message('Keep this conversation')
        self.runtime.action(self.c,dict(kind='launch',name='Worker',profile='claude',task='Keep this worker',worker_id=''),'close-worker')
        session=self.terminals.get('terminal-1')
        self.runtime.close_conversation(self.c['id'])
        self.assertEqual(self.runtime.agents(),[])
        self.assertIsNone(session.process.poll())
        self.assertTrue(self.runtime.get(self.c['id'])['paused'])
        self.assertTrue(self.runtime.snapshot()['coordinators'][0]['closed'])
        with self.assertRaises(ValueError):self.message('No hidden work','closed')
        self.runtime.reopen(self.c['id'])
        self.assertEqual(len(self.runtime.agents()),1)
        self.assertTrue(self.runtime.get(self.c['id'])['paused'])
        self.assertEqual(self.runtime.snapshot(self.c['id'])['messages'][0]['text'],'Keep this conversation')
        self.message('Continue','resume')
        self.assertFalse(self.runtime.get(self.c['id'])['paused'])

    def test_rename_coordinator_preserves_conversation(self):
        self.message('Keep this task')
        self.runtime.rename({'id':self.c['id'],'name':'UI development'})
        self.assertEqual(self.runtime.get(self.c['id'])['name'],'UI development')
        self.assertEqual(self.runtime.snapshot(self.c['id'])['messages'][0]['text'],'Keep this task')
        with self.assertRaises(ValueError):self.runtime.rename({'id':self.c['id'],'name':'bad\nname'})

    def test_usage_is_durable_and_idempotent_per_turn(self):
        stats={'reported':True,'input_tokens':1234,'output_tokens':56,'cached_input_tokens':1000}
        ctx={'context_policy':{'trimmed':True}}
        self.runtime.record_usage(self.c['id'],'usage-turn','claude',stats,ctx)
        self.runtime.record_usage(self.c['id'],'usage-turn','claude',stats,ctx)
        restored=CoordinatorRuntime(self.runtime.path,self.terminals,self.box,self.handler)
        usage=restored.snapshot(self.c['id'])['usage']
        self.assertEqual(usage['turns'],1)
        self.assertEqual(usage['totals']['input_tokens'],1234)
        self.assertTrue(usage['last']['context_trimmed'])
        restored.close()

    def test_context_overflow_pauses_without_stranding_runtime(self):
        self.message()
        with patch.object(self.runtime,'context',side_effect=ValueError('Context budget exceeded')):
            self.runtime.start()
            self.wait(lambda:self.runtime.get(self.c['id'])['paused'])
        self.assertFalse(self.calls)
        self.assertNotIn(self.c['id'],self.runtime.running)
        self.assertTrue(any('Context budget' in m['text'] for m in self.runtime.snapshot(self.c['id'])['messages']))

    def test_messages_are_idempotent_and_pending_messages_are_one_turn(self):
        self.message();self.message();self.message('Second message','two')
        with self.assertRaises(ValueError):self.message('Different payload','one')
        self.runtime.start();self.wait(lambda:any(m['kind']=='assistant' for m in self.runtime.snapshot(self.c['id'])['messages']))
        time.sleep(.6);self.assertEqual(len(self.calls),1)
        self.assertEqual([m['text'] for m in self.calls[0]['conversation']],['Task','Second message'])
    def test_worker_actions_and_reply_reporting_do_not_depend_on_model_ack(self):
        action=dict(kind='launch',name='Reviewer',profile='claude-personal',task='Review the local change',worker_id='')
        self.handler=lambda c,ctx,cancel:dict(message='Assigning a review.' if len(self.calls)==1 else 'The review is complete.',actions=[action] if len(self.calls)==1 else [])
        self.message();self.runtime.start();self.wait(lambda:len(self.terminals.launched)==1 and not self.runtime.running)
        payload=self.terminals.launched[0];self.assertEqual(payload['parent_id'],self.c['id']);self.assertEqual(payload['launch_profile'],'claude-personal')
        self.assertEqual(payload['argv'][-2],'--')
        task=self.box.inbox(self.runtime.desk,self.c['id'])[0]
        self.assertIn(task['id'],payload['argv'][-1])
        self.box.reply(self.runtime.desk,task['id'],'Verified result','completed')
        self.wait(lambda:len(self.calls)==2 and not self.runtime.running)
        self.assertTrue(self.box.get(self.runtime.desk,task['id'])['acknowledged'])
        messages=self.runtime.snapshot(self.c['id'])['messages']
        self.assertEqual(sum(m['kind']=='worker' for m in messages),1)
        self.assertIn('Verified result',next(m['text'] for m in messages if m['kind']=='worker'))
        self.runtime.ingest();self.assertEqual(len(self.calls),2)
    def test_reply_during_active_turn_waits_but_is_visible_immediately(self):
        release=threading.Event()
        self.handler=lambda c,ctx,cancel:(release.wait(3),dict(message='Done',actions=[]))[1] if len(self.calls)==1 else dict(message='Reply handled',actions=[])
        self.message();self.runtime.start();self.wait(lambda:len(self.calls)==1)
        task,_=self.box.create(self.runtime.desk,self.c['id'],'worker','Work');self.box.reply(self.runtime.desk,task['id'],'Arrived while busy','completed')
        self.wait(lambda:any(m['kind']=='worker' for m in self.runtime.snapshot(self.c['id'])['messages']))
        self.assertEqual(len(self.calls),1);release.set()
        self.wait(lambda:len(self.calls)==2 and not self.runtime.running)
        self.assertTrue(any(m['kind']=='worker' for m in self.calls[1]['conversation']))
    def test_pause_prevents_late_model_actions(self):
        entered=threading.Event()
        def planner(c,ctx,cancel):
            entered.set();cancel.wait(3)
            return dict(message='Late',actions=[dict(kind='launch',name='Should not start',profile='claude',task='No',worker_id='')])
        self.handler=planner;self.message();self.runtime.start();self.assertTrue(entered.wait(3))
        self.runtime.pause(self.c['id']);self.wait(lambda:not self.runtime.running)
        self.assertEqual(self.terminals.launched,[]);self.assertTrue(self.runtime.get(self.c['id'])['paused'])
        self.assertFalse(any(m['kind']=='error' for m in self.runtime.snapshot(self.c['id'])['messages']))
    def test_restart_does_not_repeat_uncertain_actions_and_runtime_has_one_owner(self):
        with self.runtime.db() as db:
            db.execute('INSERT INTO turns VALUES(?,?,?,?,?)',('old',self.c['id'],'running',0,time.time()))
            db.execute('INSERT INTO actions VALUES(?,?,?,?,?,?,?,?)',('old:0',self.c['id'],'launch','{}','running',None,None,'Launching'))
        self.runtime.start();self.assertTrue(self.runtime.get(self.c['id'])['paused'])
        self.assertEqual(self.runtime.snapshot(self.c['id'])['actions'][0]['state'],'uncertain')
        other=CoordinatorRuntime(self.runtime.path,self.terminals,self.box)
        with self.assertRaises(ValueError):other.start()
        other.close();self.assertEqual(self.terminals.launched,[])
    def test_reading_another_coordinators_worker_is_rejected(self):
        worker=self.terminals.launch(dict(parent_id='somebody-else'))
        with self.assertRaises(ValueError):self.runtime.action(self.c,dict(kind='read',worker_id=worker.id),'bad-read')
        self.assertEqual(self.runtime.snapshot(self.c['id'])['actions'][0]['state'],'failed')
    def test_read_followups_are_bounded(self):
        worker=self.terminals.launch(dict(parent_id=self.c['id']))
        self.handler=lambda c,ctx,cancel:dict(message='Inspecting',actions=[dict(kind='read',worker_id=worker.id)])
        self.message();self.runtime.start();self.wait(lambda:len(self.calls)==5 and not self.runtime.running)
        time.sleep(.6);self.assertEqual(len(self.calls),5)

    def test_real_pty_worker_callback_is_reserved_before_launch(self):
        fixture=self.root/'fixture-worker'
        fixture.write_text('#!'+sys.executable+'\n'+f'''import sys,re
sys.path.insert(0,{str(Path(__file__).resolve().parents[1])!r})
from scripts.control_mailbox import Mailbox, LEGACY_AUTO_PREFIX
prompt=sys.argv[-1]
identity=re.search(r'reply (task-[0-9a-f]+)',prompt).group(1)
Mailbox({str(self.box.path)!r}).reply('http://127.0.0.1:4310',identity,'Actual PTY callback received','completed')
print('Worker reported',flush=True)
''');fixture.chmod(0o700)
        manager=TerminalManager();runtime=CoordinatorRuntime(self.root/'pty-coordinator.sqlite3',manager,self.box)
        c=runtime.create(dict(cwd=str(self.root),profile='claude'))
        try:
            # The login shell's startup file stands a fixture in for the claude CLI.
            (self.root/'.zshrc').write_text('claude(){ '+shlex.quote(str(fixture))+' "$@"; }\n')
            with patch.dict(os.environ,{'ZDOTDIR':str(self.root)}):
                runtime.action(c,dict(kind='launch',profile='claude',name='Fixture worker',task='Verify callback',worker_id=''),'pty-action')
            session=next(iter(manager.sessions.values()));session.process.wait(5)
            runtime.ingest();runtime.ingest()
            messages=runtime.snapshot(c['id'])['messages']
            self.assertEqual(sum(m['kind']=='worker' for m in messages),1)
            self.assertIn('Actual PTY callback received',next(m['text'] for m in messages if m['kind']=='worker'))
            self.assertEqual(session.parent_id,c['id'])
            self.assertFalse(any('without reporting' in m['text'] for m in messages))
        finally:runtime.close();manager.close()

    def test_exited_worker_without_callback_is_flagged_once(self):
        self.runtime.action(self.c,dict(kind='launch',profile='claude',name='Silent worker',task='Inspect',worker_id=''),'silent')
        session=next(iter(self.terminals.sessions.values()));session.process.poll=lambda:0
        self.runtime.ingest();self.runtime.ingest()
        messages=self.runtime.snapshot(self.c['id'])['messages']
        self.assertEqual(sum('without reporting' in m['text'] for m in messages),1)
        self.assertEqual(self.runtime.get(self.c['id'])['state'],'error')

    def test_native_turn_observer_reports_without_overwriting_explicit_result(self):
        for harness,event in [('claude',{'hook_event_name':'Stop','last_assistant_message':'Native Claude response'}),('codex',{'type':'agent-turn-complete','last-assistant-message':'Native Codex response'})]:
            task,_=self.box.create(self.runtime.desk,self.c['id'],'worker',harness+' task')
            report(self.box,self.runtime.desk,task['id'],event,harness)
            self.assertIsNone(self.box.get(self.runtime.desk,task['id'])['result'])
            with self.box.connect() as db:
                progress=dict(db.execute('SELECT * FROM task_progress WHERE task_id=?',(task['id'],)).fetchone())
            self.assertEqual(progress['kind'],'turn_ended')
            self.assertIn('response',progress['text'])
            explicit,_=self.box.create(self.runtime.desk,self.c['id'],'worker',harness+' explicit')
            self.box.reply(self.runtime.desk,explicit['id'],'Needs user input','blocked')
            report(self.box,self.runtime.desk,explicit['id'],event,harness)
            self.assertEqual(self.box.get(self.runtime.desk,explicit['id'])['result'],'Needs user input')
            self.assertEqual(self.box.get(self.runtime.desk,explicit['id'])['outcome'],'blocked')

    def test_background_pytest_turn_end_then_explicit_result_is_delivered_once(self):
        task,_=self.box.create(self.runtime.desk,self.c['id'],'worker','Run pytest')
        # A turn may end with no reliable job metadata while a shell is still running.
        event={'hook_event_name':'Stop','last_assistant_message':'pytest is still running in the background.'}
        report(self.box,self.runtime.desk,task['id'],event,'claude')
        report(self.box,self.runtime.desk,task['id'],event,'claude')
        self.runtime.step()
        self.assertEqual(self.calls,[])
        self.assertEqual(self.runtime.snapshot(self.c['id'])['messages'],[])
        self.assertIsNone(self.box.claim(self.runtime.desk,self.c['id']))
        self.assertEqual(self.box.wait(self.runtime.desk,self.c['id'],0)['replies'],[])
        final='pytest finished: 47 passed. Final verified report.'
        self.box.reply(self.runtime.desk,task['id'],final,'completed')
        report(self.box,self.runtime.desk,task['id'],event,'claude')
        self.runtime.start()
        self.wait(lambda:len(self.calls)==1 and not self.runtime.running)
        self.runtime.ingest();self.runtime.ingest()
        results=[m for m in self.runtime.snapshot(self.c['id'])['messages'] if m['kind']=='worker']
        self.assertEqual(len(results),1)
        self.assertEqual(results[0]['text'],'Run pytest · completed\n\n'+final)
        self.assertTrue(self.box.get(self.runtime.desk,task['id'])['acknowledged'])
        self.assertEqual(len(self.calls),1)
        with self.assertRaises(ValueError):self.box.reply(self.runtime.desk,task['id'],'Different final','completed')

    def test_legacy_automatic_reply_is_demoted_and_explicit_report_reaches_coordinator(self):
        task,_=self.box.create(self.runtime.desk,self.c['id'],'worker','Legacy task')
        old=LEGACY_AUTO_PREFIX+'Still running pytest'
        self.box.reply(self.runtime.desk,task['id'],old,'completed')
        batch=self.box.claim(self.runtime.desk,self.c['id']);self.box.delivered(batch['id'],'sent')
        self.box.ack(self.runtime.desk,task['id'],self.c['id'])
        key=self.c['id']+':reply:'+task['id']
        with self.runtime.db() as db:
            self.runtime.append(db,self.c['id'],'worker','Legacy task · completed\n\n'+old,key)
            db.execute('INSERT INTO turns VALUES(?,?,?,?,?)',(key,self.c['id'],'pending',0,time.time()))
        self.box=Mailbox(self.box.path);self.runtime.mailbox=self.box
        self.runtime.step()
        self.assertEqual(self.calls,[])
        self.assertIsNone(self.box.get(self.runtime.desk,task['id'])['result'])
        self.assertIsNone(self.box.claim(self.runtime.desk,self.c['id']))
        self.assertEqual(self.runtime.snapshot(self.c['id'])['messages'][0]['kind'],'system')
        self.box.reply(self.runtime.desk,task['id'],'Real final report','completed')
        self.runtime.start();self.wait(lambda:len(self.calls)==1 and not self.runtime.running)
        results=[m for m in self.runtime.snapshot(self.c['id'])['messages'] if m['kind']=='worker']
        self.assertEqual(len(results),1);self.assertIn('Real final report',results[0]['text'])
        Mailbox(self.box.path)
        self.assertEqual(self.box.get(self.runtime.desk,task['id'])['result'],'Real final report')

    def test_followup_reuses_worker_and_reports_on_new_task(self):
        launch=dict(kind='launch',name='Fix worker',profile='claude',task='Fix bug')
        self.runtime.action(self.c,launch,'launch-fix')
        worker=next(iter(self.terminals.sessions.values()))
        initial=self.box.inbox(self.runtime.desk,self.c['id'])[0]
        self.box.reply(self.runtime.desk,initial['id'],'Fix staged','completed')
        self.runtime.ingest()
        action=dict(kind='send',worker_id=worker.id,task='Commit and open the PR')
        self.runtime.action(self.c,action,'followup-pr')
        self.runtime.action(self.c,action,'followup-pr')
        self.assertEqual(len(self.terminals.launched),1)
        self.assertEqual(len(worker.followups),1)
        tasks=self.box.inbox(self.runtime.desk,self.c['id'],True)
        followup=tasks[-1];self.assertNotEqual(followup['id'],initial['id'])
        self.assertIn(followup['id'],worker.followups[0])
        report(self.box,self.runtime.desk,initial['id'],{'hook_event_name':'Stop','last_assistant_message':'Pushing branch'},'claude')
        with self.box.connect() as db:
            self.assertEqual(db.execute('SELECT task_id FROM task_progress').fetchone()[0],followup['id'])
        self.runtime.ingest()
        self.assertEqual(sum(m['kind']=='worker' for m in self.runtime.snapshot(self.c['id'])['messages']),1)
        self.box.reply(self.runtime.desk,followup['id'],'PR opened: https://example.test/pr/457','completed')
        self.runtime.ingest();self.runtime.ingest()
        results=[m['text'] for m in self.runtime.snapshot(self.c['id'])['messages'] if m['kind']=='worker']
        self.assertEqual(len(results),2);self.assertIn('PR opened:',results[-1])
        report_task=[m['reply_task'] for m in self.runtime.snapshot(self.c['id'])['messages'] if m['kind']=='worker'][-1]
        self.assertEqual(report_task['id'],followup['id'])
        self.assertEqual(report_task['text'],'Commit and open the PR')
        self.assertEqual(self.box.get(self.runtime.desk,initial['id'])['result'],'Fix staged')

    def test_followup_rejects_pending_foreign_exited_and_busy_workers(self):
        self.runtime.action(self.c,dict(kind='launch',name='Worker',profile='claude',task='Fix'),'launch')
        worker=next(iter(self.terminals.sessions.values()))
        task=self.box.inbox(self.runtime.desk,self.c['id'])[0]
        action=dict(kind='send',worker_id=worker.id,task='Follow up')
        self.assertEqual(self.runtime.action(self.c,action,'pending'),'queued')
        self.runtime.cancel_delivery({'id':self.c['id'],'action_id':'pending'})
        self.box.reply(self.runtime.desk,task['id'],'Done','completed')
        worker.parent_id='different'
        with self.assertRaisesRegex(ValueError,'another coordinator'):self.runtime.action(self.c,action,'foreign')
        worker.parent_id=self.c['id'];worker.process.poll=lambda:0
        with self.assertRaisesRegex(ValueError,'exited'):self.runtime.action(self.c,action,'exited')
        worker.process.poll=lambda:None
        worker.send_task=lambda *a,**kw:(_ for _ in ()).throw(ValueError('Busy prompt'))
        with self.assertRaisesRegex(ValueError,'Busy'):self.runtime.action(self.c,action,'busy')
        self.assertEqual(len(self.box.inbox(self.runtime.desk,self.c['id'],True)),1)
        self.assertEqual(worker.followups,[])

    def test_nudge_keeps_pending_assignment_and_final_report_delivered_once(self):
        self.runtime.action(self.c,dict(kind='launch',name='Watcher',profile='claude',task='Watch until closed'),'launch')
        worker=next(iter(self.terminals.sessions.values()))
        task=self.box.inbox(self.runtime.desk,self.c['id'])[0]
        action=dict(kind='nudge',worker_id=worker.id,task='Check whether the PR closed and report if finished')
        self.runtime.action(self.c,action,'nudge-one')
        self.runtime.action(self.c,action,'nudge-one')
        self.assertEqual(len(worker.followups),1)
        self.assertIn('reply '+task['id'],worker.followups[0])
        pending=self.box.inbox(self.runtime.desk,self.c['id'],True)
        self.assertEqual(len(pending),1);self.assertIsNone(pending[0]['result'])
        self.assertEqual(pending[0]['status'],'waiting')
        self.assertEqual(self.runtime.worker_reviews(self.c['id']),[])
        self.box.reply(self.runtime.desk,task['id'],'Verified closed; monitor stopped','completed')
        self.runtime.ingest();self.runtime.ingest()
        self.assertEqual(sum(m['kind']=='worker' for m in self.runtime.snapshot(self.c['id'])['messages']),1)
        self.assertEqual(self.runtime.worker_reviews(self.c['id'])[0]['task_id'],task['id'])
        with self.assertRaisesRegex(ValueError,'unfinished'):self.runtime.action(self.c,action,'after-final')

    def test_nudge_rejects_busy_foreign_and_uncertain_delivery(self):
        self.runtime.action(self.c,dict(kind='launch',name='Watcher',profile='claude',task='Watch'),'launch')
        worker=next(iter(self.terminals.sessions.values()))
        task=self.box.inbox(self.runtime.desk,self.c['id'])[0]
        action=dict(kind='nudge',worker_id=worker.id,task='Check stop condition')
        worker.parent_id='other'
        with self.assertRaisesRegex(ValueError,'another coordinator'):self.runtime.action(self.c,action,'foreign-nudge')
        worker.parent_id=self.c['id']
        worker.send_task=lambda *args,**kwargs:(_ for _ in ()).throw(ValueError('Busy prompt'))
        with self.assertRaisesRegex(ValueError,'Busy'):self.runtime.action(self.c,action,'busy-nudge')
        self.assertEqual(self.box.get(self.runtime.desk,task['id'])['status'],'waiting')
        def broken(text,before_send):
            before_send();worker.followups.append(text);raise OSError('Broken pipe')
        worker.send_task=broken
        with self.assertRaises(OSError):self.runtime.action(self.c,action,'broken-nudge')
        self.assertEqual(self.box.get(self.runtime.desk,task['id'])['status'],'nudge_uncertain')
        with self.assertRaisesRegex(ValueError,'uncertain'):self.runtime.action(self.c,action,'retry-nudge')
        self.assertEqual(len(worker.followups),1)
        self.box.reply(self.runtime.desk,task['id'],'Done despite lost acknowledgement','completed')
        self.assertEqual(self.box.get(self.runtime.desk,task['id'])['result'],'Done despite lost acknowledgement')

    def test_uncertain_followup_is_not_resent(self):
        self.runtime.action(self.c,dict(kind='launch',name='Worker',profile='claude',task='Fix'),'launch')
        worker=next(iter(self.terminals.sessions.values()))
        first=self.box.inbox(self.runtime.desk,self.c['id'])[0];self.box.reply(self.runtime.desk,first['id'],'Done','completed')
        def broken(text,before_send):
            before_send();worker.followups.append(text);raise OSError('Broken pipe')
        worker.send_task=broken
        action=dict(kind='send',worker_id=worker.id,task='Publish')
        with self.assertRaises(OSError):self.runtime.action(self.c,action,'uncertain')
        self.runtime.action(self.c,action,'uncertain')
        self.assertEqual(len(worker.followups),1)
        last=self.box.inbox(self.runtime.desk,self.c['id'],True)[-1]
        self.assertEqual(last['status'],'send_uncertain');self.assertIsNone(last['result'])
        with self.assertRaisesRegex(ValueError,'uncertain'):self.runtime.action(self.c,action,'new-attempt')

    def test_completed_worker_auto_closes_with_report_and_resume(self):
        self.runtime.action(self.c,dict(kind='launch',name='Worker',profile='claude',task='Inspect'),'auto-launch')
        worker=next(iter(self.terminals.sessions.values()));task=self.box.inbox(self.runtime.desk,self.c['id'])[0]
        self.runtime.close_completed_workers();self.assertIsNone(worker.process.poll())
        self.box.reply(self.runtime.desk,task['id'],'Final report artifact','completed')
        with self.box.connect() as db:db.execute('UPDATE tasks SET updated=? WHERE id=?',(time.time()-10,task['id']))
        with patch.object(self.runtime,'resolve_worker_session',return_value='native-worker'):
            self.runtime.worker_cleanup_at=0;self.runtime.close_completed_workers()
        saved=self.runtime.saved_workers(self.c['id'])[0]
        self.assertEqual(worker.process.poll(),0)
        self.assertTrue(saved['can_resume']);self.assertEqual(saved['report_task_id'],task['id'])
        self.assertEqual(self.box.get(self.runtime.desk,task['id'])['result'],'Final report artifact')
        resumed=self.runtime.resume_worker(dict(id=self.c['id'],worker_id=worker.id))
        self.assertIn('native-worker',self.terminals.get(resumed['worker_id']).argv)

    def test_auto_close_preserves_queued_followup_and_blocked_workers(self):
        self.runtime.action(self.c,dict(kind='launch',name='Worker',profile='claude',task='Inspect'),'auto-launch')
        worker=next(iter(self.terminals.sessions.values()));task=self.box.inbox(self.runtime.desk,self.c['id'])[0]
        self.box.reply(self.runtime.desk,task['id'],'Need input','blocked')
        with self.box.connect() as db:db.execute('UPDATE tasks SET updated=? WHERE id=?',(time.time()-10,task['id']))
        self.runtime.close_completed_workers();self.assertIsNone(worker.process.poll())
        with self.box.connect() as db:db.execute("UPDATE tasks SET outcome='completed' WHERE id=?",(task['id'],))
        with self.runtime.db() as db:db.execute('INSERT INTO actions VALUES(?,?,?,?,?,?,?,?)',('queued',self.c['id'],'send','{}','queued',worker.id,None,'Follow-up'))
        self.runtime.worker_cleanup_at=0;self.runtime.close_completed_workers();self.assertIsNone(worker.process.poll())

    def test_auto_close_without_native_id_retains_report_and_history(self):
        self.runtime.action(self.c,dict(kind='launch',name='Worker',profile='codex',task='Inspect'),'auto-launch')
        worker=next(iter(self.terminals.sessions.values()));task=self.box.inbox(self.runtime.desk,self.c['id'])[0]
        self.box.reply(self.runtime.desk,task['id'],'Done','completed')
        with self.box.connect() as db:db.execute('UPDATE tasks SET updated=? WHERE id=?',(time.time()-10,task['id']))
        with patch.object(self.runtime,'resolve_worker_session',return_value=None):self.runtime.close_completed_workers()
        saved=self.runtime.saved_workers(self.c['id'])[0]
        self.assertEqual(saved['state'],'unavailable');self.assertEqual(saved['report_task_id'],task['id'])
        self.assertEqual(worker.process.poll(),0)

    def test_confirm_close_persists_and_resumes_exact_account_and_conversation(self):
        import uuid
        self.runtime.action(self.c,dict(kind='launch',name='Fix worker',profile='claude-personal',task='Fix'),'launch')
        worker=next(iter(self.terminals.sessions.values()))
        task=self.box.inbox(self.runtime.desk,self.c['id'])[0]
        identity=str(uuid.uuid4())
        report(self.box,self.runtime.desk,task['id'],{'hook_event_name':'Stop','session_id':identity,'last_assistant_message':'Done'},'claude')
        payload=dict(id=self.c['id'],worker_id=worker.id,task_id=task['id'],confirmed=True)
        with self.assertRaisesRegex(ValueError,'final report'):self.runtime.retire_worker(payload)
        self.assertIsNone(worker.process.poll())
        self.box.reply(self.runtime.desk,task['id'],'Tests passed and patch reviewed','completed')
        with self.assertRaisesRegex(ValueError,'Confirm'):self.runtime.retire_worker(dict(payload,confirmed=False))
        self.runtime.retire_worker(payload);self.runtime.retire_worker(payload)
        self.assertEqual(worker.process.poll(),0)
        self.assertIn(worker.id,self.runtime.hidden_workers())
        saved=self.runtime.saved_workers(self.c['id'])[0]
        self.assertEqual(saved['session_id'],identity);self.assertEqual(saved['profile'],'claude-personal')
        self.assertEqual(saved['state'],'saved')
        # A new runtime reads the durable record and resumes the selected ID, never --last.
        self.runtime.close();self.runtime=CoordinatorRuntime(self.root/'coordinator.sqlite3',self.terminals,self.box,lambda *a:dict(message='',actions=[]))
        resumed=self.runtime.resume_worker(payload)['worker_id']
        self.assertEqual(self.runtime.resume_worker(payload)['worker_id'],resumed)
        args=self.terminals.launched[-1]['argv'];self.assertEqual(args[-2:],['--resume',identity])
        self.assertEqual(self.terminals.launched[-1]['launch_profile'],'claude-personal')
        self.assertEqual(self.terminals.launched[-1]['cwd'],worker.cwd)
        self.assertEqual(self.terminals.launched[-1]['parent_id'],self.c['id'])
        self.assertEqual(self.box.get(self.runtime.desk,task['id'])['worker'],resumed)
        self.runtime.action(self.c,dict(kind='send',worker_id=resumed,task='Open the PR'),'resume-followup')
        self.assertEqual(len(self.terminals.sessions[resumed].followups),1)

    def test_retirement_requires_resume_identity_and_resume_failure_is_not_retried(self):
        self.runtime.action(self.c,dict(kind='launch',name='Worker',profile='codex',task='Fix'),'launch')
        worker=next(iter(self.terminals.sessions.values()));task=self.box.inbox(self.runtime.desk,self.c['id'])[0]
        self.box.reply(self.runtime.desk,task['id'],'Done','completed')
        payload=dict(id=self.c['id'],worker_id=worker.id,task_id=task['id'],confirmed=True)
        with self.assertRaisesRegex(ValueError,'conversation ID'):self.runtime.retire_worker(payload)
        self.assertIsNone(worker.process.poll())
        payload['session_id']='session-123';self.runtime.retire_worker(payload)
        with patch.object(self.terminals,'launch',side_effect=OSError('uncertain launch')) as launch:
            with self.assertRaisesRegex(ValueError,'could not be confirmed'):self.runtime.resume_worker(payload)
            with self.assertRaisesRegex(ValueError,'uncertain'):self.runtime.resume_worker(payload)
            self.assertEqual(launch.call_count,1)
        self.assertEqual(self.runtime.saved_workers(self.c['id'])[0]['state'],'resuming')
        from agent_desk.worker_sessions import WorkerSessions, prompt_argv
        self.assertEqual(WorkerSessions.resume_argv(['codex','--','old task'],'codex','session-123'),['codex','resume','session-123'])
        self.assertEqual(WorkerSessions.resume_argv(['grok','--','old task'],'grok','session-123'),['grok','--resume','session-123'])
        self.assertEqual(WorkerSessions.resume_argv(['opencode','--model','a/b','--prompt','old task'],'opencode','ses_abc'),['opencode','--model','a/b','--session','ses_abc'])
        self.assertEqual(WorkerSessions.resume_argv(['pi','--model','a/b','old\ntask'],'pi','session-123'),['pi','--model','a/b','--session','session-123'])
        self.assertEqual(WorkerSessions.resume_argv(['pi','--session','old'],'pi','session-123'),['pi','--session','session-123'])
        self.assertEqual(prompt_argv(['opencode'],'opencode','-x'),['opencode','--prompt','-x'])
        self.assertEqual(prompt_argv(['pi'],'pi','-x'),['pi','Task: -x'])
        self.assertEqual(prompt_argv(['pi'],'pi','do it'),['pi','do it'])
        self.assertEqual(prompt_argv(['grok'],'grok','do it'),['grok','--','do it'])

    def test_restart_preserves_worker_lineage_goal_and_unfinished_callback(self):
        import uuid
        self.message('Original project goal')
        self.runtime.action(self.c,dict(kind='launch',name='Original worker',profile='claude-personal',task='Finish the original task'),'launch')
        original=next(iter(self.terminals.sessions.values()))
        task=self.box.inbox(self.runtime.desk,self.c['id'])[0];native=str(uuid.uuid4())
        report(self.box,self.runtime.desk,task['id'],{'hook_event_name':'Stop','session_id':native,'last_assistant_message':'Still working'},'claude')
        with self.runtime.db() as db:
            db.execute("UPDATE turns SET state='done'")
            for i in range(45):self.runtime.append(db,self.c['id'],'assistant','Older history '+str(i))
        self.runtime.close()
        # A fresh server has no native terminal processes yet.
        self.terminals=FakeTerminals();self.terminals.launched=[{}]
        self.runtime=CoordinatorRuntime(self.root/'coordinator.sqlite3',self.terminals,self.box,lambda *a:dict(message='',actions=[]))
        self.runtime.start()
        saved=self.runtime.saved_workers(self.c['id'])[0]
        self.assertEqual(saved['worker'],original.id);self.assertEqual(saved['session_id'],native)
        self.assertTrue(saved['can_resume']);self.assertEqual(saved['pending_tasks'][0]['id'],task['id'])
        self.assertEqual(self.terminals.sessions,{})  # Opening history never auto-starts workers.
        context=self.runtime.context(self.c)
        self.assertEqual(context['original_goal'],'Original project goal')
        self.assertEqual(context['task_history'][0]['id'],task['id'])
        self.assertEqual(context['saved_workers'][0]['worker'],original.id)
        self.runtime.action(self.c,dict(kind='resume',worker_id=original.id),'resume-worker')
        resumed=next(iter(self.terminals.sessions.values()))
        self.assertEqual(resumed.parent_id,self.c['id'])
        self.assertIn(native,resumed.argv);self.assertIn('reply '+task['id'],resumed.argv[-1])
        self.assertEqual(len(self.box.inbox(self.runtime.desk,self.c['id'],True)),1)
        self.assertEqual(self.box.get(self.runtime.desk,task['id'])['worker'],resumed.id)
        self.assertIsNone(self.box.get(self.runtime.desk,task['id'])['result'])

    def test_worker_without_native_id_is_retained_but_never_guessed(self):
        self.runtime.action(self.c,dict(kind='launch',name='Worker',profile='claude',task='Fix'),'launch')
        worker=next(iter(self.terminals.sessions.values()));self.runtime.close()
        self.terminals=FakeTerminals();self.terminals.launched=[{}]
        self.runtime=CoordinatorRuntime(self.root/'coordinator.sqlite3',self.terminals,self.box)
        self.runtime.recover_workers();saved=self.runtime.saved_workers(self.c['id'])[0]
        self.assertEqual(saved['state'],'unavailable');self.assertFalse(saved['can_resume'])
        with self.assertRaises(ValueError):self.runtime.resume_worker(dict(id=self.c['id'],worker_id=worker.id))
        self.assertEqual(self.terminals.sessions,{})

    def test_original_worker_reappears_when_its_legacy_owner_reconnects(self):
        self.runtime.action(self.c,dict(kind='launch',name='Worker',profile='claude',task='Fix'),'launch')
        worker=next(iter(self.terminals.sessions.values()))
        self.terminals.sessions.pop(worker.id)
        self.runtime.recover_workers()
        self.assertIn(worker.id,self.runtime.hidden_workers())
        self.terminals.sessions[worker.id]=worker
        self.assertNotIn(worker.id,self.runtime.hidden_workers())
        self.assertEqual(self.runtime.saved_workers(self.c['id']),[])
        with self.runtime.db() as db:
            self.assertIsNotNone(db.execute('SELECT 1 FROM saved_workers WHERE worker=?',(worker.id,)).fetchone())

    def test_new_coordinator_providers_and_settings_survive_reload(self):
        for profile in ('codex','codex-personal','grok'):
            c=self.runtime.create(dict(name='Provider '+profile,cwd=str(self.root),profile=profile,model='selected-model'))
            self.assertEqual(self.runtime.get(c['id'])['model'],'selected-model')
            info=next(a for a in self.runtime.agents() if a['id']==c['id'])
            self.assertEqual(info['harness'],profile.split('-')[0])
            persisted=next(a for a in self.runtime.snapshot()['coordinators'] if a['id']==c['id'])
            self.assertEqual(persisted['profile'],profile);self.assertEqual(persisted['model'],'selected-model')
        with self.assertRaises(ValueError):self.runtime.create(dict(name='Invalid',cwd=str(self.root),profile='grok',model='--bad-flag'))

    def test_review_discovers_exact_native_session_and_full_report(self):
        session=self.terminals.launch({'parent_id':self.c['id'],'launch_profile':'claude-personal','argv':['claude','task-review-native']})
        self.box.create(self.runtime.desk,self.c['id'],session.id,'Review task','task-review-native')
        with self.box.connect() as db:db.execute("UPDATE tasks SET result=?,outcome='completed' WHERE id=?",('Report '+('detail '*1500),'task-review-native'))
        with patch('agent_desk.native_session_lookup.find_conversation',return_value='12345678-1234-1234-1234-123456789abc') as lookup:
            result=self.runtime.review_worker({'id':self.c['id'],'worker_id':session.id,'task_id':'task-review-native'})
            self.assertEqual(result['session_id'],'12345678-1234-1234-1234-123456789abc')
            self.assertGreater(len(result['result']),6000)
            self.assertEqual(self.runtime.resolve_worker_session(session),result['session_id'])
            lookup.assert_called_once_with('claude-personal','task-review-native')

    def test_grok_review_discovers_and_saves_exact_session(self):
        session=self.terminals.launch({'parent_id':self.c['id'],'argv':['grok','--','reply task-grok --file /tmp/result']})
        self.box.create(self.runtime.desk,self.c['id'],session.id,'Review Grok work','task-grok')
        self.box.reply(self.runtime.desk,'task-grok','Done','completed')
        with patch('agent_desk.native_session_lookup.find_conversation',return_value='12345678-1234-1234-1234-123456789abc') as lookup:
            result=self.runtime.review_worker({'id':self.c['id'],'worker_id':session.id,'task_id':'task-grok'})
            self.assertTrue(result['session_id'])
            lookup.assert_called_once_with('grok','task-grok')
            self.runtime.retire_worker({'id':self.c['id'],'worker_id':session.id,'task_id':'task-grok','confirmed':True})
            saved=self.runtime.saved_workers(self.c['id'])[0]
            self.assertEqual(saved['profile'],'grok');self.assertTrue(saved['can_resume'])

    def test_feedback_submission_is_durable_and_preserves_coordinates(self):
        from agent_desk.feedback_delivery import submit_feedback
        notes=[{'id':'pin-1','note':'Make this clearer','selector':'#button','point':{'viewportX':412,'viewportY':55},'viewport':{'width':1440,'height':1000}}]
        payload={'target_id':self.c['id'],'request_id':'annotation-submit','notes':notes}
        self.assertTrue(submit_feedback(self.runtime,payload)['sent'])
        self.assertTrue(submit_feedback(self.runtime,payload)['duplicate'])
        messages=self.runtime.snapshot(self.c['id'])['messages'];self.assertEqual(len(messages),1)
        reference=messages[0]['text'].split('Use recall to read ')[1].split(' ')[0]
        self.assertEqual(json.loads(self.runtime.retrieve(self.c['id'],reference)['text']),notes)
        with self.assertRaises(ValueError):submit_feedback(self.runtime,payload|{'notes':[notes[0]|{'note':'Different'}]})

    def test_feedback_terminal_guard_and_ambiguous_delivery(self):
        from agent_desk.feedback_delivery import submit_feedback
        session=self.terminals.launch({'parent_id':None})
        payload={'target_id':session.id,'request_id':'terminal-feedback','notes':[{'id':'p','note':'Fix spacing'}]}
        def fail(text,before_send=None):
            before_send();raise ValueError('Disconnected')
        session.send_task=fail
        with self.assertRaisesRegex(ValueError,'Disconnected'):submit_feedback(self.runtime,payload)
        with self.assertRaisesRegex(ValueError,'interrupted'):submit_feedback(self.runtime,payload)
        session.parent_id=self.c['id']
        with self.assertRaisesRegex(ValueError,'coordinator'):submit_feedback(self.runtime,payload|{'request_id':'other'})

    def test_feedback_terminal_snapshot_and_busy_retry(self):
        from agent_desk.feedback_delivery import submit_feedback
        session=self.terminals.launch({'parent_id':None})
        payload={'target_id':session.id,'request_id':'terminal-feedback','notes':[{'id':'p','note':'Fix spacing'}]}
        original=session.send_task
        session.send_task=lambda *args,**kwargs:(_ for _ in ()).throw(ValueError('Busy'))
        with self.assertRaisesRegex(ValueError,'Busy'):submit_feedback(self.runtime,payload)
        session.send_task=original
        self.assertTrue(submit_feedback(self.runtime,payload)['sent'])
        self.assertTrue(submit_feedback(self.runtime,payload)['duplicate'])
        self.assertEqual(len(session.followups),1)
        files=list((self.root/'feedback-submissions').glob('*.json'));self.assertEqual(len(files),1)
        self.assertEqual(json.loads(files[0].read_text()),payload['notes'])
        self.assertEqual(files[0].stat().st_mode&0o777,0o600)

    def test_tool_feedback_arrives_as_its_own_prompt(self):
        from agent_desk.feedback_delivery import submit_feedback
        session=self.terminals.launch({'parent_id':None})
        payload={'target_id':session.id,'request_id':'review-feedback','prompt':'Review feedback on /repo:\n- src/signup.js:7 Name this pattern.\n','notes':[{'id':'p','note':'Saved review submission'}]}
        self.assertTrue(submit_feedback(self.runtime,payload)['sent'])
        self.assertEqual(session.followups,['Review feedback on /repo:\n- src/signup.js:7 Name this pattern.\nSubmission: review-feedback'])
        self.assertTrue(submit_feedback(self.runtime,payload)['duplicate'])
        with self.assertRaisesRegex(ValueError,'different feedback'):submit_feedback(self.runtime,payload|{'prompt':'Something else'})
        for bad in ('',' ',7,'x'*6001):
            with self.assertRaisesRegex(ValueError,'Invalid feedback prompt'):submit_feedback(self.runtime,payload|{'request_id':'other','prompt':bad})

    def test_feedback_waits_for_busy_terminal_and_delivers_once(self):
        from agent_desk.feedback_delivery import submit_feedback, drain_feedback
        from agent_desk.worker_screen import WorkerNotReady
        session=self.terminals.launch({'parent_id':None})
        payload={'target_id':session.id,'request_id':'queued-feedback','notes':[{'id':'p','note':'Add a local skills finder'}]}
        original=session.send_task
        session.send_task=lambda *args,**kwargs:(_ for _ in ()).throw(WorkerNotReady('busy prompt'))
        result=submit_feedback(self.runtime,payload)
        self.assertTrue(result['queued'])
        self.assertTrue(submit_feedback(self.runtime,payload)['duplicate'])
        drain_feedback(self.runtime)
        session.send_task=original
        self.assertEqual(len(session.followups),0)
        drain_feedback(self.runtime)
        self.assertEqual(len(session.followups),1)
        self.assertTrue(submit_feedback(self.runtime,payload)['sent'])
        drain_feedback(self.runtime)
        self.assertEqual(len(session.followups),1)

    def test_feedback_status_cancellation_and_failure_are_durable(self):
        from agent_desk.feedback_delivery import submit_feedback,drain_feedback,feedback_status,cancel_feedback
        from agent_desk.worker_screen import WorkerNotReady
        session=self.terminals.launch({'parent_id':None})
        payload={'target_id':session.id,'request_id':'cancel-feedback','notes':[{'id':'pin','note':'Fix this'}]}
        original=session.send_task
        session.send_task=lambda *args,**kwargs:(_ for _ in ()).throw(WorkerNotReady('Draft in composer'))
        submit_feedback(self.runtime,payload)
        state=feedback_status(self.runtime,{})['submissions'][0]
        self.assertEqual(state['state'],'queued');self.assertIn('Draft',state['detail'])
        cancel_feedback(self.runtime,{'request_id':'cancel-feedback'})
        session.send_task=original;drain_feedback(self.runtime)
        self.assertEqual(len(session.followups),0)
        self.assertEqual(feedback_status(self.runtime,{})['submissions'][0]['state'],'cancelled')
        session.send_task=lambda *args,**kwargs:(_ for _ in ()).throw(WorkerNotReady('Busy'))
        submit_feedback(self.runtime,payload|{'request_id':'fail-feedback'})
        session.send_task=lambda *args,**kwargs:(_ for _ in ()).throw(ValueError('Worker exited'))
        drain_feedback(self.runtime)
        state=feedback_status(self.runtime,{})['submissions'][0]
        self.assertEqual(state['state'],'failed');self.assertEqual(state['detail'],'Worker exited')

    def test_api_auth_and_persistent_message_submission(self):
        from agent_desk import server
        http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
        base='http://127.0.0.1:'+str(http.server_port)
        try:
            with patch.object(server,'COORDINATORS',self.runtime):
                for path,body in [('/api/coordinators',None),('/api/coordinators/message',{}),('/api/coordinators/quota',{}),('/api/coordinators/submit-feedback',{})]:
                    with self.assertRaises(HTTPError) as caught:urlopen(Request(base+path,data=json.dumps(body).encode() if body is not None else None))
                    self.assertEqual(caught.exception.code,403);caught.exception.close()
                headers={'X-Agent-Desk-Terminal':server.TERMINAL_TOKEN,'Content-Type':'application/json'}
                payload=dict(id=self.c['id'],request_id='api-message',text='Saved through the API')
                for _ in range(2):
                    with urlopen(Request(base+'/api/coordinators/message',headers=headers,data=json.dumps(payload).encode())) as r:self.assertTrue(json.load(r)['saved'])
                with urlopen(Request(base+'/api/coordinators?id='+self.c['id'],headers=headers)) as r:snapshot=json.load(r)
                self.assertEqual([m['text'] for m in snapshot['messages']],['Saved through the API'])
                with patch.object(self.runtime.account_quota,'read',return_value={'state':'unavailable','windows':[]}) as quota:
                    payload={'id':self.c['id'],'profile':'codex-personal'}
                    with urlopen(Request(base+'/api/coordinators/quota',headers=headers,data=json.dumps(payload).encode())) as r:
                        self.assertEqual(json.load(r)['state'],'unavailable')
                    quota.assert_called_once_with(self.runtime.get(self.c['id'])['profile'],refresh=False)
                body={'target_id':self.c['id'],'request_id':'api-feedback','notes':[{'id':'pin-api','note':'Fix spacing','point':{'viewportX':40,'viewportY':80}}]}
                for _ in range(2):
                    with urlopen(Request(base+'/api/coordinators/submit-feedback',headers=headers,data=json.dumps(body).encode())) as r:
                        self.assertTrue(json.load(r)['sent'])
                self.assertEqual(len(self.runtime.snapshot(self.c['id'])['messages']),2)


        finally:http.shutdown();http.server_close();thread.join(2)


if __name__=='__main__':unittest.main()
