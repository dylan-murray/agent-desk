"""Plugins: folders that add to Agent Desk. A plugin has a page, a server, or both, declared in plugin.json.

A page (index.html beside plugin.json) opens as a tab in every terminal pane's dock. It runs sandboxed
in an opaque origin with no network access, so it cannot read the desk, its tokens or other panes. It
asks the desk page for what its permissions allow, and only for the pane it is shown in. Plugins that
ship with the desk are trusted. Any other page must be approved for the exact plugin.json it has, so one
that later asks for more is switched off until approved again.

A server is a Python program the desk starts on a file, a folder or nothing, and shows as a tool window.
It runs as you, like anything else you install, so it starts only when you or an agent open it. Skills
from before plugin.json declared their server in agent-desk-ui.json, or were known by folder name; both
still load as server plugins.
"""
import hashlib
import json
import re
import threading
from pathlib import Path

BUNDLED = Path(__file__).resolve().parent
MANIFEST = 'plugin.json'
LEGACY_MANIFEST = 'agent-desk-ui.json'
PAGE = 'index.html'
# Annotation skills that predate manifests, recognised by folder name.
LEGACY_NAMES = {
    'readme-review': ('Markdown review', 'Annotate a README or markdown document.', 'readme_annotate.py', 'file'),
    'document-builder': ('Document review', 'Review and annotate a draft document.', 'notion_draft.py', 'file'),
    'diagram-doc-creator': ('Diagram feedback', 'Review a diagram and mark precise changes.', 'diagram_doc.py', 'file'),
    'architecture-review': ('Architecture review', 'Revise a system architecture on a canvas.', 'architecture_review.py', 'file'),
    'pull-request-description-review': ('PR description review', 'Annotate a pull request description draft.', 'review_draft.py', 'file')}
PERMISSIONS = {
    'files.read': "Read files in the pane's folder and see which ones changed",
    'editor.open': "Open files in the pane's editor and see which file it shows",
}
ASSET_TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2'}
# A plugin picks its rail icon by name, so its look in the desk is never its own markup.
ICONS = ('puzzle', 'folder', 'code', 'review', 'chart', 'list', 'bug', 'book', 'terminal', 'globe', 'check', 'search')
NAME = re.compile(r'^[a-z0-9][a-z0-9-]{0,39}$')
FIELDS = {'name', 'description', 'icon', 'order', 'permissions', 'buttons', 'server'}
SERVER_FIELDS = {'run', 'target', 'args', 'transports'}
TARGETS = ('file', 'directory', 'none')
MAX_BUTTONS = 3


def text(value, field, low, high):
    if not isinstance(value, str) or not low <= len(value.strip()) <= high or any(ord(c) < 32 for c in value):
        raise ValueError(f'{field} must be {low}-{high} characters of plain text')
    return value.strip()


def inside(folder, relative, suffix, field):
    """A file in the plugin's own folder, named relative to it."""
    if not isinstance(relative, str) or not relative.endswith(suffix) or relative.startswith('/') or '\\' in relative:
        raise ValueError(f'{field} must be a {suffix} file in the plugin folder')
    target = (folder / relative).resolve()
    if not target.is_relative_to(folder.resolve()) or not target.is_file():
        raise ValueError(f'{field} must be a {suffix} file in the plugin folder')
    return target


def server(folder, run, target='file', args=None, transports=()):
    if target not in TARGETS:
        raise ValueError('server.target is file, directory or none')
    if args is None:
        args = (['{target}'] if target != 'none' else []) + ['--port', '{port}', '--no-browser']
    if not isinstance(args, list) or len(args) > 40 or not all(isinstance(a, str) and len(a) <= 2000 for a in args):
        raise ValueError('server.args is a list of at most 40 strings')
    if not isinstance(transports, (list, tuple)) or not all(isinstance(t, str) for t in transports):
        raise ValueError('server.transports is a list of strings')
    return dict(script=str(inside(folder, run, '.py', 'server.run')), target=target, args=args, transports=list(transports))


def buttons_of(buttons):
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
    return shown


def parse(folder):
    """The plugin in this folder, None when it declares none, or ValueError saying what is wrong."""
    folder = Path(folder)
    if not (folder / MANIFEST).is_file():
        return legacy(folder)
    raw = (folder / MANIFEST).read_bytes()
    if len(raw) > 20000:
        raise ValueError('plugin.json is too large')
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError('plugin.json holds an object')
    # sdk is where the plugin library is served from.
    if not NAME.match(folder.name) or folder.name == 'sdk':
        raise ValueError('Plugin folders are named with lowercase letters, digits and dashes, and not sdk')
    unknown = set(data) - FIELDS
    if unknown:
        raise ValueError('Unknown plugin.json fields: ' + ', '.join(sorted(unknown)))
    name = text(data.get('name'), 'name', 1, 40)
    if data.get('icon', 'puzzle') not in ICONS:
        raise ValueError('icon is one of ' + ', '.join(ICONS))
    order = data.get('order', 50)
    if type(order) is not int or not 0 <= order <= 1000:
        raise ValueError('order is a whole number from 0 to 1000')
    plugin = dict(id=folder.name, title=name, description=text(data.get('description', ''), 'description', 0, 200), icon=data.get('icon', 'puzzle'),
                  order=order, digest=hashlib.sha256(raw).hexdigest(), folder=str(folder.resolve()), server=None)
    if (folder / PAGE).is_file():
        permissions = data.get('permissions', [])
        if not isinstance(permissions, list) or len(set(permissions)) != len(permissions) or not set(permissions) <= set(PERMISSIONS):
            raise ValueError('permissions may only list ' + ', '.join(PERMISSIONS))
        plugin.update(tab=name, entrypoint=PAGE, permissions=permissions, buttons=buttons_of(data.get('buttons', [])))
    elif 'permissions' in data or 'buttons' in data:
        raise ValueError('permissions and buttons are for a plugin with a page (index.html)')
    if 'server' in data:
        spec = data['server']
        if not isinstance(spec, dict) or 'run' not in spec or set(spec) - SERVER_FIELDS:
            raise ValueError('server names the Python file it runs and, optionally, its target, args and transports')
        plugin['server'] = server(folder, **spec)
    if 'entrypoint' not in plugin and not plugin['server']:
        raise ValueError('A plugin has a page (index.html), a server, or both')
    return plugin


def legacy(folder):
    """A server declared the older way: agent-desk-ui.json with runtime python-http, or a known folder name."""
    manifest = folder / LEGACY_MANIFEST
    if manifest.is_file():
        data = json.loads(manifest.read_text())
        if not isinstance(data, dict) or data.get('runtime') != 'python-http':
            return None
        title, description = data.get('title', folder.name), data.get('description', '')
        if not isinstance(title, str) or not isinstance(description, str):
            raise ValueError('title and description are text')
        spec = server(folder, data.get('entrypoint'), data.get('target', 'file'), data.get('args'), data.get('transports', []))
    elif folder.name in LEGACY_NAMES:
        title, description, entry, target = LEGACY_NAMES[folder.name]
        if not (folder / entry).is_file():
            return None
        # These opened in the desktop app before servers declared their transports, so they still do.
        spec = server(folder, entry, target, transports=['unix-http-v1'])
    else:
        return None
    return dict(id=folder.name, title=title, description=description, icon='puzzle', order=50, folder=str(folder.resolve()), server=spec)


def discover(roots):
    """Every plugin in these folders, the first of each name winning; a broken one is kept with its problem."""
    found = {}
    for root in roots:
        root = Path(root)
        if not root.is_dir():
            continue
        for folder in sorted(root.iterdir()):
            if folder.name in found or not folder.is_dir():
                continue
            try:
                plugin = parse(folder)
            except (OSError, ValueError, TypeError) as exc:
                found[folder.name] = dict(id=folder.name, problem=str(exc), status='invalid', root=str(root.resolve()))
                continue
            if plugin:
                found[folder.name] = dict(plugin, root=str(root.resolve()))
    return found


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
        """Every plugin with a dock page, and every broken one, with whether its page may run."""
        found, approved = [], self.approved()
        for plugin in discover(self.roots).values():
            if plugin.get('status') == 'invalid':
                found.append(plugin)
            elif 'entrypoint' in plugin:
                status = 'bundled' if Path(plugin['root']) == self.bundled else 'approved' if approved.get(plugin['id']) == plugin['digest'] else 'needs approval'
                found.append(dict(plugin, status=status))
        return found

    def public(self):
        return [{k: v for k, v in plugin.items() if k not in ('folder', 'root', 'server')} | ({'permission_text': [PERMISSIONS[p] for p in plugin['permissions']]} if 'permissions' in plugin else {})
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
