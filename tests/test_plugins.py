import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from agent_desk import pane_files, server
from agent_desk.plugins import Plugins, parse
from agent_desk.tool_runtime import BUNDLED
from account_fixtures import use_accounts


def setUpModule():
    use_accounts()


def plugin(root, name, **changes):
    folder = Path(root) / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'index.html').write_text('<!doctype html><p>fixture</p>')
    (folder / 'tool.py').write_text('print("never served")')
    manifest = {'runtime': 'static', 'title': 'Fixture', 'entrypoint': 'index.html', 'dock': {'tab': 'Fixture'}, 'permissions': [], 'buttons': []} | changes
    (folder / 'agent-desk-ui.json').write_text(json.dumps({k: v for k, v in manifest.items() if v is not None}))
    return folder


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temp.cleanup()

    def test_the_bundled_file_list_is_a_plugin_with_its_permissions_and_button(self):
        files = parse(BUNDLED / 'files')
        self.assertEqual((files['tab'], files['icon'], files['permissions']), ('Files', 'folder', ['files.read', 'editor.open']))
        self.assertEqual(parse(plugin(self.temp.name, 'plain'))['icon'], 'puzzle')

    def test_a_manifest_is_checked_strictly(self):
        refused = {
            'an unknown field': dict(network=True),
            'an unknown permission': dict(permissions=['terminal.input']),
            'a permission twice': dict(permissions=['files.read', 'files.read']),
            'an entry outside the folder': dict(entrypoint='../index.html'),
            'an entry that is not a page': dict(entrypoint='tool.py'),
            'no dock tab': dict(dock={}),
            'a dock field it does not know': dict(dock={'tab': 'X', 'position': 'left'}),
            'too many buttons': dict(buttons=[{'id': f'b{i}', 'label': 'B'} for i in range(4)]),
            'a button id with odd characters': dict(buttons=[{'id': 'Do It', 'label': 'B'}]),
            'a button label with control characters': dict(buttons=[{'id': 'b', 'label': 'B\x1b[2J'}]),
            'two buttons with one id': dict(buttons=[{'id': 'b', 'label': 'B'}, {'id': 'b', 'label': 'C'}]),
            'a long tab name': dict(dock={'tab': 'x' * 25}),
            'an icon the desk does not draw': dict(dock={'tab': 'X', 'icon': '<svg onload=alert(1)>'}),
        }
        for index, (case, changes) in enumerate(refused.items()):
            with self.subTest(case):
                with self.assertRaises(ValueError):
                    parse(plugin(self.temp.name, f'case-{index}', **changes))
        with self.assertRaises(ValueError):
            parse(plugin(self.temp.name, 'sdk'))
        with self.assertRaises(ValueError):
            parse(plugin(self.temp.name, 'Has_Caps'))


class ApprovalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.extra = Path(self.temp.name) / 'skills'
        self.plugins = Plugins([BUNDLED, self.extra], BUNDLED, Path(self.temp.name) / 'plugins.json')

    def tearDown(self):
        self.temp.cleanup()

    def status(self, name):
        return next(p for p in self.plugins.catalog() if p['id'] == name)['status']

    def test_a_plugin_from_outside_the_desk_runs_only_once_its_exact_manifest_is_approved(self):
        plugin(self.extra, 'probe')
        self.assertEqual(self.status('files'), 'bundled')
        self.assertEqual(self.status('probe'), 'needs approval')
        self.assertIsNone(self.plugins.asset('probe', 'index.html'))
        with self.assertRaises(ValueError):
            self.plugins.approve('probe', '0' * 64)
        digest = next(p for p in self.plugins.catalog() if p['id'] == 'probe')['digest']
        self.plugins.approve('probe', digest)
        self.assertEqual(self.status('probe'), 'approved')
        self.assertIsNotNone(self.plugins.asset('probe', 'index.html'))
        self.assertIsNone(self.plugins.asset('probe', 'tool.py'), 'only page assets are served')
        self.assertIsNone(self.plugins.asset('probe', '../probe/index.html/../../plugins.json'))
        plugin(self.extra, 'probe', permissions=['files.read'])
        self.assertEqual(self.status('probe'), 'needs approval', 'asking for more switches it off')
        self.assertIsNone(self.plugins.asset('probe', 'index.html'))
        self.plugins.approve('probe', next(p for p in self.plugins.catalog() if p['id'] == 'probe')['digest'])
        self.plugins.revoke('probe')
        self.assertEqual(self.status('probe'), 'needs approval')

    def test_a_broken_plugin_is_reported_not_loaded(self):
        plugin(self.extra, 'broken', permissions=['everything'])
        broken = next(p for p in self.plugins.catalog() if p['id'] == 'broken')
        self.assertEqual(broken['status'], 'invalid')
        self.assertIn('permissions', broken['problem'])


class PluginRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.desk = f'http://127.0.0.1:{self.http.server_port}'
        extra = Path(self.temp.name) / 'skills'
        plugin(extra, 'probe')
        self.patches = [patch.object(server, 'PLUGINS', Plugins([BUNDLED, extra], BUNDLED, Path(self.temp.name) / 'plugins.json'))]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in self.patches:
            item.stop()
        self.http.shutdown()
        self.http.server_close()
        self.temp.cleanup()

    def get(self, path, headers=None):
        request = Request(self.desk + path, headers={'Host': f'127.0.0.1:{self.http.server_port}'} | (headers or {}))
        try:
            with urlopen(request, timeout=5) as response:
                return response.status, dict(response.headers), response.read()
        except HTTPError as error:
            return error.code, dict(error.headers), error.read()

    def entries(self):
        return {p['id']: p for p in json.loads(self.get('/api/plugins')[2])['plugins']}

    def test_a_plugin_page_is_sandboxed_with_no_network_and_only_on_the_secret_path(self):
        files = self.entries()['files']
        status, headers, _ = self.get(files['entry'])
        self.assertEqual(status, 200)
        policy = headers['Content-Security-Policy']
        for rule in ('sandbox allow-scripts', "connect-src 'none'", "form-action 'none'", "default-src 'none'"):
            self.assertIn(rule, policy)
        self.assertNotIn('allow-same-origin', policy)
        # Its own scripts load from an opaque origin, which the browser labels cross-site with no referrer.
        script = files['entry'].replace('index.html', 'files.js')
        self.assertEqual(self.get(script, {'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'script'})[0], 200)
        self.assertEqual(self.get(files['entry'].replace('files/index.html', 'sdk/agent-desk.js'))[0], 200)
        wrong = '/plugins/not-the-key/files/index.html'
        self.assertEqual(self.get(wrong, {'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'script'})[0], 403)
        self.assertEqual(self.get(wrong)[0], 404)
        self.assertEqual(self.get(files['entry'].replace('index.html', 'agent-desk-ui.json'))[0], 404)
        self.assertEqual(self.get(files['entry'].replace('index.html', '..%2f..%2fplugins.py'))[0], 404)
        self.assertEqual(self.get(self.entries()['probe']['entry'])[0], 404, 'an unapproved plugin is not served')

    def test_only_the_page_approves_a_plugin(self):
        digest = self.entries()['probe']['digest']
        def approve(token):
            request = Request(self.desk + '/api/plugins/approve', data=json.dumps({'id': 'probe', 'digest': digest}).encode(),
                              headers={'X-Agent-Desk-Terminal': token, 'Content-Type': 'application/json', 'Host': f'127.0.0.1:{self.http.server_port}'})
            try:
                with urlopen(request, timeout=5) as response:
                    return response.status
            except HTTPError as error:
                return error.code
        self.assertEqual(approve(server.HELPER_TOKEN), 403)
        self.assertEqual(self.entries()['probe']['status'], 'needs approval')
        self.assertEqual(approve(server.TERMINAL_TOKEN), 200)
        self.assertEqual(self.entries()['probe']['status'], 'approved')


class ChangesTests(unittest.TestCase):
    def test_changes_are_named_from_the_panes_folder(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            env = {'GIT_AUTHOR_NAME': 'Fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.com', 'GIT_COMMITTER_NAME': 'Fixture', 'GIT_COMMITTER_EMAIL': 'fixture@example.com', 'PATH': '/usr/bin:/bin:/opt/homebrew/bin'}
            git = lambda *args: subprocess.run(['git', *args], cwd=repo, env=env, check=True, capture_output=True)
            (repo / 'app' / 'src').mkdir(parents=True)
            for name in ('app/src/a.py', 'app/src/b.py', 'app/c.py', 'top.py'):
                (repo / name).write_text(f'{name}\n')
            git('init', '-q', '-b', 'main')
            git('add', '.')
            git('commit', '-q', '-m', 'Fixture')
            (repo / 'app/src/a.py').write_text('y\nz\n')
            (repo / 'app/new.py').write_text('n\n')
            (repo / 'app/c.py').unlink()
            (repo / 'top.py').write_text('changed outside the pane\n')
            git('mv', 'app/src/b.py', 'app/src/moved.py')
            found = pane_files.changes(repo / 'app')
        self.assertEqual(found['changes'], {'src/a.py': 'modified', 'new.py': 'untracked', 'c.py': 'deleted', 'src/moved.py': 'renamed'})
        # Lines added and removed since the last commit; a new file is all new lines, a pure rename none.
        self.assertEqual(found['lines'], {'src/a.py': [2, 1], 'new.py': [1, 0], 'c.py': [0, 1], 'src/moved.py': [0, 0]})

    def test_a_folder_outside_git_has_no_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            self.assertEqual(pane_files.changes(temp), {'changes': {}, 'git': False})


if __name__ == '__main__':
    unittest.main()
