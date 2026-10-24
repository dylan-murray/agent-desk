"""Readouts for one terminal: give the agent launched in it the agent-desk tool server (set_readouts).

Readouts are opt in per terminal. The tool is passed on the agent's command line for that launch only,
so nothing is written to an account's configuration and agents started elsewhere never see it.

Verified against the harnesses (Claude Code, Codex 0.159):
- Claude Code takes ``--mcp-config <json>`` and passes its whole environment to stdio tool servers, so
  the pane's identity arrives as is. ``--mcp-config`` is variadic, so a single-valued ``--settings`` follows
  it, carrying the allow rule that keeps an unattended loop from stalling on a permission prompt.
- Codex takes ``-c mcp_servers.<name>.<key>=<toml>`` overrides. It starts tool servers with a small
  environment allowlist, so ``env_vars`` must name the pane variables.

Earlier versions registered the server once per account (``claude mcp add --scope user`` plus an allow
rule; a marked table in Codex's ``config.toml``). ``retire`` removes those entries at startup, and only
those: never an ``agent-desk`` entry Agent Desk did not write.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

from agent_desk import readouts, skill_harnesses
from agent_desk.accounts import account, config_folder

NAME = 'agent-desk'
TOOL = 'mcp__agent-desk__set_readouts'
ENV_VARS = list(readouts.IDENTITY)
BEGIN = '# >>> agent-desk tool server (managed by Agent Desk; remove it from the Skills page)'  # as earlier versions wrote it
END = '# <<< agent-desk tool server'


def command():
    return [sys.executable, '-I', '-S', str(Path(__file__).with_name('tool_server.py'))]


def targets(home=None, environ=None):
    home = Path(home) if home is not None else Path.home()
    found = []
    for harness in skill_harnesses.harnesses(home, environ):
        profile = harness['id']
        known = account(profile)
        if not known or known['harness'] not in ('claude', 'codex'):
            found.append(dict(id=profile, label=harness['label'], kind='unsupported'))
            continue
        folder = config_folder(profile, home)
        if known['harness'] == 'claude':
            added = bool(known['config_dir'])
            found.append(dict(id=profile, label=harness['label'], kind='claude', home=home, config_dir=folder if added else None,
                              config=(folder if added else home) / '.claude.json', settings=folder / 'settings.json'))
        else:
            found.append(dict(id=profile, label=harness['label'], kind='codex', home=home, config=folder / 'config.toml'))
    return found


def _read_json(path):
    if not path.exists():
        return {}
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError(f'{path} is not a JSON object')
    return data


def _write_atomic(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.agent-desk-tmp')
    temporary.write_text(text)
    if path.exists():
        os.chmod(temporary, path.stat().st_mode & 0o777)
    os.replace(temporary, path)


def _without_block(text):
    if BEGIN not in text:
        return text
    start, end = text.index(BEGIN), text.find(END, text.index(BEGIN))
    if end < 0:
        raise ValueError('The Agent Desk block in the Codex config is incomplete; fix it by hand')
    return (text[:start].rstrip('\n') + '\n' + text[end + len(END):].lstrip('\n')).lstrip('\n')


def _claude(target, *args):
    executable = shutil.which('claude')
    if not executable:
        raise ValueError('The claude command is not on PATH')
    env = dict(os.environ, HOME=str(target['home']))
    env.pop('CLAUDE_CONFIG_DIR', None)
    if target['config_dir']:
        env['CLAUDE_CONFIG_DIR'] = str(target['config_dir'])
    result = subprocess.run([executable, 'mcp', *args], env=env, capture_output=True, text=True, timeout=60)
    return result


def _allow(target, allowed):
    settings = _read_json(target['settings'])
    permissions = settings.setdefault('permissions', {})
    rules = [rule for rule in permissions.get('allow', []) if rule != TOOL]
    permissions['allow'] = rules + [TOOL] if allowed else rules
    _write_atomic(target['settings'], json.dumps(settings, indent=2) + '\n')


def unregister(target):
    if target['kind'] == 'claude':
        _claude(target, 'remove', '--scope', 'user', NAME)
        _allow(target, False)
    elif target['kind'] == 'codex' and target['config'].exists():
        text = target['config'].read_text()
        if BEGIN in text:
            updated = _without_block(text)
            tomllib.loads(updated)
            _write_atomic(target['config'], updated)


def with_readouts(argv):
    """The launch command with the tool server added for this agent only, right after its executable."""
    if len(argv) >= 4 and argv[1] == '-lic' and argv[3] == 'agent-desk':
        match, start = re.search(r'(?:^|\n)(claude|codex)(?:-[a-z0-9-]+)? "\$@"$', argv[2]), 4
    else:
        match, start = (re.fullmatch(r'(claude|codex)(?:-[a-z0-9-]+)?', Path(argv[0]).name) if argv else None), 1
    if not match:
        raise ValueError('Readouts work with Claude and Codex agents')
    server = command()
    if match.group(1) == 'claude':
        flags = ['--mcp-config', json.dumps({'mcpServers': {NAME: {'type': 'stdio', 'command': server[0], 'args': server[1:]}}}),
                 '--settings', json.dumps({'permissions': {'allow': [TOOL]}})]
    else:
        flags = [flag for key, value in (('command', server[0]), ('args', server[1:]), ('env_vars', ENV_VARS))
                 for flag in ('-c', f'mcp_servers.{NAME}.{key}={json.dumps(value)}')]
    return [*argv[:start], *flags, *argv[start:]]


def _wrote(target):
    """Whether this account holds a registration an earlier Agent Desk wrote."""
    if target['kind'] == 'claude':
        server = _read_json(target['config']).get('mcpServers', {}).get(NAME)
        return isinstance(server, dict) and Path(str((server.get('args') or [''])[-1])).name == 'tool_server.py'
    return target['kind'] == 'codex' and target['config'].exists() and BEGIN in target['config'].read_text()


def retire(home=None, environ=None):
    """Remove the account-wide registrations earlier versions wrote, now that readouts are per terminal."""
    removed, errors = [], []
    for target in targets(home, environ):
        try:
            if target['kind'] != 'unsupported' and _wrote(target):
                unregister(target)
                removed.append(target['label'])
        except (OSError, ValueError, subprocess.SubprocessError, tomllib.TOMLDecodeError) as error:
            errors.append(f"{target['label']}: {error}")
    return dict(removed=removed, errors=errors)
