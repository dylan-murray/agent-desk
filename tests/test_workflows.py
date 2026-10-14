from datetime import datetime, timezone
from pathlib import Path
import socket
import json
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from agent_desk.workflow_runtime import WorkflowRuntime, next_cron
from agent_desk.special_agents import SpecialAgents

class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.runtime=WorkflowRuntime(Path(self.temp.name)/'workflows.sqlite3')
    def tearDown(self):
        for row in self.runtime.snapshot()['executions']:
            if row['state'] in ('queued','starting','running','ready'):self.runtime.stop(row['id'])
        for child in self.runtime.children.values():
            try:child.wait(timeout=6)
            except Exception:child.kill();child.wait()
        self.temp.cleanup()
    def config(self,name,code='print("done")'):
        return self.runtime.save_config(dict(name=name,kind='command',cwd=self.temp.name,argv=[sys.executable,'-c',code],timeout=10))
    def flow(self,nodes,**values):
        return self.runtime.save_workflow(dict(name='Pipeline',trigger='manual',timezone='UTC',nodes=nodes,**values))
    def wait(self,predicate,timeout=15):
        end=time.time()+timeout
        while time.time()<end:
            self.runtime.tick();state=self.runtime.snapshot()
            if predicate(state):return state
            time.sleep(.1)
        self.fail(str(self.runtime.snapshot()))
    def test_dag_order_failure_propagation_and_cycle_validation(self):
        first=self.config('first','import sys;sys.exit(2)');second=self.config('second')
        nodes=[dict(id='a',config_id=first['id'],depends_on=[]),dict(id='b',config_id=second['id'],depends_on=['a'])]
        flow=self.flow(nodes);self.runtime.start_flow(flow['id'])
        with self.assertRaises(ValueError):self.runtime.start_flow(flow['id'])
        state=self.wait(lambda s:s['flows'][0]['state']=='failed')
        self.assertEqual({r['node_id']:r['state'] for r in state['executions']},{'a':'failed','b':'skipped'})
        nodes[0]['depends_on']=['b']
        with self.assertRaises(ValueError):self.flow(nodes)
    def test_successful_dependency_chain_uses_same_run(self):
        first=self.config('first',"from pathlib import Path;Path('upstream').write_text('ok')")
        second=self.config('second',"from pathlib import Path;assert Path('upstream').read_text()=='ok';print('verified')")
        flow=self.flow([dict(id='a',config_id=first['id'],depends_on=[]),dict(id='b',config_id=second['id'],depends_on=['a'])]);run=self.runtime.start_flow(flow['id'])
        state=self.wait(lambda s:s['flows'][0]['state']=='succeeded')
        self.assertTrue(all(r['flow_id']==run['id'] and r['state']=='succeeded' for r in state['executions']))
        self.assertIn('verified',self.runtime.logs(next(r['id'] for r in state['executions'] if r['node_id']=='b'))['text'])
    def test_apps_get_distinct_ports_and_survive_runtime_recreation(self):
        configs=[self.runtime.save_config(dict(name=name,kind='app',cwd=self.temp.name,argv=[sys.executable,'-c','import http.server,socketserver,sys;socketserver.TCPServer(("127.0.0.1",int(sys.argv[1])),http.server.SimpleHTTPRequestHandler).serve_forever()','{port}'],timeout=10)) for name in ['one','two']]
        runs=[self.runtime.start(c['id']) for c in configs]
        state=self.wait(lambda s:sum(r['state']=='ready' for r in s['executions'])==2)
        ports=[r['port'] for r in state['executions']];self.assertEqual(len(set(ports)),2)
        reopened=WorkflowRuntime(self.runtime.path)
        self.assertEqual(reopened.start(configs[0]['id'])['id'],runs[0]['id'])
        for port in ports:
            with socket.create_connection(('127.0.0.1',port),timeout=2):pass
        reopened.stop(runs[0]['id'])
        self.wait(lambda s:next(r for r in s['executions'] if r['id']==runs[0]['id'])['state']=='cancelled')
        self.assertEqual(next(r for r in self.runtime.snapshot()['executions'] if r['id']==runs[1]['id'])['state'],'ready')
    def test_once_pause_and_claim_are_durable(self):
        config=self.config('once');flow=self.flow([dict(id='a',config_id=config['id'],depends_on=[])])
        flow.update(trigger='once',at=time.time()+60,enabled=True);self.runtime.save_workflow(flow)
        self.runtime.toggle(flow['id'],False);self.assertIsNone(self.runtime.snapshot()['workflows'][0]['next_due'])
        self.runtime.toggle(flow['id'],True)
        with self.runtime.db() as db:db.execute('UPDATE workflows SET next_due=?',(time.time()-1,))
        state=self.wait(lambda s:s['flows'] and s['flows'][0]['state']=='succeeded')
        self.assertEqual(len(state['flows']),1);self.assertIsNone(state['workflows'][0]['next_due']);self.runtime.tick();self.assertEqual(len(self.runtime.snapshot()['flows']),1)
    def test_cron_timezone_and_invalid_expressions(self):
        after=datetime(2026,9,7,12,59,tzinfo=timezone.utc).timestamp()
        expected=datetime(2026,9,7,13,0,tzinfo=timezone.utc).timestamp()
        self.assertEqual(next_cron('0 9 * * 1-5','America/New_York',after),expected)
        for expr in ['* * *','60 * * * *','*/0 * * * *','-1 * * * *']:
            with self.assertRaises(ValueError):next_cron(expr,'UTC',after)

    def test_cancellation_and_review_survive_reopen(self):
        config=self.config('slow','import time;time.sleep(60)')
        run=self.runtime.start(config['id']);self.runtime.stop(run['id'])
        self.runtime.update(run['id'],state='running')
        self.assertEqual(self.runtime.snapshot()['executions'][0]['state'],'cancelled')
        self.runtime.review(dict(id=run['id'],state='done'))
        self.assertEqual(WorkflowRuntime(self.runtime.path).snapshot()['executions'][0]['review_state'],'done')

    def test_scheduler_recovers_automation_report_after_worker_exit(self):
        agents=SpecialAgents(Path(self.temp.name)/'special-agents.sqlite3')
        role=agents.save_role(dict(name='Scoped pass',kind='watcher',scope='Fixture only',
            instructions='Check fixture',cwd=self.temp.name,choice='claude',command='claude',mode='direct'))
        config=self.runtime.save_config(dict(name='Automation',kind='automation',role_id=role['id'],timeout=30))
        for outcome, expected in [('review','succeeded'),('blocked','blocked'),('failed','failed')]:
            with self.subTest(outcome=outcome):
                agent_run=agents.start_run(role['id'])
                agents.report(dict(run_id=agent_run['id'],state=outcome,detail='Durable result'))
                with self.runtime.db() as db:
                    db.execute('INSERT INTO executions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                        (agent_run['id'],config['id'],None,None,json.dumps(config),'running',999999,None,'',time.time()-20,None,agent_run['id'],None))
                with patch.object(self.runtime,'owned',return_value=False):self.runtime.tick()
                with self.runtime.db() as db:
                    row=db.execute('SELECT state,detail FROM executions WHERE id=?',(agent_run['id'],)).fetchone()
                self.assertEqual((row['state'],row['detail']),(expected,'Durable result'))

    def test_stale_scheduler_interrupt_does_not_replace_finished_result(self):
        config=self.config('Finished')
        with self.runtime.db() as db:
            db.execute('INSERT INTO executions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                ('finished',config['id'],None,None,json.dumps(config),'succeeded',999999,None,'Complete',time.time()-20,time.time(),None,None))
        self.runtime.update('finished',expected_states=('starting','running','ready'),state='interrupted',detail='Stale check')
        with self.runtime.db() as db:
            row=db.execute('SELECT state,detail FROM executions WHERE id=?',('finished',)).fetchone()
        self.assertEqual((row['state'],row['detail']),('succeeded','Complete'))


    def test_schedule_update_and_delete_keep_history_without_duplicates(self):
        config=self.config('Task')
        payload=dict(id='stable-schedule',name='Morning',trigger='cron',cron='0 9 * * *',timezone='UTC',enabled=True,nodes=[dict(id='task',config_id=config['id'],depends_on=[])])
        first=self.runtime.save_workflow(payload)
        self.runtime.save_workflow(dict(payload,update=True,cron='0 10 * * *'))
        self.runtime.save_workflow(dict(payload,update=True,cron='0 10 * * *'))
        self.assertEqual(len(self.runtime.snapshot()['workflows']),1)
        flow=self.runtime.start_flow(first['id'])
        self.runtime.delete_workflow(first['id']);self.runtime.delete_workflow(first['id'])
        state=self.runtime.snapshot()
        self.assertEqual(state['workflows'],[])
        self.assertEqual(state['flows'][0]['id'],flow['id'])
        self.assertTrue(state['configs'])
        with self.assertRaisesRegex(ValueError,'deleted'):
            self.runtime.save_workflow(dict(payload,update=True))

    def test_configuration_delete_preserves_named_runs_logs_and_review(self):
        config=self.config('Named historical task','print("retained output")')
        workflow=self.flow([dict(id='task',config_id=config['id'],depends_on=[])])
        flow=self.runtime.start_flow(workflow['id'])
        state=self.wait(lambda s:s['flows'][0]['state']=='succeeded')
        run=state['executions'][0]
        self.runtime.review(dict(id=run['id'],state='done'))
        self.runtime.delete_workflow(workflow['id'])
        self.runtime.delete_config(config['id']);self.runtime.delete_config(config['id'])
        reopened=WorkflowRuntime(self.runtime.path);state=reopened.snapshot()
        self.assertEqual(state['configs'],[])
        self.assertEqual(state['flows'][0]['workflow_name'],'Pipeline')
        self.assertEqual(state['flows'][0]['id'],flow['id'])
        self.assertEqual(state['executions'][0]['config_name'],'Named historical task')
        self.assertEqual(state['executions'][0]['config_kind'],'command')
        self.assertEqual(state['executions'][0]['review_state'],'done')
        self.assertNotIn('payload',state['executions'][0])
        self.assertIn('retained output',reopened.logs(run['id'])['text'])
        with self.assertRaisesRegex(ValueError,'not found'):reopened.start(config['id'])
        with self.assertRaisesRegex(ValueError,'deleted'):reopened.save_config(dict(config,update=True))

    def test_configuration_delete_blocks_workflow_references_and_active_states(self):
        config=self.config('In use')
        workflow=self.flow([dict(id='task',config_id=config['id'],depends_on=[])])
        with self.assertRaisesRegex(ValueError,'Pipeline'):self.runtime.delete_config(config['id'])
        self.assertEqual(self.runtime.config(config['id']),config)
        self.runtime.start_flow(workflow['id'])
        self.runtime.delete_workflow(workflow['id'])
        run=self.runtime.snapshot()['executions'][0]
        for state in ('queued','starting','running','ready'):
            self.runtime.update(run['id'],state=state)
            with self.subTest(state=state),self.assertRaisesRegex(ValueError,'active run'):
                self.runtime.delete_config(config['id'])
        self.runtime.update(run['id'],state='succeeded',finished=time.time())
        self.runtime.delete_config(config['id'])
        self.assertEqual(self.runtime.snapshot()['configs'],[])
        for invalid in (None,[],{},'',True):
            with self.subTest(invalid=invalid),self.assertRaises(ValueError):self.runtime.delete_config(invalid)

    def test_configuration_deleted_during_workflow_validation_is_rejected(self):
        config=self.config('Concurrent delete')
        original=self.runtime.config
        def deleted_after_read(identity):
            result=original(identity);self.runtime.delete_config(identity);return result
        with patch.object(self.runtime,'config',side_effect=deleted_after_read):
            with self.assertRaisesRegex(ValueError,'deleted'):
                self.flow([dict(id='task',config_id=config['id'],depends_on=[])])
        self.assertEqual(self.runtime.snapshot()['workflows'],[])
