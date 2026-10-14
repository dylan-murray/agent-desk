"""Saved CLI logins. Claude and Codex each have a default account; more are added by config folder."""
import json
import os
from pathlib import Path
import re

from agent_desk.paths import DATA_DIR

ACCOUNTS_FILE = DATA_DIR / 'accounts.json'
# harness: (variable that selects its config folder, default folder, label)
HARNESSES = {'codex': ('CODEX_HOME', '.codex', 'Codex'), 'claude': ('CLAUDE_CONFIG_DIR', '.claude', 'Claude')}
LIMIT = 20
# CLIs with one login each: launched as they are, with no config folder to select.
SINGLE = {'grok': 'Grok', 'opencode': 'OpenCode', 'pi': 'Pi'}


def _saved():
    try:
        rows = json.loads(ACCOUNTS_FILE.read_text())
    except (OSError, ValueError):
        return []
    return [row for row in rows if isinstance(row, dict) and row.get('harness') in HARNESSES and isinstance(row.get('id'), str)
            and re.fullmatch(r'[a-z][a-z0-9-]{0,59}', row['id'])
            and isinstance(row.get('name'), str) and isinstance(row.get('config_dir'), str)][:LIMIT] if isinstance(rows, list) else []


def accounts():
    """Every account, each harness's default first. A default account has no config_dir: the CLI picks its own."""
    saved = _saved()
    names = {row['id']: row['name'] for row in saved if row['id'] in HARNESSES}
    return [found for harness in HARNESSES for found in
            [_row(harness, harness, names.get(harness, ''), ''), *(_row(row['id'], harness, row['name'], row['config_dir']) for row in saved if row['harness'] == harness and row['id'] not in HARNESSES)]]


def _row(identity, harness, name, config_dir):
    label = HARNESSES[harness][2] + (' · ' + name if name else '')
    return dict(id=identity, harness=harness, name=name, label=label, config_dir=config_dir, default=identity == harness)


def listing():
    """Accounts for the settings dialog, with whether each config folder is there yet."""
    return [dict(row, exists=config_folder(row['id']).is_dir()) for row in accounts()]


def account(identity):
    return next((row for row in accounts() if row['id'] == identity), None)


def account_ids():
    return [row['id'] for row in accounts()]


def harness_of(profile):
    """The CLI a profile runs: an account's harness, or a CLI that has a single login."""
    if isinstance(profile, str) and profile in SINGLE:
        return profile
    if not isinstance(profile, str):
        return None
    found = account(profile)
    # A removed account's saved sessions still belong to its CLI.
    return found['harness'] if found else next((h for h in HARNESSES if profile.startswith(h + '-')), None)


def label(profile):
    found = account(profile)
    return found['label'] if found else SINGLE.get(profile, str(profile))


def config_folder(profile, home=None):
    """Where this account's CLI keeps its login, sessions and skills."""
    found = account(profile)
    if not found:
        raise ValueError('Unknown launch account profile')
    home = Path(home) if home is not None else Path.home()
    if not found['config_dir']:
        return home / HARNESSES[found['harness']][1]
    folder = found['config_dir']
    return home / folder[2:] if folder.startswith('~/') else Path(folder)


def sibling(profile, harness):
    """The account of another harness that goes with this one: the same name, else that harness's default."""
    found = account(profile)
    if found and found['harness'] == harness:
        return profile
    name = found['name'] if found else ''
    return next((row['id'] for row in accounts() if row['harness'] == harness and name and row['name'] == name), harness)


def save_account(payload):
    harness, name, folder = payload.get('harness'), payload.get('name'), payload.get('config_dir', '')
    identity = payload.get('id') or ''
    if harness not in HARNESSES:
        raise ValueError('Choose Claude or Codex')
    if not isinstance(name, str) or len(name.strip()) > 40 or re.search(r'[\x00-\x1f\x7f]', name):
        raise ValueError('Name this account with up to 40 characters')
    name = name.strip()
    if not isinstance(identity, str) or not isinstance(folder, str):
        raise ValueError('Invalid account')
    saved = _saved()
    if identity == harness:
        # The default account can be named, but keeps the folder its CLI chooses.
        folder = ''
    else:
        if not name:
            raise ValueError('Name this account')
        folder = folder.strip()
        if not (folder.startswith('~/') or folder.startswith('/')) or re.search(r'[\x00-\x1f\x7f]', folder) or len(folder) > 500 or '..' in Path(folder).parts:
            raise ValueError('Enter the account’s config folder as an absolute path or one starting with ~/')
        folder = folder.rstrip('/') or '/'
        if not identity:
            slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
            if not slug:
                raise ValueError('Use letters or numbers in the account name')
            identity = harness + '-' + slug
        if not re.fullmatch(r'[a-z][a-z0-9-]{0,59}', identity) or identity in HARNESSES or identity in SINGLE:
            raise ValueError('Invalid account')
        existing = next((row for row in saved if row['id'] == identity), None)
        if existing and (not payload.get('id') or existing['harness'] != harness):
            raise ValueError('An account with this name already exists')
    entry = dict(id=identity, harness=harness, name=name, config_dir=folder)
    rows = [row for row in saved if row['id'] != identity] + [entry]
    if len(rows) > LIMIT:
        raise ValueError('Remove an account before adding another')
    _write(rows)
    return {'accounts': listing(), 'saved': next(row for row in listing() if row['id'] == identity)}


def delete_account(payload):
    identity = payload.get('id')
    if not isinstance(identity, str) or identity in HARNESSES or not any(row['id'] == identity for row in _saved()):
        raise ValueError('Choose an added account to remove')
    _write([row for row in _saved() if row['id'] != identity])
    return {'accounts': listing()}


def _write(rows):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp = ACCOUNTS_FILE.with_suffix('.tmp')
    temp.write_text(json.dumps(rows, indent=2) + '\n')
    os.replace(temp, ACCOUNTS_FILE)
