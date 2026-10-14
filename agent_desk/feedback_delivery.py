"""Explicit annotation submissions to coordinators or unassigned coding terminals."""
import hashlib
import json
import os
import re
import tempfile
import time
from agent_desk.worker_screen import WorkerNotReady


def _schema(runtime):
    with runtime.db() as db:
        db.execute('CREATE TABLE IF NOT EXISTS feedback_submissions (request TEXT PRIMARY KEY,target TEXT,digest TEXT,state TEXT,created REAL)')
        if 'detail' not in {r[1] for r in db.execute('PRAGMA table_info(feedback_submissions)')}:
            db.execute("ALTER TABLE feedback_submissions ADD COLUMN detail TEXT NOT NULL DEFAULT ''")


def feedback_status(runtime, payload):
    with runtime.lock:
        _schema(runtime)
        with runtime.db() as db:
            rows=[dict(r) for r in db.execute('SELECT request,target,state,created,detail FROM feedback_submissions ORDER BY created DESC LIMIT 100')]
    for row in rows:
        with runtime.db() as db:digest=db.execute('SELECT digest FROM feedback_submissions WHERE request=?',(row['request'],)).fetchone()[0]
        try:
            notes=json.loads((runtime.path.parent/'feedback-submissions'/(digest+'.json')).read_text())
            row['note_versions']=[{'id':n['id'],'version':[n.get('updatedAt') or n.get('createdAt'),n['note']]} for n in notes]
        except (OSError,ValueError,KeyError):row['note_versions']=[]
    return {'submissions': rows}


def cancel_feedback(runtime, payload):
    with runtime.lock:
        _schema(runtime)
        with runtime.db() as db:
            changed=db.execute("UPDATE feedback_submissions SET state='cancelled',detail='Cancelled before delivery' WHERE request=? AND state='queued'", (payload.get('request_id'),)).rowcount
        if not changed: raise ValueError('Only waiting submissions can be cancelled; refresh delivery status')
    return {'cancelled': True}


def submit_feedback(runtime,payload):
    request=payload.get('request_id');target=payload.get('target_id');notes=payload.get('notes')
    if not isinstance(request,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,90}',request):raise ValueError('Submission ID required')
    if not isinstance(target,str) or not 1<=len(target)<=150:raise ValueError('Choose an agent')
    if not isinstance(notes,list) or not 1<=len(notes)<=200:raise ValueError('Choose annotations to send')
    if any(not isinstance(n,dict) or not isinstance(n.get('id'),str) or not isinstance(n.get('note'),str) or not n['note'].strip() for n in notes):raise ValueError('Invalid annotation')
    # A tool that words its own request sends it as the prompt; the notes are still saved beside it.
    direct=payload.get('prompt')
    if direct is not None and (not isinstance(direct,str) or not direct.strip() or len(direct)>6000):raise ValueError('Invalid feedback prompt')
    source=json.dumps(notes,ensure_ascii=False,sort_keys=True,indent=2)
    if len(source.encode())>80000:raise ValueError('Select fewer annotations per submission (80 KB maximum)')
    digest=hashlib.sha256((target+'\0'+source+('\0'+direct if direct else '')).encode()).hexdigest()
    with runtime.lock:
        _schema(runtime)
        with runtime.db() as db:
            previous=db.execute('SELECT * FROM feedback_submissions WHERE request=?',(request,)).fetchone()
        if previous:
            if previous['digest']!=digest:raise ValueError('This submission ID was already used for different feedback')
            if previous['state']=='sent':return {'sent':True,'target_id':target,'duplicate':True}
            if previous['state']=='queued':return {'sent':False,'queued':True,'target_id':target,'duplicate':True}
            raise ValueError('Delivery was interrupted after submission began. Check the agent terminal before sending again')
        try:coordinator=runtime.get(target)
        except ValueError:coordinator=None
        instruction=('Implement the following '+str(len(notes))+' Agent Desk annotation(s). Read the complete saved feedback before editing; it includes the exact selectors, click coordinates, viewport, and requested changes. '
                     'Inspect the current UI, make the requested fixes, run relevant checks, and report back. Read the repository AGENTS.md and UI feedback INDEX.md when present. Preserve each exact annotation and target, capture before/after examples when possible, and record the outcome, commit, validation, and acceptance state in that catalog. Do not call a change accepted without explicit user acceptance. Do not act on older annotations outside this submission.\n\n')
        if coordinator:
            artifact=runtime.artifact(target,'Submitted UI annotations',source)
            # Artifact retrieval is available to the coordinator's bounded planner.
            reference=artifact
            runtime.message({'id':target,'request_id':'feedback-'+request,'text':instruction+'Use recall to read '+reference+' (and subsequent pages if present).\nSubmission: '+request})
        else:
            session=runtime.terminals.get(target)
            if session.parent_id:raise ValueError('Send this feedback to the worker’s coordinator so it can assign and track the fixes')
            folder=runtime.path.parent/'feedback-submissions';folder.mkdir(mode=0o700,parents=True,exist_ok=True)
            path=folder/(digest+'.json')
            if not path.exists():
                fd,temp=tempfile.mkstemp(dir=folder)
                try:
                    with os.fdopen(fd,'w') as file:file.write(source)
                    os.replace(temp,path)
                finally:
                    if os.path.exists(temp):os.unlink(temp)
            prompt=(direct.strip() if direct else instruction+'Read this UTF-8 JSON file: '+str(path.resolve()))+'\nSubmission: '+request
            def reserve():
                with runtime.db() as db:db.execute('INSERT INTO feedback_submissions(request,target,digest,state,created) VALUES(?,?,?,?,?)',(request,target,digest,'uncertain',time.time()))
            try:session.send_task(prompt,before_send=reserve)
            except WorkerNotReady as error:
                with runtime.db() as db:
                    if db.execute('SELECT 1 FROM feedback_submissions WHERE request=?',(request,)).fetchone():
                        raise ValueError('Delivery was interrupted after submission began. Check the agent terminal before sending again')
                    db.execute('INSERT INTO feedback_submissions(request,target,digest,state,created) VALUES(?,?,?,?,?)',(request,target,digest,'queued',time.time()))
                    db.execute('UPDATE feedback_submissions SET detail=? WHERE request=?',(str(error),request))
                return {'sent':False,'queued':True,'target_id':target,'duplicate':False}
        with runtime.db() as db:
            db.execute('INSERT INTO feedback_submissions(request,target,digest,state,created) VALUES(?,?,?,?,?) ON CONFLICT(request) DO UPDATE SET state=excluded.state',(request,target,digest,'sent',time.time()))
        return {'sent':True,'target_id':target,'duplicate':False}


def drain_feedback(runtime):
    """Deliver saved standalone feedback when its coding-agent prompt is ready."""
    with runtime.lock:
        _schema(runtime)
        with runtime.db() as db:
            queued=[dict(row) for row in db.execute("SELECT * FROM feedback_submissions WHERE state='queued' ORDER BY created LIMIT 20")]
        for item in queued:
            try:
                session=runtime.terminals.get(item['target'])
                if session.parent_id:
                    raise ValueError('Target is now owned by a coordinator')
                path=runtime.path.parent/'feedback-submissions'/(item['digest']+'.json')
                prompt=('Implement the Agent Desk annotations in this UTF-8 JSON file: '+str(path.resolve())+
                        '\nRead the complete saved feedback and repository AGENTS.md before editing. Preserve exact targets and record validation and acceptance in the UI feedback catalog.\nSubmission: '+item['request'])
                def reserve():
                    with runtime.db() as db:
                        db.execute("UPDATE feedback_submissions SET state='uncertain' WHERE request=? AND state='queued'",(item['request'],))
                session.send_task(prompt,before_send=reserve)
            except WorkerNotReady as error:
                with runtime.db() as db:db.execute('UPDATE feedback_submissions SET detail=? WHERE request=?',(str(error),item['request']))
                continue
            except (ValueError,OSError) as error:
                with runtime.db() as db:
                    db.execute("UPDATE feedback_submissions SET state='failed',detail=? WHERE request=? AND state='queued'",(str(error),item['request']))
                continue
            with runtime.db() as db:
                db.execute("UPDATE feedback_submissions SET state='sent',detail='' WHERE request=?",(item['request'],))
