"""Explicit managed-terminal account directories, isolated from the Desk launcher."""
from pathlib import Path
import os
import re
import shlex

from agent_desk.accounts import HARNESSES, account, config_folder

AUTH_OVERRIDES = ('CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'OPENAI_API_KEY', 'CODEX_API_KEY',
                  'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID',
                  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN')

# A new PTY is a fresh agent, even when Desk was launched from another agent.
# Account configuration may be shared; caller conversation/owner IDs may not.
# An inherited CLAUDE_CODE_CHILD_SESSION also turns off transcript saving,
# which leaves nothing for `claude --resume` after a restart.
CALLER_CONTEXT = ('CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION',
                  'CLAUDE_PID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ATTENDED',
                  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_TMPDIR', 'CLAUDE_TMPDIR',
                  'AGENT_DESK_AGENT_ID', 'AGENT_DESK_COORDINATOR_ID', 'AGENT_DESK_WORKER_ID', 'AGENT_DESK_RUN_ID')


HOST_TERMINAL = ('TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID', 'LC_TERMINAL', 'LC_TERMINAL_VERSION',
                 'CURSOR_TRACE_ID', 'WT_SESSION', 'KITTY_WINDOW_ID', 'ITERM_SESSION_ID', 'ITERM_PROFILE')
HOST_TERMINAL_PREFIXES = ('VSCODE_', 'GHOSTTY_')


def infer_profile(argv):
    command = Path(argv[0]).name if argv else ''
    if len(argv) >= 4 and argv[1] == '-lic' and argv[3] == 'agent-desk':
        match = re.fullmatch(r'([a-z][a-z0-9-]*) "\$@"', argv[2])
        command = match.group(1) if match else ''
    return command if account(command) else None


def terminal_environment(parent, profile=None, home=None):
    selected = account(profile) if profile is not None else None
    if profile is not None and not selected:
        raise ValueError('Unknown launch account profile')
    env = dict(parent)
    for key in CALLER_CONTEXT:env.pop(key,None)
    if remote_native():
        if selected and not selected['default']:
            raise ValueError('Added local accounts are unavailable remotely; configure the CLI on the remote machine')
        return env
    if profile:
        # An account selects saved CLI configuration, not the API keys or
        # config folder of the process that happened to start Agent Desk.
        for key in AUTH_OVERRIDES:
            env.pop(key, None)
        # Unset preserves Claude's default macOS Keychain entry. Explicitly setting
        # even ~/.claude can select a different store from a normal CLI launch.
        if HARNESSES[selected['harness']][0] and (selected['config_dir'] or selected['harness'] != 'claude'):
            env[HARNESSES[selected['harness']][0]] = str(config_folder(profile, home))
    return env


def profile_command(argv, profile=None, home=None):
    """Apply account selection after a login shell has sourced its rc files.

    Keep aliases/functions and positional arguments, but do not let rc exports
    silently replace the selected saved login with an API key or another store.
    The command names the account; an added account runs its harness's CLI, and a Cortex Code account its connection.
    """
    if remote_native():
        terminal_environment({}, profile)
        return list(argv)
    selected = account(profile) if profile is not None else None
    if not selected or len(argv)<4 or argv[1]!='-lic' or argv[3]!='agent-desk':
        return list(argv)
    env = terminal_environment({}, profile, home)
    prefix = 'unset ' + ' '.join((*AUTH_OVERRIDES,*CALLER_CONTEXT)) + '\n'
    prefix += ''.join('export '+key+'='+shlex.quote(value)+'\n' for key,value in env.items())
    script = argv[2]
    if not selected['default']:
        command = selected['harness'] + (' --connection ' + shlex.quote(selected['connection']) if selected['harness'] == 'cortex' else '')
        script = re.sub(r'(^|\n)'+re.escape(profile)+r' "\$@"$', lambda m: m.group(1)+command+' "$@"', script)
    return [*argv[:2], prefix+script, *argv[3:]]


# Codex subcommands that never open the interactive session; everything else (no arguments, a prompt,
# options, resume, fork) does.
CODEX_NON_SESSION = {'exec', 'e', 'review', 'login', 'logout', 'mcp', 'mcp-server', 'app-server', 'completion', 'sandbox',
                     'debug', 'apply', 'a', 'cloud', 'features', 'agents', 'remote-control', 'help'}


def codex_without_daemon(argv):
    """Keep an interactive Codex session in its pane rather than Codex's shared background service.

    A shared service starts tool servers (and runs commands) with whatever environment it was first started
    with, so they lose the pane they belong to. ``--no-daemon`` runs the session's server inside the pane.
    """
    lic = len(argv) >= 4 and argv[1] == '-lic' and argv[3] == 'agent-desk' and re.search(r'(^|\n)codex(-[a-z0-9-]+)? "\$@"$', argv[2])
    start = 4 if lic else 1 if argv and Path(argv[0]).name == 'codex' else None
    if start is None or '--no-daemon' in argv[start:]:
        return list(argv)
    words = [a for a in argv[start:argv.index('--')] if not a.startswith('-')] if '--' in argv[start:] else [a for a in argv[start:] if not a.startswith('-')]
    if words and words[0] in CODEX_NON_SESSION:
        return list(argv)
    return [*argv[:start], '--no-daemon', *argv[start:]]


def remote_native():
    return os.environ.get('AGENT_DESK_REMOTE_NATIVE') == '1'


def login_shell():
    return '/bin/bash' if remote_native() else '/bin/zsh'
