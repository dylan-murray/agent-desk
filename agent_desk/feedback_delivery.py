"""Explicit annotation submissions to coordinators or unassigned coding terminals."""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import sys
import tempfile
import time
from agent_desk.annotations import submission
from agent_desk.worker_screen import WorkerNotReady


def _schema(runtime):
    with runtime.db() as db:
        db.execute('CREATE TABLE IF NOT EXISTS feedback_submissions (request TEXT PRIMARY KEY,target TEXT,digest TEXT,state TEXT,created REAL)')
        columns={r[1] for r in db.execute('PRAGMA table_info(feedback_submissions)')}
        if 'detail' not in columns:
            db.execute("ALTER TABLE feedback_submissions ADD COLUMN detail TEXT NOT NULL DEFAULT ''")
        # The exact prompt a queued delivery types once the agent's prompt is free.
        if 'prompt' not in columns:
            db.execute("ALTER TABLE feedback_submissions ADD COLUMN prompt TEXT NOT NULL DEFAULT ''")


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


def submit_feedback(runtime,payload,report=''):
    request=payload.get('request_id');target=payload.get('target_id');notes=payload.get('notes')
    if not isinstance(request,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,90}',request):raise ValueError('Submission ID required')
    if not isinstance(target,str) or not 1<=len(target)<=150:raise ValueError('Choose an agent')
    if not isinstance(notes,list) or not 1<=len(notes)<=200:raise ValueError('Choose annotations to send')
    if any(not isinstance(n,dict) or not isinstance(n.get('id'),str) or not isinstance(n.get('note',n.get('comment')),str) or not n.get('note',n.get('comment')).strip() for n in notes):raise ValueError('Invalid annotation')
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
            runtime.message({'id':target,'request_id':'feedback-'+request,'text':instruction+report+'Use recall to read '+reference+' (and subsequent pages if present).\nSubmission: '+request})
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
            prompt=(direct.strip() if direct else instruction+'Read this UTF-8 JSON file: '+str(path.resolve()))+report+'\nSubmission: '+request
            def reserve():
                with runtime.db() as db:db.execute('INSERT INTO feedback_submissions(request,target,digest,state,created) VALUES(?,?,?,?,?)',(request,target,digest,'uncertain',time.time()))
            try:session.send_task(prompt,before_send=reserve)
            except WorkerNotReady as error:
                with runtime.db() as db:
                    if db.execute('SELECT 1 FROM feedback_submissions WHERE request=?',(request,)).fetchone():
                        raise ValueError('Delivery was interrupted after submission began. Check the agent terminal before sending again')
                    db.execute('INSERT INTO feedback_submissions(request,target,digest,state,created,detail,prompt) VALUES(?,?,?,?,?,?,?)',(request,target,digest,'queued',time.time(),str(error),prompt))
                return {'sent':False,'queued':True,'target_id':target,'duplicate':False}
        with runtime.db() as db:
            db.execute('INSERT INTO feedback_submissions(request,target,digest,state,created) VALUES(?,?,?,?,?) ON CONFLICT(request) DO UPDATE SET state=excluded.state',(request,target,digest,'sent',time.time()))
        return {'sent':True,'target_id':target,'duplicate':False}


def _note_ids(path):
    try:return [n['id'] for n in json.loads(path.read_text()) if isinstance(n,dict) and isinstance(n.get('id'),str)]
    except (OSError,ValueError,TypeError):return []


def drain_feedback(runtime,delivered=None):
    """Deliver saved standalone feedback when its coding-agent prompt is ready.

    ``delivered(ids, ok)`` hears which notes reached the agent, or could not.
    """
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
                prompt=item['prompt'] or ('Implement the Agent Desk annotations in this UTF-8 JSON file: '+str(path.resolve())+
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
                if delivered:delivered(_note_ids(runtime.path.parent/'feedback-submissions'/(item['digest']+'.json')),False)
                continue
            with runtime.db() as db:
                db.execute("UPDATE feedback_submissions SET state='sent',detail='' WHERE request=?",(item['request'],))
            if delivered:delivered(_note_ids(path),True)


STATUS_SCRIPT=Path(__file__).resolve().parents[1]/'scripts'/'annotation_status.py'


def annotation_report(notes,store_path,page):
    """List each note and the command that reports progress back onto it in the page."""
    command=' '.join(shlex.quote(str(p)) for p in (sys.executable,STATUS_SCRIPT,'--file',store_path))
    where=page.get('title') or page.get('url') or 'the Agent Desk page'
    lines=['\n\nNotes on '+where+':']
    for n in sorted(notes,key=lambda n:n['n']):
        text=' "'+n['targetText'][:80]+'"' if n.get('targetText') else ''
        lines.append('- #%d %s on %s (%s%s): %s'%(n['n'],n['kind'],n['route'],n.get('selector') or n.get('tag') or 'page',text,' '.join(n['comment'].split())))
    listed='\n'.join(lines)
    if len(listed)>3500:listed=listed[:3500]+'\n- …'
    return (listed+'\nReport progress on each note by its number so it shows on the note, with `'+command+'` followed by '
            '`<n> working` when you start, `<n> resolved --reply "<what changed>"` once the change is made and checked, '
            'or `<n> open --reply "<why>"` if you change nothing. Resolved means implemented, not accepted.\n')


def submit_annotations(runtime,store,payload):
    """Send annotate-anything notes from the page to an Agent Desk session and track them on the notes."""
    ids=payload.get('note_ids');page=payload.get('page') if isinstance(payload.get('page'),dict) else {}
    if not isinstance(ids,list) or not ids:raise ValueError('Choose notes to send')
    notes=store.take(ids)
    if not notes:return {'sent':0,'watching':False}
    agent=payload.get('agent') if isinstance(payload.get('agent'),str) else ''
    result=submit_feedback(runtime,{'request_id':payload.get('request_id'),'target_id':payload.get('target_id'),'notes':notes},
                           report=annotation_report(notes,store.path,page))
    queued=bool(result.get('queued'))
    stamp=store.mark_sent([n['id'] for n in notes],agent=agent,picked_up=not queued)
    label=agent.strip()[:60] or 'your agent'
    return {'submission':submission(notes,page,stamp),'sent':len(notes),'watching':False,'agent':label,
            'delivery':{'to':label,'ok':True,**({'detail':'waiting for its prompt to be free'} if queued else {})}}
