"""Dock plugins: pages that open as a tab in every terminal pane's dock.

A plugin is a folder with an agent-desk-ui.json whose runtime is "static" and that names a dock tab.
Its page runs sandboxed in an opaque origin with no network access, so it cannot read the desk, its
tokens or other panes. It asks the desk page for what its manifest's permissions allow, and only for
the pane it is shown in. Plugins that ship with the desk are trusted. Any other plugin must be approved
for the exact manifest it has, so one that later asks for more is switched off until approved again.
"""
import hashlib
import json
import re
import threading
from pathlib import Path

MANIFEST = 'agent-desk-ui.json'
PERMISSIONS = {
    'files.read': "Read files in the pane's folder and see which ones changed",
    'editor.open': "Open files in the pane's editor and see which file it shows",
}
ASSET_TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2'}
# A plugin picks its rail icon by name, so its look in the desk is never its own markup.
ICONS = ('puzzle', 'folder', 'code', 'review', 'chart', 'list', 'bug', 'book', 'terminal', 'globe', 'check', 'search')
NAME = re.compile(r'^[a-z0-9][a-z0-9-]{0,39}$')
FIELDS = {'runtime', 'title', 'description', 'entrypoint', 'dock', 'permissions', 'buttons'}
MAX_BUTTONS = 3


def text(value, field, low, high):
    if not isinstance(value, str) or not low <= len(value.strip()) <= high or any(ord(c) < 32 for c in value):
        raise ValueError(f'{field} must be {low}-{high} characters of plain text')
    return value.strip()


def parse(folder):
    """The plugin in this folder, or ValueError saying what is wrong with its manifest."""
    folder = Path(folder)
    raw = (folder / MANIFEST).read_bytes()
    if len(raw) > 20000:
        raise ValueError('The manifest is too large')
    data = json.loads(raw)
    if not isinstance(data, dict) or data.get('runtime') != 'static':
        raise ValueError('Not a dock plugin')
    # sdk is where the plugin library is served from.
    if not NAME.match(folder.name) or folder.name == 'sdk':
        raise ValueError('Plugin folders are named with lowercase letters, digits and dashes, and not sdk')
    unknown = set(data) - FIELDS
    if unknown:
        raise ValueError('Unknown manifest fields: ' + ', '.join(sorted(unknown)))
    entry = data.get('entrypoint')
    if not isinstance(entry, str) or not entry.endswith('.html') or entry.startswith('/') or '\\' in entry:
        raise ValueError('entrypoint must be an .html file in the plugin folder')
    page = (folder / entry).resolve()
    if not page.is_relative_to(folder.resolve()) or not page.is_file():
        raise ValueError('entrypoint must be an .html file in the plugin folder')
    dock = data.get('dock')
    if not isinstance(dock, dict) or set(dock) - {'tab', 'order', 'icon'}:
        raise ValueError('dock names the tab and, optionally, its order and icon')
    if dock.get('icon', 'puzzle') not in ICONS:
        raise ValueError('dock.icon is one of ' + ', '.join(ICONS))
    order = dock.get('order', 50)
    if type(order) is not int or not 0 <= order <= 1000:
        raise ValueError('dock.order is a whole number from 0 to 1000')
    permissions = data.get('permissions', [])
    if not isinstance(permissions, list) or len(set(permissions)) != len(permissions) or not set(permissions) <= set(PERMISSIONS):
        raise ValueError('permissions may only list ' + ', '.join(PERMISSIONS))
    buttons = data.get('buttons', [])
    if not isinstance(buttons, list) or len(buttons) > MAX_BUTTONS:
        raise ValueError(f'A plugin adds at most {MAX_BUTTONS} buttons')
    shown = []
    for button in buttons:
        if not isinstance(button, dict) or set(button) - {'id', 'label', 'title', 'toggle'}:
            raise ValueError('A button has an id, a label and, optionally, a title and toggle')
        if not isinstance(button.get('id'), str) or not NAME.match(button['id']) or len(button['id']) > 32:
            raise ValueError('Button ids are lowercase letters, digits and dashes')
        if not isinstance(button.get('toggle', False), bool):
            raise ValueError('toggle is true or false')
        shown.append(dict(id=button['id'], label=text(button.get('label'), 'A button label', 1, 24),
                          title=text(button.get('title', button.get('label')), 'A button title', 1, 120), toggle=button.get('toggle', False)))
    if len({b['id'] for b in shown}) != len(shown):
        raise ValueError('Button ids must be different')
    return dict(id=folder.name, title=text(data.get('title'), 'title', 1, 40), description=text(data.get('description', ''), 'description', 0, 200),
                tab=text(dock.get('tab'), 'dock.tab', 1, 24), order=order, icon=dock.get('icon', 'puzzle'), entrypoint=Path(entry).as_posix(), permissions=permissions,
                buttons=shown, digest=hashlib.sha256(raw).hexdigest(), folder=str(folder.resolve()))


class Plugins:
    def __init__(self, roots, bundled, grants):
        self.roots, self.bundled, self.grants = roots, Path(bundled).resolve(), Path(grants)
        self.lock = threading.Lock()

    def approved(self):
        try:
            data = json.loads(self.grants.read_text())
            return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)} if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def catalog(self):
        """Every dock plugin found, the first of each name winning, with whether it may run."""
        found, approved = {}, self.approved()
        for root in self.roots:
            root = Path(root)
            if not root.is_dir():
                continue
            for folder in sorted(root.iterdir()):
                if folder.name in found or not (folder / MANIFEST).is_file():
                    continue
                try:
                    plugin = parse(folder)
                except (OSError, ValueError, TypeError) as exc:
                    if str(exc) != 'Not a dock plugin':
                        found[folder.name] = dict(id=folder.name, problem=str(exc), status='invalid')
                    continue
                plugin['status'] = 'bundled' if root.resolve() == self.bundled else 'approved' if approved.get(plugin['id']) == plugin['digest'] else 'needs approval'
                found[folder.name] = plugin
        return list(found.values())

    def public(self):
        return [{k: v for k, v in plugin.items() if k != 'folder'} | ({'permission_text': [PERMISSIONS[p] for p in plugin['permissions']]} if 'permissions' in plugin else {})
                for plugin in self.catalog()]

    def trusted(self, name):
        return next((p for p in self.catalog() if p['id'] == name and p.get('status') in ('bundled', 'approved')), None)

    def approve(self, name, digest):
        """Approve the manifest the person saw: a manifest changed since then is not approved."""
        plugin = next((p for p in self.catalog() if p['id'] == name), None)
        if not plugin or plugin.get('status') == 'invalid':
            raise ValueError('No such plugin')
        if plugin['status'] == 'bundled':
            return plugin
        if digest != plugin['digest']:
            raise ValueError('The plugin changed since you looked at it; review it again')
        with self.lock:
            grants = self.approved() | {name: digest}
            self.write(grants)
        return dict(plugin, status='approved')

    def revoke(self, name):
        with self.lock:
            grants = self.approved()
            grants.pop(name, None)
            self.write(grants)

    def write(self, grants):
        self.grants.parent.mkdir(parents=True, exist_ok=True)
        temp = self.grants.with_suffix('.tmp')
        temp.write_text(json.dumps(grants, indent=2, sort_keys=True) + '\n')
        temp.replace(self.grants)

    def asset(self, name, relative):
        """A trusted plugin's file and its type, or None. Only page assets are served, never code that runs here."""
        plugin = self.trusted(name)
        if not plugin or not relative or '\\' in relative or '\x00' in relative:
            return None
        root = Path(plugin['folder'])
        target = (root / relative).resolve()
        kind = ASSET_TYPES.get(target.suffix.lower())
        if not kind or not target.is_relative_to(root) or not target.is_file() or target.stat().st_size > 2_000_000:
            return None
        return target, kind
