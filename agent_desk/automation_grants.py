import json
import os
from pathlib import Path
import shlex
import uuid

from agent_desk.paths import DATA_DIR

STATES = ('review', 'blocked', 'failed')


def report_commands(helper, run_id, output):
    return [f"{helper} report --run {shlex.quote(run_id)} --state {state} --file {shlex.quote(str(output / 'result.md'))}"
            for state in STATES]


def cursor_home(environ=None):
    environ = os.environ if environ is None else environ
    if environ.get('CURSOR_CONFIG_DIR', '').strip():
        return Path(environ['CURSOR_CONFIG_DIR']).expanduser()
    if environ.get('XDG_CONFIG_HOME', '').strip():
        return Path(environ['XDG_CONFIG_HOME']).expanduser() / 'cursor'
    return Path.home() / '.cursor'


def cursor_config(run_id, allow, home=None, root=None):
    home = cursor_home() if home is None else Path(home)
    folder = (DATA_DIR if root is None else Path(root)) / 'automation-cursor' / run_id
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    for entry in home.iterdir() if home.is_dir() else ():
        link = folder / entry.name
        if entry.name != 'cli-config.json' and not link.is_symlink() and not link.exists():
            link.symlink_to(entry)
    try:
        settings = json.loads((home / 'cli-config.json').read_text())
    except (OSError, ValueError):
        settings = {}
    if not isinstance(settings, dict):
        settings = {}
    permissions = settings.get('permissions') if isinstance(settings.get('permissions'), dict) else {}
    granted = [rule for rule in permissions.get('allow', []) if isinstance(rule, str)]
    settings.setdefault('version', 1)
    settings['permissions'] = dict(permissions, allow=granted + [rule for rule in allow if rule not in granted],
                                   deny=permissions.get('deny', []) if isinstance(permissions.get('deny'), list) else [])
    target = folder / 'cli-config.json'
    temporary = folder / '.cli-config.json.tmp'
    temporary.write_text(json.dumps(settings, indent=2))
    temporary.chmod(0o600)
    temporary.replace(target)
    return folder


def cortex_settings(run_id, allow, home=None, root=None):
    environ = os.environ
    home = Path(home) if home is not None else Path(environ['SNOWFLAKE_HOME']).expanduser() / 'cortex' if environ.get('SNOWFLAKE_HOME') else Path.home() / '.snowflake' / 'cortex'
    try:
        settings = json.loads((home / 'settings.json').read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(settings, dict):
        return None
    permissions = settings.get('permissions') if isinstance(settings.get('permissions'), dict) else {}
    granted = [rule for rule in permissions.get('allow', []) if isinstance(rule, str)]
    settings['permissions'] = dict(permissions, allow=granted + [rule for rule in allow if rule not in granted])
    folder = (DATA_DIR if root is None else Path(root)) / 'automation-cortex'
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = folder / (run_id + '.json')
    path.write_text(json.dumps(settings, indent=2))
    path.chmod(0o600)
    return path


def grants(harness, run_id, output, helper):
    output = Path(output)
    reports = report_commands(helper, run_id, output)
    files = str(output) + '/**'
    if harness == 'claude':
        allowed = ['WebSearch', 'WebFetch', *('Bash(' + command + ')' for command in reports)]
        return (['--permission-mode', 'auto', '--session-id', str(uuid.uuid5(uuid.NAMESPACE_URL, 'agent-desk-run:' + run_id)),
                 '--settings', json.dumps({'autoMemoryEnabled': False, 'permissions': {'allow': allowed}})], {})
    if harness == 'codex':
        return ['--sandbox', 'workspace-write', '--add-dir', str(output)], {}
    if harness == 'grok':
        rules = ['Edit(' + files + ')', *('Bash(' + command + ')' for command in reports)]
        return ['--permission-mode', 'auto', *(word for rule in rules for word in ('--allow', rule))], {}
    if harness == 'cortex':
        rules = ['Edit(' + files + ')', 'Write(' + files + ')']
        settings = cortex_settings(run_id, rules)
        return (['--config', str(settings)] if settings else []), {}
    if harness == 'opencode':
        config = {'permission': {'external_directory': {files: 'allow'}, 'bash': {command: 'allow' for command in reports}}}
        return [], {'OPENCODE_CONFIG_CONTENT': json.dumps(config)}
    if harness == 'cursor-agent':
        rules = ['Write(' + files + ')', *('Shell(' + command + ')' for command in reports)]
        return ['--auto-review', '--add-dir', str(output)], {'CURSOR_CONFIG_DIR': str(cursor_config(run_id, rules))}
    return [], {}
