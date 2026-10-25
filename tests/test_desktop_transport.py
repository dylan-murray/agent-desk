"""Desktop transport boundaries and recovery with real, disposable local fixtures."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import base64
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from agent_desk.local_transport import (UnixHTTPConnection, desk_url, desktop_id,
                                       endpoint_key, runtime_directory, workspace_key)

ROOT = Path(__file__).resolve().parents[1]


class IdentityTests(unittest.TestCase):
    def test_browser_and_desktop_identities_are_distinct(self):
        identity = secrets.token_hex(16)
        self.assertEqual(endpoint_key(desk_url(identity)), identity)
        self.assertEqual(endpoint_key(desk_url('1' * 32)), '1' * 32)
        self.assertEqual(endpoint_key(desk_url(4310)), 4310)
        for bad in ['../x', 'a' * 31, 'agent-desk://app', '0', '-1']:
            with self.assertRaises(ValueError):workspace_key(bad)
        with self.assertRaises(ValueError):desktop_id('agent-desk://user@' + identity)

    def test_socket_directory_rejects_shared_permissions_and_symlinks(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'run';root.mkdir(mode=0o755)
            with patch.dict(os.environ, AGENT_DESK_SOCKET_ROOT=str(root)):
                with self.assertRaises(PermissionError):runtime_directory(folder, 'a' * 32)
            root.rmdir();root.symlink_to(Path(folder))
            with patch.dict(os.environ, AGENT_DESK_SOCKET_ROOT=str(root)):
                with self.assertRaises(PermissionError):runtime_directory(folder, 'a' * 32)


class DesktopIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ad-', dir='/private/tmp' if sys.platform == 'darwin' else None)
        self.root = Path(self.temp.name).resolve();self.data = self.root / 'state';self.data.mkdir(mode=0o700)
        self.workspace = secrets.token_hex(16)
        self.env = dict(os.environ, AGENT_DESK_DATA_DIR=str(self.data), AGENT_DESK_SOCKET_ROOT=str(self.root / 's'), AGENT_DESK_WORKSPACE_ID=self.workspace)
        with patch.dict(os.environ, self.env):self.folder = runtime_directory(self.data, self.workspace)
        self.processes = [];self.log = (self.root / 'backend.log').open('ab')
        self.start()

    def start(self):
        process = subprocess.Popen([sys.executable, '-m', 'agent_desk.desktop_backend', '--workspace-id', self.workspace], cwd=ROOT, env=self.env, stdout=self.log, stderr=self.log)
        self.processes.append(process)
        def ready():
            if process.poll() is not None:self.fail((self.root / 'backend.log').read_text())
            try:
                self.record = json.loads((self.folder / 'connection.json').read_text())
                return self.request('/api/desktop/status')[0] == 200
            except (OSError, ValueError):return False
        self.until(ready)
        return process

    def until(self, predicate, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = predicate()
            if value:return value
            time.sleep(.05)
        self.fail('Desktop fixture timed out: ' + (self.root / 'backend.log').read_text())

    def request(self, route, payload=None, token='user', origin=None, bearer=None):
        connection = UnixHTTPConnection(self.folder / 'backend.sock', timeout=30)
        headers = {'Host': 'app', 'Content-Type': 'application/json'}
        if token == 'user':headers['X-Agent-Desk-Terminal'] = self.record['user_token']
        elif token:headers['X-Agent-Desk-Terminal'] = token
        if origin:headers['Origin'] = origin
        if bearer is not None:headers['Authorization'] = 'Bearer ' + bearer
        body = json.dumps(payload).encode() if payload is not None else None
        try:
            connection.request('POST' if body is not None else 'GET', route, body, headers)
            response = connection.getresponse();data = response.read()
            return response.status, json.loads(data) if data else None
        finally:connection.close()

    def tearDown(self):
        try:self.request('/api/desktop/shutdown', {})
        except (OSError, ValueError):pass
        for process in self.processes:
            if process.poll() is None:process.terminate()
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait()
        # Fixture-only emergency cleanup, authenticated to its own supervisor.
        try:
            from agent_desk.terminal_supervisor import SupervisorClient
            with patch.dict(os.environ, self.env):owner = SupervisorClient(self.data, self.workspace, start=False)
            for row in owner.list():
                if row['exit_code'] is None:owner.get(row['id']).stop()
            owner.shutdown()
        except (OSError, ValueError):pass
        self.log.close();self.temp.cleanup()

    def test_authentication_contexts_and_no_tcp_listener(self):
        self.assertEqual(self.request('/api/agents', token=None)[0], 403)
        helper = (self.data / ('.terminal-token-' + self.workspace)).read_text()
        self.assertEqual(self.request('/api/agents', token=helper)[0], 200)
        self.assertEqual(self.request('/api/desktop/status', token=helper)[0], 403)
        self.assertEqual(self.request('/api/terminal-auth')[0], 403)
        self.assertEqual(self.request('/api/agents', origin='https://hostile.example')[0], 403)
        self.assertEqual(self.request('/api/desktop/status')[1]['workspace'], self.workspace)
        pids = [str(self.processes[-1].pid)]
        with patch.dict(os.environ, self.env):
            from agent_desk.terminal_supervisor import SupervisorClient
            pids.append(str(SupervisorClient(self.data, self.workspace, start=False).call('hello')['pid']))
        if shutil.which('lsof'):
            result = subprocess.run(['lsof', '-nP', '-a', '-p', ','.join(pids), '-iTCP', '-sTCP:LISTEN'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1, result.stderr or result.stdout)
            self.assertEqual(result.stdout.strip(), '')

    def test_clean_shutdown_restart_allows_new_terminals_without_resume(self):
        self.assertEqual(self.request('/api/desktop/shutdown', {})[0], 200)
        self.processes[-1].wait(timeout=15)
        marker = self.data / 'desktop-shutdown.json'
        self.assertEqual(json.loads(marker.read_text())['state'], 'stopped')
        self.start()
        self.assertFalse(self.request('/api/desktop/status')[1]['paused'])
        self.assertFalse(marker.exists())
        code, result = self.request('/api/terminals/launch', {'cwd': str(self.root), 'argv': ['/bin/sh']})
        self.assertEqual(code, 200, result)

    def test_surviving_terminal_duplicate_owner_and_helper_requests(self):
        code, launched = self.request('/api/terminals/launch', {'cwd': str(self.root), 'argv': ['/bin/sh'], 'name': 'Desktop fixture'})
        self.assertEqual(code, 200, launched)
        identity = launched['id']
        owner_pid = None
        with patch.dict(os.environ, self.env):
            from agent_desk.terminal_supervisor import SupervisorClient
            owner_pid = SupervisorClient(self.data, self.workspace, start=False).call('hello')['pid']
        duplicate = subprocess.run([sys.executable, '-m', 'agent_desk.desktop_backend', '--workspace-id', self.workspace], cwd=ROOT, env=self.env, capture_output=True, timeout=10)
        self.assertNotEqual(duplicate.returncode, 0)
        self.processes[-1].terminate();self.processes[-1].wait(timeout=15)
        self.start()
        with patch.dict(os.environ, self.env):
            self.assertEqual(SupervisorClient(self.data, self.workspace, start=False).call('hello')['pid'], owner_pid)
        self.assertIn(identity, [row['id'] for row in self.request('/api/agents')[1]['agents']])
        helper = subprocess.run([sys.executable, str(ROOT / 'scripts/agent_control.py'), '--desk', desk_url(self.workspace), 'list'], cwd=self.root, env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(helper.returncode, 0, helper.stderr)
        self.assertIn(identity, helper.stdout)
        self.assertEqual(self.request('/api/terminals/input', {'id': identity, 'data': base64.b64encode(b'echo desktop-fixture-ok\n').decode()})[0], 200)
        self.until(lambda: 'desktop-fixture-ok' in base64.b64decode(self.request('/api/terminals/output?id='+identity+'&cursor=0')[1]['data']).decode(errors='replace'))

    def test_port_free_visual_tool_and_explicit_compatibility(self):
        from agent_desk.tool_runtime import ToolRuntime
        skills = self.root / 'skills';skill = skills / 'fixture';skill.mkdir(parents=True)
        shutil.copyfile(ROOT / 'tests/fixtures/desktop/tool.py', skill / 'tool.py')
        manifest = {'runtime': 'python-http', 'entrypoint': 'tool.py', 'target': 'none', 'transports': ['unix-http-v1']}
        (skill / 'agent-desk-ui.json').write_text(json.dumps(manifest))
        with patch.dict(os.environ, self.env), patch('agent_desk.tool_runtime.DATA_DIR', self.data):
            runtime = ToolRuntime(state=self.data / 'tool-runtime', roots=[skills])
            item = runtime.launch('fixture', None)
            try:
                self.assertEqual(item['transport'], 'unix-http-v1')
                connection = UnixHTTPConnection(item['socket']);connection.request('GET', '/');response = connection.getresponse()
                self.assertIn(b'Fixture review', response.read());connection.close()
                if shutil.which('lsof'):
                    result = subprocess.run(['lsof', '-nP', '-a', '-p', str(item['pid']), '-iTCP', '-sTCP:LISTEN'], capture_output=True, text=True)
                    self.assertEqual(result.returncode, 1, result.stderr or result.stdout)
                    self.assertEqual(result.stdout.strip(), '')
            finally:runtime.stop(item['id'])
            manifest.pop('transports');(skill / 'agent-desk-ui.json').write_text(json.dumps(manifest))
            self.assertEqual(runtime.catalog(), [])

    def test_readme_completion_forwards_body_and_authentication_without_redirects(self):
        from agent_desk.tool_runtime import ToolRuntime
        from agent_desk.readme_feedback import digest, file_digest, save_json, request_json
        from agent_desk.local_transport import urlopen
        from urllib.error import HTTPError
        from urllib.request import Request
        skills = self.root / 'skills'
        skill = skills / 'readme-review';skill.mkdir(parents=True)
        shutil.copyfile(ROOT / 'tests/fixtures/desktop/readme_annotate.py', skill / 'readme_annotate.py')
        doc = self.root / 'README.md';doc.write_text('# Fictional README\n\nOriginal sentence.\n')
        notes = [dict(id=1, kind='sentence', quote='Original sentence.', start=3, end=3,
                      section='Fictional README', comment='Clarify this sentence.', status='open')]
        doc.with_suffix('.notes.json').write_text(json.dumps(notes))
        with patch.dict(os.environ, self.env), patch('agent_desk.tool_runtime.DATA_DIR', self.data), patch('agent_desk.paths.DATA_DIR', self.data):
            runtime = ToolRuntime(self.data / 'tool-runtime', [skills])
            tool = runtime.launch('readme-review', str(doc))
            try:
                (self.data / 'skill-uis.json').write_text(json.dumps([dict(tool, agent_id='coordinator-fixture')]))
                identity = 'readme-' + digest(notes)
                snapshot = dict(state='sent', request_id=identity, tool_id=tool['id'], document=str(doc),
                                round=1, notes=notes, document_hash=file_digest(doc))
                saved = self.data / 'readme-feedback' / digest(str(doc)) / (identity + '.json')
                save_json(saved, snapshot)
                config = request_json(tool['url'] + '/desk-feedback/config')
                payload = dict(request_id=identity, ids=[1])
                with self.assertRaisesRegex(ValueError, 'token required'):
                    request_json(tool['url'] + '/desk-feedback/complete', payload)
                command = [sys.executable, str(ROOT / 'scripts/complete_readme_feedback.py'), '--snapshot', str(saved), '--ids', '1']
                unchanged = subprocess.run(command, env=self.env, capture_output=True, text=True, timeout=10)
                self.assertNotEqual(unchanged.returncode, 0)
                self.assertIn('has not changed', unchanged.stderr)
                doc.write_text('# Fictional README\n\nClarified sentence.\n')
                completed = subprocess.run(command, env=self.env, capture_output=True, text=True, timeout=10)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertIn('Marked done: 1', completed.stdout)
                stored = request_json(tool['url'] + '/state')['annotations']
                self.assertEqual(stored, [dict(notes[0], status='addressed')])
                with self.assertRaises(HTTPError) as redirect:
                    urlopen(Request(tool['url'] + '/redirect', headers={'X-Readme-Feedback': config['token']}))
                self.assertEqual(redirect.exception.code, 302)
                redirect.exception.close()
                # A registry record cannot move the connection outside its workspace.
                item = runtime.read(tool['id']);item['socket'] = str(self.root / 'foreign.sock')
                runtime.save(item)
                with self.assertRaises(OSError):request_json(tool['url'] + '/state')
            finally:runtime.stop(tool['id'])

    def test_forced_workflow_stop_includes_command_children(self):
        unrelated = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(120)'])
        self.addCleanup(lambda: (unrelated.terminate(), unrelated.wait()))
        code, config = self.request('/api/workflows/save-config', {
            'name': 'Resistant fixture', 'kind': 'command', 'cwd': str(self.root),
            'argv': [sys.executable, '-c', 'import os,pathlib,signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);pathlib.Path("command-pid").write_text(str(os.getpid()));time.sleep(120)'], 'timeout': 180,
        })
        self.assertEqual(code, 200, config)
        code, run = self.request('/api/workflows/launch', {'id': config['id']})
        self.assertEqual(code, 200, run)
        worker = self.until(lambda: next((row for row in self.request('/api/workflows')[1]['executions']
                                         if row['id'] == run['id'] and row['state'] == 'running'), None))
        self.until(lambda: (self.root / 'command-pid').exists())
        command_pid = int((self.root / 'command-pid').read_text())
        os.kill(worker['pid'], signal.SIGSTOP)
        code, result = self.request('/api/desktop/shutdown', {})
        self.assertEqual(code, 200, result)
        self.assertTrue(result['stopped'])
        self.processes[-1].wait(timeout=15)
        from agent_desk.managed_processes import processes
        self.assertNotIn(worker['pid'], processes())
        self.assertNotIn(command_pid, processes())
        self.assertIsNone(unrelated.poll())

    def test_shutdown_waits_for_external_tool_launch_and_forces_resistant_tool(self):
        skills = self.root / 'skills';skill = skills / 'slow';skill.mkdir(parents=True)
        prefix = ('import os,pathlib,signal,time\n'
                  'signal.signal(signal.SIGTERM,signal.SIG_IGN)\n'
                  'pathlib.Path(__file__).with_suffix(".starting").write_text(str(os.getpid()))\n'
                  'time.sleep(2)\n')
        (skill / 'tool.py').write_text(prefix + (ROOT / 'tests/fixtures/desktop/tool.py').read_text())
        (skill / 'agent-desk-ui.json').write_text(json.dumps(dict(runtime='python-http', entrypoint='tool.py', target='none', transports=['unix-http-v1'])))
        launcher = subprocess.Popen([sys.executable, '-c',
            'import sys;from agent_desk.tool_runtime import ToolRuntime;ToolRuntime(roots=[__import__("pathlib").Path(sys.argv[1])]).launch("slow",None)', str(skills)], cwd=ROOT, env=self.env, stdout=self.log, stderr=self.log)
        self.processes.append(launcher)
        self.until(lambda: (skill / 'tool.starting').exists())
        pid = int((skill / 'tool.starting').read_text())
        backend = self.processes[0]
        with ThreadPoolExecutor(max_workers=1) as pool:
            stop = pool.submit(self.request, '/api/desktop/shutdown', {})
            self.until(lambda: self.request('/api/desktop/status')[1]['paused'])
            self.assertFalse(stop.done(), 'shutdown waits for the launch lock')
            self.assertEqual(self.request('/api/terminals/launch', {'cwd': str(self.root), 'argv': ['/bin/sh']})[0], 409)
            code, result = stop.result(timeout=20)
        self.assertEqual(code, 200, result)
        launcher.wait(timeout=5);self.assertEqual(launcher.returncode, 0)
        backend.wait(timeout=15)
        from agent_desk.managed_processes import processes
        self.assertNotIn(pid, processes())
        records = [json.loads(p.read_text()) for p in (self.data / 'tool-runtime').glob('*.json')]
        self.assertTrue(records and all(row.get('stopped') for row in records))

    def test_source_tokens_authenticate_webhooks_without_desktop_token(self):
        code, source = self.request('/api/event-bus/save-source', dict(name='Fictional adapter', kind='webhook', settings={}))
        self.assertEqual(code, 200, source)
        details = source['connection']
        self.assertEqual(details, dict(workspace=desk_url(self.workspace), socket=str(self.folder / 'backend.sock'), url='http://app/api/event-bus/webhook/' + source['id']))
        route = '/api/event-bus/webhook/' + source['id']
        submit = lambda event='one', token=source['token'], **extra: self.request(route, dict(id=event, payload={'type': 'message'}), token=None, bearer=token, **extra)
        self.assertEqual(submit(token='invalid')[0], 403)
        self.assertEqual(submit(origin='https://foreign.example')[0], 403)
        self.request('/api/event-bus/toggle-source', dict(id=source['id'], enabled=True))
        self.assertEqual(submit()[0], 202)
        self.assertEqual(submit()[0], 200)
        self.assertTrue(submit()[1]['duplicate'])
        rotated = self.request('/api/event-bus/rotate-token', dict(id=source['id']))[1]
        self.assertEqual(rotated['connection'], details)
        self.assertEqual(submit('old')[0], 403)
        self.assertEqual(submit('new', token=rotated['token'])[0], 202)
        # Persist an incomplete pause, then restart the same backend build.
        (self.data / 'desktop-shutdown.json').write_text('{"state":"incomplete"}')
        self.processes[-1].terminate();self.processes[-1].wait(timeout=15)
        self.start()
        self.assertTrue(self.request('/api/desktop/status')[1]['paused'])
        self.assertEqual(submit('paused', token=rotated['token'])[0], 409)
        self.assertEqual(submit('paused', token='invalid')[0], 403)
        self.assertEqual(self.request('/api/desktop/resume', {})[0], 200)
        self.assertEqual(submit('resumed', token=rotated['token'])[0], 202)

    def test_unverified_worker_stays_paused_and_unrelated_process_survives(self):
        unrelated = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(120)'])
        self.addCleanup(lambda: (unrelated.terminate(), unrelated.wait()))
        identity = secrets.token_hex(12)
        with closing(sqlite3.connect(self.data / 'workflows.sqlite3')) as db, db:
            db.execute('INSERT INTO executions(id,config_id,payload,state,pid,detail,created) VALUES(?,?,?,?,?,?,?)',
                       (identity, 'fixture', '{"name":"Fictional worker","kind":"command"}', 'running', unrelated.pid, '', time.time()))
        code, result = self.request('/api/desktop/shutdown', {})
        self.assertEqual(code, 409, result)
        self.assertFalse(result['stopped']);self.assertIsNone(unrelated.poll())
        self.assertTrue(self.request('/api/desktop/status')[1]['paused'])
        self.processes[-1].terminate();self.processes[-1].wait(timeout=15)
        self.start()
        state = self.request('/api/desktop/status')[1]
        self.assertTrue(state['paused'])
        self.assertIn(identity, [row['id'] for row in state['executions']])
        with closing(sqlite3.connect(self.data / 'workflows.sqlite3')) as db, db:
            db.execute("UPDATE executions SET state='cancelled',detail='' WHERE id=?", (identity,))

    def test_resistant_authenticated_idle_supervisor_is_forced(self):
        from agent_desk.terminal_supervisor import SupervisorClient
        from agent_desk.managed_processes import processes
        with patch.dict(os.environ, self.env):
            owner = SupervisorClient(self.root / 'secondary', self.workspace)
        pid = owner.call('hello')['pid']
        original = owner.call
        def call(operation, **fields):
            if operation == 'shutdown':
                os.kill(pid, signal.SIGSTOP)
                raise TimeoutError('Fixture supervisor stopped responding')
            return original(operation, **fields)
        with patch.object(owner, 'call', side_effect=call):owner.shutdown()
        self.assertNotIn(pid, processes())
