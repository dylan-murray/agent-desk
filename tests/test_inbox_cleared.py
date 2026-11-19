import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agent_desk import inbox_cleared
from agent_desk.inbox_cleared import InboxCleared


class InboxClearedTests(unittest.TestCase):
    """Cleared Inbox History lives in SQLite; an earlier inbox-cleared.json is brought in once."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.store = self.folder / 'inbox.sqlite3'
        self.legacy = self.folder / 'inbox-cleared.json'

    def tearDown(self):
        self.temp.cleanup()

    def test_cleared_keys_come_back_in_the_order_they_were_cleared_without_repeats(self):
        cleared = InboxCleared(self.store, legacy=self.legacy)
        self.assertFalse(self.store.exists(), 'building it does not touch the data folder')
        self.assertEqual(cleared.keys(), [])
        self.assertEqual(cleared.clear(['report:a', 'run:b']), ['report:a', 'run:b'])
        self.assertEqual(cleared.clear(['run:b', 'pr:c']), ['report:a', 'run:b', 'pr:c'])
        self.assertEqual(InboxCleared(self.store).keys(), ['report:a', 'run:b', 'pr:c'])
        self.assertEqual(self.store.stat().st_mode & 0o777, 0o600)

    def test_only_short_text_keys_are_accepted(self):
        cleared = InboxCleared(self.store)
        for bad in ('report:a', [''], ['x' * 201], [1], ['k'] * 5001):
            with self.assertRaisesRegex(ValueError, 'Invalid inbox items'):
                cleared.clear(bad)
        self.assertEqual(cleared.keys(), [])

    def test_the_oldest_keys_go_first_past_the_limit(self):
        with mock.patch.object(inbox_cleared, 'LIMIT', 3):
            cleared = InboxCleared(self.store)
            cleared.clear(['a', 'b'])
            self.assertEqual(cleared.clear(['c', 'd']), ['b', 'c', 'd'])

    def test_an_earlier_json_file_is_imported_once_and_kept_beside_it(self):
        self.legacy.write_text(json.dumps(['report:old', 'run:older', 7]))
        cleared = InboxCleared(self.store, legacy=self.legacy)
        self.assertEqual(cleared.keys(), ['report:old', 'run:older'])
        self.assertFalse(self.legacy.exists())
        self.assertEqual(json.loads((self.folder / 'inbox-cleared.json.imported').read_text()), ['report:old', 'run:older', 7])
        self.assertEqual(cleared.clear(['pr:new']), ['report:old', 'run:older', 'pr:new'])
        self.assertEqual(InboxCleared(self.store, legacy=self.legacy).keys(), ['report:old', 'run:older', 'pr:new'])

    def test_an_unreadable_json_file_imports_nothing_and_is_set_aside(self):
        self.legacy.write_text('{not json')
        self.assertEqual(InboxCleared(self.store, legacy=self.legacy).keys(), [])
        self.assertTrue((self.folder / 'inbox-cleared.json.imported').exists())


if __name__ == '__main__':
    unittest.main()
