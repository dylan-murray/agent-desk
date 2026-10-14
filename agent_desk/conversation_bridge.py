"""Desk integration for an independent portable conversation format."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets

from agent_desk.accounts import accounts, config_folder, harness_of
from agent_desk.conversations import read_transcript, context_document, handoff_prompt, user_text


def sources(home=None):
    home=Path(home or Path.home())
    found={a['id']:(config_folder(a['id'],home)/('projects' if a['harness']=='claude' else 'sessions'),'*.jsonl') for a in accounts()}
    return found|{'grok':(home/'.grok/sessions','chat_history.jsonl')}


class ConversationBridge:
    def __init__(self, data_dir, home=None):
        self.root=Path(data_dir)/'conversations';self.home=home

    def candidates(self):
        rows=[]
        for profile,(root,pattern) in sources(self.home).items():
            for path in root.rglob(pattern):
                if 'subagents' in path.parts:continue
                try:stat=path.stat()
                except OSError:continue
                identity=hashlib.sha256((profile+'\0'+str(path)).encode()).hexdigest()
                rows.append(dict(id=identity,profile=profile,path=str(path),updated=stat.st_mtime,bytes=stat.st_size,name=path.stem))
        return sorted(rows,key=lambda x:x['updated'],reverse=True)

    def catalog(self,offset=0):
        # Reading titles is bounded to the latest 200 local conversations.
        if type(offset) is not int or offset<0:raise ValueError('Invalid conversation page')
        candidates=self.candidates()
        rows=candidates[offset:offset+200]
        for row in rows:
            try:
                with Path(row['path']).open() as source:
                    for _ in range(80):
                        line=source.readline(65536)
                        if not line:break
                        if not line.endswith('\n'):break
                        record=json.loads(line)
                        meta=record.get('payload',{}) if record.get('type')=='session_meta' else record
                        if meta.get('cwd'):row['cwd']=meta['cwd']
                        msg=record.get('message',record.get('payload',record))
                        if isinstance(msg,dict) and (msg.get('role')=='user' or row['profile']=='grok' and msg.get('type')=='user' and not msg.get('synthetic_reason')):
                            content=msg.get('content','')
                            title=user_text(content)
                            if title:row['title']=title[:160];break
            except (OSError,ValueError,TypeError):pass
        # Imported records remain selectable even if the native file moves or
        # its original harness is removed.
        for path in (sorted(self.root.glob('*.json'),key=lambda p:p.stat().st_mtime,reverse=True) if offset==0 else []):
            if not re.fullmatch(r'[a-f0-9]{64}\.json',path.name):continue
            try:
                saved=json.loads(path.read_text())
                rows.append(dict(id='portable:'+saved['id'],profile='portable',title=saved['title'],name=saved['title'],cwd=saved['cwd'],updated=path.stat().st_mtime))
            except (OSError,ValueError,KeyError):continue
        return {'conversations':rows,'limit':200,'next_offset':offset+200 if offset+200<len(candidates) else None}

    def import_source(self,payload):
        selected=payload.get('source_id','')
        if isinstance(selected,str) and re.fullmatch(r'portable:[a-f0-9]{64}',selected):
            try:record=json.loads((self.root/(selected[9:]+'.json')).read_text())
            except (OSError,ValueError):raise ValueError('Saved portable conversation is unavailable') from None
            return {k:v for k,v in record.items() if k not in ('events','messages')}|{'message_count':len(record['messages'])}
        row=next((r for r in self.candidates() if r['id']==payload.get('source_id')),None)
        if not row:raise ValueError('Choose a saved local conversation and refresh if it moved')
        record=read_transcript(row['path'],harness_of(row['profile']));record['source']['profile']=row['profile']
        # Link a subsequent native session to its own previous portable history.
        # Only an explicit handoff at the start of a user message is a link.
        for message in record['messages']:
            if message['role']!='user':continue
            content=message['content']
            # Harnesses may prepend separate system-reminder blocks to the first
            # user turn. Match an explicit user text block, never a tool result
            # or a handoff quoted in the middle of another message.
            texts=[content] if isinstance(content,str) else [x.get('text','') for x in content if isinstance(x,dict) and x.get('type') in ('text','input_text')] if isinstance(content,list) else []
            match=next((m for text in texts if (m:=re.match(r'Continue portable conversation ([a-f0-9]{64})\. Read the complete UTF-8 conversation record at ',text))),None)
            if not match:continue
            parent_path=self.root/(match[1]+'.json')
            if parent_path.is_file() and match[1]!=record['id']:
                parent=json.loads(parent_path.read_text())
                record['parent_id']=parent['id']
                record['messages']=parent['messages']+record['messages']
                record['warnings']=sorted(set(parent.get('warnings',[])+record['warnings']))
            break
        self.root.mkdir(mode=0o700,parents=True,exist_ok=True)
        destination=self.root/(record['id']+'.json')
        data=json.dumps(record,ensure_ascii=False,indent=2)+'\n'
        temp=self.root/('.'+secrets.token_hex(12))
        try:
            with os.fdopen(os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as stream:stream.write(data)
            os.replace(temp,destination)
        finally:temp.unlink(missing_ok=True)
        return {k:v for k,v in record.items() if k not in ('events','messages')}|{'message_count':len(record['messages'])}

    def prepare(self,payload):
        identity=payload.get('conversation_id','')
        if not isinstance(identity,str) or not re.fullmatch('[a-f0-9]{64}',identity):raise ValueError('Import a conversation first')
        path=self.root/(identity+'.json')
        if not path.is_file():raise ValueError('Saved conversation is unavailable')
        record=json.loads(path.read_text())
        task=payload.get('task','Continue the unfinished work in this conversation.')
        if not isinstance(task,str) or not 1<=len(task.strip())<=8000:raise ValueError('Enter a continuation request of up to 8,000 characters')
        context=self.root/(identity+'.context.json')
        with os.fdopen(os.open(context,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600),'w') as stream:stream.write(context_document(record))
        return {'prompt':handoff_prompt(context,identity,task),'conversation_id':identity,'cwd':record['cwd']}
