"""Restart only the web backend, refusing to replace its live terminal owner.

Run from the checkout: python -m scripts.restart_backend --port 4310 --pid PID
The exact listener PID is required. Raw preflight metadata stays in local state.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from urllib.request import urlopen

from agent_desk.paths import DATA_DIR,PROJECT_DIR
from agent_desk.terminal_owners import TerminalOwners


def restart(pid,port,data_dir=DATA_DIR):
    listeners=subprocess.run(['lsof','-nP','-t',f'-iTCP:{port}','-sTCP:LISTEN'],capture_output=True,text=True,check=True).stdout.split()
    if listeners!=[str(pid)]:raise ValueError('Listener PID changed; no process was signalled')
    command=subprocess.run(['ps','-p',str(pid),'-o','command='],capture_output=True,text=True,check=True).stdout
    if '-m agent_desk' not in command or 'terminal_supervisor' in command:
        raise ValueError('PID is not an Agent Desk web backend')
    client=TerminalOwners.attach(data_dir,port,start=False)
    owner=client.call('hello')['pid']
    before={s['id']:client.get(s['id']).process.pid for s in client.list() if s['exit_code'] is None}
    root=Path(data_dir)/'restarts';root.mkdir(mode=0o700,parents=True,exist_ok=True)
    stamp=str(int(time.time()))
    snapshot=root/(stamp+'-preflight.json')
    with os.fdopen(os.open(snapshot,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as stream:
        json.dump(dict(backend=pid,owner=owner,terminals=before),stream)
    # A final authenticated handshake precedes the only signal: to the web PID.
    if client.call('hello')['pid']!=owner:raise ValueError('Terminal owner changed; restart cancelled')
    os.kill(pid,signal.SIGINT)
    deadline=time.monotonic()+25
    while time.monotonic()<deadline:
        result=subprocess.run(['lsof','-nP','-t',f'-iTCP:{port}','-sTCP:LISTEN'],capture_output=True,text=True)
        if not result.stdout.strip():break
        time.sleep(.2)
    else:raise ValueError('Backend did not release its port. No second process was started')
    if client.call('hello')['pid']!=owner:raise ValueError('Terminal owner changed during shutdown')
    log=root/(stamp+'-backend.log')
    with os.fdopen(os.open(log,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'ab') as stream:
        process=subprocess.Popen([sys.executable,'-m','agent_desk','--port',str(port),'--attach-only'],cwd=PROJECT_DIR,
            env=dict(os.environ,AGENT_DESK_DATA_DIR=str(Path(data_dir).resolve())),stdin=subprocess.DEVNULL,stdout=stream,stderr=stream,start_new_session=True)
    deadline=time.monotonic()+20
    while time.monotonic()<deadline:
        if process.poll() is not None:raise ValueError('New backend failed; terminals are still owned by PID '+str(owner)+'. Inspect '+str(log))
        try:
            with urlopen(f'http://127.0.0.1:{port}/config.js',timeout=1) as response:response.read()
            break
        except OSError:time.sleep(.2)
    else:raise ValueError('Backend readiness timed out; inspect '+str(log))
    after={s['id']:client.get(s['id']).process.pid for s in client.list()}
    missing=[identity for identity,pid in before.items() if after.get(identity)!=pid]
    if missing or client.call('hello')['pid']!=owner:
        raise ValueError('Continuity verification failed; no further restart attempted. Inspect '+str(snapshot))
    return dict(backend_pid=process.pid,supervisor_pid=owner,preserved_terminals=len(before),log=str(log))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid',type=int,required=True);parser.add_argument('--port',type=int,default=4310)
    args=parser.parse_args()
    try:print(json.dumps(restart(args.pid,args.port)))
    except (OSError,ValueError,subprocess.SubprocessError) as error:parser.exit(1,str(error)+'\n')
