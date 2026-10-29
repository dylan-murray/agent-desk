import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agent_desk.pull_requests import PullRequests, checks_of

FAKE_GH = Path(__file__).with_name('fixtures') / 'fake_gh.py'
PR_URL = 'https://github.com/example-org/example-repo/pull/42'
JOB_URL = 'https://github.com/example-org/example-repo/actions/runs/7/job/11'


def pull_request(checks=(), reviews=(), **fields):
    return dict(dict(number=42, title='Fixture change', url=PR_URL, state='OPEN', isDraft=False, reviewDecision='',
                     statusCheckRollup=list(checks), latestReviews=list(reviews)), **fields)


def run(name, status, conclusion='', url=JOB_URL):
    return {'__typename': 'CheckRun', 'name': name, 'status': status, 'conclusion': conclusion, 'detailsUrl': url}


class ChecksTests(unittest.TestCase):
    def test_check_runs_and_status_contexts_summarise_to_one_state(self):
        self.assertEqual(checks_of([])[0], None)
        self.assertEqual(checks_of([run('lint', 'COMPLETED', 'SUCCESS'), run('docs', 'COMPLETED', 'SKIPPED')])[0], 'passing')
        self.assertEqual(checks_of([run('lint', 'COMPLETED', 'SUCCESS'), run('unit', 'IN_PROGRESS')])[0], 'pending')
        self.assertEqual(checks_of([{'context': 'deploy', 'state': 'PENDING'}])[0], 'pending')
        state, failed, total = checks_of([run('unit', 'IN_PROGRESS'), {'context': 'deploy', 'state': 'ERROR', 'targetUrl': 'https://ci.example.test/1'}])
        self.assertEqual((state, total), ('failing', 2))
        self.assertEqual(failed, [{'name': 'deploy', 'url': 'https://ci.example.test/1'}])


class PullRequestPollTests(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp())
        self.addCleanup(subprocess.run, ['rm', '-rf', str(self.folder)])
        self.fake = self.folder / 'fake-gh'
        self.fake.mkdir()
        bin_dir = self.folder / 'bin'
        bin_dir.mkdir()
        gh = bin_dir / 'gh'
        gh.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FAKE_GH}" "$@"\n')
        gh.chmod(0o755)
        # Only the stub and the system tools: a real gh elsewhere on PATH is never found.
        self.env = {'PATH': f'{bin_dir}{os.pathsep}/usr/bin{os.pathsep}/bin', 'AGENT_DESK_FAKE_GH': str(self.fake)}
        patcher = mock.patch.dict(os.environ, self.env)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.repo = self.repository('example-repo', 'https://github.com/example-org/example-repo.git')
        self.prs = PullRequests(self.folder / 'data' / 'pull-requests.json', interval=60)
        self.now = 1000.0

    def repository(self, name, remote):
        repo = self.folder / name
        repo.mkdir()
        for argv in (['init', '-q', '-b', 'feature/fixture'], ['remote', 'add', 'origin', remote]):
            subprocess.run(['git', '-C', str(repo), *argv], check=True, capture_output=True)
        return str(repo)

    def answer(self, data=None, code=0, stderr='', name='pr.json'):
        (self.fake / name).write_text(json.dumps({'code': code, 'stdout': data if data is not None else '', 'stderr': stderr}))

    def poll(self, repo=None, advance=60):
        self.now += advance
        self.prs.poll([{'id': 'term-1', 'exit_code': None, 'repo': repo or self.repo}], self.now)

    def calls(self):
        log = self.fake / 'calls.log'
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def test_a_branch_pull_request_is_summarised_for_its_folder(self):
        self.answer(pull_request([run('lint', 'COMPLETED', 'SUCCESS')], isDraft=True, reviewDecision='APPROVED'))
        self.poll()
        status = self.prs.status(self.repo)
        self.assertEqual({k: status[k] for k in ('number', 'state', 'review', 'checks', 'total', 'branch')},
                         {'number': 42, 'state': 'draft', 'review': 'approved', 'checks': 'passing', 'total': 1, 'branch': 'feature/fixture'})
        self.assertEqual(self.calls()[0][1:4], ['pr', 'view', '--json'])

    def test_no_pull_request_signed_out_or_missing_gh_shows_nothing(self):
        self.answer(code=1, stderr='no pull requests found for branch "feature/fixture"')
        self.poll()
        self.assertIsNone(self.prs.status(self.repo))
        self.answer(code=4, stderr='To get started with GitHub CLI, please run:  gh auth login')
        self.poll()
        self.assertIsNone(self.prs.status(self.repo))
        self.answer(pull_request())
        with mock.patch.dict(os.environ, {'PATH': f'/usr/bin{os.pathsep}/bin'}):
            self.poll()
        self.assertIsNone(self.prs.status(self.repo))
        self.assertEqual(self.prs.snapshot(), {'events': []})

    def test_a_github_enterprise_remote_shows_its_pull_request(self):
        enterprise = self.repository('corp-repo', 'git@ghe.example-corp.test:platform/corp-repo.git')
        job = 'https://ghe.example-corp.test/platform/corp-repo/actions/runs/9/job/31'
        self.answer(pull_request([run('build', 'COMPLETED', 'FAILURE', job)], url='https://ghe.example-corp.test/platform/corp-repo/pull/7', number=7),
                    name='pr-corp-repo.json')
        self.poll(enterprise)
        status = self.prs.status(enterprise)
        self.assertEqual((status['number'], status['url'], status['checks'], status['logs']),
                         (7, 'https://ghe.example-corp.test/platform/corp-repo/pull/7', 'failing', True))
        self.answer('build\tCompile\t2026-10-28T10:00:00Z error: fixture', name='log.json')
        self.assertEqual(self.prs.failure_log(enterprise)['log'], 'error: fixture')
        self.assertEqual(self.calls()[-1][1:], ['run', 'view', '--job', '31', '--log-failed'])

    def test_a_host_gh_does_not_know_is_asked_rarely_and_a_local_remote_never(self):
        other = self.repository('elsewhere', 'https://gitlab.example.test/team/elsewhere.git')
        self.answer(code=1, stderr='none of the git remotes configured for this repository point to a known GitHub host. '
                    'To tell gh about a new GitHub host, please use `gh auth login`', name='pr-elsewhere.json')
        self.poll(other)
        self.poll(other)
        self.poll(other)
        self.assertIsNone(self.prs.status(other))
        self.assertEqual(len(self.calls()), 1)
        self.poll(other, advance=1800)
        self.assertEqual(len(self.calls()), 2, 'asked again later, in case gh has since signed in to that host')
        local = self.repository('mirror', str(self.folder / 'example-repo'))
        self.poll(local)
        self.assertEqual(len(self.calls()), 2)

    def test_polls_wait_for_the_interval(self):
        self.answer(pull_request())
        self.poll()
        self.poll(advance=30)
        self.assertEqual(len(self.calls()), 1)
        self.poll(advance=31)
        self.assertEqual(len(self.calls()), 2)

    def test_checks_turning_failed_and_new_reviews_reach_the_inbox_once(self):
        self.answer(pull_request([run('lint', 'COMPLETED', 'SUCCESS'), run('unit', 'IN_PROGRESS')]))
        self.poll()
        self.assertEqual(self.prs.snapshot()['events'], [], 'the first look is only a baseline')
        self.answer(pull_request([run('lint', 'COMPLETED', 'SUCCESS'), run('unit', 'COMPLETED', 'FAILURE')]))
        self.poll()
        self.poll()
        events = self.prs.snapshot()['events']
        self.assertEqual([(e['kind'], e['category'], e['terminal'], e['number']) for e in events], [('checks', 'attention', 'term-1', 42)])
        self.assertIn('[unit](' + JOB_URL + ')', events[0]['detail'])
        review = {'id': 'R_1', 'author': {'login': 'fixture-reviewer'}, 'state': 'CHANGES_REQUESTED'}
        self.answer(pull_request([run('unit', 'COMPLETED', 'FAILURE')], [review], reviewDecision='CHANGES_REQUESTED'))
        self.poll()
        self.poll()
        events = self.prs.snapshot()['events']
        self.assertEqual(len(events), 2)
        self.assertEqual(events[1]['title'], 'fixture-reviewer requested changes on #42 Fixture change')
        self.assertEqual(events[1]['category'], 'attention')
        saved = json.loads((self.folder / 'data' / 'pull-requests.json').read_text())
        self.assertEqual([e['id'] for e in saved], [e['id'] for e in events])
        self.prs.review({'id': events[0]['id'], 'state': 'done'})
        reopened = PullRequests(self.folder / 'data' / 'pull-requests.json')
        self.assertEqual(reopened.snapshot()['events'][0]['state'], 'done')
        with self.assertRaisesRegex(ValueError, 'Invalid'):
            self.prs.review({'id': events[0]['id'], 'state': 'gone'})

    def test_a_brief_gh_failure_keeps_the_last_answer_then_clears_it(self):
        self.answer(pull_request())
        self.poll()
        self.answer(code=1, stderr='error connecting to api.github.com')
        self.poll()
        self.poll()
        self.assertEqual(self.prs.status(self.repo)['number'], 42)
        self.poll()
        self.assertIsNone(self.prs.status(self.repo))

    def test_failure_log_is_the_tail_of_the_failed_actions_job(self):
        self.answer(pull_request([run('unit', 'COMPLETED', 'FAILURE')]))
        self.poll()
        lines = ''.join(f'unit\tRun tests\t2026-10-28T10:00:{i:02d}Z line {i}\n' for i in range(80))
        self.answer(lines, name='log.json')
        failure = self.prs.failure_log(self.repo, lines=5)
        self.assertEqual(failure['check'], 'unit')
        self.assertEqual(failure['log'].splitlines(), [f'line {i}' for i in range(75, 80)])
        self.assertEqual(self.calls()[-1][1:], ['run', 'view', '--job', '11', '--log-failed'])
        self.answer(pull_request([run('unit', 'COMPLETED', 'SUCCESS')]))
        self.poll()
        with self.assertRaisesRegex(ValueError, 'no failing checks'):
            self.prs.failure_log(self.repo)


if __name__ == '__main__':
    unittest.main()
