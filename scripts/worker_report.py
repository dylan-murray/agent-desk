"""Passive, launch-scoped worker progress observer. Never blocks a turn."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parent))
from control_mailbox import Mailbox


def report(box,desk,task_id,event,harness):
    if harness=='claude':
        if event.get('hook_event_name')!='Stop':return
        response=event.get('last_assistant_message')
    else:
        if event.get('type')!='agent-turn-complete':return
        response=event.get('last-assistant-message')
    native_id=event.get('session_id' if harness=='claude' else 'thread-id')
    if isinstance(native_id,str):
        try:box.remember_conversation(desk,task_id,native_id,harness)
        except ValueError:pass
    if not isinstance(response,str) or not response.strip():return
    # Stop/turn-complete does not mean the delegated task or background jobs ended.
    # Keep observing subsequent turns; only an explicit reply supplies an outcome.
    origin=box.get(desk,task_id)
    # Launch-scoped hooks persist when the same terminal receives another task.
    # Route observations to its latest pending task, never into a final-result slot.
    if origin['worker']!='launching':
        pending=[t for t in box.inbox(desk,origin['controller'],True)
                 if t['worker']==origin['worker'] and t['result'] is None]
        if not pending:return
        task_id=pending[-1]['id']
    box.progress(desk,task_id,response,harness)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--db',required=True);parser.add_argument('--desk',required=True)
    parser.add_argument('--task',required=True);parser.add_argument('--harness',choices=['claude','codex'],required=True)
    parser.add_argument('payload',nargs='?');args=parser.parse_args()
    try:
        raw=args.payload if args.payload is not None else sys.stdin.read(1000000)
        report(Mailbox(args.db),args.desk,args.task,json.loads(raw),args.harness)
    except (ValueError,OSError):pass
    # Empty output and exit 0: this hook never makes an approval/stop decision.
    return 0


if __name__=='__main__':sys.exit(main())
