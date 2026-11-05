"""Importing a desk saved in the other Agent Desk app: only names come over, never commands."""
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from agent_desk import accounts, saved_desks, server
from agent_desk.desks import Desks
from agent_desk.standalone_agent import SHELL_MARKER

WORKSPACE = 'ab' * 16
CLAUDE_ID = '11111111-1111-4111-8111-111111111111'
CODEX_ID = '22222222-2222-7222-8222-222222222222'


def terminal(identity, cwd, **fields):
    """A terminal as the other app's supervisor recorded it, commands and all."""
    return dict(id=identity, name='Claude', display_name=None, cwd=cwd, launch_profile='claude', parent_id=None, created=1, origin=0,
                native_session=None, agent_exited=False,
                argv=['/bin/zsh', '-lic', 'claude "$@"', 'agent-desk', '--dangerously-skip-permissions', '--mcp-config', '/elsewhere/mcp.json']) | fields


class Apps:
    """Two scratch data folders standing in for the browser desk and the desktop app, and a project folder."""

    def __init__(self, test):
        temp = tempfile.TemporaryDirectory()
        test.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve()
        self.browser, self.desktop, self.project = root / 'browser', root / 'desktop', root / 'project'
        for folder in (self.browser, self.desktop, self.project):
            folder.mkdir()
        self.peer_file = self.desktop / f'desks-{WORKSPACE}.json'

    def save_in_desktop(self, terminals, layout=None, name='Research'):
        record = dict(terminals=terminals, coordinators=['coordinator-1'], at=1700000000.0,
                      layout=layout or dict(layout='columns', panes=[dict(id=t['id']) for t in terminals[:16]], pages=[]))
        self.peer_file.write_text(json.dumps(dict(desks=[dict(id='main', name='Main'), dict(id='desk-1234abcd', name=name)],
                                                  placed={}, saved={'desk-1234abcd': record}), indent=2))


class PeerFileTests(unittest.TestCase):
    def setUp(self):
        self.apps = Apps(self)
        self.peer = saved_desks.Peer(self.apps.desktop, desktop=True)

    def test_saved_desks_are_listed_by_name_with_nothing_else(self):
        self.apps.save_in_desktop([terminal('terminal-a', str(self.apps.project))])
        self.assertEqual(self.peer.saved(), [dict(source=WORKSPACE, id='desk-1234abcd', name='Research', key=f'{WORKSPACE}/desk-1234abcd', saved_at=1700000000.0, sessions=1)])

    def test_a_symlinked_file_or_folder_is_refused(self):
        real = self.apps.desktop / 'real.json'
        self.apps.save_in_desktop([terminal('terminal-a', str(self.apps.project))])
        self.apps.peer_file.rename(real)
        self.apps.peer_file.symlink_to(real)
        self.assertEqual(self.peer.saved(), [])
        with self.assertRaises(ValueError):
            self.peer.record(WORKSPACE, 'desk-1234abcd')
        self.apps.peer_file.unlink()
        real.rename(self.apps.peer_file)
        linked = self.apps.desktop.parent / 'linked'
        linked.symlink_to(self.apps.desktop)
        self.assertEqual(saved_desks.Peer(linked, desktop=True).saved(), [])

    def test_a_file_another_user_owns_is_refused(self):
        self.apps.save_in_desktop([terminal('terminal-a', str(self.apps.project))])
        self.assertEqual(len(self.peer.saved()), 1)
        files = self.peer.files()
        with patch.object(saved_desks.os, 'getuid', return_value=os.getuid() + 1):
            self.assertEqual(saved_desks.read_peer_file(files[WORKSPACE]), None)
            self.assertEqual(self.peer.saved(), [])

    def test_an_oversized_or_unreadable_file_means_no_saved_desks(self):
        self.apps.peer_file.write_text('{"desks": [' + ' ' * saved_desks.PEER_LIMIT + ']}')
        self.assertEqual(self.peer.saved(), [])
        for bad in ('{not json', '[]', json.dumps(dict(desks='x', saved={})), json.dumps(dict(desks=[dict(id='a b', name='X')], saved={'a b': {}}))):
            self.apps.peer_file.write_text(bad)
            self.assertEqual(self.peer.saved(), [], bad)

    def test_only_desk_files_in_the_fixed_folder_are_read(self):
        (self.apps.desktop / 'desks.json').write_text('{}')
        (self.apps.desktop / f'desks-{WORKSPACE}.json.tmp').write_text('{}')
        self.apps.save_in_desktop([])
        self.assertEqual(list(self.peer.files()), [WORKSPACE])
        browser = saved_desks.Peer(self.apps.browser, desktop=False)
        self.assertEqual(browser.files(), {'browser': self.apps.browser / 'desks.json'})
        for source in ('../desktop', str(self.apps.peer_file), None, ['x']):
            with self.assertRaises(ValueError):
                self.peer.record(source, 'desk-1234abcd')

    def test_the_peer_folder_is_fixed_unless_the_server_is_started_elsewhere(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('AGENT_DESK_PEER_DATA_DIR', None)
            self.assertEqual(saved_desks.Peer.of(4310).folder, saved_desks.DESKTOP_DATA)
            self.assertEqual(saved_desks.Peer.of(4322).folder, saved_desks.DESKTOP_DATA)
            self.assertEqual(saved_desks.Peer.of(WORKSPACE).folder, saved_desks.BROWSER_DATA)
        with patch.dict(os.environ, {'AGENT_DESK_PEER_DATA_DIR': str(self.apps.desktop)}):
            self.assertEqual(saved_desks.Peer.of(4310).folder, self.apps.desktop)

    def test_a_packaged_desktop_app_finds_the_browser_desk_from_its_pointer(self):
        installed, pointer = self.apps.desktop.parent / 'installed', self.apps.desktop.parent / 'installed' / 'browser-desk.json'
        bundle = self.apps.desktop.parent / 'bundle'
        with patch.multiple(saved_desks, PROJECT_DIR=bundle, INSTALLED_DATA=installed, BROWSER_POINTER=pointer):
            self.assertEqual(saved_desks.browser_data(), installed)
            saved_desks.remember_browser_desk(self.apps.browser)
            self.assertEqual(json.loads(pointer.read_text()), dict(data=str(self.apps.browser)))
            self.assertEqual(pointer.stat().st_mode & 0o777, 0o600)
            self.assertEqual(saved_desks.browser_data(), self.apps.browser)
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop('AGENT_DESK_PEER_DATA_DIR', None)
                self.assertEqual(saved_desks.Peer.of(WORKSPACE).folder, self.apps.browser)
            linked = self.apps.desktop.parent / 'linked-browser'
            linked.symlink_to(self.apps.browser)
            for bad in (dict(data=str(linked)), dict(data='relative/data'), dict(data=str(self.apps.browser / 'desks.json')), dict(data=['x']), []):
                pointer.write_text(json.dumps(bad))
                self.assertEqual(saved_desks.browser_data(), installed, bad)
            real = pointer.with_name('real.json')
            real.write_text(json.dumps(dict(data=str(self.apps.browser))))
            pointer.unlink()
            pointer.symlink_to(real)
            self.assertEqual(saved_desks.browser_data(), installed)
            pointer.unlink()
            pointer.write_text(json.dumps(dict(data=str(self.apps.browser))))
            with patch.object(saved_desks.os, 'getuid', return_value=os.getuid() + 1):
                self.assertEqual(saved_desks.browser_data(), installed)

    def test_a_checkout_finds_its_own_data_without_the_pointer(self):
        pointer = self.apps.desktop.parent / 'browser-desk.json'
        pointer.write_text(json.dumps(dict(data=str(self.apps.browser))))
        (self.apps.project / 'pyproject.toml').write_text('')
        with patch.multiple(saved_desks, PROJECT_DIR=self.apps.project, BROWSER_DATA=self.apps.project / 'data', BROWSER_POINTER=pointer):
            self.assertEqual(saved_desks.browser_data(), self.apps.project / 'data')


class ImportedRecordTests(unittest.TestCase):
    def setUp(self):
        self.apps = Apps(self)

    def test_argv_and_anything_unexpected_are_never_imported(self):
        item = terminal('terminal-a', str(self.apps.project), native_session=CLAUDE_ID, display_name='Reviewer', env={'TOKEN': 'x'}, parent_id='terminal-z')
        record = saved_desks.imported(dict(terminals=[item], coordinators=['coordinator-1'], layout=dict(layout='grid', panes=[dict(id='terminal-a')], pages=[]), extra=1), 'desktop app')
        self.assertEqual(record['terminals'], [dict(id='terminal-a', name='Reviewer', cwd=str(self.apps.project), profile='claude', conversation=CLAUDE_ID)])
        self.assertEqual((record['coordinators'], record['imported']), ([], dict(app='desktop app')))
        self.assertNotIn('dangerously', json.dumps(record))
        self.assertNotIn('mcp', json.dumps(record))

    def test_each_field_is_checked_as_strictly_as_save_does(self):
        good = str(self.apps.project)
        record = saved_desks.imported(dict(terminals=[
            terminal('bad id', good), terminal('terminal-gone', str(self.apps.project / 'gone')), terminal('terminal-relative', 'project'),
            terminal('terminal-a', good, native_session='../../etc/passwd', launch_profile='Claude Work', name='x\x1b[31m'),
            terminal('terminal-a', good), terminal('terminal-b', good, native_session=CODEX_ID, launch_profile='codex', agent_exited=True), 'junk'],
            layout=dict(layout='grid', panes=[dict(id='terminal-a', rect=dict(x=9, y=0, w=6, h=1))], pages=[])), 'desktop app')
        self.assertEqual(record['terminals'], [dict(id='terminal-a', name='Terminal', cwd=good, profile=None, conversation=None),
                                               dict(id='terminal-b', name='Claude', cwd=good, profile=None, conversation=None)])
        self.assertEqual(record['layout'], dict(layout='grid', panes=[dict(id='terminal-a'), dict(id='terminal-b')], pages=[]), 'a bad layout is dropped, not trusted')

    def test_a_desk_comes_over_with_as_many_terminals_as_a_desk_can_hold(self):
        most = saved_desks.MOST_TERMINALS_PER_DESK
        items = [terminal(f'terminal-{n}', str(self.apps.project)) for n in range(most + 1)]
        record = saved_desks.imported(dict(terminals=items, layout='not a layout'), 'desktop app')
        self.assertEqual(len(record['terminals']), most)
        self.assertEqual(record['layout']['panes'], [dict(id=t['id']) for t in record['terminals']], 'a bad layout opens every terminal that came over')

    def test_web_pages_keep_to_http_and_panes_to_what_came_over(self):
        pages = [dict(id='web-1', url='https://example.test/', name='Docs'), dict(id='web-2', url='http://localhost:3000/', name='App')]
        record = saved_desks.imported(dict(terminals=[terminal('terminal-a', str(self.apps.project))], layout=dict(
            layout='rows', panes=[dict(id='terminal-a'), dict(id='terminal-gone'), dict(id='web-1')], pages=pages)), 'desktop app')
        self.assertEqual(record['layout'], dict(layout='rows', panes=[dict(id='terminal-a'), dict(id='web-1')], pages=[dict(pages[0])]))
        bad = saved_desks.imported(dict(terminals=[], layout=dict(layout='rows', panes=[dict(id='web-1')], pages=[dict(id='web-1', url='file:///etc/passwd')])), 'desktop app')
        self.assertEqual(bad['layout']['pages'], [])


class ImportRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.http.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()

    def setUp(self):
        self.apps = Apps(self)
        (self.apps.browser / 'accounts.json').write_text(json.dumps([dict(id='codex-team', harness='codex', name='Team', config_dir='~/.codex-team')]))
        for patcher in (patch.object(server, 'DESKS', Desks(self.apps.browser / 'desks.json')),
                        patch.object(server, 'PEER', saved_desks.Peer(self.apps.desktop, desktop=True)),
                        patch.object(accounts, 'ACCOUNTS_FILE', self.apps.browser / 'accounts.json')):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.launched = []

    def post(self, path, body, token=True):
        headers = {'X-Agent-Desk-Terminal': server.TERMINAL_TOKEN} if token else {}
        with urlopen(Request(self.base + path, data=json.dumps(body).encode(), headers=headers)) as response:
            return json.load(response)

    def error(self, path, body, token=True):
        with self.assertRaises(HTTPError) as caught:
            self.post(path, body, token)
        with caught.exception as response:
            return response.status, json.load(response)['error']

    def launch(self, payload, coordinator=None, desk=None):
        self.launched.append(payload)
        return Mock(id=f'terminal-new-{len(self.launched)}')

    def import_research(self, **body):
        listed = self.post('/api/desks/peer', {})
        self.assertEqual(listed['app'], 'desktop app')
        return self.post('/api/desks/import', dict(source=listed['desks'][0]['source'], id=listed['desks'][0]['id'], **body))

    def test_import_and_list_need_the_desk_token(self):
        self.apps.save_in_desktop([terminal('terminal-a', str(self.apps.project))])
        for path in ('/api/desks/peer', '/api/desks/import'):
            self.assertEqual(self.error(path, dict(source=WORKSPACE, id='desk-1234abcd'), token=False)[0], 403)
        self.assertEqual(server.DESKS.snapshot(), [dict(id='main', name='Main')])

    def test_the_source_file_is_unchanged_and_nothing_starts_on_import(self):
        self.apps.save_in_desktop([terminal('terminal-a', str(self.apps.project), native_session=CLAUDE_ID)])
        before, stat = self.apps.peer_file.read_bytes(), self.apps.peer_file.stat()
        with patch.object(server, 'TERMINALS', Mock(launch=self.launch)):
            desk = self.import_research()['desk']
        self.assertEqual((desk['name'], desk['imported'], desk['imported_from']), ('Research', 'desktop app', f'{WORKSPACE}/desk-1234abcd'))
        self.assertTrue(desk['saved_at'])
        self.assertEqual(self.launched, [], 'importing launches nothing')
        after = self.apps.peer_file.stat()
        self.assertEqual(self.apps.peer_file.read_bytes(), before)
        self.assertEqual((after.st_mtime_ns, after.st_ino, after.st_mode), (stat.st_mtime_ns, stat.st_ino, stat.st_mode))
        self.assertEqual(sorted(p.name for p in self.apps.desktop.iterdir()), [self.apps.peer_file.name])

    def test_reopen_builds_commands_from_this_apps_accounts_and_resumes(self):
        project = str(self.apps.project)
        self.apps.save_in_desktop([terminal('terminal-a', project, native_session=CLAUDE_ID, display_name='Reviewer'),
                                   terminal('terminal-b', project, launch_profile='codex-team', native_session=CODEX_ID, name='Codex'),
                                   terminal('terminal-c', project, launch_profile=None, argv=['/usr/bin/make', 'deploy'], name='Shell'),
                                   terminal('terminal-d', project, launch_profile='grok', argv=['grok', '--yolo'], name='Grok')])
        desk = self.import_research()['desk']
        preview = self.post('/api/desks/reopen-preview', {'id': desk['id']})['sessions']
        self.assertEqual([(r['id'], r['resumes'], r['detail']) for r in preview], [
            ('terminal-a', True, f'On reopen: resumes Claude conversation {CLAUDE_ID}'),
            ('terminal-b', True, f'On reopen: resumes Codex conversation {CODEX_ID}'),
            ('terminal-c', False, 'On reopen: starts a new shell in the same folder'),
            ('terminal-d', False, 'On reopen: Grok conversations are not recorded, so this is a new session')])
        with patch.object(server, 'TERMINALS', Mock(launch=self.launch)):
            reopened = self.post('/api/desks/reopen', {'id': desk['id']})
        shell = os.environ.get('SHELL', '/bin/zsh')
        self.assertEqual([p['argv'] for p in self.launched], [
            ['/bin/zsh', '-lic', 'claude "$@"', 'agent-desk', '--resume', CLAUDE_ID, SHELL_MARKER],
            ['/bin/zsh', '-lic', 'codex-team "$@"', 'agent-desk', 'resume', CODEX_ID, SHELL_MARKER],
            [shell, '-l'], ['grok', SHELL_MARKER]])
        launched = json.dumps(self.launched)
        for flag in ('--dangerously-skip-permissions', '--mcp-config', '/elsewhere', 'make', 'deploy', '--yolo'):
            self.assertNotIn(flag, launched)
        self.assertEqual([(p['cwd'], p['launch_profile']) for p in self.launched],
                         [(project, 'claude'), (project, 'codex-team'), (project, None), (project, None)])
        self.assertEqual([r['new_id'] for r in reopened['results']], [f'terminal-new-{i}' for i in range(1, 5)])
        self.assertNotIn('saved_at', next(d for d in reopened['desks'] if d['id'] == desk['id']))

    def test_an_account_missing_here_is_never_launched_until_one_is_picked(self):
        project = str(self.apps.project)
        self.apps.save_in_desktop([terminal('terminal-a', project, launch_profile='claude-work', native_session=CLAUDE_ID),
                                   terminal('terminal-b', project, launch_profile=None, name='Shell')])
        desk = self.import_research()['desk']
        row = self.post('/api/desks/reopen-preview', {'id': desk['id']})['sessions'][0]
        self.assertTrue(row['needs_account'])
        self.assertIn('no “claude-work” account here', row['detail'])
        with patch.object(server, 'TERMINALS', Mock(launch=self.launch)):
            for choices in (None, {}, {'terminal-a': 'claude-other'}, {'terminal-a': 7}, {'terminal-b': ''}):
                status, message = self.error('/api/desks/reopen', {'id': desk['id'], 'accounts': choices})
                self.assertEqual(status, 400)
                self.assertIn('Pick an account', message)
            self.assertEqual(self.launched, [], 'nothing starts, and nothing falls back to another account')
            self.assertTrue(next(d for d in server.DESKS.snapshot() if d['id'] == desk['id'])['saved_at'], 'the desk stays saved')
            self.post('/api/desks/reopen', {'id': desk['id'], 'accounts': {'terminal-a': 'claude'}})
        self.assertEqual(self.launched[0]['argv'], ['/bin/zsh', '-lic', 'claude "$@"', 'agent-desk', '--resume', CLAUDE_ID, SHELL_MARKER])

    def test_an_account_can_be_left_out_instead(self):
        self.apps.save_in_desktop([terminal('terminal-a', str(self.apps.project), launch_profile='claude-work'),
                                   terminal('terminal-b', str(self.apps.project), launch_profile=None, name='Shell')])
        desk = self.import_research()['desk']
        with patch.object(server, 'TERMINALS', Mock(launch=self.launch)):
            results = self.post('/api/desks/reopen', {'id': desk['id'], 'accounts': {'terminal-a': ''}})['results']
        self.assertEqual([r['id'] for r in results], ['terminal-b'])
        self.assertEqual(self.launched[0]['launch_profile'], None)

    def test_a_taken_name_is_refused_and_a_new_one_used(self):
        self.apps.save_in_desktop([terminal('terminal-a', str(self.apps.project))])
        self.post('/api/desks/create', {'name': 'research'})
        status, message = self.error('/api/desks/import', dict(source=WORKSPACE, id='desk-1234abcd'))
        self.assertEqual(status, 400)
        self.assertIn('already a desk called', message)
        self.assertEqual(self.import_research(name='Research (desktop)')['desk']['name'], 'Research (desktop)')

    def test_a_desk_no_longer_saved_there_cannot_be_imported(self):
        self.apps.save_in_desktop([])
        self.assertIn('no longer saved in the desktop app', self.error('/api/desks/import', dict(source=WORKSPACE, id='desk-other'))[1])
        self.assertIn('no longer saved', self.error('/api/desks/import', dict(source='../' + WORKSPACE, id='desk-1234abcd'))[1])

    def test_only_an_imported_desk_is_previewed(self):
        work = self.post('/api/desks/create', {'name': 'Work'})['id']
        server.DESKS.keep(work, dict(terminals=[], coordinators=[], layout=None))
        self.assertIn('Only an imported desk', self.error('/api/desks/reopen-preview', {'id': work})[1])


if __name__ == '__main__':
    unittest.main()
