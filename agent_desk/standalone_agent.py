"""Run a manually launched agent, then leave its PTY at an interactive shell.

This process belongs only to new standalone launches. Controllers, automation
workers and existing sessions never pass through it.
"""
import os
from pathlib import Path
import signal
import subprocess
import sys
import termios

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from agent_desk.accounts import SINGLE
from agent_desk.launch_profiles import codex_without_daemon, profile_command, login_shell

# The per-terminal PTY worker consumes this private launch flag before exec.
# Keeping argv[0] intact preserves identity in already-running supervisors.
SHELL_MARKER = '--agent-desk-shell-on-exit'


def launch_payload(payload):
    """Wrap only supported manually launched agents, preserving exact arguments."""
    from agent_desk.launch_profiles import infer_profile
    if payload.get('parent_id') or payload.get('coordinator_harness') is not None:return payload
    argv=payload.get('argv')
    if not isinstance(argv,list) or not argv or any(not isinstance(a,str) or not a or '\0' in a or len(a)>10000 for a in argv):return payload
    profile=payload.get('launch_profile') or infer_profile(argv)
    if not profile and Path(argv[0]).name not in SINGLE:return payload
    if len(argv)>99:raise ValueError('Standalone agent launch supports at most 99 command arguments')
    return dict(payload,argv=[*argv,SHELL_MARKER],launch_profile=profile)


def main():
    profile=None if sys.argv[1]=='-' else sys.argv[1]
    argv=codex_without_daemon(profile_command(sys.argv[2:],profile))
    original=termios.tcgetattr(0)
    # The agent receives SIGINT normally. Its supervising wrapper stays around
    # to restore the terminal and start the user's shell when the agent exits.
    signal.signal(signal.SIGINT,lambda *_:None)
    try:
        child=subprocess.Popen(argv)  # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-tainted-env-args.dangerous-subprocess-use-tainted-env-args
        code=child.wait()
    except OSError as error:
        print('Could not start agent: '+str(error),flush=True)
        code=127
    signal.signal(signal.SIGTTOU,signal.SIG_IGN)
    os.tcsetpgrp(0,os.getpgrp())
    termios.tcsetattr(0,termios.TCSANOW,original)
    # Restore common full-screen modes even if a CLI exited without cleanup.
    sys.stdout.write('\x1b]777;agent-desk;shell\x07\x1b[?1049l\x1b[?2004l\x1b[?25h\x1b[0m\r\nAgent exited ('+str(code)+'). Shell ready.\r\n')
    sys.stdout.flush()
    signal.signal(signal.SIGINT,signal.SIG_DFL)
    signal.signal(signal.SIGTTOU,signal.SIG_DFL)
    shell=os.environ.get('SHELL') or login_shell()
    if not Path(shell).is_file():shell=login_shell()
    os.execv(shell,[shell,'-il'])  # nosemgrep: python.lang.security.audit.dangerous-os-exec-tainted-env-args.dangerous-os-exec-tainted-env-args


if __name__=='__main__':main()
