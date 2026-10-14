import base64
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import zipfile

from agent_desk import remote_environments as remote
from agent_desk.launch_profiles import terminal_environment, profile_command, login_shell


class RemoteTests(unittest.TestCase):
    def test_namespace_preserves_text_and_native_session_ids(self):
        value={'id':'coordinator-a','worker_id':'terminal-b','terminal_id':'terminal-b','parent_id':'coordinator-a',
               'resumed_worker':'terminal-c','text':'terminal-b is in this code','session_id':'native-cli-id',
               'reply_task':{'id':'task-c','result':'coordinator-a'},'cwd':'/remote/project'}
        encoded=remote.translate(value,'host')
        self.assertEqual(encoded['worker_id'],'remote:host:terminal-b')
        self.assertEqual(encoded['resumed_worker'],'remote:host:terminal-c')
        self.assertEqual(encoded['terminal_id'],'remote:host:terminal-b')
        self.assertEqual(encoded['text'],value['text'])
        self.assertEqual(encoded['session_id'],value['session_id'])
        self.assertEqual(remote.translate(encoded,'host',False),value)
        with self.assertRaises(ValueError):remote.translate({'worker_id':'remote:other:terminal-b'},'host',False)

    def test_bundle_is_deterministic_code_only(self):
        first=remote.bundle();self.assertEqual(first,remote.bundle())
        archive=zipfile.ZipFile(io.BytesIO(base64.b64decode(first['bundle'])))
        names=archive.namelist()
        self.assertIn('agent_desk/remote_node.py',names)
        self.assertIn('scripts/agent_control.py',names)
        self.assertFalse(any('/data/' in n or '.git/' in n or '__pycache__' in n for n in names))
        self.assertTrue(all(n.startswith(('agent_desk/','scripts/')) for n in names))

    def test_remote_preserves_auth_and_local_profiles_still_isolate(self):
        env={'ANTHROPIC_API_KEY':'remote-fixture','CODEX_HOME':'/remote/custom-codex','CLAUDE_CONFIG_DIR':'/remote/custom-claude','PATH':'/remote/bin'}
        argv=['/bin/bash','-lic','claude "$@"','agent-desk','task']
        with patch.dict(os.environ,{'AGENT_DESK_REMOTE_NATIVE':'1'}):
            self.assertEqual(terminal_environment(env,'claude'),env)
            self.assertEqual(profile_command(argv,'claude'),argv)
            self.assertEqual(login_shell(),'/bin/bash')
            with self.assertRaises(ValueError):terminal_environment(env,'claude-personal')
        with patch.dict(os.environ,{'AGENT_DESK_REMOTE_NATIVE':'0'}):
            self.assertNotIn('ANTHROPIC_API_KEY',terminal_environment(env,'claude'))
            self.assertEqual(login_shell(),'/bin/zsh')

    def test_registry_reconnect_preserves_remote_team_without_local_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'remote.json';manager=remote.RemoteEnvironments(path)
            manager.nodes={'host':{'id':'host','name':'studio','connected':True,'node':True,'profiles':['claude'],
                'agents':[{'id':'terminal-b','terminal_id':'terminal-b','parent_id':'coordinator-a','status':'working'}],
                'coordinators':[{'id':'coordinator-a'}]}}
            manager._save();restored=remote.RemoteEnvironments(path)
            self.assertFalse(restored.list()[0]['connected'])
            self.assertEqual(restored.records('agents')[0]['status'],'unknown')
            self.assertEqual(restored.records('agents')[0]['parent_id'],'remote:host:coordinator-a')
            # A remote names its processes by number; anything else is dropped before the page shows it.
            for sent,shown in ((4242,4242),('<img src=x>',None),(True,None),(None,None)):
                restored.nodes['host']['agents'][0]['pid']=sent
                self.assertEqual(restored.records('agents')[0].get('pid'),shown)
            with self.assertRaisesRegex(ValueError,'Reconnect'):restored.request('host','/api/coordinators/message',{'id':'remote:host:coordinator-a'})
            bridge=Mock();manager.bridges['host']=bridge
            bridge.request.return_value={'coordinators':[{'id':'coordinator-a','profile':'claude'}]}
            result=manager.request('host','/api/coordinators?id=coordinator-a')
            self.assertEqual(result['coordinators'][0]['remote_node'],'host')
            manager.request('host','/api/terminals/input',{'id':'remote:host:terminal-b','data':'dGVzdA==','remote_node':'host'})
            self.assertEqual(bridge.request.call_args.args[1]['id'],'terminal-b')
            self.assertNotIn('remote_node',bridge.request.call_args.args[1])
            with self.assertRaises(ValueError):manager.request('host','/api/coordinators/create',{'profile':'claude-personal'})
            self.assertEqual(path.stat().st_mode & 0o777,0o600)

    def test_bootstrap_bundle_has_no_environment_payload(self):
        with patch.dict(os.environ,{'ANTHROPIC_API_KEY':'never-send-fixture'}):
            self.assertNotIn('never-send-fixture',json.dumps(remote.bundle()))

    def test_successful_create_is_not_reclassified_when_refresh_disconnects(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager=remote.RemoteEnvironments(Path(tmp)/'nodes.json')
            manager.nodes={'host':{'id':'host','name':'studio','connected':True,'node':True,'profiles':['claude']}}
            bridge=Mock();manager.bridges['host']=bridge
            bridge.request.side_effect=[{'id':'coordinator-new','name':'Work','cwd':'/remote/project','profile':'claude','state':'idle'},ValueError('disconnected')]
            result=manager.request('host','/api/coordinators/create',{'profile':'claude'})
            self.assertEqual(result['id'],'remote:host:coordinator-new')
            self.assertFalse(manager.list()[0]['connected'])
            self.assertEqual(manager.records('agents')[0]['id'],result['id'])
            self.assertEqual(bridge.request.call_count,2)
