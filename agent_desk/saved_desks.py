"""Saving a desk and reopening it later as it was.

Saving keeps, for each terminal on the desk, the record the terminal supervisor already writes
for restarts (terminal_restore.record): its folder, command, account and the native Claude or
Codex conversation it is in. Reopening launches each through terminal_restore.plan, exactly as
a restart would, so an agent resumes that conversation, a shell starts again in its folder and
another command is not re-run. Coordinators are closed and reopened by their own runtime, and
the page's pane layout and web pages are kept so the desk looks the same when it comes back.

A desk saved in the other Agent Desk app (the browser desk or the desktop app) can be imported.
Only names come over: each terminal's folder, account name, pane name and native conversation,
and the pane layout. Commands never do; reopening builds each one from this app's own accounts.
"""
import json
import os
import re
import stat
from pathlib import Path
from urllib.parse import urlsplit

from agent_desk.desks import desk_name
from agent_desk.paths import PROJECT_DIR

LAYOUTS = ('grid', 'rows', 'columns', 'grid-3', 'main')
PANE_ID = re.compile(r'^[A-Za-z0-9_.:-]{1,200}$')
CONVERSATION = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
PROFILE = re.compile(r'^[a-z][a-z0-9-]{0,59}$')
PEER_LIMIT = 1 << 20
# Where each app keeps its desks: the packaged desktop app's profile, and the browser desk run
# from this checkout (or, installed, its user data folder), as paths.DATA_DIR defaults.
DESKTOP_DATA = Path.home() / 'Library' / 'Application Support' / 'Agent Desk' / 'data'
INSTALLED_DATA = Path.home() / '.local' / 'share' / 'agent-desk'
BROWSER_DATA = PROJECT_DIR / 'data' if (PROJECT_DIR / 'pyproject.toml').is_file() else INSTALLED_DATA
# The packaged desktop app cannot know which checkout the browser desk runs from, so the browser
# desk on its usual port leaves its data folder's path here, in the installed app's own folder.
BROWSER_POINTER = INSTALLED_DATA / 'browser-desk.json'


def session_records(path):
    """The supervisor's restart records, read without ever moving or rewriting its file."""
    try:
        value = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return {}
    sessions = value.get('sessions') if isinstance(value, dict) and value.get('version') == 1 else None
    return {item['id']: item for item in sessions or [] if isinstance(item, dict) and isinstance(item.get('id'), str)}


def _rect(value):
    if not isinstance(value, dict) or set(value) != {'x', 'y', 'w', 'h'} or any(type(value[k]) is not int for k in value):
        raise ValueError('Invalid pane position')
    if not (0 <= value['x'] and 0 <= value['y'] <= 400 and 1 <= value['w'] and value['x'] + value['w'] <= 12 and 1 <= value['h'] <= 24):
        raise ValueError('Invalid pane position')
    return {k: value[k] for k in ('x', 'y', 'w', 'h')}


def layout(value):
    """The page's panes for the desk: their order, layout and sizes, and its web pages."""
    if not isinstance(value, dict) or value.get('layout') not in LAYOUTS:
        raise ValueError('Send the desk\'s pane layout')
    panes, pages = value.get('panes', []), value.get('pages', [])
    if not isinstance(panes, list) or len(panes) > 16 or not isinstance(pages, list) or len(pages) > 16:
        raise ValueError('A desk holds at most 16 panes')
    clean = []
    for pane in panes:
        if not isinstance(pane, dict) or not isinstance(pane.get('id'), str) or not PANE_ID.match(pane['id']):
            raise ValueError('Invalid pane')
        clean.append(dict(id=pane['id'], **({'rect': _rect(pane['rect'])} if pane.get('rect') is not None else {})))
    kept = []
    for page in pages:
        url = page.get('url') if isinstance(page, dict) else None
        if not isinstance(page.get('id') if isinstance(page, dict) else None, str) or not PANE_ID.match(page['id']):
            raise ValueError('Invalid web page')
        if not isinstance(url, str) or len(url) > 4000 or urlsplit(url).scheme not in ('http', 'https'):
            raise ValueError('Web pages must use an http or https address')
        name = page.get('name') or ''
        if not isinstance(name, str) or len(name) > 100:
            raise ValueError('Invalid web page name')
        kept.append(dict(id=page['id'], url=url, name=name))
    return dict(layout=value['layout'], panes=clean, pages=kept)


def outcome(item):
    """What reopening will do with a saved terminal, in the words the save dialog uses."""
    from agent_desk.terminal_restore import plan
    _, resumed, detail = plan(item)
    # plan() says what a restart did; this says what reopening will do.
    detail = re.sub(r'^(resum|start)ed ', lambda m: m.group(1) + ('es ' if m.group(1) == 'resum' else 's '), detail)
    return dict(id=item['id'], resumes=resumed, detail='On reopen: ' + detail)


def read_peer_file(path):
    """The other app's desk file as JSON, or None. Never through a symlink, never a file another
    user owns or an oversized one; bad JSON reads as nothing saved. The file is only ever read."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > PEER_LIMIT:
            return None
        data = b''
        while len(data) <= PEER_LIMIT and (chunk := os.read(fd, PEER_LIMIT + 1 - len(data))):
            data += chunk
    finally:
        os.close(fd)
    if len(data) > PEER_LIMIT:
        return None
    try:
        value = json.loads(data)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def remember_browser_desk(folder):
    """Leave the browser desk's data folder where the desktop app looks for it. Best effort: an
    unwritable home only means the desktop app falls back to the installed app's folder."""
    try:
        BROWSER_POINTER.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temp = BROWSER_POINTER.with_name(BROWSER_POINTER.name + '.tmp')
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as file:
            json.dump(dict(data=str(Path(folder).resolve())), file)
        os.replace(temp, BROWSER_POINTER)
    except OSError:
        pass


def browser_data():
    """Where the browser desk keeps its data, as the desktop app finds it: this checkout's when the
    app runs from one, else the folder the browser desk left in the pointer, if it is a real folder
    of this user's, else the installed app's."""
    if (PROJECT_DIR / 'pyproject.toml').is_file():
        return BROWSER_DATA
    folder = (read_peer_file(BROWSER_POINTER) or {}).get('data')
    if isinstance(folder, str) and len(folder) <= 4096 and '\0' not in folder and os.path.isabs(folder):
        try:
            info = os.lstat(folder)
        except OSError:
            info = None
        if info and stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid():
            return Path(folder)
    return INSTALLED_DATA


class Peer:
    """The other app's saved desks, read from its fixed data folder. The page names a desk to
    import by its source and ID, never by a path."""

    def __init__(self, folder, desktop):
        self.folder, self.desktop = Path(folder), desktop
        self.app = 'desktop app' if desktop else 'browser desk'

    @classmethod
    def of(cls, key):
        """A browser desk (served on a port) imports from the desktop app; the desktop app (a workspace key)
        from the browser desk. AGENT_DESK_PEER_DATA_DIR, set where the server starts, moves that folder."""
        desktop = isinstance(key, int)
        override = os.environ.get('AGENT_DESK_PEER_DATA_DIR')
        return cls(Path(override).expanduser() if override else DESKTOP_DATA if desktop else browser_data(), desktop)

    def files(self):
        """Each desk file there, by source: the browser desk's one, or one per desktop workspace."""
        try:
            info = os.lstat(self.folder)
        except OSError:
            return {}
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            return {}
        if not self.desktop:
            return {'browser': self.folder / 'desks.json'}
        try:
            names = sorted(os.listdir(self.folder))
        except OSError:
            return {}
        return {m.group(1): self.folder / name for name in names if (m := re.fullmatch(r'desks-([0-9a-f]{32})\.json', name))}

    def _saved(self, source, path):
        data = read_peer_file(path) or {}
        desks, saved = data.get('desks'), data.get('saved')
        if not isinstance(desks, list) or not isinstance(saved, dict):
            return
        for desk in desks:
            identity = desk.get('id') if isinstance(desk, dict) else None
            if not isinstance(identity, str) or not PANE_ID.match(identity) or not isinstance(saved.get(identity), dict):
                continue
            try:
                name = desk_name(desk.get('name'))
            except ValueError:
                continue
            yield dict(source=source, id=identity, name=name), saved[identity]

    def saved(self):
        """The desks saved there, as the desk menu lists them."""
        found = []
        for source, path in self.files().items():
            for desk, record in self._saved(source, path):
                at = record.get('at')
                found.append(dict(desk, key=f'{source}/{desk["id"]}', saved_at=at if type(at) in (int, float) else None,
                                  sessions=len(imported(record, self.app)['terminals'])))
        return found[:32]

    def record(self, source, identity):
        """A desk saved there, by the source and ID the menu listed: its name and saved record."""
        path = self.files().get(source) if isinstance(source, str) else None
        found = next((pair for pair in self._saved(source, path) if pair[0]['id'] == identity), None) if path else None
        if not found:
            raise ValueError(f'That desk is no longer saved in the {self.app}')
        return found[0]['name'], found[1]


def imported_terminal(item):
    """A terminal from the other app's saved desk as names only, or None if it cannot come over.
    Its command is never read: reopening starts the account's CLI as this app would launch it."""
    if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not PANE_ID.match(item['id']):
        return None
    cwd = item.get('cwd')
    if not isinstance(cwd, str) or len(cwd) > 4096 or '\0' in cwd or not os.path.isabs(cwd) or not Path(cwd).is_dir():
        return None
    name = item.get('display_name') or item.get('name')
    if not isinstance(name, str) or not 1 <= len(name) <= 100 or re.search(r'[\x00-\x1f\x7f]', name):
        name = 'Terminal'
    # An agent that had exited comes back as the shell it had become, as a restart would.
    profile = item.get('launch_profile')
    profile = profile if isinstance(profile, str) and PROFILE.match(profile) and item.get('agent_exited') is not True else None
    conversation = item.get('native_session')
    conversation = conversation if profile and isinstance(conversation, str) and CONVERSATION.match(conversation) else None
    return dict(id=item['id'], name=name, cwd=cwd, profile=profile, conversation=conversation)


def imported(record, app, origin=None):
    """A saved record from the other app, kept as a saved desk here, with the source and ID it was
    listed under there. Coordinators stay behind: they belong to the other app's coordinator runtime."""
    terminals, seen = [], set()
    for item in record.get('terminals') if isinstance(record.get('terminals'), list) else []:
        terminal = imported_terminal(item)
        if terminal and terminal['id'] not in seen and len(terminals) < 32:
            seen.add(terminal['id'])
            terminals.append(terminal)
    try:
        kept = layout(record.get('layout'))
    except ValueError:
        kept = dict(layout='grid', panes=[dict(id=t['id']) for t in terminals[:16]], pages=[])
    pages = {page['id'] for page in kept['pages']}
    kept['panes'] = [pane for pane in kept['panes'] if pane['id'] in seen or pane['id'] in pages]
    kept['pages'] = [page for page in kept['pages'] if page['id'] in {pane['id'] for pane in kept['panes']}]
    return dict(terminals=terminals, coordinators=[], layout=kept, imported=dict(app=app, **({'from': origin} if origin else {})))


def account_here(profile):
    """Whether this app can launch that account: one of its accounts, or a single-login CLI."""
    from agent_desk.accounts import account, SINGLE
    return isinstance(profile, str) and (account(profile) is not None or profile in SINGLE)


def relaunch(terminal, profile):
    """A restart record for an imported terminal, built from this app's accounts: the account's CLI
    launched as the launcher would start it, so plan() adds the conversation to resume, or a login shell."""
    from agent_desk.accounts import account
    from agent_desk.launch_profiles import login_shell
    from agent_desk.standalone_agent import SHELL_MARKER
    if profile is None:
        argv, launch_profile = [os.environ.get('SHELL', '/bin/zsh'), '-l'], None
    elif account(profile):
        argv, launch_profile = [login_shell(), '-lic', profile + ' "$@"', 'agent-desk', SHELL_MARKER], profile
    else:
        argv, launch_profile = [profile, SHELL_MARKER], None
    return dict(id=terminal['id'], name=terminal['name'], display_name=terminal['name'], cwd=terminal['cwd'], argv=argv,
                launch_profile=launch_profile, parent_id=None, created=0, origin=0,
                native_session=terminal['conversation'] if profile else None, agent_exited=False)


def reopen_preview(record):
    """What reopening an imported desk does with each terminal. An account this app does not have
    is not replaced: the row says so, and reopening waits for an account to be picked."""
    from agent_desk.accounts import harness_of
    rows = []
    for terminal in record.get('terminals', []):
        base = dict(id=terminal['id'], name=terminal['name'], cwd=terminal['cwd'], profile=terminal['profile'],
                    harness=harness_of(terminal['profile']) if terminal['profile'] else 'shell')
        if terminal['profile'] and not account_here(terminal['profile']):
            rows.append(base | dict(needs_account=True, resumes=False,
                                    detail=f'There is no “{terminal["profile"]}” account here. Pick an account to reopen it with.'))
        else:
            rows.append(base | outcome(relaunch(terminal, terminal['profile'])))
    return rows


def relaunch_all(record, choices):
    """The restart records an imported desk reopens with. choices names an account here for a
    terminal whose account is missing, or '' to leave it out; nothing falls back on its own."""
    choices = choices if isinstance(choices, dict) else {}
    items = []
    for index, terminal in enumerate(record.get('terminals', [])):
        profile = terminal['profile']
        if profile and not account_here(profile):
            choice = choices.get(terminal['id'])
            if choice == '':
                continue
            if not account_here(choice):
                raise ValueError(f'Pick an account for {terminal["name"]}: there is no “{profile}” account here')
            profile = choice
        items.append(dict(relaunch(terminal, profile), created=index))
    return items
