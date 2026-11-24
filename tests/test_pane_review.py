import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from agent_desk import desk_tokens, server
from agent_desk.terminals import TerminalManager
from agent_desk.tool_runtime import BUNDLED, ToolRuntime
from account_fixtures import use_accounts

ROOT = Path(__file__).resolve().parents[1]


def setUpModule():
    use_accounts()


class BundledReviewTests(unittest.TestCase):
    def test_the_desk_uses_its_own_code_review_over_an_installed_copy(self):
        with tempfile.TemporaryDirectory() as temp:
            stale = Path(temp) / '.agents' / 'skills' / 'code-review'
            stale.mkdir(parents=True)
            (stale / 'review_app.py').write_text('raise SystemExit("an older copy")')
            environment = {k: v for k, v in os.environ.items() if k != 'AGENT_DESK_TOOL_ROOTS'}
            with patch.dict(os.environ, environment, clear=True), patch.object(Path, 'home', return_value=Path(temp)):
                found = {item['id']: item for item in ToolRuntime(Path(temp) / 'state').catalog()}
        self.assertEqual(found['code-review']['script'], str(BUNDLED / 'code-review' / 'review_app.py'))
        self.assertTrue((BUNDLED / 'code-review' / 'vendor' / 'highlight-LICENSE').is_file())


class PaneReviewRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.manager = TerminalManager()
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.desk = f'http://127.0.0.1:{self.http.server_port}'
        self.launched = []
        def launch(skill, target, identity=None, title=None, port=None, extra=None):
            self.launched.append(dict(skill=skill, target=target, identity=identity, extra=extra))
            return dict(id=identity, title='Code review · project', skill=skill, url='http://127.0.0.1:49999', context=str(target))
        self.patches = [patch.object(server, 'TERMINALS', self.manager), patch.object(server, 'SKILL_UIS_FILE', Path(self.temp.name) / 'skill-uis.json'),
                        patch.object(server.TOOL_RUNTIME, 'launch', side_effect=launch), patch.object(server.TOOL_RUNTIME, 'status', return_value={'status': 'running'})]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in self.patches:
            item.stop()
        self.manager.close()
        self.http.shutdown()
        self.http.server_close()
        self.temp.cleanup()

    def call(self, payload, token):
        request = Request(self.desk + '/api/tools/pane-review', data=json.dumps(payload).encode(),
                          headers={'X-Agent-Desk-Terminal': token, 'Content-Type': 'application/json'})
        with urlopen(request, timeout=5) as response:
            return json.load(response)

    def test_review_opens_on_the_panes_folder_and_reports_back_to_that_pane(self):
        session = self.manager.launch(dict(cwd=self.temp.name, argv=['/bin/sh'], name='Review pane'))
        item = self.call(dict(id=session.id, name='Builder'), server.TERMINAL_TOKEN)
        launched = self.launched[-1]
        self.assertEqual((launched['skill'], launched['target']), ('code-review', session.cwd))
        self.assertTrue(launched['identity'].startswith('pane-review-'))
        extra = launched['extra']
        self.assertEqual(extra[extra.index('--agent-name') + 1], 'Builder')
        self.assertEqual(extra[extra.index('--session-id') + 1], session.id)
        self.assertEqual(extra[extra.index('--feedback-adapter') + 1], 'command')
        self.assertIn('--follow-pr', extra)
        offered = json.loads(extra[extra.index('--reviewers') + 1])
        self.assertTrue({'claude', 'codex', 'grok', 'opencode', 'pi'} <= {r['harness'] for r in offered}, 'every coding agent the desk knows is offered')
        self.assertTrue(all(set(r['env']) <= {'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'XDG_DATA_HOME', 'PI_CODING_AGENT_DIR'} for r in offered))
        command = json.loads(extra[extra.index('--feedback-command') + 1])
        self.assertEqual(command[1:], [str(ROOT / 'scripts' / 'review_bridge.py'), self.desk])
        self.assertEqual((item['agent_id'], item['status']), (session.id, 'running'))
        self.assertEqual(self.call(dict(id=session.id, name='Builder'), server.TERMINAL_TOKEN)['id'], item['id'], 'the same pane gets the same review')

    def test_only_the_page_opens_a_panes_review(self):
        session = self.manager.launch(dict(cwd=self.temp.name, argv=['/bin/sh'], name='Review pane'))
        with self.assertRaises(HTTPError) as caught:
            self.call(dict(id=session.id, name='Builder'), server.HELPER_TOKEN)
        self.assertEqual(caught.exception.code, 403)
        with self.assertRaises(HTTPError) as caught:
            self.call(dict(id='terminal-unknown', name='Builder'), server.TERMINAL_TOKEN)
        self.assertEqual(caught.exception.code, 404)
        self.assertEqual(self.launched, [])


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.received = []
        self.reply = (200, None)
        test = self
        class Desk(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                test.received.append((self.path, self.headers.get('X-Agent-Desk-Terminal'), body))
                code, answer = test.reply
                data = json.dumps(answer or {'sent': True, 'target_id': body['target_id']}).encode()
                self.send_response(code)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(data)
        self.http = ThreadingHTTPServer(('127.0.0.1', 0), Desk)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.desk = f'http://127.0.0.1:{self.http.server_port}'
        desk_tokens.write_token('terminal', self.http.server_port, 'fixture-helper-token', self.temp.name)

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.temp.cleanup()

    def bridge(self, event):
        environment = {k: v for k, v in os.environ.items() if not k.startswith('AGENT_DESK_')} | {'AGENT_DESK_DATA_DIR': self.temp.name}
        return subprocess.run([sys.executable, str(ROOT / 'scripts' / 'review_bridge.py'), self.desk], input=json.dumps(event),
                              capture_output=True, text=True, env=environment, timeout=20)

    def test_a_submission_reaches_the_pane_and_is_acknowledged(self):
        event = {'submission_id': 'a' * 64, 'destination': {'session_id': 'terminal-fixture'}, 'message': 'Read the snapshot at /tmp/s.json'}
        result = self.bridge(event)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'accepted': True, 'submission_id': 'a' * 64, 'session_id': 'terminal-fixture', 'queued': False})
        path, token, body = self.received[-1]
        self.assertEqual((path, token), ('/api/coordinators/submit-feedback', 'fixture-helper-token'))
        self.assertEqual((body['request_id'], body['target_id'], body['prompt']), ('a' * 64, 'terminal-fixture', event['message']))

    def test_a_refusal_is_not_acknowledged(self):
        self.reply = (400, {'error': 'This worker does not have a supported coding-agent prompt'})
        result = self.bridge({'submission_id': 'b' * 64, 'destination': {'session_id': 'terminal-fixture'}, 'message': 'hello'})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertIn('supported coding-agent prompt', result.stderr)


class ReviewAppTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp.name) / 'project'
        self.repo.mkdir()
        self.environment = {k: v for k, v in os.environ.items() if not k.startswith('AGENT_DESK_')} | {
            'REVIEW_APP_HOME': str(Path(self.temp.name) / 'notes'), 'GIT_AUTHOR_NAME': 'Fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.com',
            'GIT_COMMITTER_NAME': 'Fixture', 'GIT_COMMITTER_EMAIL': 'fixture@example.com'}
        self.git('init', '-q', '-b', 'main')
        (self.repo / 'app.py').write_text('one\n')
        self.git('add', '.')
        self.git('commit', '-q', '-m', 'Start')

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.repo, env=self.environment, check=True, capture_output=True, text=True).stdout.strip()

    def review(self, *args):
        return subprocess.run([sys.executable, str(BUNDLED / 'code-review' / 'review_app.py'), str(self.repo), *args], env=self.environment,
                              capture_output=True, text=True, timeout=30)

    def notes(self):
        return json.loads(Path(self.review('--notes-path').stdout.strip()).read_text())['annotations']

    def test_an_agent_resolves_a_note_only_with_proof_and_the_proof_stays_on_it(self):
        (self.repo / 'app.py').write_text('two\n')
        path = Path(self.review('--notes-path').stdout.strip())
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'annotations': [{'id': 1, 'kind': 'general', 'comment': 'rename it', 'status': 'open'}]}))
        refused = self.review('--author', 'Fixture', '--reply', '1', 'renamed', '--resolve', '1')
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('--proof', refused.stderr)
        self.assertEqual((self.notes()[0]['status'], self.notes()[0].get('replies')), ('open', None), 'a refused command changes nothing')
        shot = Path(self.temp.name) / 'shot.png'
        shot.write_bytes(b'\x89PNG\r\n\x1a\nfixture')
        done = self.review('--author', 'Fixture', '--reply', '1', 'renamed', '--resolve', '1', '--proof', 'pytest -q: 3 passed', '--proof-file', str(shot))
        self.assertEqual(done.returncode, 0, done.stderr)
        note = self.notes()[0]
        self.assertEqual((note['status'], note['proof']['author'], note['proof']['text']), ('addressed', 'Fixture', 'pytest -q: 3 passed'))
        self.assertEqual((path.parent / (path.stem + '-proof') / note['proof']['file']).read_bytes(), shot.read_bytes())
        (Path(self.temp.name) / 'notes.txt').write_text('not an image')
        self.assertNotEqual(self.review('--resolve', '1', '--proof', 'ok', '--proof-file', str(Path(self.temp.name) / 'notes.txt')).returncode, 0)

    def test_a_second_opinion_runs_on_the_account_chosen_and_leaves_notes_under_its_name(self):
        (self.repo / 'app.py').write_text('two\n')
        tools, seen = Path(self.temp.name) / 'bin', Path(self.temp.name) / 'seen.txt'
        tools.mkdir()
        # A stand-in claude: it records which config folder it ran with and returns one review comment.
        review = {'structured_output': {'summary': 'fine', 'comments': [{'file': 'app.py', 'start': 1, 'end': 1, 'severity': 'nit', 'comment': 'name it better', 'suggestion': None}]}}
        (tools / 'claude').write_text(f'#!/bin/sh\necho "$CLAUDE_CONFIG_DIR" > {seen}\ncat > /dev/null\necho \'{json.dumps(review)}\'\n')
        (tools / 'claude').chmod(0o755)
        folder = Path(self.temp.name) / 'personal-claude'
        reviewers = [{'id': 'claude-personal', 'label': 'Claude · Personal', 'harness': 'claude', 'env': {'CLAUDE_CONFIG_DIR': str(folder)}}]
        self.environment['PATH'] = f'{tools}{os.pathsep}{self.environment.get("PATH", "")}'
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        process = subprocess.Popen([sys.executable, str(BUNDLED / 'code-review' / 'review_app.py'), str(self.repo), '--port', str(port), '--no-browser',
                                    '--reviewers', json.dumps(reviewers)], env=self.environment, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            base = f'http://127.0.0.1:{port}'
            for _ in range(100):
                try:
                    state = json.load(urlopen(base + '/state', timeout=2))
                    break
                except OSError:
                    time.sleep(.1)
            self.assertEqual(list(state['reviewers']), ['claude-personal'], 'only the reviewers the desk offers are listed')
            self.assertEqual((state['reviewers']['claude-personal']['author'], state['reviewers']['claude-personal']['harness']), ('Claude · Personal', 'claude'))
            urlopen(Request(base + '/second-opinion', data=json.dumps({'reviewers': ['claude-personal']}).encode(), headers={'Content-Type': 'application/json'}), timeout=5).read()
            for _ in range(100):
                state = json.load(urlopen(base + '/state', timeout=2))
                if not state['reviewers']['claude-personal']['running'] and state['reviewers']['claude-personal']['finished']:
                    break
                time.sleep(.1)
            self.assertEqual(state['reviewers']['claude-personal']['added'], 1, state['reviewers']['claude-personal']['error'])
            self.assertEqual([(n['author'], n['comment']) for n in state['annotations']], [('Claude · Personal', '[nit] name it better')])
            self.assertEqual(seen.read_text().strip(), str(folder), 'the reviewer ran with that account\'s config folder')
        finally:
            process.terminate()
            process.wait(timeout=10)
            process.stderr.close()

    def test_a_reviewer_may_only_point_its_cli_at_a_config_folder(self):
        for reviewers in ([{'id': 'claude', 'label': 'Claude', 'harness': 'claude', 'env': {'PATH': '/tmp/evil'}}],
                          [{'id': 'claude', 'label': 'Claude', 'harness': 'claude', 'env': {'CLAUDE_CONFIG_DIR': 'relative/folder'}}],
                          [{'id': 'shell', 'label': 'Shell', 'harness': 'bash', 'env': {}}], []):
            with self.subTest(reviewers=reviewers):
                refused = self.review('--reviewers', json.dumps(reviewers), '--notes-path')
                self.assertNotEqual(refused.returncode, 0)
                self.assertIn('--reviewers', refused.stderr)

    def test_files_git_is_not_tracking_are_marked_apart_from_new_files_on_the_branch(self):
        (self.repo / 'app.py').write_text('two\n')
        (self.repo / 'staged.py').write_text('new\n')
        self.git('add', 'staged.py')
        (self.repo / 'local_only.rb').write_text('LOCAL = true\n')
        sys.path.insert(0, str(BUNDLED / 'code-review'))
        try:
            import review_app
        finally:
            sys.path.remove(str(BUNDLED / 'code-review'))
        seen = {f['path']: (f['status'], f.get('untracked', False)) for f in review_app.diff_model(self.repo, 'HEAD', True)['files']}
        self.assertEqual(seen, {'app.py': ('modified', False), 'staged.py': ('added', False), 'local_only.rb': ('added', True)})
        self.assertEqual([f['path'] for f in review_app.diff_model(self.repo, 'HEAD', False)['files']], ['app.py', 'staged.py'])

    def test_a_branch_with_a_pull_request_is_reviewed_from_where_it_left_its_base(self):
        start = self.git('rev-parse', 'HEAD')
        self.git('update-ref', 'refs/remotes/origin/main', start)
        self.git('checkout', '-q', '-b', 'feature')
        (self.repo / 'app.py').write_text('two\n')
        self.git('commit', '-qam', 'Feature')
        tools = Path(self.temp.name) / 'bin'
        tools.mkdir()
        (tools / 'gh').write_text('#!/bin/sh\necho \'{"url": "https://github.com/fixture/project/pull/7", "state": "OPEN", "baseRefName": "main", "title": "Add a feature"}\'\n')
        (tools / 'gh').chmod(0o755)
        sys.path.insert(0, str(BUNDLED / 'code-review'))
        try:
            import review_app
        finally:
            sys.path.remove(str(BUNDLED / 'code-review'))
        with patch.dict(os.environ, {'PATH': f'{tools}{os.pathsep}{os.environ["PATH"]}'}):
            self.assertEqual(review_app.branch_pr(self.repo), {'url': 'https://github.com/fixture/project/pull/7', 'base': start, 'title': 'Add a feature', 'base_name': 'main'})
            (tools / 'gh').write_text('#!/bin/sh\necho \'{"url": "https://github.com/fixture/project/pull/7", "state": "MERGED", "baseRefName": "main"}\'\n')
            self.assertIsNone(review_app.branch_pr(self.repo), 'a merged pull request is not followed')


FAKE_GH = '''import json, os, sys
args = sys.argv[1:]
prs = json.load(open(os.environ['FAKE_PRS']))
if args[:2] == ['pr', 'view']:
    print(json.dumps(prs[args[2]] if len(args) > 2 and not args[2].startswith('-') else prs['branch']))
elif args[:1] == ['api']:
    print(json.dumps([prs.get('api:' + args[-1], [])]))
else:
    sys.exit('fake gh: ' + ' '.join(args))
'''

FAKE_CODEX = '''import json, sys
from pathlib import Path
args = sys.argv[1:]
tree = Path(args[args.index('-C') + 1])
json.dump({'cwd': str(tree), **{name: (tree / name).read_text() for name in ('other.py', 'app.py')}}, open(REVIEWED, 'w'))
review = {'summary': '', 'comments': [{'file': 'other.py', 'start': 1, 'end': 1, 'severity': 'nit', 'comment': 'read at the PR head', 'suggestion': None}]}
Path(args[args.index('-o') + 1]).write_text(json.dumps(review))
'''


class PullRequestSwitchTests(unittest.TestCase):
    """Review can show another of the terminal's pull requests, read from Git without checking it out."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp.name) / 'project'
        self.repo.mkdir()
        tools = Path(self.temp.name) / 'bin'
        tools.mkdir()
        (tools / 'gh').write_text(f'#!{sys.executable}\n' + FAKE_GH)
        (tools / 'gh').chmod(0o755)
        self.reviewed = Path(self.temp.name) / 'reviewed.json'
        (tools / 'codex').write_text(f'#!{sys.executable}\n' + FAKE_CODEX.replace('REVIEWED', repr(str(self.reviewed))))
        (tools / 'codex').chmod(0o755)
        self.prs = Path(self.temp.name) / 'prs.json'
        self.environment = {k: v for k, v in os.environ.items() if not k.startswith('AGENT_DESK_')} | {
            'REVIEW_APP_HOME': str(Path(self.temp.name) / 'notes'), 'GIT_AUTHOR_NAME': 'Fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.com',
            'GIT_COMMITTER_NAME': 'Fixture', 'GIT_COMMITTER_EMAIL': 'fixture@example.com', 'FAKE_PRS': str(self.prs),
            'GROUND_CONTROL_DATA_DIR': str(Path(self.temp.name) / 'submissions'), 'REVIEW_APP_PR_POLL_SECONDS': '3600',
            'PATH': f'{tools}{os.pathsep}{os.environ["PATH"]}'}
        self.git('init', '-q', '-b', 'main')
        (self.repo / 'app.py').write_text('one\n')
        self.git('add', '.')
        self.git('commit', '-q', '-m', 'Start')
        self.main = self.git('rev-parse', 'HEAD')
        self.git('checkout', '-q', '-b', 'other')
        (self.repo / 'other.py').write_text('hello\n')
        self.git('add', '.')
        self.git('commit', '-q', '-m', 'Other')
        self.other = self.git('rev-parse', 'HEAD')
        self.git('checkout', '-q', '-b', 'feature', 'main')
        (self.repo / 'app.py').write_text('two\n')
        self.git('commit', '-qam', 'Feature')
        self.git('update-ref', 'refs/remotes/origin/main', self.main)
        self.git('remote', 'add', 'origin', 'https://github.com/fixture/project.git')
        self.url = 'https://github.com/fixture/project/pull/8'
        comment = {'id': 81, 'path': 'other.py', 'line': 1, 'side': 'RIGHT', 'body': 'Say hello properly', 'user': {'login': 'reviewer'},
                   'created_at': '2026-11-18T10:00:00Z', 'html_url': self.url + '#discussion_r81'}
        self.prs.write_text(json.dumps({
            'branch': {'url': 'https://github.com/fixture/project/pull/7', 'state': 'OPEN', 'baseRefName': 'main'},
            self.url: {'number': 8, 'title': 'Add other', 'state': 'OPEN', 'url': self.url, 'headRefName': 'other', 'headRefOid': self.other,
                       'baseRefName': 'main', 'baseRefOid': self.main},
            'api:repos/fixture/project/pulls/8/comments': [comment]}))

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args, cwd=None):
        return subprocess.run(['git', *args], cwd=cwd or self.repo, env=self.environment, check=True, capture_output=True, text=True).stdout.strip()

    def start(self):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        process = subprocess.Popen([sys.executable, str(BUNDLED / 'code-review' / 'review_app.py'), str(self.repo), '--port', str(port), '--no-browser',
                                    '--follow-pr', '--feedback-adapter', 'manual'], env=self.environment, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.addCleanup(lambda: (process.terminate(), process.wait(timeout=10), process.stderr.close()))
        base = f'http://127.0.0.1:{port}'
        for _ in range(100):
            try:
                if json.load(urlopen(base + '/state', timeout=2))['pr']:
                    return base
            except OSError:
                pass
            time.sleep(.1)
        self.fail('the review app did not pick up the branch pull request')

    def post(self, base, route, payload, headers=None):
        request = Request(base + route, data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json', **(headers or {})})
        try:
            with urlopen(request, timeout=30) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def test_another_pull_request_is_reviewed_from_its_commits_with_its_own_notes(self):
        base = self.start()
        get = lambda route: json.load(urlopen(base + route, timeout=10))
        self.post(base, '/annotate', {'kind': 'line', 'file': 'app.py', 'side': 'new', 'start': 1, 'end': 1, 'quote': 'two', 'comment': 'on the checked-out work'})
        self.assertEqual(get('/state')['repos'], ['fixture/project'])

        code, answer = self.post(base, '/pr-select', {'url': self.url})
        self.assertEqual((code, answer['view']), (200, {'url': self.url, 'number': 8, 'title': 'Add other', 'branch': 'other'}))
        model = get('/diff')
        self.assertEqual(([f['path'] for f in model['files']], model['branch'], model['checked_out']), (['other.py'], 'other', False))
        self.assertEqual(urlopen(base + '/file?path=other.py&side=new', timeout=10).read(), b'hello\n', 'the file is read at the PR head, not from disk')
        self.assertFalse((self.repo / 'other.py').exists())
        self.assertEqual(self.git('rev-parse', '--abbrev-ref', 'HEAD'), 'feature', 'nothing was checked out')
        state = get('/state')
        self.assertEqual([(n['author'], n['comment'], n['start']) for n in state['annotations']], [('reviewer', 'Say hello properly', 1)])
        self.post(base, '/annotate', {'kind': 'line', 'file': 'other.py', 'side': 'new', 'start': 1, 'end': 1, 'quote': 'hello', 'comment': 'on PR 8'})
        state = get('/state')
        self.assertEqual([(n['comment'], n['pr']) for n in state['annotations']], [('Say hello properly', self.url), ('on PR 8', self.url)])

        token = re.search(r'"token": ?"([^"]+)"', urlopen(base + '/', timeout=10).read().decode()).group(1)
        code, sent = self.post(base, '/_ground-control/submit', {}, {'X-Ground-Control-Token': token})
        self.assertEqual(code, 200, sent)
        snapshot = json.loads(Path(sent['snapshot']).read_text())
        self.assertEqual(sorted(n['comment'] for n in snapshot['annotations']), ['Say hello properly', 'on PR 8'], 'Send carries only the notes on the PR shown')
        self.assertIn('pull request #8 (branch other), which is not checked out', sent['prompt'])

        self.assertEqual(self.post(base, '/second-opinion', {'reviewers': ['codex']})[0], 200)
        for _ in range(100):
            state = get('/state')
            if state['reviewers']['codex']['finished']:
                break
            time.sleep(.1)
        self.assertEqual(state['reviewers']['codex']['added'], 1, state['reviewers']['codex']['error'])
        reviewed = json.loads(self.reviewed.read_text())
        self.assertNotEqual(reviewed['cwd'], str(self.repo), 'the reviewer reads the PR head, not the checked-out work')
        self.assertEqual((reviewed['other.py'], reviewed['app.py']), ('hello\n', 'one\n'))
        self.assertEqual([(n['comment'], n['pr']) for n in get('/state')['annotations'] if n.get('author') == 'Codex'], [('[nit] read at the PR head', self.url)])
        self.assertEqual(self.git('worktree', 'list', '--porcelain').count('worktree '), 1, 'the temporary checkout is removed')
        self.assertEqual(self.git('rev-parse', '--abbrev-ref', 'HEAD'), 'feature')
        code, refused = self.post(base, '/pr-select', {'url': 'https://github.com/someone/else/pull/1'})
        self.assertEqual((code, refused['error']), (502, 'that pull request is in another repository'))
        self.assertEqual(get('/state')['view']['number'], 8, 'a refused switch keeps the PR shown')

        self.assertEqual(self.post(base, '/pr-select', {'url': None}), (200, {'view': None}))
        self.assertEqual([f['path'] for f in get('/diff')['files']], ['app.py'])
        self.assertEqual([n['comment'] for n in get('/state')['annotations']], ['on the checked-out work'])

    def test_a_pull_request_whose_commits_are_missing_is_fetched_without_checking_it_out(self):
        hub = Path(self.temp.name) / 'hub.git'
        self.git('init', '-q', '--bare', str(hub))
        self.git('push', '-q', str(hub), 'main', f'{self.other}:refs/pull/8/head')
        clone = Path(self.temp.name) / 'clone'
        self.git('clone', '-q', '--no-local', '--branch', 'main', str(hub), str(clone))
        self.assertNotEqual(subprocess.run(['git', 'cat-file', '-e', self.other + '^{commit}'], cwd=clone, capture_output=True).returncode, 0)
        sys.path.insert(0, str(BUNDLED / 'code-review'))
        try:
            import review_app
        finally:
            sys.path.remove(str(BUNDLED / 'code-review'))
        with patch.dict(os.environ, {'PATH': self.environment['PATH'], 'FAKE_PRS': str(self.prs)}), \
                patch.object(review_app, 'github_remotes', return_value={'fixture/project': 'origin'}):
            view = review_app.other_pr(clone, self.url)
        self.assertEqual((view['number'], view['branch'], view['head'], view['base']), (8, 'other', self.other, self.main))
        self.assertEqual(self.git('rev-parse', '--abbrev-ref', 'HEAD', cwd=clone), 'main')
        self.assertIn('other.py', self.git('diff', '--name-only', view['base'], view['head'], cwd=clone))

    def test_remotes_are_matched_by_owner_and_name(self):
        sys.path.insert(0, str(BUNDLED / 'code-review'))
        try:
            import review_app
        finally:
            sys.path.remove(str(BUNDLED / 'code-review'))
        self.git('remote', 'add', 'fork', 'git@github.com:Someone/Project-Fork')
        self.git('remote', 'add', 'elsewhere', 'https://gitlab.com/fixture/project.git')
        self.assertEqual(review_app.github_remotes(self.repo), {'fixture/project': 'origin', 'someone/project-fork': 'fork'})


if __name__ == '__main__':
    unittest.main()
