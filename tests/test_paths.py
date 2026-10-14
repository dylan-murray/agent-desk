"""The package must retain local state regardless of where it is launched."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class PathTests(unittest.TestCase):
    def inspect_paths(self, cwd, data_dir=None):
        root = Path(__file__).resolve().parents[1]
        env = {**os.environ, 'PYTHONPATH': str(root)}
        env.pop('AGENT_DESK_DATA_DIR', None)
        if data_dir is not None:
            env['AGENT_DESK_DATA_DIR'] = str(data_dir)
        code = ('import json; from agent_desk.paths import DATA_DIR, STATIC_DIR; '
                'from scripts.control_mailbox import DEFAULT_DB; '
                'print(json.dumps([str(DATA_DIR), str(DEFAULT_DB), '
                '(STATIC_DIR / "index.html").is_file()]))')
        return json.loads(subprocess.check_output([sys.executable, '-c', code], cwd=cwd, env=env, text=True))

    def test_checkout_uses_existing_state_from_other_directory(self):
        with tempfile.TemporaryDirectory() as cwd:
            data, mailbox, assets = self.inspect_paths(cwd)
        expected = Path(__file__).resolve().parents[1] / 'data'
        self.assertEqual(Path(data), expected)
        self.assertEqual(Path(mailbox), expected / 'control-mailbox.sqlite3')
        self.assertTrue(assets)

    def test_explicit_state_directory_is_shared_with_mailbox(self):
        with tempfile.TemporaryDirectory() as cwd:
            expected = Path(cwd).resolve() / 'custom-state'
            data, mailbox, assets = self.inspect_paths(cwd, expected)
        self.assertEqual(Path(data), expected)
        self.assertEqual(Path(mailbox), expected / 'control-mailbox.sqlite3')
        self.assertTrue(assets)
