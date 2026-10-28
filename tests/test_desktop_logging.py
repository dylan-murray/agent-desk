import os
from pathlib import Path
import tempfile
import time
import unittest

from agent_desk.desktop_logging import DiagnosticHandler, DiagnosticStream, RETENTION_SECONDS


class DiagnosticLogTests(unittest.TestCase):
    def test_rotation_bounds_long_unicode_output_and_preserves_other_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'notes.txt').write_text('keep')
            handler = DiagnosticHandler(root, max_bytes=1024, max_total=16384)
            try:
                stream = DiagnosticStream(handler)
                text = 'fixture diagnostic 🙂\n' * 3000
                self.assertEqual(stream.write(text), len(text))
                stream.flush()
                files = list(root.glob('*.log'))
                self.assertGreater(len(files), 1)
                self.assertLessEqual(sum(file.stat().st_size for file in files), 16384)
                for file in files:
                    self.assertLessEqual(file.stat().st_size, 1024)
                    self.assertEqual(file.stat().st_mode & 0o777, 0o600)
                    file.read_text(encoding='utf-8')
                self.assertEqual((root / 'notes.txt').read_text(), 'keep')
            finally:
                handler.close()

    def test_expiration_and_daily_rotation_while_the_backend_keeps_running(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            now = [time.time()]
            expired = root / 'desktop-backend.expired.log'
            expired.write_text('expired')
            old = now[0] - RETENTION_SECONDS - 1
            os.utime(expired, (old, old))
            handler = DiagnosticHandler(root, clock=lambda: now[0])
            try:
                self.assertFalse(expired.exists())
                stream = DiagnosticStream(handler)
                stream.write('first day\n')
                now[0] += 86400
                stream.write('next day\n')
                self.assertEqual((root / 'desktop-backend.log').read_text(), 'next day\n')
                archives = list(root.glob('desktop-backend.*.log'))
                self.assertEqual(len(archives), 1)
                self.assertEqual(archives[0].read_text(), 'first day\n')
                now[0] += RETENTION_SECONDS + 1
                stream.write('later\n')
                self.assertFalse(archives[0].exists())
            finally:
                handler.close()

    def test_log_file_symlinks_are_not_followed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            target = root / 'private.txt'
            target.write_text('keep')
            (root / 'desktop-backend.log').symlink_to(target)
            handler = DiagnosticHandler(root)
            try:
                with self.assertRaises(OSError):
                    handler._open()
                self.assertEqual(target.read_text(), 'keep')
            finally:
                handler.close()

    def test_log_directory_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            target = root / 'target'
            target.mkdir(mode=0o700)
            link = root / 'logs'
            link.symlink_to(target, target_is_directory=True)
            with self.assertRaises(PermissionError):
                DiagnosticHandler(link)
