"""Preserve native worker links before upgrading servers without checkpoint support.

Only reads the local server and native history; --save writes Agent Desk's worker
registry. Never sends terminal input, stops a process, or starts a model turn.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from urllib.request import urlopen

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from agent_desk.accounts import SINGLE, harness_of
from agent_desk.coordinator_runtime import CoordinatorRuntime
from scripts.control_mailbox import Mailbox


from agent_desk.native_session_lookup import find_conversation
from agent_desk.paths import DATA_DIR

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--save',action='store_true');parser.add_argument('--port',type=int,default=4310);args=parser.parse_args()
    desk='http://127.0.0.1:'+str(args.port)
    with urlopen(desk+'/api/agents',timeout=10) as response:agents=json.load(response)['agents']
    workers=[a for a in agents if a.get('terminal_id') and str(a.get('parent_id','')).startswith('coordinator-') and a.get('exit_code') is None]
    box=Mailbox();tasks=box.events(desk);commands=subprocess.check_output(['ps','-axo','command='],text=True)
    processes=[]
    for line in commands.splitlines():
        if 'terminal_worker.py ' not in line:continue
        tail=line.split('terminal_worker.py ',1)[1];start=tail.find('[')
        if start<0:continue
        try:argv,end=json.JSONDecoder().raw_decode(tail[start:])
        except ValueError:continue
        if isinstance(argv,list):processes.append((tail[:start].strip(),argv))
    sessions={};missing=[];known=0
    for worker in workers:
        assigned=[t for t in tasks if t['worker']==worker['id']]
        matches=[argv for cwd,argv in processes if cwd==worker['cwd'] and any(t['id'] in json.dumps(argv) for t in assigned)]
        if len(matches)!=1:
            missing.append(worker['id']);continue
        profile=worker.get('launch_profile') or (Path(matches[0][0]).name if Path(matches[0][0]).name in SINGLE else '')
        native=box.conversation(desk,worker['id'])
        if not native:
            # Original launch hook/task is present in the worker argv, even after follow-ups.
            origins=[t for t in assigned if t['id'] in json.dumps(matches[0])]
            for task in origins:
                native=find_conversation(profile,task['id'])
                if native:
                    if args.save:box.remember_conversation(desk,task['id'],native,harness_of(profile))
                    break
        known+=bool(native)
        sessions[worker['id']]=SimpleNamespace(id=worker['id'],parent_id=worker['parent_id'],name=worker.get('name','Worker'),cwd=worker['cwd'],launch_profile=profile,argv=matches[0])
    if args.save:
        manager=SimpleNamespace(external_parents=set(),list=lambda:[],get=lambda identity:sessions[identity])
        path=DATA_DIR/('coordinators.sqlite3' if args.port==4310 else 'coordinators-'+str(args.port)+'.sqlite3')
        runtime=CoordinatorRuntime(path,manager,box)
        for session in sessions.values():runtime.remember_worker(session)
    print(json.dumps(dict(live_workers=len(workers),launches_matched=len(sessions),native_ids_found=known,unmatched_workers=missing,saved=args.save)))
    return bool(missing)


if __name__=='__main__':raise SystemExit(main())
