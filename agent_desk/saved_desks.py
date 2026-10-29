"""Saving a desk and reopening it later as it was.

Saving keeps, for each terminal on the desk, the record the terminal supervisor already writes
for restarts (terminal_restore.record): its folder, command, account and the native Claude or
Codex conversation it is in. Reopening launches each through terminal_restore.plan, exactly as
a restart would, so an agent resumes that conversation, a shell starts again in its folder and
another command is not re-run. Coordinators are closed and reopened by their own runtime, and
the page's pane layout and web pages are kept so the desk looks the same when it comes back.
"""
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

LAYOUTS = ('grid', 'rows', 'columns', 'grid-3', 'main')
PANE_ID = re.compile(r'^[A-Za-z0-9_.:-]{1,200}$')


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
