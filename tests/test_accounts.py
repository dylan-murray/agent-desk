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
        for payload in (dict(harness='cortex', name='Other', config_dir='~/.cortex-other'), dict(id='grok', harness='grok', name='Work', config_dir=''), dict(harness='claude', name='', config_dir='~/.claude-x'),
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

    def test_grok_opencode_and_pi_accounts_run_their_cli_with_its_own_folder(self):
        for harness, variable in (('grok', 'GROK_HOME'), ('opencode', 'XDG_DATA_HOME'), ('pi', 'PI_CODING_AGENT_DIR')):
            saved = accounts.save_account(dict(harness=harness, name='Work', config_dir='~/.'+harness+'-work'))['saved']
            self.assertEqual((saved['id'], accounts.harness_of(saved['id'])), (harness+'-work', harness))
            self.assertEqual(terminal_environment({'GROK_HOME': '/inherited'}, saved['id'], self.home)[variable], str(self.home/('.'+harness+'-work')))
            launched = profile_command(['/bin/zsh', '-lic', harness+'-work "$@"', 'agent-desk'], saved['id'], self.home)
            self.assertTrue(launched[2].endswith('export '+variable+'='+str(self.home/('.'+harness+'-work'))+'\n'+harness+' "$@"'))
        self.assertEqual(accounts.label('pi-work'), 'Pi · Work')
        # Their own logins stay plain CLIs, not accounts.
        self.assertEqual(accounts.account_ids(), ['codex', 'claude', 'grok-work', 'opencode-work', 'pi-work'])
        self.assertEqual((accounts.harness_of('grok'), accounts.account('grok')), ('grok', None))

    def test_an_added_grok_or_pi_account_keeps_its_conversations_and_has_no_quota(self):
        from agent_desk.account_quota import AccountQuota
        from agent_desk.native_session_lookup import find_conversation
        handoff = 'Run reply task-123 --file /tmp/report'
        for harness in ('grok', 'pi'):
            accounts.save_account(dict(harness=harness, name='Work', config_dir=str(self.home/(harness+'-work'))))
        grok = self.home/'grok-work'/'sessions'/'project'/'session-one'/'chat_history.jsonl'
        grok.parent.mkdir(parents=True)
        grok.write_text(json.dumps(dict(type='user', content=[dict(type='text', text=handoff)]))+'\n')
        pi = self.home/'pi-work'/'sessions'/'--tmp-project--'/'one.jsonl'
        pi.parent.mkdir(parents=True)
        pi.write_text(json.dumps(dict(type='session', id='11111111-2222-4333-8444-555555555555'))+'\n'+
                      json.dumps(dict(type='message', message=dict(role='user', content=[dict(type='text', text=handoff)])))+'\n')
        self.assertEqual(find_conversation('grok-work', 'task-123'), 'session-one')
        self.assertEqual(find_conversation('pi-work', 'task-123'), '11111111-2222-4333-8444-555555555555')
        calls = []
        quota = AccountQuota(fetcher=calls.append)
        self.assertEqual([quota.read(profile)['state'] for profile in ('grok-work', 'pi-work')], ['unsupported', 'unsupported'])
        self.assertEqual(calls, [])

    def test_a_cortex_account_is_a_saved_snowflake_connection(self):
        for connection in ('', '-x', 'two words', 'a\nb'):
            with self.assertRaisesRegex(ValueError, 'Snowflake connection'):
                accounts.save_account(dict(harness='cortex', name='Prod', connection=connection))
        snowflake = self.home/'snowflake';snowflake.mkdir()
        (snowflake/'connections.toml').write_text('[prod_conn]\naccount = "fixture"\n')
        (snowflake/'config.toml').write_text('[connections.dev_conn]\naccount = "fixture"\n')
        with patch.dict('os.environ', {'SNOWFLAKE_HOME': str(snowflake)}):
            self.assertEqual(accounts.snowflake_connections(), {'prod_conn', 'dev_conn'})
            saved = accounts.save_account(dict(harness='cortex', name='Prod', connection=' prod_conn ', config_dir='~/ignored'))['saved']
            missing = accounts.save_account(dict(harness='cortex', name='Old', connection='gone_conn'))['saved']
        self.assertEqual((saved['id'], saved['label'], saved['connection'], saved['exists']), ('cortex-prod', 'Cortex Code · Prod', 'prod_conn', True))
        self.assertFalse(missing['exists'])
        self.assertEqual(accounts.harness_of('cortex-prod'), 'cortex')
        # Cortex Code keeps its one folder: only the connection changes.
        self.assertNotIn(None, terminal_environment({}, 'cortex-prod', self.home))
        launched = profile_command(['/bin/zsh', '-lic', 'cortex-prod "$@"', 'agent-desk', '--', 'task'], 'cortex-prod', self.home)
        self.assertTrue(launched[2].endswith('\ncortex --connection prod_conn "$@"'))
        self.assertEqual(launched[3:], ['agent-desk', '--', 'task'])
        accounts.ACCOUNTS_FILE.write_text(json.dumps([dict(id='cortex-bad', harness='cortex', name='Bad', config_dir='~/.snowflake/cortex', connection='-x')]))
        self.assertEqual(accounts.account_ids(), ['codex', 'claude'])

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
