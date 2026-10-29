"""Each terminal's pull requests, read with the GitHub CLI on a modest interval.

A terminal's main pull request is the one for the branch its folder has checked out. Pull request
links the terminal prints (gh pr create prints one, agents paste theirs) join it as well.

Nothing here reaches the page as an error: without gh, a sign-in, a GitHub remote or a pull
request for the branch, a folder simply has no pull request. GitHub Enterprise works the same way:
gh knows which hosts it is signed into, so any remote with a host is asked about."""
import base64
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
from pathlib import Path

FIELDS = 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup,latestReviews,headRefName'
FAILED = {'FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'}
PASSED = {'SUCCESS', 'NEUTRAL', 'SKIPPED'}
HOSTED = re.compile(r'^(?:[a-z][a-z0-9+.-]*://(?:[^@/]+@)?[^/:@]+|[^@/\s]+@[^:/\s]+:)', re.I)
VERBS = {'APPROVED': 'approved', 'CHANGES_REQUESTED': 'requested changes on', 'COMMENTED': 'reviewed'}
JOB_URL = re.compile(r'^https://[^/]+/[\w.-]+/[\w.-]+/actions/runs/\d+/job(?:s)?/(\d+)')
PR_LINK = re.compile(r'https://[\w.-]+/[\w.-]+/[\w.-]+/pull/\d+')
# Hyperlinks a TUI draws (OSC 8) carry the whole address even when the visible text is wrapped.
OSC8 = re.compile(r'\x1b\]8;[^;\x07\x1b]*;(https://[^\x07\x1b]+)(?:\x07|\x1b\\)')
ESCAPES = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]')
# What `gh pr merge` prints once GitHub has merged: "Squashed and merged pull request owner/repo#42 (title)",
# "Merged pull request #42 (title)" or "Pull request owner/repo#42 was already merged".
MERGED = re.compile(r'\bmerged pull request (\S*#\d+)|\bpull request (\S*#\d+) was already merged', re.I)
# gh prefixes each log line with its job, step and timestamp.
STAMP = re.compile(r'^\d{4}-\d\d-\d\dT[\d:.]+Z ')
EVENT_LIMIT = 200
# A transient gh failure keeps the last answer for a couple of polls rather than flickering the chip.
TOLERATED_FAILURES = 2
# A remote gh doesn't know (GitLab, or an Enterprise host not signed into) is asked again only this often.
UNKNOWN_HOST_RECHECK = 1800
# Printed pull requests that are merged or closed leave the list after a day.
CLOSED_KEPT = 86400
LINKS_PER_TERMINAL = 20
SCAN_CHUNKS = 32
SCAN_OVERLAP = 400
# Coming back to the desk re-checks before the next poll, but not more often than this. A merge printed in a
# terminal is rarer, so it waits less; a redrawn screen can print the same line again.
RECHECK_GAP = 15
MERGE_RECHECK_GAP = 3


def run(argv, cwd, timeout=20):
    return subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)


def branch_of(repo):
    result = run(['git', '-C', repo, 'symbolic-ref', '--quiet', '--short', 'HEAD'], repo, 5)
    return result.stdout.strip() or None if result.returncode == 0 else None


def hosted_remote(repo):
    result = run(['git', '-C', repo, 'remote', '-v'], repo, 5)
    return result.returncode == 0 and any(HOSTED.match(line.split()[1]) for line in result.stdout.splitlines() if len(line.split()) > 1)


def links_in(text):
    """Pull request links in terminal output, in the order they appear."""
    links = [m.group(1) for m in OSC8.finditer(text) if PR_LINK.fullmatch(m.group(1).rstrip('/'))]
    plain = ESCAPES.sub('', text)
    for match in PR_LINK.finditer(plain):
        # A link that ends at a line break followed by digits was wrapped mid-number, so it is not trusted.
        if re.match(r'\r?\n\d', plain[match.end():match.end() + 3]):
            continue
        links.append(match.group(0))
    return list(dict.fromkeys(link.rstrip('/') for link in links))


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
            'review': str(data.get('reviewDecision') or '').lower() or None, 'branch': str(data.get('headRefName') or '')[:200] or None,
            'checks': checks, 'failed': failed[:10], 'total': total, 'logs': any(JOB_URL.match(c['url']) for c in failed)}


def reviews_of(data):
    return {str(r.get('id')): ((r.get('author') or {}).get('login') or 'Someone', str(r.get('state') or '').upper())
            for r in data.get('latestReviews') or [] if r.get('id') and str(r.get('state') or '').upper() in VERBS}


class PullRequests:
    def __init__(self, path, interval=None, output=None):
        self.path = Path(path)
        self.interval = interval or float(os.environ.get('AGENT_DESK_PR_POLL_SECONDS') or 90)
        # output(terminal, cursor) returns {data: base64, cursor}: the terminal's bytes from cursor.
        self.output = output
        self.lock = threading.Lock()
        self.folders = {}
        self.links = {}
        self.printed = {}
        self.cursors = {}
        self.overlap = {}
        self.repos = {}
        self.merges = {}
        self.stopping = threading.Event()
        self.woken = threading.Event()
        try:
            saved = json.loads(self.path.read_text())
        except (OSError, ValueError):
            saved = []
        # Earlier versions saved only the list of Inbox items.
        saved = {'events': saved} if isinstance(saved, list) else saved if isinstance(saved, dict) else {}
        self.events = [e for e in saved.get('events') or [] if isinstance(e, dict)]
        self.forgotten = {key: set(value) for key, value in (saved.get('forgotten') or {}).items() if isinstance(value, list)}

    def status(self, repo, terminal=None, now=None):
        """The terminal's main pull request with the others it printed under 'others', or None."""
        now = time.time() if now is None else now
        with self.lock:
            entry = self.folders.get(repo) if repo else None
            hidden = self.forgotten.get(terminal, ())
            main = dict(entry['pr'], branch=entry['branch'], seen=None) if entry and entry['pr'] and entry['pr']['url'] not in hidden else None
            others = []
            for url, seen in reversed(list(self.printed.get(terminal, {}).items())):
                link = self.links.get(url)
                if not link or not link['pr'] or url in hidden or (main and url == main['url']):
                    continue
                if link['closed'] and now - link['closed'] > CLOSED_KEPT:
                    continue
                others.append(dict(link['pr'], seen=seen))
            if not main and not others:
                return None
            main = main or others.pop(0)
            return dict(main, others=others)

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

    def forget(self, terminal, url, repo=None):
        """Stop showing a pull request in this terminal, even if it is printed again: one it printed, or
        its folder's branch pull request. A new pull request on that branch has a new URL, so it still shows."""
        with self.lock:
            entry = self.folders.get(repo) if repo else None
            if url not in self.printed.get(terminal, {}) and not (entry and entry['pr'] and entry['pr']['url'] == url):
                raise ValueError('This terminal is not showing that pull request')
            self.forgotten.setdefault(terminal, set()).add(url)
            self.printed.get(terminal, {}).pop(url, None)
            self.save()
        return {'ok': True}

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix('.tmp')
        temp.write_text(json.dumps({'events': self.events[-EVENT_LIMIT:], 'forgotten': {k: sorted(v) for k, v in self.forgotten.items() if v}}, indent=2) + '\n')
        os.replace(temp, self.path)

    def scan(self, terminal, now):
        """Read the terminal's new output for pull request links. True when it shows a merge it hasn't shown before."""
        cursor, text = self.cursors.get(terminal, 0), ''
        for _ in range(SCAN_CHUNKS):
            chunk = self.output(terminal, cursor)
            data = base64.b64decode(chunk.get('data') or '')
            cursor = chunk.get('cursor', cursor)
            if not data:
                break
            text += data.decode(errors='replace')
        self.cursors[terminal] = cursor
        if not text:
            return False
        # A link split across two reads is found in the overlap kept from the last one.
        text = self.overlap.get(terminal, '') + text
        self.overlap[terminal] = text[-SCAN_OVERLAP:]
        found = [url for url in links_in(text) if url not in self.forgotten.get(terminal, ())]
        with self.lock:
            printed = self.printed.setdefault(terminal, {})
            for url in found:
                printed.setdefault(url, now)
            for url in list(printed)[:-LINKS_PER_TERMINAL]:
                printed.pop(url)
            # A screen that is redrawn prints the same merge again; only the first time counts.
            seen = self.merges.setdefault(terminal, set())
            merges = {a or b for a, b in MERGED.findall(ESCAPES.sub('', text))} - seen
            seen.update(merges)
        return bool(merges)

    def hurry(self, terminals, now=None, gap=RECHECK_GAP):
        """Check these terminals' pull requests at the next tick instead of the next poll: a merge or a
        review on GitHub usually comes just before someone looks. Only open and draft pull requests are asked
        about again, since merged and closed ones rarely change, and ones checked in the last gap seconds wait."""
        now = time.time() if now is None else now
        with self.lock:
            repos = {self.repos.get(terminal) for terminal in terminals}
            entries = [self.folders[repo] for repo in repos if repo in self.folders]
            entries += [self.links[url] for terminal in terminals for url in self.printed.get(terminal, {}) if url in self.links]
            for entry in entries:
                # A folder with no pull request, or a remote gh doesn't know, keeps its usual wait.
                if entry['pr'] and entry['pr']['state'] in ('open', 'draft') and entry['next'] - now <= self.interval:
                    entry['next'] = min(entry['next'], max(now, entry['next'] - self.interval + gap))
        self.woken.set()

    def poll(self, terminals, now=None):
        """terminals: running local sessions with their repo; one gh call per due repo or printed link."""
        now = time.time() if now is None else now
        gh = shutil.which('gh')
        repos, running, repo_of = {}, {}, {}
        for terminal in terminals:
            if terminal.get('exit_code') is None:
                running[terminal['id']] = terminal.get('cwd')
                if terminal.get('repo'):
                    repos.setdefault(terminal['repo'], terminal['id'])
                    repo_of[terminal['id']] = terminal['repo']
        with self.lock:
            self.repos = repo_of
            for repo in [r for r in self.folders if r not in repos or not gh]:
                del self.folders[repo]
            for store in (self.printed, self.cursors, self.overlap, self.merges):
                for terminal in [t for t in store if t not in running]:
                    del store[terminal]
        if not gh:
            with self.lock:
                self.links.clear()
            return
        merged = []
        if self.output:
            for terminal in running:
                try:
                    if self.scan(terminal, now):
                        merged.append(terminal)
                except (OSError, ValueError, KeyError, TypeError):
                    continue
        if merged:
            self.hurry(merged, now, MERGE_RECHECK_GAP)
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
        with self.lock:
            # A printed link that is some folder's branch pull request is already polled there.
            branch_urls = {entry['pr']['url'] for entry in self.folders.values() if entry['pr']}
            wanted = {}
            for terminal, printed in self.printed.items():
                for url in printed:
                    if url not in branch_urls:
                        wanted.setdefault(url, terminal)
            for url in [u for u in self.links if u not in wanted]:
                del self.links[url]
        for url, terminal in wanted.items():
            if self.stopping.is_set():
                break
            link = self.links.get(url)
            if link and now < link['next']:
                continue
            try:
                self.observe_link(gh, url, terminal, running.get(terminal), now)
            except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
                with self.lock:
                    self.links[url] = dict(link or {'pr': None, 'reviews': {}, 'failures': 0, 'closed': None}, next=now + self.interval)

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
                self.compare(previous, pr, reviews, Path(repo).name, branch, terminal, now)

    def observe_link(self, gh, url, terminal, cwd, now):
        previous = self.links.get(url)
        result = run([gh, 'pr', 'view', url, '--json', FIELDS], cwd if cwd and os.path.isdir(cwd) else None, 25)
        if result.returncode != 0:
            failures = (previous or {}).get('failures', 0) + 1
            with self.lock:
                kept = previous if previous and failures <= TOLERATED_FAILURES else {'pr': None, 'reviews': {}, 'closed': None}
                self.links[url] = dict(kept, failures=failures, next=now + self.interval)
            return
        data = json.loads(result.stdout)
        pr, reviews = summary(data), reviews_of(data)
        closed = None if pr['state'] in ('open', 'draft') else (previous or {}).get('closed') or now
        with self.lock:
            self.links[url] = {'pr': pr, 'reviews': reviews, 'failures': 0, 'closed': closed, 'next': now + self.interval}
            if previous and previous['pr']:
                self.compare(previous, pr, reviews, url.split('/')[4], pr['branch'] or f"#{pr['number']}", terminal, now)

    def compare(self, previous, pr, reviews, repo_name, branch, terminal, now):
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
            self.events.append(dict(item, id='pr-' + secrets.token_hex(8), terminal=terminal, repo=repo_name, branch=branch,
                                    number=pr['number'], url=pr['url'], state='review', created=now))
        if added:
            del self.events[:-EVENT_LIMIT]
            self.save()

    def failure_log(self, cwd, repo, terminal, url=None, lines=60):
        """The failed log tail of the first failing GitHub Actions job on one of this terminal's pull requests."""
        gh = shutil.which('gh')
        status = self.status(repo, terminal)
        candidates = [status, *status['others']] if status else []
        pr = next((p for p in candidates if p['url'] == url), None) if url else status
        if not gh or not pr or pr['checks'] != 'failing':
            raise ValueError('This pull request has no failing checks')
        check = next((c for c in pr['failed'] if JOB_URL.match(c['url'])), None)
        if not check:
            raise ValueError('The failing checks are not GitHub Actions jobs, so there is no log to send')
        result = run([gh, 'run', 'view', '--job', JOB_URL.match(check['url']).group(1), '--log-failed'], repo or cwd, 30)
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
                self.woken.wait(min(5, self.interval))
                self.woken.clear()
        threading.Thread(target=loop, daemon=True).start()
