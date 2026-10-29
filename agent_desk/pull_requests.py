"""Each terminal's branch pull request, read with the GitHub CLI on a modest interval.

Nothing here reaches the page as an error: without gh, a sign-in, a GitHub remote or a pull
request for the branch, a folder simply has no pull request. GitHub Enterprise works the same way:
gh knows which hosts it is signed into, so any remote with a host is asked about."""
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
from pathlib import Path

FIELDS = 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup,latestReviews'
FAILED = {'FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'}
PASSED = {'SUCCESS', 'NEUTRAL', 'SKIPPED'}
HOSTED = re.compile(r'^(?:[a-z][a-z0-9+.-]*://(?:[^@/]+@)?[^/:@]+|[^@/\s]+@[^:/\s]+:)', re.I)
VERBS = {'APPROVED': 'approved', 'CHANGES_REQUESTED': 'requested changes on', 'COMMENTED': 'reviewed'}
JOB_URL = re.compile(r'^https://[^/]+/[\w.-]+/[\w.-]+/actions/runs/\d+/job(?:s)?/(\d+)')
# gh prefixes each log line with its job, step and timestamp.
STAMP = re.compile(r'^\d{4}-\d\d-\d\dT[\d:.]+Z ')
EVENT_LIMIT = 200
# A transient gh failure keeps the last answer for a couple of polls rather than flickering the chip.
TOLERATED_FAILURES = 2
# A remote gh doesn't know (GitLab, or an Enterprise host not signed into) is asked again only this often.
UNKNOWN_HOST_RECHECK = 1800


def run(argv, cwd, timeout=20):
    return subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)


def branch_of(repo):
    result = run(['git', '-C', repo, 'symbolic-ref', '--quiet', '--short', 'HEAD'], repo, 5)
    return result.stdout.strip() or None if result.returncode == 0 else None


def hosted_remote(repo):
    result = run(['git', '-C', repo, 'remote', '-v'], repo, 5)
    return result.returncode == 0 and any(HOSTED.match(line.split()[1]) for line in result.stdout.splitlines() if len(line.split()) > 1)


def checks_of(rollup):
    failed, pending = [], False
    for check in rollup or []:
        outcome = str(check.get('conclusion') or check.get('state') or '').upper()
        if outcome in FAILED:
            failed.append({'name': str(check.get('name') or check.get('context') or 'Check')[:120],
                           'url': str(check.get('detailsUrl') or check.get('targetUrl') or '')[:500]})
        elif outcome not in PASSED:
            pending = True
    state = 'failing' if failed else 'pending' if pending else 'passing' if rollup else None
    return state, failed, len(rollup or [])


def summary(data):
    checks, failed, total = checks_of(data.get('statusCheckRollup'))
    state = str(data.get('state') or '').upper()
    return {'number': data['number'], 'title': str(data.get('title') or '')[:300], 'url': data['url'],
            'state': 'merged' if state == 'MERGED' else 'closed' if state == 'CLOSED' else 'draft' if data.get('isDraft') else 'open',
            'review': str(data.get('reviewDecision') or '').lower() or None,
            'checks': checks, 'failed': failed[:10], 'total': total, 'logs': any(JOB_URL.match(c['url']) for c in failed)}


def reviews_of(data):
    return {str(r.get('id')): ((r.get('author') or {}).get('login') or 'Someone', str(r.get('state') or '').upper())
            for r in data.get('latestReviews') or [] if r.get('id') and str(r.get('state') or '').upper() in VERBS}


class PullRequests:
    def __init__(self, path, interval=None):
        self.path = Path(path)
        self.interval = interval or float(os.environ.get('AGENT_DESK_PR_POLL_SECONDS') or 90)
        self.lock = threading.Lock()
        self.folders = {}
        self.stopping = threading.Event()
        try:
            events = json.loads(self.path.read_text())
        except (OSError, ValueError):
            events = []
        self.events = [e for e in events if isinstance(e, dict)] if isinstance(events, list) else []

    def status(self, repo):
        with self.lock:
            entry = self.folders.get(repo)
            return dict(entry['pr'], branch=entry['branch']) if entry and entry['pr'] else None

    def snapshot(self):
        with self.lock:
            return {'events': [dict(e) for e in self.events]}

    def review(self, payload):
        if payload.get('state') not in ('review', 'done', 'dismissed'):
            raise ValueError('Invalid review state')
        with self.lock:
            event = next((e for e in self.events if e['id'] == payload.get('id')), None)
            if not event:
                raise ValueError('Pull request item not found')
            event['state'] = payload['state']
            self.save()
            return dict(event)

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix('.tmp')
        temp.write_text(json.dumps(self.events[-EVENT_LIMIT:], indent=2) + '\n')
        os.replace(temp, self.path)

    def poll(self, terminals, now=None):
        """terminals: running local sessions with their repo; one gh call per due repo."""
        now = time.time() if now is None else now
        gh = shutil.which('gh')
        repos = {}
        for terminal in terminals:
            if terminal.get('exit_code') is None and terminal.get('repo'):
                repos.setdefault(terminal['repo'], terminal['id'])
        with self.lock:
            for repo in [r for r in self.folders if r not in repos or not gh]:
                del self.folders[repo]
        if not gh:
            return
        for repo, terminal in repos.items():
            if self.stopping.is_set():
                break
            entry = self.folders.get(repo)
            if entry and now < entry['next']:
                continue
            try:
                self.observe(gh, repo, terminal, now)
            except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
                with self.lock:
                    self.folders[repo] = dict(entry or {'branch': None, 'pr': None, 'reviews': {}, 'failures': 0}, next=now + self.interval)

    def observe(self, gh, repo, terminal, now):
        previous = self.folders.get(repo)
        branch = branch_of(repo)
        data, failures, delay = None, 0, self.interval
        if branch and hosted_remote(repo):
            result = run([gh, 'pr', 'view', '--json', FIELDS], repo, 25)
            if result.returncode == 0:
                data = json.loads(result.stdout)
            elif 'known github host' in result.stderr.lower():
                delay = max(self.interval, UNKNOWN_HOST_RECHECK)
            elif 'no pull requests found' not in result.stderr.lower() and previous and previous['branch'] == branch:
                # Signed out, offline or rate limited: keep the last answer briefly, then show nothing.
                failures = previous.get('failures', 0) + 1
                if failures <= TOLERATED_FAILURES:
                    with self.lock:
                        self.folders[repo] = dict(previous, failures=failures, next=now + self.interval)
                    return
        pr, reviews = (summary(data), reviews_of(data)) if data else (None, {})
        with self.lock:
            self.folders[repo] = {'branch': branch, 'pr': pr, 'reviews': reviews, 'failures': failures, 'next': now + delay}
            # The first look at a pull request is its baseline: only changes seen while watching reach the Inbox.
            if previous and previous['pr'] and pr and previous['branch'] == branch and previous['pr']['number'] == pr['number']:
                self.compare(previous, pr, reviews, repo, branch, terminal, now)

    def compare(self, previous, pr, reviews, repo, branch, terminal, now):
        added = []
        old = previous['pr']
        if pr['checks'] == 'failing' and old['checks'] != 'failing' and pr['state'] in ('open', 'draft'):
            names = '\n'.join('- ' + (f"[{c['name']}]({c['url']})" if c['url'].startswith('https://') else c['name']) for c in pr['failed'])
            added.append(dict(kind='checks', category='attention', title=f"Checks failing · #{pr['number']} {pr['title']}",
                              detail=f"{len(pr['failed'])} of {pr['total']} checks failed on `{branch}`.\n\n{names}"))
        fresh = [reviews[key] for key in reviews if key not in previous.get('reviews', {})]
        if fresh:
            lines = '\n'.join(f'- {author} {VERBS[state]} the pull request' for author, state in fresh)
            who = fresh[0][0] if len(fresh) == 1 else f'{len(fresh)} reviewers'
            verb = VERBS[fresh[0][1]] if len(fresh) == 1 else 'reviewed'
            added.append(dict(kind='review', category='attention' if any(s == 'CHANGES_REQUESTED' for _, s in fresh) else 'review',
                              title=f"{who} {verb} #{pr['number']} {pr['title']}", detail=f'New review on `{branch}`.\n\n{lines}'))
        for item in added:
            self.events.append(dict(item, id='pr-' + secrets.token_hex(8), terminal=terminal, repo=Path(repo).name, branch=branch,
                                    number=pr['number'], url=pr['url'], state='review', created=now))
        if added:
            del self.events[:-EVENT_LIMIT]
            self.save()

    def failure_log(self, repo, lines=60):
        """The failed log tail of the first failing GitHub Actions job on this folder's pull request."""
        gh = shutil.which('gh')
        pr = self.status(repo)
        if not gh or not pr or pr['checks'] != 'failing':
            raise ValueError('This pull request has no failing checks')
        check = next((c for c in pr['failed'] if JOB_URL.match(c['url'])), None)
        if not check:
            raise ValueError('The failing checks are not GitHub Actions jobs, so there is no log to send')
        result = run([gh, 'run', 'view', '--job', JOB_URL.match(check['url']).group(1), '--log-failed'], repo, 30)
        if result.returncode != 0:
            raise ValueError('GitHub did not return the failed log')
        tail = [STAMP.sub('', line.split('\t', 2)[-1]) for line in result.stdout.splitlines() if line.strip()][-lines:]
        return dict(check=check['name'], number=pr['number'], url=check['url'], log='\n'.join(tail))

    def start(self, terminals):
        def loop():
            while not self.stopping.is_set():
                try:
                    self.poll(terminals())
                except Exception:
                    pass
                self.stopping.wait(min(5, self.interval))
        threading.Thread(target=loop, daemon=True).start()
