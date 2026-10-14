import tempfile
import unittest
from pathlib import Path

from agent_desk import skill_harnesses as sh
from account_fixtures import use_accounts


def skill(folder, body='Instructions here.', name=None, description='A useful local skill.', extra=''):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'SKILL.md').write_text(f'---\nname: {name or folder.name}\ndescription: {description}\n{extra}---\n{body}\n')
    return folder


def setUpModule():
    use_accounts()


class SkillHarnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        for account in ('.claude', '.claude-personal', '.codex', '.codex-personal', '.grok'):
            (self.home / account).mkdir()
        self.env = {}

    def tearDown(self):
        self.temp.cleanup()

    def listing(self):
        return sh.list_skills(self.home, self.env)

    def test_discovers_symlinked_skills_and_reads_their_frontmatter(self):
        source = skill(self.home / 'library' / 'example', name='Example', description='>\n  A useful\n  local skill.')
        (self.home / '.claude' / 'skills').mkdir()
        (self.home / '.claude' / 'skills' / 'example').symlink_to(source, target_is_directory=True)
        [found] = self.listing()['skills']
        self.assertEqual(found['name'], 'Example')
        self.assertIn('local skill', found['description'])
        self.assertIn('Instructions here.', found['content'])
        self.assertEqual(found['path'], str(source.resolve() / 'SKILL.md'))

    def test_reports_which_harness_can_see_each_skill(self):
        skill(self.home / '.claude' / 'skills' / 'claude-only')
        skill(self.home / '.agents' / 'skills' / 'shared')
        skill(self.home / '.codex' / 'skills' / 'codex-work-only')
        result = self.listing()
        self.assertEqual([h['id'] for h in result['harnesses']], ['codex', 'codex-personal', 'claude', 'claude-personal', 'grok'])
        by_id = {s['id']: s['availability'] for s in result['skills']}
        # Grok reads ~/.claude/skills through its Claude compatibility by default; Codex does not.
        self.assertEqual(by_id['claude-only'], dict(codex=False, **{'codex-personal': False}, claude=True, **{'claude-personal': False}, grok=True))
        self.assertEqual(by_id['shared'], dict(codex=True, **{'codex-personal': True}, claude=False, **{'claude-personal': False}, grok=True))
        self.assertEqual(by_id['codex-work-only'], dict(codex=True, **{'codex-personal': False}, claude=False, **{'claude-personal': False}, grok=False))

    def test_same_skill_through_two_roots_is_listed_once(self):
        source = skill(self.home / '.claude' / 'skills' / 'example')
        (self.home / '.agents' / 'skills').mkdir(parents=True)
        (self.home / '.agents' / 'skills' / 'example').symlink_to(source, target_is_directory=True)
        [found] = self.listing()['skills']
        self.assertEqual(found['sources'], ['Codex', 'Codex · Personal', 'Claude Code', 'Grok'])
        self.assertEqual(found['conflicts'], [])

    def test_only_installed_harnesses_are_listed(self):
        (self.home / '.codex-personal').rmdir()
        (self.home / '.grok').rmdir()
        self.assertEqual([h['id'] for h in self.listing()['harnesses']], ['codex', 'claude', 'claude-personal'])

    def test_opencode_and_pi_are_listed_with_the_folders_they_read(self):
        (self.home / '.config' / 'opencode').mkdir(parents=True)
        (self.home / '.pi' / 'agent').mkdir(parents=True)
        skill(self.home / '.agents' / 'skills' / 'shared')
        skill(self.home / '.claude' / 'skills' / 'claude-only')
        skill(self.home / '.pi' / 'agent' / 'skills' / 'pi-only')
        result = self.listing()
        self.assertEqual([h['id'] for h in result['harnesses']][-2:], ['opencode', 'pi'])
        seen = {s['name']: (s['availability']['opencode'], s['availability']['pi']) for s in result['skills']}
        self.assertEqual(seen, {'shared': (True, True), 'claude-only': (True, False), 'pi-only': (False, True)})

    def test_grok_claude_compatibility_can_be_turned_off(self):
        skill(self.home / '.claude' / 'skills' / 'claude-only')
        (self.home / '.grok' / 'config.toml').write_text('[compat.claude]\nskills = false\n')
        self.assertFalse(self.listing()['skills'][0]['availability']['grok'])
        (self.home / '.grok' / 'config.toml').write_text('')
        self.env = {'GROK_CLAUDE_SKILLS_ENABLED': 'false'}
        self.assertFalse(self.listing()['skills'][0]['availability']['grok'])
        self.env = {}
        self.assertTrue(self.listing()['skills'][0]['availability']['grok'])

    def test_explicit_only_skills_are_recognised_in_either_vocabulary(self):
        skill(self.home / '.agents' / 'skills' / 'claude-flag', extra='disable-model-invocation: true\n')
        openai = skill(self.home / '.agents' / 'skills' / 'openai-flag')
        (openai / 'agents').mkdir()
        (openai / 'agents' / 'openai.yaml').write_text('policy:\n  allow_implicit_invocation: false\n')
        skill(self.home / '.agents' / 'skills' / 'implicit')
        flags = {s['id']: s['explicit_only'] for s in self.listing()['skills']}
        self.assertEqual(flags, {'claude-flag': True, 'implicit': False, 'openai-flag': True})

    def test_portability_notes_flag_dependencies_not_harness_examples(self):
        installed = {'example-presenter'}
        notes = lambda body: sh.portability_notes('---\nname: x\n---\n' + body, installed)
        self.assertEqual(len(notes('python ~/.claude/skills/x/run.py')), 1)
        self.assertEqual(len(notes('Monitor(command: "watch")')), 1)
        self.assertEqual(notes('in Claude Code that is\n`Monitor(command: "watch")`'), [])
        self.assertEqual(len(notes('Use `mcp__claude_ai_Slack__search`.')), 1)
        self.assertEqual(notes('Use the Slack search tool (Claude: `mcp__claude_ai_Slack__search`).'), [])
        self.assertEqual(notes('Run a `/example-questioner` session, using the `/example-presenter` skill.'), ['Depends on a /example-questioner skill that is not installed for any harness.'])
        self.assertEqual(notes('Always invoke the /example-questioner and /example-presenter skills.'), ['Depends on a /example-questioner skill that is not installed for any harness.'])
        self.assertEqual(notes('mark each note via the `/resolve` endpoint'), [])
        self.assertEqual(notes('Run `cp <skill-dir>/template.html docs/` for this skill.'), [])

    def test_skills_depending_on_an_installed_claude_command_are_not_flagged(self):
        (self.home / '.claude' / 'commands').mkdir()
        (self.home / '.claude' / 'commands' / 'discover-ideas.md').write_text('command')
        skill(self.home / '.claude' / 'skills' / 'leaf', body='a leaf skill run by `/discover-ideas`')
        self.assertEqual(self.listing()['skills'][0]['portability'], [])

    def test_share_links_whole_directories_and_leaves_conflicts_alone(self):
        source, dest = self.home / 'source', self.home / 'dest'
        folder = skill(source / 'example')
        (folder / 'helper.txt').write_text('supporting file')
        sh.share(source, dest, apply=True)
        self.assertEqual((dest / 'example' / 'helper.txt').read_text(), 'supporting file')
        self.assertEqual(sh.share(source, dest, apply=True)[0][2], 'already shared')
        (dest / 'example').unlink()
        (dest / 'example').mkdir()
        self.assertEqual(sh.share(source, dest, apply=True)[0][2], 'conflict; left unchanged')

    def test_making_skills_available_everywhere(self):
        skill(self.home / '.claude' / 'skills' / 'from-claude')
        skill(self.home / '.agents' / 'skills' / 'from-shared')
        skill(self.home / '.codex' / 'skills' / 'from-codex')
        preview = sh.make_available_everywhere(self.home, self.env, apply=False)
        self.assertTrue(preview['linked'])
        self.assertFalse((self.home / '.claude-personal' / 'skills').exists(), 'a preview created files')
        applied = sh.make_available_everywhere(self.home, self.env)
        self.assertEqual(applied['conflicts'], [])
        for found in applied['skills']:
            self.assertTrue(all(found['availability'].values()), found['id'] + ' is still missing somewhere: ' + str(found['availability']))
        # Links point at the real folder, not at another link, and the personal skills root was created.
        self.assertEqual((self.home / '.claude-personal' / 'skills' / 'from-codex').resolve(), (self.home / '.codex' / 'skills' / 'from-codex').resolve())
        self.assertEqual(sh.make_available_everywhere(self.home, self.env)['linked'], [], 'a second run changed something')

    def test_making_skills_available_never_replaces_a_different_skill(self):
        skill(self.home / '.claude' / 'skills' / 'example', body='the real one')
        skill(self.home / '.agents' / 'skills' / 'example', body='a different skill with the same name')
        result = sh.make_available_everywhere(self.home, self.env)
        self.assertTrue(any(c['path'].endswith('.agents/skills/example') or c['path'].endswith('.claude/skills/example') for c in result['conflicts']))
        self.assertEqual((self.home / '.agents' / 'skills' / 'example' / 'SKILL.md').read_text().split('---\n')[-1].strip(), 'a different skill with the same name')
        self.assertTrue(self.listing()['skills'][0]['conflicts'], 'the name clash is not reported on the skill')

    def test_find_and_add_local_skill_without_replacing_a_name_conflict(self):
        source=skill(self.home/'projects'/'sample'/'skills'/'local-example')
        found=sh.find_local_skills(self.home/'projects',self.home)
        self.assertEqual(found['skills'][0]['path'],str(source.resolve()))
        self.assertFalse(found['skills'][0]['installed'])
        result=sh.add_local_skill(str(source/'SKILL.md'),self.home,self.env)
        self.assertTrue(all(result['skills'][0]['availability'].values()))
        self.assertTrue(sh.find_local_skills(self.home/'projects',self.home)['skills'][0]['installed'])
        self.assertEqual(sh.add_local_skill(str(source),self.home,self.env)['linked'],[])
        conflict=skill(self.home/'other'/'local-example')
        with self.assertRaisesRegex(ValueError,'different skill'):
            sh.add_local_skill(str(conflict),self.home,self.env)
        self.assertEqual((self.home/'.agents'/'skills'/'local-example').resolve(),source.resolve())


if __name__ == '__main__':
    unittest.main()
