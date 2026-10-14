import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_desk import accounts
from agent_desk.launch_profiles import infer_profile, profile_command, terminal_environment


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        for patcher in (patch.object(accounts, 'DATA_DIR', self.home), patch.object(accounts, 'ACCOUNTS_FILE', self.home/'accounts.json')):
            patcher.start(); self.addCleanup(patcher.stop)
        self.addCleanup(self.temp.cleanup)

    def test_each_harness_starts_with_only_the_login_its_cli_already_uses(self):
        self.assertEqual([(a['id'], a['label'], a['config_dir']) for a in accounts.accounts()], [('codex', 'Codex', ''), ('claude', 'Claude', '')])
        self.assertEqual(accounts.config_folder('claude', self.home), self.home/'.claude')
        self.assertEqual(terminal_environment({}, 'codex', self.home), {'CODEX_HOME': str(self.home/'.codex')})
        # Claude's default login stays unset so its usual Keychain entry is used.
        self.assertEqual(terminal_environment({}, 'claude', self.home), {})
        self.assertIsNone(accounts.account('claude-personal'))
        with self.assertRaises(ValueError):
            terminal_environment({}, 'claude-personal', self.home)

    def test_an_added_account_is_listed_survives_a_reread_and_can_be_removed(self):
        saved = accounts.save_account(dict(harness='claude', name=' Personal ', config_dir='~/.agent-desk-missing-fixture/'))['saved']
        self.assertEqual((saved['id'], saved['label'], saved['config_dir'], saved['exists']), ('claude-personal', 'Claude · Personal', '~/.agent-desk-missing-fixture', False))
        accounts.save_account(dict(harness='codex', name='Side project', config_dir=str(self.home/'side')))
        self.assertEqual(accounts.account_ids(), ['codex', 'codex-side-project', 'claude', 'claude-personal'])
        self.assertEqual(accounts.config_folder('claude-personal', self.home), self.home/'.agent-desk-missing-fixture')
        self.assertEqual(accounts.config_folder('codex-side-project', self.home), self.home/'side')
        self.assertEqual(accounts.harness_of('codex-side-project'), 'codex')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            accounts.save_account(dict(harness='claude', name='personal', config_dir='~/elsewhere'))
        accounts.delete_account({'id': 'codex-side-project'})
        self.assertEqual(accounts.account_ids(), ['codex', 'claude', 'claude-personal'])
        # Sessions saved under a removed account are still recognised as that CLI's.
        self.assertEqual(accounts.harness_of('codex-side-project'), 'codex')

    def test_a_default_account_can_be_named_but_keeps_its_folder_and_cannot_be_removed(self):
        accounts.save_account(dict(id='claude', harness='claude', name='Work', config_dir='~/ignored'))
        self.assertEqual((accounts.label('claude'), accounts.account('claude')['config_dir']), ('Claude · Work', ''))
        with self.assertRaises(ValueError):
            accounts.delete_account({'id': 'claude'})

    def test_invalid_accounts_and_unreadable_files_are_rejected_without_saving(self):
        for payload in (dict(harness='grok', name='Other', config_dir='~/.grok-other'), dict(harness='claude', name='', config_dir='~/.claude-x'),
                        dict(harness='claude', name='x'*41, config_dir='~/.claude-x'), dict(harness='claude', name='Personal', config_dir='relative/path'),
                        dict(harness='claude', name='Personal', config_dir='~/../outside'), dict(harness='claude', name='···', config_dir='~/.claude-x'),
                        dict(id='grok', harness='claude', name='Personal', config_dir='~/.claude-x'),
                        dict(id='opencode', harness='claude', name='Personal', config_dir='~/.claude-x'),
                        dict(id='pi', harness='codex', name='Personal', config_dir='~/.codex-x')):
            with self.assertRaises(ValueError):
                accounts.save_account(payload)
        self.assertFalse(accounts.ACCOUNTS_FILE.exists())
        accounts.ACCOUNTS_FILE.write_text('[{"id":"x"},"text",{"id":"claude-a","harness":"other","name":"A","config_dir":"~/a"}]')
        self.assertEqual(accounts.account_ids(), ['codex', 'claude'])
        accounts.ACCOUNTS_FILE.write_text('not json')
        self.assertEqual(accounts.account_ids(), ['codex', 'claude'])
        # An id edited into the file is held to the same shape as one saved through the API.
        accounts.ACCOUNTS_FILE.write_text(json.dumps([{'id':'claude-a"><img src=x>','harness':'claude','name':'A','config_dir':'~/a'},
                                                      {'id':'claude-b','harness':'claude','name':'B','config_dir':'~/b'}]))
        self.assertEqual(accounts.account_ids(), ['codex', 'claude', 'claude-b'])

    def test_an_added_account_runs_its_cli_with_its_own_config_folder(self):
        accounts.save_account(dict(harness='codex', name='Personal', config_dir='~/.codex-personal'))
        argv = ['/bin/zsh', '-lic', 'codex-personal "$@"', 'agent-desk', 'resume']
        self.assertEqual(infer_profile(argv), 'codex-personal')
        self.assertIsNone(infer_profile(['/bin/zsh', '-lic', 'codex-other "$@"', 'agent-desk']))
        launched = profile_command(argv, 'codex-personal', self.home)
        self.assertTrue(launched[2].endswith('export CODEX_HOME='+str(self.home/'.codex-personal')+'\ncodex "$@"'))
        self.assertEqual(launched[3:], ['agent-desk', 'resume'])
        # The default account keeps its own command, so a user's alias for it still applies.
        self.assertTrue(profile_command(['/bin/zsh', '-lic', 'codex "$@"', 'agent-desk'], 'codex', self.home)[2].endswith('\ncodex "$@"'))

    def test_accounts_with_the_same_name_go_together_across_harnesses(self):
        accounts.save_account(dict(harness='codex', name='Personal', config_dir='~/.codex-personal'))
        accounts.save_account(dict(harness='claude', name='Personal', config_dir='~/.claude-personal'))
        accounts.save_account(dict(harness='claude', name='Client', config_dir='~/.claude-client'))
        self.assertEqual(accounts.sibling('claude-personal', 'codex'), 'codex-personal')
        self.assertEqual(accounts.sibling('claude-client', 'codex'), 'codex')
        self.assertEqual(accounts.sibling('claude', 'codex'), 'codex')
        self.assertEqual(accounts.sibling('claude-client', 'claude'), 'claude-client')


if __name__ == '__main__':
    unittest.main()
