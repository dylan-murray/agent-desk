"""Confirmed worker retirement and durable native-conversation resume records."""
import json
import sys
import re
import time
from pathlib import Path

from agent_desk.accounts import SINGLE, harness_of


def session_profile(session):
    """The account a terminal runs, or the single-login CLI it was started as."""
    name=Path(session.argv[0]).name
    return session.launch_profile or (name if name in SINGLE else '')


def prompt_argv(argv, profile, prompt):
    """Append an initial prompt the way this profile's CLI takes one."""
    harness=harness_of(profile)
    if harness=='opencode':return [*argv,'--prompt',prompt]
    # Pi has no -- separator: a leading - or @ would be read as an option or a file.
    if harness=='pi':return [*argv,('Task: ' if prompt[:1] in ('-','@') else '')+prompt]
    return [*argv,'--',prompt]


def without_prompt(argv, profile):
    harness=harness_of(profile);args=list(argv)
    if harness=='opencode':
        return args[:args.index('--prompt')] if '--prompt' in args else args
    # Agent Desk's prompts always span lines; Pi's option values never do.
    if harness=='pi':return args[:-1] if len(args)>1 and '\n' in args[-1] else args
    return args[:len(args)-1-args[::-1].index('--')] if '--' in args else args


class WorkerSessions:
    def attachable_workers(self):
        excluded=self.attachment_exclusions()|self.protected_panes()
        result=[]
        for info in self.terminals.list():
            if info.get('parent_id') or info['exit_code'] is not None or info['id'] in excluded:continue
            session=self.terminals.get(info['id'])
            if getattr(session,'coordinator',None):continue
            profile=session_profile(session)
            if not harness_of(profile):continue
            result.append(dict(worker_id=session.id,name=session.name,cwd=session.cwd,profile=profile))
        return result

    def attach_worker(self, coordinator, worker):
        self.get(coordinator)
        with self.lock:
            session=self.terminals.get(worker)
            with self.db() as db:
                previous=db.execute('SELECT coordinator FROM attached_workers WHERE worker=?',(worker,)).fetchone()
            if previous and previous['coordinator']==coordinator and session.parent_id==coordinator:
                return dict(worker_id=worker,attached=True)
            if worker not in {w['worker_id'] for w in self.attachable_workers()}:
                raise ValueError('Choose an unassigned live agent from attachable_workers; owned workers, automations and external terminals cannot be adopted')
            # Record ownership before exposing it to the coordinator. Attachment
            # sends no input and creates no fictional task or completion report.
            with self.db() as db:
                db.execute('INSERT INTO attached_workers VALUES(?,?,?)',(worker,coordinator,time.time()))
                db.execute('INSERT INTO worker_registry VALUES(?,?,?,?,?,?,?,?)',
                    (worker,coordinator,session.name,session.cwd,session_profile(session),None,time.time(),json.dumps(dict(argv=session.argv))))
            session.parent_id=coordinator
            return dict(worker_id=worker,attached=True)

    def remember_worker(self, session):
        profile=session_profile(session)
        identity=self.mailbox.conversation(self.desk,session.id)
        metadata=json.dumps(dict(argv=session.argv))
        with self.db() as db:
            db.execute('INSERT INTO worker_registry VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(worker) DO UPDATE SET session_id=COALESCE(excluded.session_id,worker_registry.session_id),metadata=excluded.metadata',
                       (session.id,session.parent_id,session.name,session.cwd,profile,identity,time.time(),metadata))

    def checkpoint_workers(self):
        with self.db() as db:coordinators={r[0] for r in db.execute('SELECT id FROM coordinators')}
        for worker in self.terminals.list():
            if worker.get('parent_id') in coordinators:
                self.remember_worker(self.terminals.get(worker['id']))

    def recover_workers(self):
        live={w['id'] for w in self.terminals.list()}
        with self.db() as db:records=[dict(r) for r in db.execute('SELECT * FROM worker_registry')]
        for record in records:
            if record['worker'] in live:continue
            identity=self.mailbox.conversation(self.desk,record['worker']) or record['session_id']
            metadata=json.loads(record['metadata']);tasks=self.worker_tasks(record['coordinator'],record['worker'])
            metadata.update(tasks=tasks,save_reason='restart')
            if identity:metadata['argv']=self.resume_argv(metadata['argv'],record['profile'],identity)
            with self.db() as db:
                db.execute('INSERT OR IGNORE INTO saved_workers VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                    (record['worker'],record['coordinator'],record['name'],record['cwd'],record['profile'],identity or '',
                     'saved' if identity else 'unavailable',None,record['created'],json.dumps(metadata),tasks[-1]['id'] if tasks else None))

    def saved_workers(self, coordinator=None):
        with self.db() as db:
            rows=db.execute('SELECT worker,coordinator,name,cwd,profile,session_id,state,resumed_worker,created FROM saved_workers'+
                            (' WHERE coordinator=?' if coordinator else '')+' ORDER BY created DESC',
                            (coordinator,) if coordinator else ()).fetchall()
        live={s['id'] for s in self.terminals.list() if s['exit_code'] is None}
        # A previously unreachable owner may reconnect with the original PTY.
        # Keep its archive in storage, but do not hide the returned live pane
        # or offer a duplicate resume from its stale disappearance record.
        records=[dict(row) for row in rows if not (row['worker'] in live and row['state'] in ('saved','unavailable'))]
        for record in records:
            available=record['state']=='saved'
            if record['state']=='active':
                try:live=self.terminals.get(record['resumed_worker']).process.poll() is None
                except ValueError:live=False
                available=not live and not any(r['worker']==record['resumed_worker'] for r in records)
            record['can_resume']=available
            tasks=self.worker_tasks(record['coordinator'],record['resumed_worker'] or record['worker'])
            record['pending_tasks']=[dict(id=t['id'],task=t['task'],status=t['status']) for t in tasks if t['result'] is None and t['status']!='cancelled']
            record['last_task']=tasks[-1]['task'] if tasks else ''
            record['report_task_id']=next((t['id'] for t in reversed(tasks) if t['result'] is not None),None)
        return records

    def hidden_workers(self):
        return {r['worker'] for r in self.saved_workers() if r['state']!='closing'}

    def worker_tasks(self, coordinator, worker):
        return [t for t in self.mailbox.inbox(self.desk,coordinator,True) if t['worker']==worker]

    def worker_reviews(self, coordinator):
        result=[]
        for worker in self.terminals.list():
            if worker.get('parent_id')!=coordinator or worker['id'] in self.hidden_workers():continue
            tasks=self.worker_tasks(coordinator,worker['id'])
            if tasks and all(t['result'] is not None for t in tasks) and tasks[-1]['outcome']=='completed':
                result.append(dict(worker_id=worker['id'],task_id=tasks[-1]['id'],
                                   session_id=self.mailbox.conversation(self.desk,worker['id']),result=tasks[-1]['result'][:6000]))
        return result

    def resolve_worker_session(self, session):
        identity=self.mailbox.conversation(self.desk,session.id)
        if identity:return identity
        with self.db() as db:
            saved=db.execute('SELECT session_id FROM worker_registry WHERE worker=? AND coordinator=?',(session.id,session.parent_id)).fetchone()
        if saved and saved['session_id']:return saved['session_id']
        profile=session_profile(session)
        if not harness_of(profile):return None
        from agent_desk.native_session_lookup import find_conversation
        import subprocess
        for task in self.worker_tasks(session.parent_id,session.id):
            # Match the task actually present in this terminal's launch command.
            if task['id'] not in json.dumps(session.argv):
                with self.db() as db:attached=db.execute('SELECT 1 FROM attached_workers WHERE worker=? AND coordinator=?',(session.id,session.parent_id)).fetchone()
                if not attached:continue
            try:identity=find_conversation(profile,task['id'])
            except (OSError,subprocess.TimeoutExpired):return None
            if identity:
                self.mailbox.remember_conversation(self.desk,task['id'],identity,harness_of(profile))
                self.remember_worker(session)
                return identity
        return None

    def review_worker(self,payload):
        coordinator=payload.get('id');self.get(coordinator)
        session=self.terminals.get(payload.get('worker_id'))
        if session.parent_id!=coordinator:raise ValueError('That worker belongs to another coordinator')
        tasks=self.worker_tasks(coordinator,session.id)
        if not tasks or tasks[-1]['id']!=payload.get('task_id') or any(t['result'] is None for t in tasks):raise ValueError('The worker’s task changed. Review its latest result')
        return dict(session_id=self.resolve_worker_session(session),result=tasks[-1]['result'],task=tasks[-1]['task'])

    @staticmethod
    def resume_argv(argv, profile, identity):
        args=without_prompt(argv,profile)
        flag={'codex':'resume','opencode':'--session','pi':'--session'}.get(harness_of(profile),'--resume')
        if flag in args:
            index=args.index(flag);args[index+1:index+2]=[identity]
        else:args.extend([flag,identity])
        return args

    def close_completed_workers(self):
        if time.monotonic()<getattr(self,'worker_cleanup_at',0):return
        self.worker_cleanup_at=time.monotonic()+2
        with self.lock:
            with self.db() as db:identities=[r[0] for r in db.execute('SELECT id FROM coordinators')]
            for identity in identities:
                if identity in self.running:continue
                for review in self.worker_reviews(identity):
                    tasks=self.worker_tasks(identity,review['worker_id'])
                    if tasks[-1]['status']!='replied' or time.time()-tasks[-1]['updated']<3:continue
                    with self.db() as db:
                        queued=[r[0] for r in db.execute("SELECT worker FROM actions WHERE coordinator=? AND state IN ('queued','running')",(identity,))]
                    if any(w and self.canonical_worker_id(identity,w)==review['worker_id'] for w in queued):continue
                    try:self.retire_worker(dict(id=identity,worker_id=review['worker_id'],task_id=review['task_id'],confirmed=True,automatic=True))
                    except (ValueError,OSError):continue

    def retire_worker(self, payload):
        coordinator=payload.get('id');worker=payload.get('worker_id')
        self.get(coordinator)
        if payload.get('confirmed') is not True:
            raise ValueError('Confirm the worker’s work before closing its terminal')
        with self.lock:
            with self.db() as db:
                saved=db.execute('SELECT * FROM saved_workers WHERE worker=? AND coordinator=?',(worker,coordinator)).fetchone()
            if saved and saved['state']!='closing':return dict(saved=True,worker_id=worker)
            session=self.terminals.get(worker)
            if session.parent_id!=coordinator:raise ValueError('That worker belongs to another coordinator')
            tasks=self.worker_tasks(coordinator,worker)
            if not tasks or any(t['result'] is None for t in tasks) or tasks[-1]['outcome']!='completed':
                raise ValueError('This worker still needs to provide a completed final report')
            if tasks[-1]['id']!=payload.get('task_id'):
                raise ValueError('The worker’s task changed. Review its latest result before closing')
            identity=self.resolve_worker_session(session) or payload.get('session_id','')
            if not identity and payload.get('automatic'):identity=''
            elif not isinstance(identity,str) or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}',identity):
                raise ValueError('The native conversation ID could not be identified yet. Keep this terminal open and retry session discovery')
            profile=session_profile(session)
            if not harness_of(profile):
                raise ValueError('Resume is not configured for this worker’s executable')
            metadata=json.dumps(dict(argv=self.resume_argv(session.argv,profile,identity) if identity else session.argv,
                                     terminal_output=session.output(session.start),tasks=tasks))
            # Save before stopping. A failed stop leaves a recoverable closing record.
            with self.db() as db:
                db.execute('INSERT OR IGNORE INTO saved_workers VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                           (worker,coordinator,session.name,session.cwd,profile,identity,'closing',None,time.time(),metadata,tasks[-1]['id']))
            session.stop()
            with self.db() as db:
                db.execute("UPDATE saved_workers SET state=? WHERE worker=?",('saved' if identity else 'unavailable',worker))
                self.append(db,coordinator,'system',('Saved and automatically closed ' if payload.get('automatic') else 'Confirmed and closed ')+session.name+'. Report retained. '+('Its native conversation is saved for resuming.' if identity else 'History saved; link the exact native conversation ID to resume.'),worker+':saved')
            return dict(saved=True,worker_id=worker)

    def stop_worker(self,payload):
        coordinator=payload.get('id');self.get(coordinator)
        if payload.get('confirmed') is not True:raise ValueError('Confirm stopping this worker')
        worker=self.canonical_worker_id(coordinator,payload.get('worker_id'))
        with self.lock:
            session=self.terminals.get(worker)
            if session.parent_id!=coordinator:raise ValueError('That worker belongs to another coordinator')
            identity=self.resolve_worker_session(session) or ''
            profile=session_profile(session)
            tasks=self.worker_tasks(coordinator,worker)
            metadata=json.dumps(dict(argv=self.resume_argv(session.argv,profile,identity) if identity else session.argv,
                                     terminal_output=session.output(session.start),tasks=tasks,save_reason='user_stop'))
            # Persist intent before stopping; queued sends must never reopen it.
            with self.db() as db:
                db.execute('INSERT OR IGNORE INTO stopped_workers VALUES(?,?,?)',(worker,coordinator,time.time()))
                for action in db.execute("SELECT id,worker FROM actions WHERE coordinator=? AND state='queued'",(coordinator,)).fetchall():
                    if self.canonical_worker_id(coordinator,action['worker'])==worker:
                        db.execute("UPDATE actions SET state='cancelled',detail='Worker intentionally stopped; queued input cancelled' WHERE id=?",(action['id'],))
                db.execute('INSERT OR REPLACE INTO saved_workers VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                           (worker,coordinator,session.name,session.cwd,profile,identity,'closing',None,time.time(),metadata,tasks[-1]['id'] if tasks else None))
            with self.mailbox.connect() as db:
                db.execute("UPDATE tasks SET status='cancelled',updated=? WHERE desk=? AND controller=? AND worker=? AND result IS NULL",(time.time(),self.desk,coordinator,worker))
            session.stop()
            with self.db() as db:
                db.execute('UPDATE saved_workers SET state=? WHERE worker=?',('saved' if identity else 'unavailable',worker))
                self.append(db,coordinator,'system','Stopped and closed '+session.name+'. Unfinished assignments were cancelled, not completed. '+('Its native conversation is saved.' if identity else 'History is saved; an exact native conversation ID is needed to resume.'),worker+':stopped')
            return dict(stopped=True,worker_id=worker,can_resume=bool(identity))

    def canonical_worker_id(self,coordinator,worker):
        if not isinstance(worker,str) or not worker:raise ValueError('Choose an exact worker ID')
        seen=set()
        while worker not in seen:
            seen.add(worker)
            with self.db() as db:row=db.execute('SELECT coordinator,resumed_worker FROM saved_workers WHERE worker=?',(worker,)).fetchone()
            if not row:return worker
            if row['coordinator']!=coordinator:raise ValueError('That worker belongs to another coordinator')
            if not row['resumed_worker']:return worker
            worker=row['resumed_worker']
        raise ValueError('Worker resume history contains a cycle; inspect its saved sessions')

    def delivery_worker(self,coordinator,worker):
        worker=self.canonical_worker_id(coordinator,worker)
        try:session=self.terminals.get(worker)
        except ValueError:session=None
        if session and session.parent_id!=coordinator:raise ValueError('That worker belongs to another coordinator')
        if session and session.process.poll() is None:return session
        with self.db() as db:saved=db.execute("SELECT 1 FROM saved_workers WHERE worker=? AND coordinator=? AND state IN ('saved','active')",(worker,coordinator)).fetchone()
        if not saved:raise ValueError('Worker has exited or is unavailable; save its exact conversation before sending a follow-up')
        resumed=self.resume_worker({'id':coordinator,'worker_id':worker})
        return self.terminals.get(resumed['worker_id'])

    def resume_worker(self, payload):
        coordinator=payload.get('id');self.get(coordinator);worker=self.canonical_worker_id(coordinator,payload.get('worker_id'))
        with self.lock:
            with self.db() as db:
                row=db.execute('SELECT * FROM saved_workers WHERE worker=? AND coordinator=?',(worker,coordinator)).fetchone()
            if not row:
                try:existing=self.terminals.get(worker)
                except ValueError:existing=None
                if existing:
                    if existing.parent_id!=coordinator:raise ValueError('That worker belongs to another coordinator')
                    if existing.process.poll() is None:return dict(worker_id=existing.id,already_running=True)
                    raise ValueError('That worker has exited but has not been saved. Save its exact native conversation before resuming')
                raise ValueError('No saved worker with this ID is available here. Use an exact worker ID from this coordinator’s saved_workers list')
            if row['state']=='unavailable' and payload.get('session_id'):
                identity=payload['session_id']
                if not isinstance(identity,str) or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}',identity):
                    raise ValueError('Enter the exact native conversation ID')
                metadata=json.loads(row['metadata']);metadata['argv']=self.resume_argv(metadata['argv'],row['profile'],identity)
                with self.db() as db:
                    db.execute("UPDATE saved_workers SET session_id=?,state='saved',metadata=? WHERE worker=?",(identity,json.dumps(metadata),worker))
                    row=db.execute('SELECT * FROM saved_workers WHERE worker=?',(worker,)).fetchone()
            source_worker=row['resumed_worker'] or worker
            try:previous=self.terminals.get(source_worker)
            except ValueError:previous=None
            if previous and previous.process.poll() is None:
                if row['resumed_worker']:return dict(worker_id=previous.id)
                return dict(worker_id=previous.id,already_running=True)
            if row['state'] not in ('saved','active'):
                raise ValueError('Resume or closure is uncertain. Inspect the existing terminals before retrying')
            with self.db() as db:
                newer=db.execute('SELECT worker FROM saved_workers WHERE worker=? AND worker!=?',(source_worker,worker)).fetchone()
            if newer:raise ValueError('Use this worker’s more recent saved session')
            metadata=json.loads(row['metadata'])
            pending=[t for t in self.worker_tasks(coordinator,source_worker) if t['result'] is None and t['status']!='cancelled']
            if any(t['status'] in ('send_uncertain','nudge_uncertain') for t in pending):
                raise ValueError('The previous dispatch is uncertain. Inspect and reconcile it before resuming work')
            if pending:
                from pathlib import Path
                import shlex
                helper=shlex.join([sys.executable,str(Path(__file__).resolve().parents[1]/'scripts'/'agent_control.py'),'--desk',self.desk])
                instructions='Agent Desk is resuming this existing conversation after an interruption. Inspect the current worktree and actual task state first. Do not blindly repeat prior commands or external actions. Continue only the outstanding assignments below and report against their ORIGINAL task IDs.\n'
                for task in pending:
                    instructions+='\nTask '+task['id']+': '+task['task']+'\nFinal report: '+helper+' reply '+task['id']+' --file /absolute/path/to/result.txt\n'
                if len(instructions)>9000:raise ValueError('Too much unfinished work to resume safely in one prompt. Review these tasks manually')
                metadata['argv']=prompt_argv(metadata['argv'],row['profile'],instructions)
            # A crash after this claim must not launch a second copy on retry.
            with self.db() as db:db.execute("UPDATE saved_workers SET state='resuming' WHERE worker=?",(worker,))
            try:
                session=self.terminals.launch(dict(cwd=row['cwd'],argv=metadata['argv'],name=row['name'],
                    parent_id=coordinator,launch_profile=None if row['profile'] in SINGLE else row['profile']))
                with self.mailbox.connect() as db:
                    db.execute('UPDATE tasks SET worker=? WHERE desk=? AND controller=? AND worker=?',(session.id,self.desk,coordinator,source_worker))
                self.remember_worker(session)
                with self.db() as db:
                    db.execute("UPDATE saved_workers SET state='active',resumed_worker=? WHERE worker=?",(session.id,worker))
                    self.append(db,coordinator,'system','Resumed '+row['name']+' in terminal '+session.id+'. Send follow-up work to this worker.',worker+':resumed')
                return dict(worker_id=session.id)
            except Exception:
                # Keep the durable claim: process launch may have succeeded.
                raise ValueError('Resume could not be confirmed. Inspect terminals before retrying; the saved conversation is retained') from None
