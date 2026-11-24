import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from agent_desk.session_titles import ConversationTitles, clean, scan

CLAUDE_ID = '11111111-2222-4333-8444-555555555555'
CODEX_ID = '01a1a228-5f78-7ee1-84a3-971a8cdded2c'
CORTEX_ID = '7e4b1e96-fe7d-4b39-a5cc-1c6a56749de4'
CURSOR_ID = '3c9a0f12-6b4e-4d2a-9e81-52f7a0c4d6b3'


class TerminalTitleTests(unittest.TestCase):
    def test_last_title_in_a_chunk_wins_and_split_escapes_carry_over(self):
        self.assertEqual(scan(b'', b'\x1b]0;one\x07out\x1b]2;two\x1b\\')[0], b'two')
        found, carry = scan(b'', b'out\x1b]0;\xe2\x9c\xb3 Fix the lo')
        self.assertIsNone(found)
        self.assertEqual(scan(carry, b'gin page\x07more')[0].decode(), '✳ Fix the login page')

    def test_other_escapes_are_not_titles_and_are_not_carried(self):
        self.assertEqual(scan(b'', b'\x1b]8;;https://x\x07link\x1b]8;;\x07'), (None, b''))
        self.assertEqual(scan(b'', b'\x1b]0;' + b'x' * 5000)[1][-10:], b'x' * 10)
        self.assertLessEqual(len(scan(b'', b'\x1b]0;' + b'x' * 5000)[1]), 1024)

    def test_generic_and_spinner_titles(self):
        self.assertIsNone(clean('✳ Claude Code'))
        self.assertIsNone(clean('zsh'))
        self.assertIsNone(clean('  '))
        self.assertEqual(clean('⠙ MFN upload issues\x07'), 'MFN upload issues')
        self.assertEqual(len(clean('a' * 400)), 240)


class ConversationTitleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='desk-titles-')
        self.root = Path(self.temp.name)
        self.claude, self.codex, self.cortex, self.cursor = (self.root / name for name in ('claude', 'codex', 'cortex', 'cursor'))
        self.titles = ConversationTitles(claude=[self.claude], codex=[self.codex], cortex=[self.cortex], cursor=[self.cursor])

    def tearDown(self):
        self.temp.cleanup()

    def append(self, path, *entries):
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('a') as stream:
            for entry in entries:
                stream.write(json.dumps(entry) + '\n')

    def test_claude_uses_the_latest_ai_title_and_prefers_a_rename(self):
        transcript = self.claude / 'projects' / '-tmp-project' / f'{CLAUDE_ID}.jsonl'
        self.append(transcript, {'type': 'user'}, {'type': 'ai-title', 'aiTitle': 'First topic'})
        self.assertEqual(self.titles.title(CLAUDE_ID), 'First topic')
        self.append(transcript, {'type': 'ai-title', 'aiTitle': 'Settings page columns'})
        with transcript.open('a') as stream:
            stream.write('{"type": "ai-title", "aiTi')
        self.assertEqual(self.titles.title(CLAUDE_ID), 'Settings page columns')
        with transcript.open('a') as stream:
            stream.write('tle": "Finished line"}\n')
        self.assertEqual(self.titles.title(CLAUDE_ID), 'Finished line')
        self.append(transcript, {'type': 'custom-title', 'customTitle': 'My name'}, {'type': 'ai-title', 'aiTitle': 'Later'})
        self.assertEqual(self.titles.title(CLAUDE_ID), 'My name')

    def test_codex_uses_its_thread_name_or_first_real_prompt(self):
        rollout = self.codex / 'sessions' / '2026' / '11' / '03' / f'rollout-2026-11-03T11-05-17-{CODEX_ID}.jsonl'
        user = lambda text: {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': text}]}}
        self.append(rollout, {'type': 'session_meta'}, user('# AGENTS.md instructions for /tmp'), user('<environment_context>x</environment_context>'),
                    user('Fix the flaky upload test in the parser\nwith more detail'), user('second prompt'))
        self.assertEqual(self.titles.title(CODEX_ID), 'Fix the flaky upload test in the parser')
        self.append(self.codex / 'session_index.jsonl', {'id': CODEX_ID, 'thread_name': 'Parser upload flake', 'updated_at': 'x'})
        self.assertEqual(self.titles.title(CODEX_ID), 'Parser upload flake')

    def test_cortex_uses_its_conversation_title_once_it_has_one(self):
        conversation = self.cortex / 'conversations' / f'{CORTEX_ID}.json'
        conversation.parent.mkdir(parents=True)
        conversation.write_text(json.dumps({'title': f'Chat for session: {CORTEX_ID}', 'session_id': CORTEX_ID, 'thread': []}))
        self.assertIsNone(self.titles.title(CORTEX_ID))
        conversation.write_text(json.dumps({'title': 'Counting rows across obligation tables', 'session_id': CORTEX_ID, 'thread': [1]}))
        self.assertEqual(self.titles.title(CORTEX_ID), 'Counting rows across obligation tables')
        conversation.write_text('{"title": "half writ')
        self.assertIsNone(self.titles.title(CORTEX_ID))

    def test_cursor_uses_its_chat_name_once_it_has_one_and_sees_renames_in_the_wal(self):
        store = self.cursor / 'chats' / ('a' * 32) / CURSOR_ID / 'store.db'
        store.parent.mkdir(parents=True)
        db = sqlite3.connect(store)
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')

        def name(value):
            db.execute("INSERT OR REPLACE INTO meta VALUES ('0', ?)", (json.dumps({'agentId': CURSOR_ID, 'name': value}).encode().hex(),))
            db.commit()
        try:
            name('New Agent')
            self.assertIsNone(self.titles.title(CURSOR_ID))
            name('Fix the flaky upload test')
            self.assertEqual(self.titles.title(CURSOR_ID), 'Fix the flaky upload test')
            name('Upload retries')
            self.assertEqual(self.titles.title(CURSOR_ID), 'Upload retries')
            db.execute("INSERT OR REPLACE INTO meta VALUES ('0', 'not hex')")
            db.commit()
            self.assertIsNone(self.titles.title(CURSOR_ID))
        finally:
            db.close()

    def test_unknown_or_malformed_ids_have_no_title(self):
        self.assertIsNone(self.titles.title('00000000-0000-4000-8000-000000000000'))
        self.assertIsNone(self.titles.title('../../etc/passwd'))
        self.assertIsNone(self.titles.title(None))


if __name__ == '__main__':
    unittest.main()
