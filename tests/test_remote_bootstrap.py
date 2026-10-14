"""Install into a temporary remote-home fixture and reuse the detached runtime."""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import signal
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from agent_desk import remote_bootstrap as boot
from agent_desk.remote_environments import bundle


class BootstrapTests(unittest.TestCase):
    def test_install_reconnect_and_version_guard_do_not_duplicate_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            home=Path(directory);processes=[];popen=subprocess.Popen
            def start(*args,**kw):
                process=popen(*args,**kw);processes.append(process);return process
            def invoke(payload):
                output=io.StringIO()
                with patch.object(Path,'home',return_value=home),patch('sys.stdin',io.StringIO(json.dumps(payload)+'\n')),patch.object(boot.subprocess,'Popen',side_effect=start),redirect_stdout(output):boot.main()
                return output.getvalue()
            try:
                payload=bundle();first=invoke(payload)
                metadata=json.loads((home/'.local/share/agent-desk/remote-state/node.json').read_text())
                self.assertIn('AGENT_DESK_REMOTE_READY',first)
                self.assertNotIn(metadata['token'],first)
                second=invoke(payload)
                self.assertEqual(first,second)
                self.assertEqual(len(processes),1)
                # A newer local bundle must not replace a runtime with active work.
                from zipfile import ZipFile,ZIP_DEFLATED
                import base64
                import hashlib
                data=io.BytesIO(base64.b64decode(payload['bundle']))
                with ZipFile(data,'a',ZIP_DEFLATED) as archive:archive.writestr('agent_desk/version_fixture.py','value = 1\n')
                encoded=data.getvalue()
                with self.assertRaisesRegex(RuntimeError,'different Agent Desk runtime'):
                    invoke({'version':hashlib.sha256(encoded).hexdigest(),'bundle':base64.b64encode(encoded).decode()})
                self.assertEqual(len(processes),1)
                self.assertIsNone(processes[0].poll())
            finally:
                for process in processes:
                    process.send_signal(signal.SIGTERM)
                    try:process.wait(timeout=10)
                    except subprocess.TimeoutExpired:process.kill();process.wait()
