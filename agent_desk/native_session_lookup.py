"""Resolve native conversations only from an exact dispatched task in user history."""
import json
import os
from pathlib import Path
import shutil
import subprocess

from agent_desk.accounts import account, config_folder, harness_of

def _mentions(path,text):
    try:return text in path.read_text(errors='ignore')
    except OSError:return False

def _opencode_conversation(task_id,handoff,data=None):
    """OpenCode keeps conversations in one SQLite file rather than a transcript per session."""
    import sqlite3
    store=Path(data or os.environ.get('XDG_DATA_HOME') or Path.home()/'.local'/'share')/'opencode'/'opencode.db'
    if not store.is_file():return None
    identities=set()
    try:
        db=sqlite3.connect('file:'+str(store)+'?mode=ro',uri=True,timeout=5)
        try:
            rows=db.execute('SELECT p.session_id,p.data,m.data FROM part p JOIN message m ON m.id=p.message_id '
                            'JOIN session s ON s.id=p.session_id WHERE s.parent_id IS NULL AND instr(p.data,?)>0',(task_id,)).fetchall()
        finally:db.close()
    except sqlite3.Error:return None
    for identity,part,message in rows:
        try:part,message=json.loads(part),json.loads(message)
        except ValueError:continue
        if message.get('role')=='user' and part.get('type')=='text' and handoff in part.get('text',''):identities.add(identity)
    return next(iter(identities)) if len(identities)==1 else None


def find_conversation(profile,task_id,handoff=None):
    home=Path.home()
    harness=harness_of(profile);known=account(profile)
    if harness=='opencode':return _opencode_conversation(task_id,handoff or 'reply '+task_id+' --file',config_folder(profile) if known else None)
    root=(config_folder(profile)/'projects') if known and harness=='claude' else home/'.snowflake'/'cortex'/'conversations' if harness=='cortex' else (config_folder(profile)/'sessions') if known else home/'.grok'/'sessions' if profile=='grok' else home/'.pi'/'agent'/'sessions' if profile=='pi' else None
    if os.environ.get('AGENT_DESK_REMOTE_NATIVE') == '1':
        if harness=='claude':root=Path(os.environ.get('CLAUDE_CONFIG_DIR',str(home/'.claude')))/'projects'
        elif harness=='codex':root=Path(os.environ.get('CODEX_HOME',str(home/'.codex')))/'sessions'
    if not root or not root.is_dir():return None
    pattern='chat_history.jsonl' if harness=='grok' else '*.history.jsonl' if harness=='cortex' else '*.jsonl'
    if shutil.which('rg'):
        names=subprocess.run(['rg','-l','--fixed-strings','--glob',pattern,'--',task_id,str(root)],capture_output=True,text=True,timeout=10).stdout.splitlines()
    else:
        names=[str(path) for path in root.rglob(pattern) if _mentions(path,task_id)]
    identities=set()
    for name in names:
        native=None
        try:
            with open(name) as source:
                for line in source:
                    try:record=json.loads(line)
                    except ValueError:continue
                    if record.get('type')=='session_meta':native=record.get('payload',{}).get('id')
                    if harness=='pi' and record.get('type')=='session':native=record.get('id')
                    if task_id not in line:continue
                    message=record if harness in ('grok','cortex') else record.get('message',{}) if harness in ('claude','pi') else record.get('payload',{})
                    if (message.get('type') if harness=='grok' else message.get('role'))!='user':continue
                    content=message.get('content','')
                    text=content if isinstance(content,str) else '\n'.join(x.get('text','') for x in content if isinstance(x,dict) and x.get('type') in ('text','input_text'))
                    if (handoff or 'reply '+task_id+' --file') not in text:continue
                    # Cortex names each conversation's files after its session ID.
                    identity=Path(name).parent.name if harness=='grok' else Path(name).name.removesuffix('.history.jsonl') if harness=='cortex' else record.get('sessionId') if harness=='claude' else native
                    if identity:identities.add(identity)
        except OSError:continue
    return next(iter(identities)) if len(identities)==1 else None
