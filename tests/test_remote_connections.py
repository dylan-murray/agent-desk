import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from agent_desk import remote_connections as rc

CONFIG = dict(transport='ssh', host='dev-server', user='', port=22, identity_file='')


class SavedConnectionTests(unittest.TestCase):
    """Hosts are entered once and kept in the workspace, not in one browser's storage."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        patcher = patch.object(rc, 'DATA_DIR', Path(self.temp.name))
        patcher.start(); self.addCleanup(patcher.stop); self.addCleanup(self.temp.cleanup)
        file_patch = patch.object(rc, 'CONNECTIONS_FILE', Path(self.temp.name)/'remote-connections.json')
        file_patch.start(); self.addCleanup(file_patch.stop)

    def host(self, name='dev-server', **extra):
        return dict(transport='ssh', host=name, **extra)

    def test_saving_keeps_one_entry_per_target_and_survives_a_reread(self):
        self.assertEqual(rc.saved_connections(), [])
        saved = rc.save_connection(self.host(label='Build box'))['saved']
        self.assertEqual(saved['host'], 'dev-server')
        self.assertEqual(saved['label'], 'Build box')
        # Saving the same target again renames it rather than stacking duplicates.
        rc.save_connection(self.host(label='Build box, renamed'))
        rows = rc.saved_connections()
        self.assertEqual([row['label'] for row in rows], ['Build box, renamed'])
        rc.save_connection(self.host('gpu-box', label='Second'))
        self.assertEqual([row['label'] for row in rc.saved_connections()], ['Second', 'Build box, renamed'])
        rc.delete_connection({'id': rows[0]['id']})
        self.assertEqual([row['label'] for row in rc.saved_connections()], ['Second'])

    def test_a_connection_is_validated_before_it_is_saved(self):
        for payload in (self.host('-oProxyCommand=bad'), self.host(''), self.host(user='me; rm -rf /'),
                        self.host(port=70000), self.host(label='   '), self.host(label='x'*81)):
            with self.assertRaises(ValueError):
                rc.save_connection(payload)
        self.assertEqual(rc.saved_connections(), [])
        with self.assertRaises(ValueError):
            rc.delete_connection({'id': ''})

    def test_unreadable_or_foreign_content_does_not_break_the_list(self):
        rc.CONNECTIONS_FILE.write_text('not json')
        self.assertEqual(rc.saved_connections(), [])
        rc.CONNECTIONS_FILE.write_text('[{"no":"id"},"text",null,{"id":"x","transport":"other"}]')
        self.assertEqual(rc.saved_connections(), [])


class TestedConnectionTests(unittest.TestCase):
    def test_connect_requires_matching_unexpired_single_use_test(self):
        manager=rc.RemoteConnections();terminals=Mock()
        for ticket in (None,'fake'):
            with self.assertRaisesRegex(ValueError,'Test this'):manager.connect({**CONFIG,'ticket':ticket},terminals)
        manager.tickets['old']=(CONFIG,time.monotonic()-1)
        with self.assertRaises(ValueError):manager.connect({**CONFIG,'ticket':'old'},terminals)
        manager.tickets['wrong']=({**CONFIG,'host':'different'},time.monotonic()+30)
        with self.assertRaises(ValueError):manager.connect({**CONFIG,'ticket':'wrong'},terminals)
        terminals.launch.assert_not_called()
        manager.tickets['ok']=(CONFIG,time.monotonic()+30)
        with patch.object(rc,'ssh_command',return_value=['ssh','fixture']):manager.connect({**CONFIG,'ticket':'ok'},terminals)
        with self.assertRaises(ValueError):manager.connect({**CONFIG,'ticket':'ok'},terminals)
        self.assertEqual(terminals.launch.call_count,1)

    @patch.object(rc,'ssh_command',return_value=['ssh','fixture'])
    @patch.object(rc.subprocess,'Popen')
    def test_only_remote_marker_can_pass(self, popen, command):
        process=popen.return_value;process.returncode=0
        process.communicate.return_value=(b'login banner',b'')
        manager=rc.RemoteConnections()
        with self.assertRaises(ValueError):manager.test(CONFIG)
        self.assertEqual(manager.tickets,{})
        process.communicate.side_effect=lambda **kw:(popen.call_args.args[0][-1].removeprefix('printf ').encode(),b'')
        result=manager.test(CONFIG)
        self.assertIn(result['ticket'],manager.tickets)

    @patch.object(rc,'ssh_command',return_value=['ssh','fixture'])
    @patch.object(rc.os,'killpg')
    @patch.object(rc.subprocess,'Popen')
    def test_timeout_kills_transport_and_never_issues_ticket(self,popen,kill,command):
        process=popen.return_value;process.pid=123
        process.communicate.side_effect=[subprocess.TimeoutExpired('ssh',40),(b'',b'')]
        manager=rc.RemoteConnections()
        with self.assertRaisesRegex(ValueError,'timed out'):manager.test(CONFIG)
        kill.assert_called_once();self.assertEqual(manager.tickets,{})

    @patch.object(rc,'ssh_command',return_value=['ssh','fixture'])
    @patch.object(rc.subprocess,'run')
    def test_runtime_probe_issues_no_usable_ticket_when_prerequisites_fail(self,run,command):
        manager=rc.RemoteConnections()
        def tested(payload):
            manager.tickets['runtime']=(CONFIG,time.monotonic()+300)
            return {'ticket':'runtime','expires_in':300}
        with patch.object(manager,'test',side_effect=tested):
            run.return_value=Mock(returncode=0,stdout='AGENT_DESK_PROBE {"python_ok": true, "node": false, "profiles": ["claude"]}\n')
            with self.assertRaisesRegex(ValueError,'prerequisites'):manager.test_runtime(CONFIG)
            self.assertEqual(manager.tickets,{})
            run.return_value=Mock(returncode=0,stdout='AGENT_DESK_PROBE {"python_ok": true, "node": true, "profiles": ["claude", "codex"]}\n')
            result=manager.test_runtime(CONFIG)
            self.assertIn('claude, codex',result['message'])
            self.assertIn('runtime',manager.tickets)


if __name__ == '__main__':
    unittest.main()
