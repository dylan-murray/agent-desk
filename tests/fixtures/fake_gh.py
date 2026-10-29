"""A stand-in for the GitHub CLI that answers from JSON files and never reaches the network.

AGENT_DESK_FAKE_GH names a folder. `gh pr view` run in a folder named NAME answers from
pr-NAME.json (or pr.json); `gh run view` answers from log.json. Each answer is
{"code": exit status, "stdout": text or JSON value, "stderr": text}. Calls are appended to calls.log."""
import json
import os
import sys
from pathlib import Path

root = Path(os.environ['AGENT_DESK_FAKE_GH'])
args = sys.argv[1:]
with open(root / 'calls.log', 'a') as log:
    log.write(json.dumps([os.getcwd(), *args]) + '\n')
names = [f'pr-{Path.cwd().name}.json', 'pr.json'] if args[:2] == ['pr', 'view'] else ['log.json'] if args[:2] == ['run', 'view'] else []
found = next((root / name for name in names if (root / name).exists()), None)
answer = json.loads(found.read_text()) if found else {'code': 1, 'stderr': 'no pull requests found for branch "fixture"'}
stdout = answer.get('stdout', '')
sys.stdout.write(stdout if isinstance(stdout, str) else json.dumps(stdout))
sys.stderr.write(answer.get('stderr', ''))
sys.exit(answer.get('code', 0))
