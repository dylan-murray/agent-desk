import os
import stat
import tempfile
import unittest
from pathlib import Path

from agent_desk import desk_tokens


class DeskTokenTests(unittest.TestCase):
    def test_tokens_are_owner_only_files_keyed_by_port(self):
        with tempfile.TemporaryDirectory() as folder:
            path = desk_tokens.write_token('terminal', 4399, 'secret', folder)
            self.assertEqual(path, Path(folder) / '.terminal-token-4399')
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
            self.assertEqual(desk_tokens.read_terminal_token('http://127.0.0.1:4399', folder), 'secret')
            desk_tokens.write_token('terminal', 4399, 'rotated', folder)
            self.assertEqual(desk_tokens.read_terminal_token('http://localhost:4399/', folder), 'rotated')

    def test_a_missing_desk_or_port_is_a_clear_error(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, 'port 4398'):
                desk_tokens.read_terminal_token('http://127.0.0.1:4398', folder)
            with self.assertRaisesRegex(ValueError, 'explicit port'):
                desk_tokens.read_terminal_token('http://127.0.0.1', folder)


if __name__ == '__main__':
    unittest.main()
