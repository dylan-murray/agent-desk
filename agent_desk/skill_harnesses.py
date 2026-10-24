"""Where each local agent harness discovers skills, and keeping every skill visible to all of them.

Discovery roots, as read from the harnesses themselves:
- Claude Code loads ``$CLAUDE_CONFIG_DIR/skills`` (``~/.claude/skills`` by default).
- Codex (0.154) lists ``~/.agents/skills`` and ``$CODEX_HOME/skills`` in ``codex debug prompt-input``.
- Grok's bundled docs (``~/.grok/docs/user-guide/08-skills.md``) name ``~/.grok/skills``, ``.agents/skills``
  at each tier, and ``~/.claude/skills`` unless ``[compat.claude] skills = false``.
- OpenCode (1.3.5) lists skills from ``~/.agents/skills`` and ``~/.claude/skills`` in ``opencode debug skill``;
  its own folder is ``~/.config/opencode/skills``.
- Pi's bundled docs (``docs/skills.md``, 0.79) name ``~/.pi/agent/skills`` and ``~/.agents/skills``.
- Cortex Code (1.1.87) lists ``~/.snowflake/cortex/skills`` and ``~/.claude/skills`` in ``cortex skill list``,
  but not ``~/.agents/skills``, so shared skills are linked into its own folder.
"""
import os
import re
import tomllib
from pathlib import Path

from agent_desk.accounts import accounts, config_folder

# A skill can opt out of implicit use in each harness's own vocabulary.
EXPLICIT_FRONTMATTER = re.compile(r'^disable-model-invocation:\s*true\s*$', re.M)
EXPLICIT_OPENAI = re.compile(r'allow_implicit_invocation:\s*false')
# Instructions that only one harness can follow. A line that names the harness as an example
# ("Claude:", "in Claude Code that is ...") is guidance, not a dependency.
CLAUDE_ONLY_TOOLS = re.compile(r'\b(Monitor\(|AskUserQuestion|TodoWrite|ExitPlanMode|EnterPlanMode|subagent_type|Skill tool)')
MCP_TOOL = re.compile(r'`mcp__[A-Za-z0-9_]+`')
HARNESS_EXAMPLE = re.compile(r'\b(Claude|Claude Code|Codex|Grok|OpenCode|Pi|Cortex Code)\b\s*(:|that is|exposes)')
# `/name` or a bare /name on a line about skills, subagents or sessions, but not a URL or endpoint path.
SKILL_REFERENCE = re.compile(r'(?:`/([a-z][a-z0-9-]+)`|(?<![\w/.:>])/([a-z][a-z0-9-]+)(?=[\s,;:)!?]|$))')
SKILL_CONTEXT = re.compile(r'\b(skills?|subagents?|session|run)\b', re.I)
NOT_A_SKILL = re.compile(r'\b(endpoint|route|url|https?)\b', re.I)


def _home(home=None):
    return Path(home) if home is not None else Path.home()


def harnesses(home=None, environ=None):
    """The harnesses installed for this user, with the roots each one reads and where to link a missing skill."""
    home = _home(home)
    environ = os.environ if environ is None else environ
    shared = home / '.agents' / 'skills'
    found = []
    for row in accounts():
        account = config_folder(row['id'], home)
        if not account.is_dir():
            continue
        if row['harness'] == 'claude':
            found.append(dict(id=row['id'], label='Claude Code' + (' · ' + row['name'] if row['name'] else ''),
                              roots=[account / 'skills'], link_root=account / 'skills'))
        elif row['harness'] in ('opencode', 'cortex'):
            # An OpenCode account moves only its data folder and a Cortex Code account only its connection;
            # their skills stay where the CLI's own login reads them.
            continue
        else:
            found.append(dict(id=row['id'], label=row['label'], roots=[shared, account / 'skills'], link_root=shared))
    grok = home / '.grok'
    if grok.is_dir():
        roots = [grok / 'skills', shared]
        if _grok_reads_claude_skills(grok, environ):
            roots.append(home / '.claude' / 'skills')
        found.append(dict(id='grok', label='Grok', roots=roots, link_root=shared))
    opencode = Path(environ.get('XDG_CONFIG_HOME') or home / '.config') / 'opencode'
    if opencode.is_dir():
        found.append(dict(id='opencode', label='OpenCode', roots=[opencode / 'skills', shared, home / '.claude' / 'skills'], link_root=shared))
    pi = home / '.pi' / 'agent'
    if pi.is_dir():
        found.append(dict(id='pi', label='Pi', roots=[pi / 'skills', shared], link_root=shared))
    cortex = home / '.snowflake' / 'cortex'
    if cortex.is_dir():
        found.append(dict(id='cortex', label='Cortex Code', roots=[cortex / 'skills', home / '.claude' / 'skills'], link_root=cortex / 'skills'))
    return found


def _grok_reads_claude_skills(grok, environ):
    flag = environ.get('GROK_CLAUDE_SKILLS_ENABLED')
    if flag is not None:
        return flag.strip().lower() not in ('0', 'false', 'no', 'off')
    try:
        config = tomllib.loads((grok / 'config.toml').read_text())
    except (OSError, tomllib.TOMLDecodeError):
        return True
    return config.get('compat', {}).get('claude', {}).get('skills', True) is not False


def _skill_folders(root):
    if not root.is_dir():
        return []
    return [folder for folder in sorted(root.iterdir()) if not folder.name.startswith('.') and (folder / 'SKILL.md').is_file()]


def _frontmatter(content):
    if not content.startswith('---\n'):
        return '', content
    parts = content.split('---', 2)
    return (parts[1], parts[2]) if len(parts) == 3 else ('', content)


def portability_notes(content, installed_names):
    """Things in a skill that would stop it working the same way in another harness."""
    notes = []
    _, body = _frontmatter(content)
    lines = body.splitlines()
    for index, line in enumerate(lines):
        # "In Claude Code that is `Monitor(...)`" often wraps, so the line before counts as context too.
        example = bool(HARNESS_EXAMPLE.search(line) or (index and HARNESS_EXAMPLE.search(lines[index - 1])))
        if '~/.claude/skills/' in line:
            notes.append('Uses a ~/.claude/skills path; other harnesses load the skill elsewhere. Refer to the skill directory instead.')
        tool = CLAUDE_ONLY_TOOLS.search(line)
        if tool and not example:
            notes.append('Calls a Claude Code tool (' + tool.group(1).rstrip('(') + ') without saying what to do in other harnesses.')
        mcp = MCP_TOOL.search(line)
        if mcp and not example:
            notes.append('Names a harness-specific MCP tool (' + mcp.group(0) + '); tool names differ per harness.')
        if SKILL_CONTEXT.search(line) and not NOT_A_SKILL.search(line):
            for quoted, bare in SKILL_REFERENCE.findall(line):
                name = quoted or bare
                if name not in installed_names:
                    notes.append(f'Depends on a /{name} skill that is not installed for any harness.')
    return list(dict.fromkeys(notes))


def list_skills(home=None, environ=None):
    home = _home(home)
    available = harnesses(home, environ)
    by_name, order = {}, []
    for harness in available:
        for root in harness['roots']:
            for folder in _skill_folders(root):
                entry = by_name.get(folder.name)
                canonical = str(folder.resolve())
                if entry is None:
                    entry = by_name[folder.name] = dict(folder=folder, canonical=canonical, harnesses=set(), shadowed=set())
                    order.append(folder.name)
                elif entry['canonical'] != canonical:
                    entry['shadowed'].add(canonical)
                entry['harnesses'].add(harness['id'])
    commands = {path.stem for account in home.glob('.claude*') for path in (account / 'commands').glob('*.md')}
    installed = set(order) | commands
    skills = []
    for name in order:
        entry = by_name[name]
        document = entry['folder'] / 'SKILL.md'
        try:
            if document.stat().st_size > 256000:
                continue
            content = document.read_text()
        except (OSError, UnicodeError):
            continue
        metadata, _ = _frontmatter(content)
        title, description = name, ''
        match = re.search(r'^name:\s*(.+)$', metadata, re.M)
        if match:
            title = match.group(1).strip().strip('"\'')
        match = re.search(r'^description:\s*(.*(?:\n[ \t]+.*)*)', metadata, re.M)
        if match:
            description = ' '.join(match.group(1).strip().lstrip('>|-').strip().split()).strip('"\'')
        openai = entry['folder'] / 'agents' / 'openai.yaml'
        explicit = bool(EXPLICIT_FRONTMATTER.search(metadata))
        try:
            explicit = explicit or bool(EXPLICIT_OPENAI.search(openai.read_text()))
        except OSError:
            pass
        availability = {harness['id']: harness['id'] in entry['harnesses'] for harness in available}
        skills.append(dict(id=name, name=title, description=description, path=str(Path(entry['canonical']) / 'SKILL.md'),
                           content=content, availability=availability, explicit_only=explicit,
                           sources=[harness['label'] for harness in available if availability[harness['id']]],
                           portability=portability_notes(content, installed),
                           conflicts=sorted(entry['shadowed'])))
    return dict(harnesses=[dict(id=h['id'], label=h['label']) for h in available], skills=skills)


def share(source, destination, apply=False):
    """Link each skill folder in source into destination without copying content or replacing anything."""
    results = []
    if not source.is_dir():
        return results
    for folder in _skill_folders(source):
        target = destination / folder.name
        canonical = folder.resolve()
        if target.exists() or target.is_symlink():
            status = 'already shared' if target.resolve() == canonical else 'conflict; left unchanged'
        elif apply:
            destination.mkdir(parents=True, exist_ok=True)
            target.symlink_to(canonical, target_is_directory=True)
            status = 'linked'
        else:
            status = 'would link'
        results.append((str(target), str(canonical), status))
    return results


def make_available_everywhere(home=None, environ=None, apply=True):
    """Link every skill any harness can see into the skill root of every harness that cannot see it yet."""
    home = _home(home)
    available = harnesses(home, environ)
    roots = list(dict.fromkeys(root for harness in available for root in harness['roots']))
    link_roots = list(dict.fromkeys(harness['link_root'] for harness in available))
    changes = []
    for destination in link_roots:
        for source in roots:
            if source == destination:
                continue
            for target, canonical, status in share(source, destination, apply):
                if status != 'already shared':
                    changes.append(dict(path=target, source=canonical, status=status))
    # One folder reached through two roots reports once.
    changes = list({(c['path'], c['status']): c for c in changes}.values())
    return dict(linked=[c for c in changes if c['status'] in ('linked', 'would link')],
                conflicts=[c for c in changes if c['status'].startswith('conflict')], **list_skills(home, environ))


def find_local_skills(root=None, home=None):
    """Find skill folders below a chosen local directory without following links."""
    home = _home(home)
    root = Path(root).expanduser().resolve() if root else home.resolve()
    if not root.is_dir():
        raise ValueError('Choose an existing local folder to search')
    found, visited = [], 0
    ignored = {'.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', 'data'}
    for current, dirs, files in os.walk(root, followlinks=False):
        visited += 1
        depth = len(Path(current).relative_to(root).parts)
        if 'SKILL.md' in files and Path(current).name not in ('', '.', '..'):
            folder = Path(current)
            found.append(dict(name=folder.name, path=str(folder.resolve()),
                              installed=(home / '.agents' / 'skills' / folder.name).resolve() == folder.resolve()))
        if visited >= 5000 or depth >= 7:
            dirs.clear()
        else:
            dirs[:] = [name for name in dirs if name not in ignored and not (Path(current) / name).is_symlink()]
        if len(found) >= 200:
            break
    return dict(root=str(root), skills=found, truncated=visited >= 5000 or len(found) >= 200)


def add_local_skill(path, home=None, environ=None):
    """Add a chosen skill folder to the shared library, then share it with harnesses."""
    home = _home(home)
    if not isinstance(path, str) or not path or len(path) > 4000:
        raise ValueError('Choose a local skill folder')
    source = Path(path).expanduser().resolve()
    if source.name == 'SKILL.md':
        source = source.parent
    document = source / 'SKILL.md'
    if not source.is_dir() or not document.is_file() or document.stat().st_size > 256000:
        raise ValueError('Choose a folder containing a SKILL.md smaller than 256 KB')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}', source.name):
        raise ValueError('Skill folder name must use letters, numbers, dots, underscores, or hyphens')
    destination = home / '.agents' / 'skills' / source.name
    if destination.exists() or destination.is_symlink():
        if destination.resolve() != source:
            raise ValueError('A different skill with this folder name is already in the shared library')
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.symlink_to(source, target_is_directory=True)
    return make_available_everywhere(home, environ)


def skill_document(payload):
    """Build deterministic, portable instructions; never execute draft contents."""
    import json
    fields={key:payload.get(key,'') for key in ('name','purpose','trigger','steps','examples')}
    if any(not isinstance(v,str) or len(v)>16000 for v in fields.values()):
        raise ValueError('Skill fields must be text of at most 16,000 characters')
    fields={k:v.strip() for k,v in fields.items()}
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*',fields['name']) or len(fields['name'])>63:
        raise ValueError('Use a short lowercase name with letters, numbers and hyphens')
    if not all(fields[k] for k in ('purpose','trigger','steps')):
        raise ValueError('Add a purpose, when to use this skill, and instructions')
    purpose=fields['purpose'] if fields['purpose'].endswith(('.','!','?')) else fields['purpose']+'.'
    description=purpose+' Use when '+fields['trigger'].rstrip('.')+'.'
    if len(description)>1024:raise ValueError('Keep purpose and triggers under 1,024 characters together')
    content='---\nname: '+fields['name']+'\ndescription: '+json.dumps(description,ensure_ascii=False)+'\n---\n\n# '+fields['name']+'\n\n'+fields['steps']+'\n'
    if fields['examples']:content+='\n## Examples\n\n'+fields['examples']+'\n'
    return dict(name=fields['name'],content=content)


def create_skill(payload,home=None,environ=None):
    draft=skill_document(payload)
    root=_home(home)/'.agents'/'skills';root.mkdir(parents=True,exist_ok=True)
    destination=root/draft['name']
    try:destination.mkdir(mode=0o700)
    except FileExistsError:raise ValueError('A skill with this name already exists. Choose another name') from None
    try:
        with (destination/'SKILL.md').open('x') as out:out.write(draft['content'])
    except Exception:
        destination.rmdir()
        raise
    return dict(created=str(destination/'SKILL.md'),**make_available_everywhere(home,environ))
