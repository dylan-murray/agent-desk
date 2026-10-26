"""Durable local launch configurations and scheduled DAG runs."""
from agent_desk.paths import DATA_DIR
import json
import os
import re
import secrets
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from agent_desk.event_bus import EventBus, predicate
from agent_desk.managed_processes import OwnedProcesses

ROOT = Path(__file__).resolve().parents[1]


def cron_fields(expression):
    if not isinstance(expression, str) or len(expression) > 100:
        raise ValueError('Enter a five-field cron expression')
    parts = expression.split()
    if len(parts) != 5:
        raise ValueError('Cron needs minute, hour, day, month, weekday')
    fields = []
    for part, low, high in zip(parts, [0,0,1,1,0], [59,23,31,12,7]):
        values = set()
        for entry in part.split(','):
            base, *step = entry.split('/')
            if len(step)>1 or step and (not step[0].isdigit() or int(step[0])<1):
                raise ValueError('Invalid cron step')
            stride = int(step[0]) if step else 1
            if base == '*': a,b=low,high
            elif re.fullmatch(r'\d+-\d+',base): a,b=map(int,base.split('-'))
            elif base.isdigit(): a,b=int(base),(high if step else int(base))
            else: raise ValueError('Use numbers, *, ranges, lists, or steps in cron')
            if not low<=a<=b<=high: raise ValueError('Cron field is out of range')
            values.update(range(a,b+1,stride))
        fields.append(values)
    fields[4]={v%7 for v in fields[4]}
    return parts,fields


def next_cron(expression, zone, after):
    parts,fields=cron_fields(expression)
    try: tz=ZoneInfo(zone)
    except (KeyError,ValueError,TypeError): raise ValueError('Choose an IANA timezone, such as America/New_York') from None
    candidate=(int(after)//60+1)*60
    for _ in range(366*24*60):
        date=datetime.fromtimestamp(candidate,tz)
        dom=date.day in fields[2];dow=(date.weekday()+1)%7 in fields[4]
        day=(dom and dow) if parts[2].startswith('*') or parts[4].startswith('*') else (dom or dow)
        if date.minute in fields[0] and date.hour in fields[1] and day and date.month in fields[3]:return candidate
        candidate+=60
    raise ValueError('No cron occurrence within the next year')


class WorkflowRuntime:
    def __init__(self, path=None, desk='http://127.0.0.1:4310'):
        self.path=Path(path or DATA_DIR/'workflows.sqlite3').resolve()
        self.desk=desk;self.lock=threading.RLock();self.stopping=threading.Event();self.desktop_paused=threading.Event();self.children={}
        self.events=EventBus(self)

    @contextmanager
    def db(self):
        self.path.parent.mkdir(parents=True,exist_ok=True)
        db=sqlite3.connect(self.path,timeout=10);self.path.chmod(0o600);db.row_factory=sqlite3.Row
        try:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY,state TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS configs(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS workflows(id TEXT PRIMARY KEY,payload TEXT NOT NULL,next_due REAL);
            CREATE TABLE IF NOT EXISTS flows(id TEXT PRIMARY KEY,workflow_id TEXT,payload TEXT,state TEXT,created REAL,finished REAL);
            CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY,config_id TEXT,flow_id TEXT,node_id TEXT,payload TEXT,state TEXT,pid INTEGER,port INTEGER,detail TEXT,created REAL,finished REAL,agent_run TEXT,terminal_id TEXT);
            ''')
            EventBus.schema(db)
            with db:yield db
        finally:db.close()

    def update(self,identity,*,expected_states=None,**fields):
        allowed={'state','pid','port','detail','finished','agent_run','terminal_id'}
        if not fields or not set(fields)<=allowed:raise ValueError('Invalid execution update')
        with self.db() as db:
            condition=" WHERE id=? AND (state!='cancelled' OR ?='cancelled')"
            parameters=[*fields.values(),identity,fields.get('state')]
            if expected_states is not None:
                condition+=' AND state IN ('+','.join('?' for _ in expected_states)+')'
                parameters.extend(expected_states)
            changed=db.execute('UPDATE executions SET '+','.join(k+'=?' for k in fields)+condition,parameters).rowcount
            if changed and fields.get('state') in ('failed','blocked','interrupted'):
                db.execute('DELETE FROM reviews WHERE id=?',(identity,))

    def snapshot(self):
        with self.db() as db:
            flows=[]
            for row in db.execute('SELECT * FROM flows ORDER BY created DESC LIMIT 100'):
                saved=json.loads(row['payload'])
                flows.append({k:row[k] for k in ('id','workflow_id','state','created','finished')} |
                             dict(workflow_name=saved['name'],trigger=saved['trigger']))
            executions=[]
            for row in db.execute("SELECT executions.*,COALESCE(reviews.state,'review') AS review_state FROM executions LEFT JOIN reviews ON reviews.id=executions.id ORDER BY created DESC LIMIT 500"):
                saved=json.loads(row['payload'])
                executions.append({k:v for k,v in dict(row).items() if k!='payload'} |
                                  dict(config_name=saved['name'],config_kind=saved['kind']))
            return dict(capabilities=dict(event_triggers=True,delete_config=True),
                configs=[json.loads(r[0]) for r in db.execute('SELECT payload FROM configs')],
                workflows=[dict(json.loads(r['payload']),next_due=r['next_due']) for r in db.execute('SELECT * FROM workflows')],
                flows=flows,executions=executions)

    def config(self,identity):
        with self.db() as db:r=db.execute('SELECT payload FROM configs WHERE id=?',(identity,)).fetchone()
        if not r:raise ValueError('Launch configuration not found')
        return json.loads(r[0])

    def save_config(self,p):
        if not isinstance(p.get('name'),str) or not 1<=len(p['name'].strip())<=100:raise ValueError('Enter a name')
        kind=p.get('kind')
        if kind not in ('app','command','automation'):raise ValueError('Choose app, command, or automation')
        item=dict(id=p.get('id') or secrets.token_hex(12),name=p['name'].strip(),kind=kind)
        if not isinstance(item['id'],str) or not re.fullmatch(r'[\w-]{1,100}',item['id']):raise ValueError('Invalid configuration ID')
        if kind=='automation':
            if not isinstance(p.get('role_id'),str) or not p['role_id']:raise ValueError('Choose a saved automation')
            item['role_id']=p['role_id']
        else:
            cwd=p.get('cwd','');argv=p.get('argv')
            if not isinstance(cwd,str) or not Path(cwd).is_absolute() or not Path(cwd).is_dir():raise ValueError('Choose an existing absolute project directory')
            if not isinstance(argv,list) or not 1<=len(argv)<=100 or any(not isinstance(a,str) or '\0' in a or len(a)>10000 for a in argv) or not argv[0]:raise ValueError('Enter an executable and arguments')
            if kind=='app' and not any('{port}' in arg for arg in argv):raise ValueError('App command must include {port}; PORT is also set automatically')
            item.update(cwd=cwd,argv=argv)
        timeout=p.get('timeout',3600)
        if type(timeout) is not int or not 10<=timeout<=86400:raise ValueError('Timeout must be 10–86400 seconds')
        item['timeout']=timeout
        with self.lock,self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if p.get('update') and not db.execute('SELECT 1 FROM configs WHERE id=?',(item['id'],)).fetchone():
                raise ValueError('This configuration was deleted. Close the editor and refresh.')
            for row in db.execute('SELECT id,payload FROM workflows').fetchall():
                rule=json.loads(row['payload'])
                if rule['trigger']=='event' and any(n['config_id']==item['id'] for n in rule['nodes']):
                    rule['enabled']=False
                    self.events.discard(db,'workflow_id',rule['id'],'Launch configuration edited; enable the rule again')
                    db.execute('UPDATE workflows SET payload=? WHERE id=?',(json.dumps(rule),rule['id']))
            db.execute('INSERT OR REPLACE INTO configs VALUES (?,?)',(item['id'],json.dumps(item)))
        return item

    def delete_config(self,identity):
        if not isinstance(identity,str) or not re.fullmatch(r'[\w-]{1,100}',identity):
            raise ValueError('Choose a launch configuration')
        with self.lock,self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute("SELECT 1 FROM executions WHERE config_id=? AND state IN ('queued','starting','running','ready')",(identity,)).fetchone():
                raise ValueError('This configuration has an active run. Stop it or wait for it to finish before deleting.')
            used=[]
            for row in db.execute('SELECT payload FROM workflows'):
                workflow=json.loads(row[0])
                if any(node['config_id']==identity for node in workflow['nodes']):used.append(workflow['name'])
            if used:
                raise ValueError('Used by '+', '.join(used[:5])+('.' if len(used)<=5 else f' and {len(used)-5} more workflows.')+
                                 ' Remove this task from those workflows, or delete the workflows first.')
            db.execute('DELETE FROM configs WHERE id=?',(identity,))
        return dict(deleted=True,id=identity)

    def save_workflow(self,p):
        name=p.get('name');nodes=p.get('nodes');zone=p.get('timezone','UTC');trigger=p.get('trigger','manual');now=time.time()
        if not isinstance(name,str) or not 1<=len(name.strip())<=100:raise ValueError('Enter a workflow name')
        if not isinstance(nodes,list) or not 1<=len(nodes)<=30:raise ValueError('Add 1–30 tasks')
        ids=[n.get('id') for n in nodes if isinstance(n,dict)]
        if len(ids)!=len(nodes) or any(not isinstance(i,str) or not re.fullmatch(r'[\w-]{1,80}',i) for i in ids) or len(set(ids))!=len(ids):raise ValueError('Task IDs must be unique')
        normalized=[]
        for node in nodes:
            config=self.config(node.get('config_id'));deps=node.get('depends_on',[])
            if not isinstance(deps,list) or any(not isinstance(d,str) or d not in ids or d==node['id'] for d in deps) or len(set(deps))!=len(deps):raise ValueError('Invalid task dependencies')
            normalized.append(dict(id=node['id'],config_id=config['id'],depends_on=deps))
        done=set()
        while len(done)<len(nodes):
            ready={n['id'] for n in normalized if set(n['depends_on'])<=done}-done
            if not ready:raise ValueError('Dependencies contain a cycle; workflows must be DAGs')
            done|=ready
        item=dict(id=p.get('id') or secrets.token_hex(12),name=name.strip(),nodes=normalized,trigger=trigger,timezone=zone,enabled=bool(p.get('enabled',False)))
        if not isinstance(item['id'],str) or not re.fullmatch(r'[\w-]{1,100}',item['id']):raise ValueError('Invalid workflow ID')
        try:ZoneInfo(zone)
        except (KeyError,ValueError,TypeError):raise ValueError('Invalid timezone') from None
        due=None
        if trigger=='cron':item['cron']=p.get('cron');due=next_cron(item['cron'],zone,now)
        elif trigger=='once':
            due=p.get('at')
            if type(due) not in (int,float) or not now<due<now+366*86400:raise ValueError('Choose a future time within the next year')
            item['at']=due
        elif trigger=='event':
            event=p.get('event')
            if not isinstance(event,dict) or set(event)!={'source_id','predicate'} or not isinstance(event['source_id'],str):raise ValueError('Choose an event source and payload predicate')
            item['event']=dict(source_id=event['source_id'],predicate=predicate(event['predicate']))
            # Saving (including an agent API call) never authorizes external execution.
            item.update(enabled=False,event_version=secrets.token_hex(12))
        elif trigger!='manual':raise ValueError('Choose manual, once, cron, or event')
        with self.lock,self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if p.get('update') and not db.execute('SELECT 1 FROM workflows WHERE id=?',(item['id'],)).fetchone():raise ValueError('This schedule was deleted. Close the editor and refresh.')
            # A configuration may have been deleted after validation, before this transaction.
            for node in normalized:
                if not db.execute('SELECT 1 FROM configs WHERE id=?',(node['config_id'],)).fetchone():
                    raise ValueError('A launch configuration was deleted. Refresh and choose its replacement.')
            if trigger=='event' and not db.execute('SELECT 1 FROM event_sources WHERE id=?',(item['event']['source_id'],)).fetchone():raise ValueError('Event source not found')
            self.events.discard(db,'workflow_id',item['id'],'Rule edited; waiting events discarded')
            db.execute('INSERT INTO workflows VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,next_due=excluded.next_due',(item['id'],json.dumps(item),due if item['enabled'] else None))
        return item

    def delete_workflow(self,identity):
        if not isinstance(identity,str) or not identity:raise ValueError('Choose a schedule')
        with self.lock,self.db() as db:
            self.events.discard(db,'workflow_id',identity,'Rule deleted; waiting events discarded')
            db.execute('DELETE FROM workflows WHERE id=?',(identity,))
        return {'deleted':True,'id':identity}

    def toggle(self,identity,enabled,*,human=False):
        with self.lock,self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            r=db.execute('SELECT payload FROM workflows WHERE id=?',(identity,)).fetchone()
            if not r:raise ValueError('Workflow not found')
            item=json.loads(r[0]);item['enabled']=bool(enabled)
            if item['trigger']=='event':
                if enabled and not human:raise ValueError('Enable event rules explicitly from the Agent Desk UI')
                if not enabled:self.events.discard(db,'workflow_id',identity,'Rule paused; waiting events discarded')
            if item['trigger']=='once' and item['at']<=time.time() and enabled:raise ValueError('Edit this schedule to choose a new future time')
            due=(next_cron(item['cron'],item['timezone'],time.time()) if item['trigger']=='cron' else item.get('at')) if enabled else None
            db.execute('UPDATE workflows SET payload=?,next_due=? WHERE id=?',(json.dumps(item),due,identity))
        return {'ok':True}

    def enqueue_flow(self,db,identity,event=None):
        row=db.execute('SELECT payload FROM workflows WHERE id=?',(identity,)).fetchone()
        if not row:raise ValueError('Workflow not found')
        if db.execute("SELECT 1 FROM flows WHERE workflow_id=? AND state='running'",(identity,)).fetchone():raise ValueError('This workflow already has an active run')
        flow=json.loads(row[0]);flow['configs']={n['config_id']:json.loads(db.execute('SELECT payload FROM configs WHERE id=?',(n['config_id'],)).fetchone()[0]) for n in flow['nodes']}
        if flow['trigger']=='event' and (not flow['enabled'] or event is None):raise ValueError('Enabled event rules run only from matching source events')
        if event is not None:
            flow['event_context']=event
            for config in flow['configs'].values():config['event_context']=event
        run=secrets.token_hex(12)
        db.execute('INSERT INTO flows VALUES (?,?,?,?,?,NULL)',(run,identity,json.dumps(flow),'running',time.time()))
        for node in flow['nodes']:
            db.execute('INSERT INTO executions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',(secrets.token_hex(12),node['config_id'],run,node['id'],json.dumps(flow['configs'][node['config_id']]),'queued',None,None,'',time.time(),None,None,None))
        return {'id':run}

    def start_flow(self,identity):
        with self.lock,self.db() as db:
            if self.desktop_paused.is_set():raise ValueError('Desktop launches are paused during shutdown recovery')
            db.execute('BEGIN IMMEDIATE')
            return self.enqueue_flow(db,identity)

    def start(self,identity):
        with self.lock,self.db() as db:
            if self.desktop_paused.is_set():raise ValueError('Desktop launches are paused during shutdown recovery')
            db.execute('BEGIN IMMEDIATE')
            config=self.config(identity)
            previous=db.execute("SELECT * FROM executions WHERE config_id=? AND state IN ('queued','starting','running','ready')",(identity,)).fetchone()
            if previous:return dict(previous)
            run=secrets.token_hex(12)
            db.execute('INSERT INTO executions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',(run,identity,None,None,json.dumps(config),'queued',None,None,'',time.time(),None,None,None))
        self.tick()
        with self.db() as db:return dict(db.execute('SELECT * FROM executions WHERE id=?',(run,)).fetchone())

    def owned(self,row):
        if not row['pid']:return False
        result=subprocess.run(['ps','-p',str(row['pid']),'-o','command='],capture_output=True,text=True,timeout=3)
        return str(ROOT/'scripts'/'workflow_worker.py') in result.stdout and row['id'] in result.stdout

    def stop(self,identity):
        with self.lock,self.db() as db:
            row=db.execute('SELECT * FROM executions WHERE id=?',(identity,)).fetchone()
            if not row:raise ValueError('Run not found')
            if row['state'] in ('starting','running','ready') and self.owned(row):os.kill(row['pid'],signal.SIGTERM)
            db.execute("UPDATE executions SET state='cancelled',finished=? WHERE id=?",(time.time(),identity))
        return {'ok':True}

    def shutdown_jobs(self):
        """Include workers whose earlier desktop stop could not be confirmed."""
        with self.db() as db:
            return [dict(row) for row in db.execute("SELECT * FROM executions WHERE state IN ('queued','starting','running','ready') OR detail LIKE 'Pending desktop shutdown:%'")]

    def stop_confirmed(self, identity, timeout=2):
        """Desktop shutdown must observe exit, not just deliver a signal.

        Do not hold a database transaction while waiting: workers save their
        cancellation after stopping their own children. A failed stop remains
        discoverable on retry, including after a backend restart.
        """
        with self.db() as db:
            found = db.execute('SELECT * FROM executions WHERE id=?', (identity,)).fetchone()
        if not found:raise ValueError('Run not found')
        row = dict(found)

        def alive():
            child = self.children.get(identity)
            if child is not None and child.pid == row['pid']:
                return child.poll() is None
            if not row['pid']:return False
            if self.owned(row):return True
            try:os.kill(row['pid'], 0)
            except ProcessLookupError:return False
            raise ValueError('Worker ownership could not be confirmed; no process was signalled')

        try:
            if alive():
                if not self.owned(row):raise ValueError('Worker ownership changed; no process was signalled')
                OwnedProcesses(row['pid']).stop(timeout)
                child = self.children.get(identity)
                if child is not None:child.wait(timeout=3)
        except (OSError, ValueError) as error:
            with self.db() as db:
                db.execute('UPDATE executions SET detail=? WHERE id=?', ('Pending desktop shutdown: ' + str(error), identity))
            raise
        with self.db() as db:
            db.execute("UPDATE executions SET state='cancelled',finished=?,detail='Stopped by desktop shutdown' WHERE id=? AND (state IN ('queued','starting','running','ready') OR detail LIKE 'Pending desktop shutdown:%')", (time.time(), identity))
        return {'ok': True}

    def cancel_flow(self,identity):
        with self.db() as db:rows=db.execute("SELECT id FROM executions WHERE flow_id=? AND state IN ('queued','starting','running','ready')",(identity,)).fetchall()
        for row in rows:self.stop(row['id'])
        with self.db() as db:db.execute("UPDATE flows SET state='cancelled',finished=? WHERE id=? AND state='running'",(time.time(),identity))
        return {'ok':True}

    def review(self,payload):
        if payload.get('state') not in ('review','done','dismissed'):raise ValueError('Invalid review state')
        with self.db() as db:
            if not db.execute('SELECT 1 FROM executions WHERE id=?',(payload.get('id'),)).fetchone():raise ValueError('Run not found')
            db.execute('INSERT OR REPLACE INTO reviews VALUES (?,?)',(payload['id'],payload['state']))
        return {'ok':True}

    def logs(self,identity):
        if not re.fullmatch(r'[a-f0-9]{24}',identity):raise ValueError('Invalid run ID')
        path=self.path.parent/'workflow-logs'/(identity+'.log')
        if not path.exists():return {'text':'No output yet.'}
        with path.open('rb') as stream:stream.seek(max(0,path.stat().st_size-48000));return {'text':stream.read(48000).decode('utf-8','replace')}

    def tick(self):
        with self.lock:
            if self.desktop_paused.is_set():return
            now=time.time()
            for identity,child in list(self.children.items()):
                if child.poll() is not None:child.wait();del self.children[identity]
            with self.db() as db:
                db.execute('BEGIN IMMEDIATE')
                due=db.execute('SELECT * FROM workflows WHERE next_due<=?',(now,)).fetchall()
                # Advance the schedule and enqueue its run in one transaction.
                for row in due:
                    item=json.loads(row['payload'])
                    next_due=next_cron(item['cron'],item['timezone'],now) if item['trigger']=='cron' else None
                    db.execute('UPDATE workflows SET next_due=? WHERE id=?',(next_due,row['id']))
                    try:self.enqueue_flow(db,row['id'])
                    except ValueError:
                        db.execute('INSERT INTO flows VALUES (?,?,?,?,?,?)',(secrets.token_hex(12),row['id'],row['payload'],'skipped',now,now))
                self.events.dispatch(db,now)
            with self.db() as db:
                rows=[dict(r) for r in db.execute("SELECT * FROM executions WHERE state IN ('starting','running','ready')")]
            for row in rows:
                if now-row['created']<=10 or self.owned(row):continue
                # The worker may have delivered its report immediately before
                # exiting. Recover that durable result before declaring it lost.
                if row['agent_run']:
                    from agent_desk.special_agents import SpecialAgents
                    with SpecialAgents(self.path.parent/'special-agents.sqlite3').db() as agents:
                        reported=agents.execute('SELECT state,detail FROM runs WHERE id=?',(row['agent_run'],)).fetchone()
                    if reported and reported['state'] in ('review','blocked','failed'):
                        outcome={'review':'succeeded','blocked':'blocked','failed':'failed'}[reported['state']]
                        self.update(row['id'],expected_states=('starting','running','ready'),state=outcome,detail=reported['detail'],finished=now)
                        continue
                self.update(row['id'],expected_states=('starting','running','ready'),state='interrupted',detail='Worker ended without a result',finished=now)
            with self.db() as db:
                flows={r['id']:json.loads(r['payload']) for r in db.execute("SELECT * FROM flows WHERE state='running'")}
                rows=[dict(r) for r in db.execute('SELECT * FROM executions')]
            active=sum(r['state'] in ('starting','running') for r in rows)
            for row in rows:
                if row['state']!='queued':continue
                if row['flow_id']:
                    flow=flows.get(row['flow_id'])
                    if not flow:continue
                    node=next(n for n in flow['nodes'] if n['id']==row['node_id'])
                    upstream=[r for r in rows if r['flow_id']==row['flow_id'] and r['node_id'] in node['depends_on']]
                    if any(r['state'] in ('failed','blocked','interrupted','cancelled','skipped') for r in upstream):
                        self.update(row['id'],state='skipped',detail='Upstream task did not succeed',finished=now);row['state']='skipped';continue
                    if any(r['state'] not in ('succeeded','ready') for r in upstream):continue
                other=next((r for r in rows if r['id']!=row['id'] and r['config_id']==row['config_id'] and r['state'] in ('starting','running','ready')),None)
                if other:
                    if other['state']=='ready' and json.loads(row['payload'])['kind']=='app':self.update(row['id'],state='succeeded',port=other['port'],detail='Reused running app',finished=now);row['state']='succeeded'
                    continue
                if active>=4:continue
                with self.db() as db:
                    if not db.execute("UPDATE executions SET state='starting' WHERE id=? AND state='queued'",(row['id'],)).rowcount:continue
                try:
                    child=subprocess.Popen([sys.executable,str(ROOT/'scripts'/'workflow_worker.py'),str(self.path),row['id'],self.desk],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
                    self.children[row['id']]=child;self.update(row['id'],pid=child.pid);row['state']='starting';active+=1
                except OSError as exc:self.update(row['id'],state='failed',detail=str(exc),finished=now)
            with self.db() as db:
                for identity in flows:
                    states=[r[0] for r in db.execute('SELECT state FROM executions WHERE flow_id=?',(identity,))]
                    if all(s not in ('queued','starting','running') for s in states):
                        db.execute('UPDATE flows SET state=?,finished=? WHERE id=?',('succeeded' if all(s in ('succeeded','ready') for s in states) else 'failed',now,identity))

    def loop(self):
        while not self.stopping.is_set():
            try:
                if not self.desktop_paused.is_set():self.events.poll_files();self.tick()
            except Exception as exc:print('Workflow scheduler:',str(exc),file=sys.stderr,flush=True)
            self.stopping.wait(2)

    def start_scheduler(self):
        import fcntl
        self.path.parent.mkdir(parents=True,exist_ok=True)
        self.scheduler_lock=self.path.with_suffix('.scheduler.lock').open('a')
        try:fcntl.flock(self.scheduler_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            self.scheduler_lock.close()
            raise ValueError('Another scheduler already owns this workflow database') from None
        threading.Thread(target=self.loop,daemon=True,name='workflow-scheduler').start()
