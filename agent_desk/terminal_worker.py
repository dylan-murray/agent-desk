"""PTY supervisor in a separate process: never fork the threaded HTTP server."""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from agent_desk.launch_profiles import terminal_environment, profile_command, codex_without_daemon, HOST_TERMINAL, HOST_TERMINAL_PREFIXES


def main():
    cwd, argv = sys.argv[1], json.loads(sys.argv[2])
    child, master = pty.fork()
    if child == 0:
        os.chdir(cwd)
        profile = (sys.argv[3] or None) if len(sys.argv)>3 else None
        env = terminal_environment(os.environ, profile)
        from agent_desk.standalone_agent import SHELL_MARKER
        if SHELL_MARKER in argv:
            argv = [sys.executable, str(Path(__file__).with_name('standalone_agent.py')), profile or '-',
                    *(arg for arg in argv if arg != SHELL_MARKER)]
        else:
            argv = codex_without_daemon(profile_command(argv, profile))
        for key in [k for k in env if k.startswith(HOST_TERMINAL_PREFIXES) or k in HOST_TERMINAL]:
            env.pop(key, None)
        env.update(TERM='xterm-256color', COLORTERM='truecolor')
        # Every process in the pane descends from this one; readouts check it before writing here.
        env['AGENT_DESK_PANE_PID'] = str(os.getpid())
        # Agent Desk is a real color terminal, even if its launcher was noninteractive.
        env.pop('NO_COLOR', None)
        for key in ('PS1', 'PS2', 'PROMPT', 'RPROMPT', 'RPS1', 'PROMPT_COMMAND'):
            env.pop(key, None)
        os.execvpe(argv[0], argv, env)  # nosemgrep: python.lang.security.audit.dangerous-os-exec-tainted-env-args.dangerous-os-exec-tainted-env-args
    def stop(*_):
        groups = {child}
        try:
            groups.add(os.tcgetpgrp(master))
        except OSError:
            pass
        for group in groups:
            if group > 0 and group != os.getpgrp():
                try:
                    os.killpg(group, signal.SIGHUP)
                except OSError:
                    pass
        try:
            os.close(master)
        except OSError:
            pass
    signal.signal(signal.SIGTERM, lambda *_: (stop(), sys.exit(0)))
    pending = b''
    delivery = None
    def write_input(content):
        while content:
            written = os.write(master, content)
            content = content[written:]
    try:
        if len(sys.argv)>4:
            from scripts.native_terminal_events import NativeDelivery
            delivery = NativeDelivery(json.loads(sys.argv[4]))
        while True:
            watched = [master, 0]
            if delivery and not delivery.failed:
                watched.append(delivery.observer.stdout)
            ready, _, _ = select.select(watched, [], [], .25 if delivery else None)
            if master in ready:
                try:
                    data = os.read(master, 32768)
                except OSError:
                    break
                if not data:
                    break
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
                if delivery:
                    delivery.observe(dict(op='output', data=base64.b64encode(data).decode()))
            if 0 in ready:
                data = os.read(0, 65536)
                if not data:
                    break
                pending += data
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    event = json.loads(line)
                    if event['op'] == 'input':
                        content = base64.b64decode(event['data'])
                        if delivery:
                            delivery.user_input(content)
                        write_input(content)
                    elif event['op'] == 'resize':
                        fcntl.ioctl(master, termios.TIOCSWINSZ,
                                    struct.pack('HHHH', event['rows'], event['cols'], 0, 0))
                        if delivery:
                            delivery.observe(event)
                    elif event['op'] == 'stop':
                        return
            if delivery:
                if delivery.observer.stdout in ready:
                    delivery.read()
                # Do not inject into a different foreground process or ahead
                # of newly queued user input / an unread screen repaint.
                pending_io, _, _ = select.select([master,0],[],[],0)
                if not pending_io and os.tcgetpgrp(master)==child:
                    delivery.tick(write_input)
    finally:
        stop()
        if delivery:
            delivery.close()
        try:
            _, status = os.waitpid(child, 0)
            code = os.waitstatus_to_exitcode(status)
        except ChildProcessError:
            code = 0
    sys.exit(max(0, code) if code >= 0 else 128 - code)


if __name__ == '__main__':
    main()
