import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from agent_desk import readouts, server, tool_registration
from agent_desk.terminals import PANE_BIN, TerminalManager
from account_fixtures import use_accounts

TOOL_SERVER = Path(readouts.__file__).with_name('tool_server.py')


def setUpModule():
    use_accounts()


class ReadoutTests(unittest.TestCase):
    def setUp(self):
        self.manager = TerminalManager()
        self.temp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.manager.close()
        self.temp.cleanup()

    def launch(self, argv=('/bin/sh',)):
        return self.manager.launch(dict(cwd=self.temp.name, argv=list(argv), name='Test shell'))

    def wait_for(self, session, expected):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            data = base64.b64decode(session.output(0)['data']).decode(errors='replace')
            if expected in data:
                return data
            time.sleep(.03)
        self.fail(f'Missing {expected!r} in {data!r}')

    def send(self, session, text):
        session.send(dict(op='input', data=base64.b64encode(text.encode()).decode()))

    def pane_env(self, session, desk='http://127.0.0.1:9'):
        # This test process stands in for the pane's root: the commands it runs descend from it.
        return dict(os.environ, AGENT_DESK_TERMINAL_ID=session.id, AGENT_DESK_PANE_TOKEN=session.pane_token, AGENT_DESK_PANE_PID=str(os.getpid()),
                    AGENT_DESK_URL=desk, AGENT_DESK_READOUTS_DIR=self.manager.readouts_dir)

    def cli(self, *args, env=None, stdin=None):
        return subprocess.run([sys.executable, str(PANE_BIN / 'agent-desk-readout'), *args], env=env, input=stdin,
                              capture_output=True, text=True, timeout=10)

    def test_pane_process_sets_readouts_on_its_own_pane_only(self):
        http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        self.manager.desk = f'http://127.0.0.1:{http.server_port}'
        try:
            with patch.object(server, 'TERMINALS', self.manager):
                one, two = self.launch(), self.launch()
                # Exactly what a loop script runs inside the pane.
                self.send(one, "agent-desk-readout set 'Done=412:good' Queue=4 'Last run=10:35' 'Failure rate=1.2%:bad' --ttl 15m && echo set-$?\n")
                self.wait_for(one, 'set-0')
                shown = one.info()['readouts']
                self.assertEqual(shown['fields'], [dict(label='Done', value='412', tone='good'), dict(label='Queue', value='4', tone='neutral'),
                                                   dict(label='Last run', value='10:35', tone='neutral'), dict(label='Failure rate', value='1.2%', tone='bad')])
                self.assertEqual(shown['ttl_seconds'], 900)
                self.assertLess(shown['age'], 5)
                self.assertIsNone(two.info()['readouts'])
                with urlopen(f'{self.manager.desk}/api/agents') as response:
                    listed = {a['id']: a for a in json.load(response)['agents']}
                self.assertEqual(listed[one.id]['readouts']['fields'][0]['value'], '412')
                self.assertNotIn('pane_token', json.dumps(listed[one.id]))
                # A quoted heredoc keeps $ and : away from the shell.
                self.send(one, "agent-desk-readout set --json <<'EOF'\n{\"fields\": [{\"label\": \"Cash\", \"value\": \"$9:30\"}], \"ttl_seconds\": 60}\nEOF\necho json-$?\n")
                self.wait_for(one, 'json-0')
                self.assertEqual(one.info()['readouts']['fields'], [dict(label='Cash', value='$9:30', tone='neutral')])
                # Another pane's token, a forged id, or the desk-wide tokens cannot write here.
                self.send(two, f'AGENT_DESK_TERMINAL_ID={one.id} agent-desk-readout set Hijacked=yes; echo hijack-$?\n')
                self.assertIn('Invalid pane token', self.wait_for(two, 'hijack-1'))
                for token in (two.pane_token, server.TOKEN, server.TERMINAL_TOKEN, ''):
                    with self.assertRaises(HTTPError) as caught:
                        urlopen(Request(self.manager.desk + '/api/readouts', data=json.dumps(dict(id=one.id, fields=[])).encode(),
                                        headers={'Authorization': 'Bearer ' + token}))
                    self.assertEqual(caught.exception.code, 403)
                    caught.exception.close()
                with self.assertRaises(HTTPError) as caught:
                    urlopen(Request(self.manager.desk + '/api/readouts', data=json.dumps(dict(id=one.id, fields=[])).encode(),
                                    headers={'Authorization': 'Bearer ' + one.pane_token, 'Origin': 'https://evil.example'}))
                self.assertEqual(caught.exception.code, 403)
                caught.exception.close()
                self.assertEqual(one.info()['readouts']['fields'][0]['label'], 'Cash')
                # Rejections reach the caller as a non-zero exit with the reason, never silently.
                self.send(one, 'agent-desk-readout set "=empty"; echo invalid-$?\n')
                self.assertIn('Labels must be non-empty', self.wait_for(one, 'invalid-1'))
                self.send(one, 'agent-desk-readout clear && echo clear-$?\n')
                self.wait_for(one, 'clear-0')
                self.assertIsNone(one.info()['readouts'])
                one.stop()
                with self.assertRaises(HTTPError) as caught:
                    urlopen(Request(self.manager.desk + '/api/readouts', data=json.dumps(dict(id='terminal-missing', fields=[])).encode(),
                                    headers={'Authorization': 'Bearer ' + one.pane_token}))
                self.assertEqual(caught.exception.code, 404)
                caught.exception.close()
        finally:
            http.shutdown()
            http.server_close()
            thread.join()

    def test_cli_reads_json_and_explains_when_outside_a_pane(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith('AGENT_DESK_')}
        result = self.cli('set', 'A=1', env=env)
        self.assertEqual(result.returncode, 2)
        self.assertIn('not running inside an Agent Desk pane', result.stderr)
        env.update(AGENT_DESK_TERMINAL_ID='terminal-0123456789abcdef', AGENT_DESK_PANE_TOKEN='t', AGENT_DESK_URL='http://127.0.0.1:9',
                   AGENT_DESK_PANE_PID=str(os.getpid()), AGENT_DESK_READOUTS_DIR='/nonexistent')
        result = self.cli('set', '--json', env=env, stdin='[1]')
        self.assertEqual(result.returncode, 2)
        self.assertIn('must be a JSON object', result.stderr)

    def test_sandboxed_cli_hands_off_through_the_private_folder(self):
        # Codex's workspace-write sandbox fails every connect, loopback included, with EPERM.
        # An unreachable desk exercises the same path: validate here, then hand off on disk.
        session = self.launch()
        env, folder = self.pane_env(session), Path(self.manager.readouts_dir)
        result = self.cli('set', 'Done=5:good', 'Runs=3', '--ttl', '1m', env=env)
        self.assertEqual((result.returncode, result.stderr), (0, ''))
        dropped = folder / (session.id + '.json')
        self.assertEqual(oct(os.stat(folder).st_mode & 0o777), '0o700')
        self.assertEqual(oct(os.stat(dropped).st_mode & 0o777), '0o600')
        self.assertIsNone(session.info()['readouts'])
        listed = {a['id']: a for a in self.manager.list()}
        self.assertEqual(listed[session.id]['readouts']['fields'], [dict(label='Done', value='5', tone='good'), dict(label='Runs', value='3', tone='neutral')])
        self.assertEqual(listed[session.id]['readouts']['ttl_seconds'], 60)
        self.assertFalse(dropped.exists())
        # Invalid values are rejected before anything is written, with the same message as HTTP.
        result = self.cli('set', '=nolabel', env=env)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Labels must be non-empty', result.stderr)
        self.assertEqual(list(folder.iterdir()), [])
        # A file with another pane's token, an older one than the last set, or junk changes nothing.
        other = self.launch()
        dropped.write_text(json.dumps(dict(token=other.pane_token, fields=[dict(label='Hijacked', value='yes')])))
        with self.assertLogs(level='WARNING'):
            self.manager.list()
        dropped.write_text(json.dumps(dict(token=session.pane_token, fields=[dict(label='Old', value='1')])))
        os.utime(dropped, (time.time() - 60, time.time() - 60))
        self.manager.list()
        dropped.write_text('{not json')
        with self.assertLogs(level='WARNING'):
            self.manager.list()
        self.assertFalse(dropped.exists(), 'an invalid file must be consumed, not retried forever')
        os.mkfifo(dropped)
        self.manager.list()  # a FIFO must not block the poll
        self.assertFalse(dropped.exists())
        self.assertEqual(session.info()['readouts']['fields'][0]['label'], 'Done')
        # A folder another user could enter is refused rather than trusted.
        os.chmod(folder, 0o755)
        result = self.cli('set', 'A=1', env=env)
        self.assertEqual(result.returncode, 1)
        self.assertIn('not a private directory', result.stderr)
        with self.assertLogs(level='WARNING'):
            self.manager.list()
        os.chmod(folder, 0o700)
        # Each desk has its own folder, removed when the desk shuts down.
        other_desk = TerminalManager()
        self.assertNotEqual(other_desk.readouts_folder(), str(folder))
        self.assertEqual(Path(other_desk.readouts_dir).parent, folder.parent)
        other_desk.close()
        self.assertFalse(Path(other_desk.readouts_dir).exists())
        self.manager.close()
        self.assertFalse(folder.exists())
        self.manager.list()  # a poll after close must not recreate it
        self.assertFalse(folder.exists())

    def test_a_process_outside_the_pane_cannot_write_to_it(self):
        # Codex's shared background service starts tool servers and commands with the environment of
        # whichever pane first started it. They must refuse, not write to that other pane.
        session = self.launch()
        self.wait_for(session, '$')
        env = dict(self.pane_env(session), AGENT_DESK_PANE_PID=str(session.process.pid))  # a pane this test does not run in
        result = self.cli('set', 'A=1', env=env)
        self.assertEqual(result.returncode, 2)
        self.assertIn('codex --no-daemon', result.stderr)
        self.assertEqual(os.listdir(self.manager.readouts_dir), [])
        # A partial identity (a pane from before this Agent Desk, or a stale service) explains itself too.
        partial = {k: v for k, v in self.pane_env(session).items() if k != 'AGENT_DESK_PANE_PID'}
        result = self.cli('set', 'A=1', env=partial)
        self.assertEqual(result.returncode, 2)
        self.assertIn('missing AGENT_DESK_PANE_PID', result.stderr)
        self.assertIn('restart Agent Desk', result.stderr)

    def test_validation(self):
        self.assertIsNone(readouts.validate(dict(fields=[])))
        clean = readouts.validate(dict(fields=[dict(label=' Count ', value=3), dict(label='Ratio', value=0.5, tone='warn')], ttl_seconds=60))
        self.assertEqual(clean['fields'], [dict(label='Count', value='3', tone='neutral'), dict(label='Ratio', value='0.5', tone='warn')])
        for payload in (dict(), dict(fields='x'), dict(fields=[dict(label='a', value='1')] * 9),
                        dict(fields=[dict(label='a', value='1'), dict(label='a ', value='2')]),
                        dict(fields=[dict(label='a', value='1', tone='red')]), dict(fields=[dict(label='a', value='1', extra=1)]),
                        dict(fields=[dict(label='a', value='x' * 65)]), dict(fields=[dict(label='a', value='\x1b[31m')]),
                        dict(fields=[dict(label='a', value=True)]), dict(fields=[dict(label='a', value=float('nan'))]),
                        dict(fields=[dict(label='a', value='1')], ttl_seconds=1), dict(fields=[dict(label='a', value='1')], ttl_seconds='15m')):
            with self.assertRaises(ValueError, msg=payload):
                readouts.validate(payload)

    def test_pane_environment_replaces_inherited_desk_identity(self):
        probe = "import os; print('{tag}', os.environ['AGENT_DESK_TERMINAL_ID'], os.environ.get('AGENT_DESK_URL'), os.environ.get('AGENT_DESK_READOUTS_DIR'), os.environ['PATH'].split(os.pathsep)[0])"
        session = self.launch([sys.executable, '-c', probe.format(tag='env')])
        with patch.dict('os.environ', {'AGENT_DESK_TERMINAL_ID': 'terminal-outer', 'AGENT_DESK_URL': 'http://127.0.0.1:1', 'AGENT_DESK_READOUTS_DIR': '/elsewhere'}):
            nested = self.launch([sys.executable, '-c', probe.format(tag='nested')])
        self.assertIn(f'env {session.id} None {self.manager.readouts_dir} {PANE_BIN}', self.wait_for(session, f'env {session.id}'))
        self.assertIn(f'nested {nested.id} None {self.manager.readouts_dir}', self.wait_for(nested, 'nested'))


class SupervisorReadoutTests(unittest.TestCase):
    """Production shape: the web backend talks to panes owned by the separate terminal supervisor."""

    def setUp(self):
        from agent_desk.terminal_supervisor import SupervisorClient
        self.temp = tempfile.TemporaryDirectory(prefix='desk-readouts-')
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.desk = f'http://127.0.0.1:{self.http.server_port}'
        # The supervisor gives its panes the URL of the backend on the same port.
        self.client = SupervisorClient(Path(self.temp.name), self.http.server_port)
        self.patch = patch.object(server, 'TERMINALS', self.client)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        try:
            for item in self.client.list():
                self.client.get(item['id']).stop()
            self.client.shutdown()
            deadline = time.monotonic() + 10
            while (self.client.folder / 'rpc.sock').exists() and time.monotonic() < deadline:
                time.sleep(.05)
        finally:
            self.http.shutdown()
            self.http.server_close()
            self.thread.join()
            self.temp.cleanup()

    def wait_for(self, session, expected):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            data = base64.b64decode(session.output(0)['data']).decode(errors='replace')
            if expected in data:
                return data
            time.sleep(.05)
        self.fail(f'Missing {expected!r} in {data!r}')

    def send(self, session, text):
        session.send(dict(op='input', data=base64.b64encode(text.encode()).decode()))

    def test_panes_owned_by_the_supervisor_set_readouts(self):
        session = self.client.launch(dict(cwd=self.temp.name, argv=['/bin/sh'], name='Supervised'))
        self.send(session, "agent-desk-readout set 'Build & test=412 passed:good' 'Open jobs=2' --ttl 12m && echo over-http-$?\n")
        self.wait_for(session, 'over-http-0')
        rows = {row['id']: row for row in self.client.list()}
        self.assertEqual(rows[session.id]['readouts']['fields'][0], dict(label='Build & test', value='412 passed', tone='good'))
        self.assertEqual(rows[session.id]['readouts']['ttl_seconds'], 720)
        # A wrong token is still a 403 after crossing the supervisor socket, not a 500.
        with self.assertRaises(HTTPError) as caught:
            urlopen(Request(self.desk + '/api/readouts', data=json.dumps(dict(id=session.id, fields=[])).encode(), headers={'Authorization': 'Bearer wrong'}))
        self.assertEqual(caught.exception.code, 403)
        caught.exception.close()
        # The sandbox hand-off folder belongs to the supervisor too, and its list() collects it.
        self.send(session, "AGENT_DESK_URL=http://127.0.0.1:9 agent-desk-readout set Handoff=yes && echo handoff-$?\n")
        self.wait_for(session, 'handoff-0')
        rows = {row['id']: row for row in self.client.list()}
        self.assertEqual(rows[session.id]['readouts']['fields'], [dict(label='Handoff', value='yes', tone='neutral')])
        with urlopen(self.desk + '/api/agents') as response:
            listed = {a['id']: a for a in json.load(response)['agents']}
        self.assertEqual(listed[session.id]['readouts']['fields'][0]['label'], 'Handoff')


class ToolServerTests(unittest.TestCase):
    """The agent-desk tool server, spoken to over stdio exactly as Claude Code and Codex do."""

    def converse(self, env, *messages):
        process = subprocess.run([sys.executable, '-I', '-S', str(TOOL_SERVER)], env=env, capture_output=True, text=True, timeout=10,
                                 input=''.join(json.dumps(m) + '\n' for m in messages))
        self.assertEqual(process.returncode, 0, process.stderr)
        return {reply['id']: reply for reply in map(json.loads, process.stdout.splitlines())}

    def handshake(self, *messages):
        return [dict(jsonrpc='2.0', id=1, method='initialize', params=dict(protocolVersion='2025-06-18', capabilities={}, clientInfo=dict(name='test', version='1'))),
                dict(jsonrpc='2.0', method='notifications/initialized'), dict(jsonrpc='2.0', id=2, method='tools/list'), *messages]

    def test_offers_nothing_outside_a_pane(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith('AGENT_DESK_')}
        replies = self.converse(env, *self.handshake(dict(jsonrpc='2.0', id=3, method='tools/call', params=dict(name='set_readouts', arguments=dict(fields=[]))),
                                                     dict(jsonrpc='2.0', id=4, method='resources/list')))
        self.assertEqual(replies[1]['result']['serverInfo']['name'], 'agent-desk')
        self.assertEqual(replies[1]['result']['protocolVersion'], '2025-06-18')
        self.assertEqual(replies[2]['result']['tools'], [])
        self.assertTrue(replies[3]['result']['isError'])
        self.assertEqual(replies[4]['error']['code'], -32601)
        self.assertEqual(len(replies), 4, 'notifications get no reply')

    def test_agent_sets_readouts_on_the_pane_it_runs_in(self):
        manager, temp = TerminalManager(), tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.addCleanup(manager.close)
        session = manager.launch(dict(cwd=temp.name, argv=['/bin/sh'], name='Agent'))
        env = dict(os.environ, AGENT_DESK_TERMINAL_ID=session.id, AGENT_DESK_PANE_TOKEN=session.pane_token, AGENT_DESK_PANE_PID=str(os.getpid()),
                   AGENT_DESK_READOUTS_DIR=manager.readouts_dir)
        fields = [dict(label='Build & test', value='412 passed', tone='good'), dict(label='Open jobs', value='2')]
        replies = self.converse(env, *self.handshake(
            dict(jsonrpc='2.0', id=3, method='tools/call', params=dict(name='set_readouts', arguments=dict(fields=fields, ttl_seconds=720))),
            dict(jsonrpc='2.0', id=4, method='tools/call', params=dict(name='set_readouts', arguments=dict(fields=[dict(label='', value='x')])))))
        tool = replies[2]['result']['tools'][0]
        self.assertEqual(tool['name'], 'set_readouts')
        self.assertEqual(tool['inputSchema']['required'], ['fields'])
        self.assertIn('Replaces what is shown', tool['description'])
        self.assertLess(len(json.dumps(tool, separators=(',', ':'))), 520, 'sent with every request; keep it short')
        self.assertNotIn('isError', replies[3]['result'])
        self.assertEqual(replies[3]['result']['content'], [dict(type='text', text='Shown.')])
        self.assertTrue(replies[4]['result']['isError'])
        self.assertIn('Labels must be non-empty', replies[4]['result']['content'][0]['text'])
        shown = {a['id']: a for a in manager.list()}[session.id]['readouts']
        self.assertEqual(shown['fields'], [dict(fields[0]), dict(fields[1], tone='neutral')])
        self.assertEqual(shown['ttl_seconds'], 720)
        # Clearing through the tool removes the row.
        cleared = self.converse(env, *self.handshake(dict(jsonrpc='2.0', id=3, method='tools/call', params=dict(name='set_readouts', arguments=dict(fields=[])))))
        self.assertEqual(cleared[3]['result']['content'][0]['text'], 'Cleared.')
        self.assertIsNone({a['id']: a for a in manager.list()}[session.id]['readouts'])

    def test_a_server_started_outside_the_pane_explains_instead_of_writing(self):
        manager, temp = TerminalManager(), tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.addCleanup(manager.close)
        session = manager.launch(dict(cwd=temp.name, argv=['/bin/sh'], name='Agent'))
        call = dict(jsonrpc='2.0', id=3, method='tools/call', params=dict(name='set_readouts', arguments=dict(fields=[dict(label='A', value='1')])))
        # Not inherited from a desk pane these tests may themselves run in.
        outside = {k: v for k, v in os.environ.items() if not k.startswith('AGENT_DESK_')}
        for env in (dict(outside, AGENT_DESK_TERMINAL_ID=session.id, AGENT_DESK_PANE_TOKEN=session.pane_token,
                         AGENT_DESK_PANE_PID=str(session.process.pid), AGENT_DESK_READOUTS_DIR=manager.readouts_dir),
                    # What the user hit: a long-running Codex service with an older pane's partial identity.
                    dict(outside, AGENT_DESK_TERMINAL_ID=session.id, AGENT_DESK_PANE_TOKEN=session.pane_token)):
            replies = self.converse(env, *self.handshake(call))
            self.assertEqual([t['name'] for t in replies[2]['result']['tools']], ['set_readouts'], 'offered, so the agent can say why it failed')
            self.assertTrue(replies[3]['result']['isError'])
            self.assertIn('--no-daemon', replies[3]['result']['content'][0]['text'])
        self.assertIn('missing AGENT_DESK_PANE_PID, AGENT_DESK_READOUTS_DIR', replies[3]['result']['content'][0]['text'])
        self.assertEqual(os.listdir(manager.readouts_dir), [])
        self.assertIsNone({a['id']: a for a in manager.list()}[session.id]['readouts'])

    def test_stays_cheap_to_start(self):
        # Imports nothing beyond the few stdlib modules readouts needs; every agent session starts one copy.
        code = f"import sys; sys.argv=['x']; sys.path.insert(0, {str(TOOL_SERVER.parent)!r}); import readouts; print(sorted(m for m in sys.modules if m in ('subprocess', 'pathlib', 'tempfile', 'urllib', 'agent_desk')))"
        result = subprocess.run([sys.executable, '-I', '-S', '-c', code], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.stdout.strip(), '[]')


class RetireTests(unittest.TestCase):
    """Removing earlier account-wide registrations, against a throwaway home with a stand-in claude command."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name) / 'home'
        for folder in ('.claude', '.claude-personal', '.codex', '.codex-personal'):
            (self.home / folder).mkdir(parents=True)
        bin_dir = Path(self.temp.name) / 'bin'
        bin_dir.mkdir()
        # Records where `claude mcp add/remove` would write, the way the real CLI does.
        fake = bin_dir / 'claude'
        fake.write_text(f'''#!{sys.executable}
import json, os, sys
config = os.path.join(os.environ['CLAUDE_CONFIG_DIR'], '.claude.json') if os.environ.get('CLAUDE_CONFIG_DIR') else os.path.join(os.environ['HOME'], '.claude.json')
data = json.load(open(config)) if os.path.exists(config) else {{}}
servers = data.setdefault('mcpServers', {{}})
args = sys.argv[1:]
if args[:2] == ['mcp', 'add']:
    name = args[4]; command = args[args.index('--') + 1:]
    servers[name] = dict(type='stdio', command=command[0], args=command[1:], env={{}})
elif args[:2] == ['mcp', 'remove']:
    if args[4] not in servers: sys.exit('No user-scoped MCP server found with name: ' + args[4])
    del servers[args[4]]
json.dump(data, open(config, 'w'))
''')
        fake.chmod(0o755)
        self.env = patch.dict('os.environ', PATH=str(bin_dir) + os.pathsep + os.environ['PATH'])
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def register_like_earlier_versions(self):
        """The account-wide entries earlier versions wrote: a user-scope claude server plus allow rule, a marked Codex table."""
        server = tool_registration.command()
        for folder, config in (('.claude', self.home / '.claude.json'), ('.claude-personal', self.home / '.claude-personal' / '.claude.json')):
            config.write_text(json.dumps(dict(mcpServers={'agent-desk': dict(type='stdio', command='/old/python', args=['-I', '-S', '/old/agent_desk/tool_server.py'], env={})})))
            (self.home / folder / 'settings.json').write_text(json.dumps(dict(permissions=dict(allow=['Bash(ls:*)', tool_registration.TOOL]), theme='dark')))
        for folder in ('.codex', '.codex-personal'):
            block = '\n'.join([tool_registration.BEGIN, '[mcp_servers.agent-desk]', 'command = ' + json.dumps(server[0]),
                               'args = ' + json.dumps(server[1:]), 'env_vars = ' + json.dumps(tool_registration.ENV_VARS), tool_registration.END])
            (self.home / folder / 'config.toml').write_text('model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n\n' + block + '\n')

    def test_startup_removes_only_the_account_wide_entries_agent_desk_wrote(self):
        # Readouts are opt in per terminal, so account-wide registrations from earlier versions are retired.
        self.register_like_earlier_versions()
        theirs = '[mcp_servers.agent-desk]\ncommand = "/their/server"\n'
        (self.home / '.codex-personal' / 'config.toml').write_text(theirs)
        result = tool_registration.retire(self.home, {})
        self.assertEqual(result['errors'], [])
        self.assertEqual(sorted(result['removed']), ['Claude Code', 'Claude Code · Personal', 'Codex'])
        for config in (self.home / '.claude.json', self.home / '.claude-personal' / '.claude.json'):
            self.assertNotIn('agent-desk', json.loads(config.read_text())['mcpServers'])
        settings = json.loads((self.home / '.claude' / 'settings.json').read_text())
        self.assertEqual(settings['permissions']['allow'], ['Bash(ls:*)'])
        self.assertEqual(settings['theme'], 'dark')
        codex = tomllib.loads((self.home / '.codex' / 'config.toml').read_text())
        self.assertNotIn('agent-desk', codex['mcp_servers'])
        self.assertEqual(codex['mcp_servers']['other'], dict(command='other'))
        self.assertEqual(codex['model'], 'gpt-5')
        self.assertEqual((self.home / '.codex-personal' / 'config.toml').read_text(), theirs, 'an entry Agent Desk did not write stays')
        self.assertEqual(tool_registration.retire(self.home, {}), dict(removed=[], errors=[]), 'nothing left to remove on the next start')

    def test_a_claude_server_named_agent_desk_that_is_not_ours_stays(self):
        config = self.home / '.claude.json'
        config.write_text(json.dumps(dict(mcpServers={'agent-desk': dict(type='stdio', command='/their/server', args=['--serve'])})))
        self.assertEqual(tool_registration.retire(self.home, {})['removed'], [])
        self.assertIn('agent-desk', json.loads(config.read_text())['mcpServers'])


class ReadoutLaunchTests(unittest.TestCase):
    """Readouts are chosen per terminal: only that agent's command line gets the tool server."""

    lic = staticmethod(lambda word, *args: ['/bin/zsh', '-lic', word + ' "$@"', 'agent-desk', *args])

    def test_claude_gets_the_server_and_its_allow_rule_before_its_own_arguments(self):
        argv = tool_registration.with_readouts(self.lic('claude-personal', '--resume', 'abc'))
        self.assertEqual(argv[:4], self.lic('claude-personal'))
        self.assertEqual(argv[4], '--mcp-config')
        server = json.loads(argv[5])['mcpServers']['agent-desk']
        self.assertEqual([server['command'], *server['args']], tool_registration.command())
        # --mcp-config is variadic; a single-valued flag after it keeps the prompt or --resume from being swallowed.
        self.assertEqual(argv[6:8], ['--settings', json.dumps({'permissions': {'allow': [tool_registration.TOOL]}})])
        self.assertEqual(argv[8:], ['--resume', 'abc'])
        direct = tool_registration.with_readouts(['/usr/local/bin/claude', 'Fix the bug'])
        self.assertEqual((direct[0], direct[1], direct[-1]), ('/usr/local/bin/claude', '--mcp-config', 'Fix the bug'))

    def test_codex_gets_the_server_with_the_pane_variables_it_must_forward(self):
        argv = tool_registration.with_readouts(self.lic('codex', 'Write tests'))
        overrides = dict(flag.split('=', 1) for flag in argv[5:10:2])
        self.assertEqual(argv[4:10:2], ['-c', '-c', '-c'])
        self.assertEqual(json.loads(overrides['mcp_servers.agent-desk.command']), tool_registration.command()[0])
        self.assertEqual(json.loads(overrides['mcp_servers.agent-desk.args']), tool_registration.command()[1:])
        self.assertEqual(json.loads(overrides['mcp_servers.agent-desk.env_vars']), list(readouts.IDENTITY))
        self.assertEqual(argv[-1], 'Write tests')

    def test_other_agents_and_shells_are_refused(self):
        for argv in (['/bin/zsh', '-l'], ['grok'], self.lic('grok'), ['/usr/bin/python3', 'claude'], []):
            with self.assertRaisesRegex(ValueError, 'Claude and Codex'):
                tool_registration.with_readouts(argv)


class CodexLaunchTests(unittest.TestCase):
    def test_interactive_codex_sessions_stay_in_their_pane(self):
        from agent_desk.launch_profiles import codex_without_daemon
        lic = lambda word, *args: ['/bin/zsh', '-lic', 'export CODEX_HOME=x\n' + word + ' "$@"', 'agent-desk', *args]
        for argv in (lic('codex'), lic('codex-personal', '-m', 'gpt-5', '--', 'Fix the bug'), lic('codex', 'resume', 'abc'),
                     lic('codex', 'fork'), ['/usr/local/bin/codex', 'Write tests']):
            start = 4 if argv[1:2] == ['-lic'] else 1
            self.assertEqual(codex_without_daemon(argv), [*argv[:start], '--no-daemon', *argv[start:]], argv)
        for argv in (lic('codex', 'exec', 'x'), lic('codex', 'app-server', '--listen', 'stdio://'), lic('codex', 'login'),
                     lic('claude', 'Hello'), ['/bin/zsh', '-l'], ['/usr/bin/python3', 'codex'], lic('codex', '--no-daemon')):
            self.assertEqual(codex_without_daemon(argv), argv, argv)
        # A prompt that happens to be a subcommand name, after --, is still a session.
        argv = lic('codex', '--', 'review')
        self.assertEqual(codex_without_daemon(argv)[4], '--no-daemon')


if __name__ == '__main__':
    unittest.main()
