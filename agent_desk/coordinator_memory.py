"""Local, scoped context storage. Retrieval never executes code or changes source files."""
import hashlib
import json
import os
import re
import tempfile
import time


def excerpt(text,limit=600):
    text=str(text or '')
    return text if len(text)<=limit else text[:limit]+'… [excerpt; retrieve source for full text]'


class CoordinatorMemory:
    def init_memory(self):
        with self.db() as db:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS context_artifacts(id TEXT PRIMARY KEY,coordinator TEXT,title TEXT,path TEXT,bytes INTEGER,created REAL);
            CREATE INDEX IF NOT EXISTS context_artifacts_owner ON context_artifacts(coordinator,created);
            CREATE TABLE IF NOT EXISTS context_memory(coordinator TEXT,name TEXT,text TEXT,source TEXT,updated REAL,PRIMARY KEY(coordinator,name));
            CREATE TABLE IF NOT EXISTS context_reader(coordinator TEXT PRIMARY KEY,profile TEXT,model TEXT);
            CREATE TABLE IF NOT EXISTS context_cache(coordinator TEXT,cache_key TEXT,artifact TEXT,created REAL,PRIMARY KEY(coordinator,cache_key));
            CREATE TABLE IF NOT EXISTS context_cache_hits(coordinator TEXT,created REAL,input_bytes INTEGER);
            ''')

    def artifact(self,identity,title,text):
        raw=text.encode();key=hashlib.sha256(identity.encode()+b'\0'+raw).hexdigest()
        root=self.path.parent/'coordinator-artifacts';root.mkdir(mode=0o700,exist_ok=True)
        target=root/(key+'.txt')
        if not target.exists():
            fd,temp=tempfile.mkstemp(dir=root,prefix='.artifact-')
            try:
                with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
                os.replace(temp,target)
            finally:
                if os.path.exists(temp):os.unlink(temp)
        with self.db() as db:db.execute('INSERT OR IGNORE INTO context_artifacts VALUES(?,?,?,?,?,?)',(key,identity,title[:160],target.name,len(raw),time.time()))
        return 'artifact:'+key

    def memory_notes(self,identity):
        with self.db() as db:return [dict(r) for r in db.execute('SELECT name,text,source,updated FROM context_memory WHERE coordinator=? ORDER BY name',(identity,))]

    def save_memory(self,payload,from_model=False):
        identity=payload.get('id');self.get(identity)
        name=payload.get('name','');text=payload.get('text','');source=payload.get('source','')
        if not isinstance(name,str) or not 1<=len(name)<=80 or not isinstance(text,str) or not 1<=len(text.encode())<=1500:raise ValueError('Memory needs a name and a note of at most 1500 bytes')
        if from_model:
            if not re.fullmatch(r'message:\d+',source):raise ValueError('Memory must cite a source message')
            with self.db() as db:row=db.execute('SELECT kind FROM messages WHERE coordinator=? AND id=?',(identity,int(source.split(':')[1]))).fetchone()
            if not row:raise ValueError('Memory source message was not found in this coordinator')
            if row['kind'] not in ('user','assistant'):raise ValueError('Memory source type is '+row['kind']+'. Cite the user or assistant message that established this instruction')
            source_kind=row['kind']
        else:source_kind='user note';source='user'
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            existing=db.execute('SELECT source FROM context_memory WHERE coordinator=? AND name=?',(identity,name)).fetchone()
            if from_model and existing and existing['source']=='user':raise ValueError('User-pinned memory can only be edited by the user')
            total=db.execute('SELECT COALESCE(SUM(length(CAST(text AS BLOB))),0) FROM context_memory WHERE coordinator=? AND name!=?',(identity,name)).fetchone()[0]
            if total+len(text.encode())>12000:raise ValueError('Memory is full (12 KB). Consolidate or remove outdated notes first')
            db.execute('INSERT OR REPLACE INTO context_memory VALUES(?,?,?,?,?)',(identity,name,text,source,time.time()))
        return {'saved':True,'source_kind':source_kind}

    def delete_memory(self,payload):
        self.get(payload.get('id'))
        with self.db() as db:db.execute('DELETE FROM context_memory WHERE coordinator=? AND name=?',(payload['id'],payload.get('name')))
        return {'deleted':True}

    def retrieve(self,identity,reference='',query='',offset=0):
        self.get(identity)
        if type(offset) is not int or not 0<=offset<=10_000_000:raise ValueError('Invalid source offset')
        if not isinstance(reference,str):raise ValueError('Invalid source reference')
        if reference:
            kind,_,key=reference.partition(':');text=None;title=reference
            with self.db() as db:
                if kind=='message' and key.isdigit():
                    row=db.execute('SELECT kind,text FROM messages WHERE coordinator=? AND id=?',(identity,int(key))).fetchone()
                    if row:title=row['kind'];text=row['text']
                elif kind=='artifact' and re.fullmatch('[a-f0-9]{64}',key):
                    row=db.execute('SELECT title,path FROM context_artifacts WHERE coordinator=? AND id=?',(identity,key)).fetchone()
                    if row:title=row['title'];text=(self.path.parent/'coordinator-artifacts'/row['path']).read_text()
            if kind=='task':
                task=self.mailbox.get(self.desk,key)
                if task['controller']==identity:text=json.dumps({k:task[k] for k in ('id','worker','task','status','outcome','result')},ensure_ascii=False)
            if text is None:raise ValueError('Source not found in this coordinator')
            end=offset+6000
            return {'reference':reference,'title':title,'text':text[offset:end],'offset':offset,'next_offset':end if end<len(text) else None,'characters':len(text)}
        if not isinstance(query,str) or not 1<=len(query)<=200:raise ValueError('Enter a search phrase or source reference')
        # Literal parameterized substring matching; results are bounded and preserve source IDs.
        pattern='%'+query.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')+'%'
        with self.db() as db:
            rows=db.execute("SELECT id,kind,text FROM messages WHERE coordinator=? AND text LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 12 OFFSET ?",(identity,pattern,offset)).fetchall()
        matches=[]
        for row in rows:
            at=row['text'].lower().find(query.lower());start=max(0,at-100)
            matches.append({'reference':'message:'+str(row['id']),'kind':row['kind'],'excerpt':excerpt(row['text'][start:],350),'offset':start})
        return {'matches':matches,'next_offset':offset+12 if len(matches)==12 else None}

    def context_state(self,identity):
        self.get(identity)
        with self.db() as db:
            artifacts=[dict(r) for r in db.execute('SELECT id,title,bytes,created FROM context_artifacts WHERE coordinator=? ORDER BY created DESC LIMIT 40',(identity,))]
            reader=db.execute('SELECT profile,model FROM context_reader WHERE coordinator=?',(identity,)).fetchone()
            hits=db.execute('SELECT COUNT(*),COALESCE(SUM(input_bytes),0) FROM context_cache_hits WHERE coordinator=?',(identity,)).fetchone()
        return dict(notes=self.memory_notes(identity),artifacts=artifacts,reader=dict(reader) if reader else None,cache_hits=hits[0],cached_input_bytes=hits[1])

    def compact_context(self,c):
        identity=c['id'];snap=self.snapshot(identity)
        with self.db() as db:
            recent=[dict(r) for r in db.execute('SELECT * FROM (SELECT * FROM messages WHERE coordinator=? ORDER BY id DESC LIMIT 12) ORDER BY id',(identity,))]
            directives=[dict(r) for r in db.execute("SELECT id,text FROM messages WHERE coordinator=? AND kind='user' ORDER BY id DESC LIMIT 8",(identity,))]
        latest_user=directives[0]['id'] if directives else None
        if latest_user and all(m['id']!=latest_user for m in recent):recent.insert(0,{'id':latest_user,'kind':'user','text':directives[0]['text']})
        conversation=[]
        for m in recent:
            text=m['text'];reference='message:'+str(m['id'])
            if m['kind']!='user' and len(text)>1000 and not (m is recent[-1] and text.startswith('Retrieved source:\n')):
                ref=self.artifact(identity,m['kind']+' message '+str(m['id']),text)
                text=excerpt(text,700)+'\nFull output: '+ref
            conversation.append({'kind':m['kind'],'text':text,'reference':reference})
        tasks=self.mailbox.inbox(self.desk,identity,True)
        active=[t for t in tasks if t['result'] is None and t['status']!='cancelled'];done=[t for t in tasks if t['result'] is not None or t['status']=='cancelled'][-12:]
        history=[]
        for t in active+done:
            result=t['result']
            item={'id':t['id'],'worker_id':t['worker'],'task':excerpt(t['task'],400),'status':t['status'],'outcome':t['outcome'],'result':excerpt(result,240) if result is not None else None,'reference':'task:'+t['id']}
            if result and len(result)>1000:item['artifact']=self.artifact(identity,'Report '+t['id'],result)
            history.append(item)
        state=self.context_state(identity)
        return dict(coordinator=c,original_goal=self.original_goal(identity),memory=state['notes'],
            recent_user_directives=[{'reference':'message:'+str(m['id']),'excerpt':excerpt(m['text'],500)} for m in directives if m['id']!=latest_user],
            conversation=conversation,task_history=history,
            actions=[{**a,'detail':excerpt(a['detail'],250)} for a in snap['actions'][:8]],
            workers=[w for w in self.terminals.list() if w.get('parent_id')==identity],saved_workers=snap['saved_workers'],
            worker_reviews=[{'worker_id':r['worker_id'],'task_id':r['task_id']} for r in snap['worker_reviews']],
            reader=state['reader'],pr_monitors=self.watches(identity),retrieval='Use recall with worker_id=source reference and name=character offset, or task=search phrase. Memory summaries are advisory; source messages control approvals. Retrieve missing constraints before acting.')
