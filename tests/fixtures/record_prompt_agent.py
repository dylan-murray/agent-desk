#!/usr/bin/env python3
"""A stand-in automation agent for browser checks: it saves the prompt it was started with and waits.

Agent Desk starts an automation as `COMMAND PROMPT`; this appends PROMPT as a JSON line to
prompts.jsonl in its working folder, so a check can read exactly what the pass was asked to do.
"""
import json
import sys
import time
from pathlib import Path

with (Path.cwd() / 'prompts.jsonl').open('a') as handle:
    handle.write(json.dumps({'prompt': sys.argv[-1]}) + '\n')
print('Recorded the prompt; waiting.', flush=True)
time.sleep(600)
