import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from agent_desk.projects import discover_projects, create_directory


class ProjectTests(unittest.TestCase):
    def test_default_discovery_includes_common_project_folders(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            for folder, repo in [('code', 'checkout-service'), ('github-projects', 'other')]:
                (home / folder / repo / '.git').mkdir(parents=True)
            with patch('agent_desk.projects.Path.home', return_value=home):
                result = discover_projects()
            self.assertEqual([p['name'] for p in result['projects']], ['checkout-service', 'other'])
            self.assertFalse(result['limited'])

    def test_repos_worktrees_duplicates_and_ignored_trees(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'repo' / '.git').mkdir(parents=True)
            (root / 'group' / 'worktree').mkdir(parents=True)
            (root / 'group' / 'worktree' / '.git').write_text('gitdir: /elsewhere')
            (root / 'node_modules' / 'ignored' / '.git').mkdir(parents=True)
            (root / 'link').symlink_to(root / 'repo', target_is_directory=True)
            result = discover_projects([root, root / 'repo'])
            self.assertEqual([p['name'] for p in result['projects']], ['repo', 'worktree'])
            self.assertFalse(result['limited'])
            self.assertTrue(discover_projects([root], max_directories=1)['limited'])

    def test_create_never_overwrites_or_traverses(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = create_directory(tmp, 'My project')
            self.assertTrue(Path(result['path']).is_dir())
            for name in ('My project', '../escape', '..', '/absolute', 'nested/name', '', 'bad\nname'):
                with self.assertRaises(ValueError):
                    create_directory(tmp, name)
