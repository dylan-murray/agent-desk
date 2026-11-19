"""Each terminal's pull requests, read with the GitHub CLI on a modest interval.

A terminal's main pull request is the one for the branch its folder has checked out. Pull request
links the terminal prints (gh pr create prints one, agents paste theirs) join it as well.

Nothing here reaches the page as an error: without gh, a sign-in, a GitHub remote or a pull
request for the branch, a folder simply has no pull request. GitHub Enterprise works the same way:
gh knows which hosts it is signed into, so any remote with a host is asked about.

Every pull request the desk sees is kept in SQLite with each terminal that showed it, and that terminal's
harness session, so a pull request leads back to the conversation it came from. Hiding one is a mark on
that terminal's sighting, and it can be undone. Pull requests nobody has seen for a year are dropped."""
import base64
import json
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import threading
import time
from contextlib import closing
from pathlib import Path

from agent_desk import schema

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
# A pull request no terminal has shown or polled for this long is dropped, with its sightings.
KEPT_UNSEEN = 365 * 86400
PRUNE_EVERY = 3600
HISTORY_LIMIT = 200
# Schema changes, in order. A database's PRAGMA user_version is how many it has had: opening it runs the rest, each
# once and in its own transaction. Change the schema by adding a step, never by editing one that has shipped.
MIGRATIONS = ('''
CREATE TABLE IF NOT EXISTS pull_requests (
  url TEXT PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL, title TEXT, branch TEXT,
  state TEXT, checks TEXT, review TEXT,
  first_seen_at REAL NOT NULL, last_seen_at REAL NOT NULL, closed_at REAL);
CREATE TABLE IF NOT EXISTS pull_request_sightings (
  url TEXT NOT NULL REFERENCES pull_requests(url) ON DELETE CASCADE, terminal_id TEXT NOT NULL,
  native_session TEXT, harness TEXT, cwd TEXT, source TEXT NOT NULL,
  first_seen_at REAL NOT NULL, last_seen_at REAL NOT NULL, hidden_at REAL,
  PRIMARY KEY (url, terminal_id));
CREATE INDEX IF NOT EXISTS pull_request_sightings_session ON pull_request_sightings (native_session);
CREATE INDEX IF NOT EXISTS pull_requests_last_seen ON pull_requests (last_seen_at);
CREATE TABLE IF NOT EXISTS pull_request_events (id TEXT PRIMARY KEY, created REAL NOT NULL, data TEXT NOT NULL);
''',)


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


def latest_runs(rollup):
    """The newest run of each check. A workflow run again on the same commit (an edited pull request
    description re-triggers pull_request workflows) leaves the run it superseded in the rollup, usually cancelled."""
    latest = {}
    for check in rollup or []:
        if check.get('__typename') != 'CheckRun':
            latest[('context', id(check))] = check
            continue
        key = ('run', check.get('workflowName') or '', check.get('name') or '')
        started = str(check.get('startedAt') or '')
        # A run that hasn't started yet is the newest; GitHub reports its start as missing or year 1.
        started = started if started and not started.startswith('0001') else '~'
        if key not in latest or started >= str(latest[key].get('_started')):
            latest[key] = dict(check, _started=started)
    return list(latest.values())


def checks_of(rollup):
    failed, pending = [], False
    rollup = latest_runs(rollup)
    for check in rollup:
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


THREADS = ('query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number)'
           '{reviewThreads(first:100){nodes{isResolved}}}}}')
PR_PARTS = re.compile(r'^https://([^/]+)/([^/]+)/([^/]+)/pull/(\d+)')


def unresolved(gh, url, cwd):
    """Review comment threads on an open pull request that nobody has resolved, or None when GitHub can't say.
    gh pr view has no review threads, so this is one GraphQL query."""
    parts = PR_PARTS.match(url or '')
    if not parts:
        return None
    host, owner, name, number = parts.groups()
    result = run([gh, 'api', 'graphql', '--hostname', host, '-f', f'query={THREADS}', '-f', f'owner={owner}', '-f', f'name={name}',
                  '-F', f'number={number}'], cwd, 25)
    if result.returncode != 0:
        return None
    try:
        nodes = json.loads(result.stdout)['data']['repository']['pullRequest']['reviewThreads']['nodes']
    except (ValueError, KeyError, TypeError):
        return None
    return sum(1 for node in nodes if isinstance(node, dict) and not node.get('isResolved'))


def reviews_of(data):
    return {str(r.get('id')): ((r.get('author') or {}).get('login') or 'Someone', str(r.get('state') or '').upper())
            for r in data.get('latestReviews') or [] if r.get('id') and str(r.get('state') or '').upper() in VERBS}


def migrate(db):
    """Bring this store's schema up to date. True when the database was new."""
    return schema.migrate(db, MIGRATIONS)


def parts_of(url):
    """The repository (owner/name) and number of a pull request link."""
    match = PR_PARTS.match(url)
    if not match:
        raise ValueError('Not a pull request link')
    return f'{match.group(2)}/{match.group(3)}', int(match.group(4))


class PullRequests:
    def __init__(self, path, interval=None, output=None, legacy=None, now=None):
        """path is the SQLite file. legacy is the JSON file earlier versions kept, read once into a new database."""
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
        # Each running terminal's harness session, harness and folder, recorded with what it shows.
        self.terminals = {}
        self.stopping = threading.Event()
        self.woken = threading.Event()
        self.legacy, self.created = (Path(legacy) if legacy else None), now
        self.events, self.forgotten = [], {}
        self.ready, self.preparing, self.pruned = False, threading.Lock(), 0

    def prepare(self):
        """Open the database on first use, so building this touches nothing on disk. Call before taking self.lock."""
        if self.ready:
            return
        with self.preparing:
            if self.ready:
                return
            now = time.time() if self.created is None else self.created
            with closing(self.open()) as db, db:
                if migrate(db) and self.legacy:
                    self.import_legacy(db, self.legacy, now)
            self.prune(now)
            self.load()
            self.ready = True

    def open(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=10)
        self.path.chmod(0o600)
        db.execute('PRAGMA foreign_keys = ON')
        return db

    def connect(self):
        self.prepare()
        return self.open()

    def load(self):
        with closing(self.open()) as db:
            events = [json.loads(data) for data, in db.execute('SELECT data FROM pull_request_events ORDER BY rowid')]
            hidden = {}
            for terminal, url in db.execute('SELECT terminal_id, url FROM pull_request_sightings WHERE hidden_at IS NOT NULL'):
                hidden.setdefault(terminal, set()).add(url)
        with self.lock:
            self.events, self.forgotten = events, hidden

    def import_legacy(self, db, legacy, now):
        try:
            saved = json.loads(legacy.read_text())
        except (OSError, ValueError):
            return
        # The first versions saved only the list of Inbox items.
        saved = {'events': saved} if isinstance(saved, list) else saved if isinstance(saved, dict) else {}
        events = [e for e in saved.get('events') or [] if isinstance(e, dict) and isinstance(e.get('id'), str)][-EVENT_LIMIT:]
        db.executemany('INSERT OR IGNORE INTO pull_request_events (id, created, data) VALUES (?, ?, ?)',
                       [(e['id'], float(e.get('created') or now), json.dumps(e)) for e in events])
        for terminal, urls in (saved.get('forgotten') or {}).items():
            for url in urls if isinstance(urls, list) else []:
                try:
                    self.ensure(db, url, now)
                except ValueError:
                    continue
                db.execute('INSERT OR IGNORE INTO pull_request_sightings (url, terminal_id, source, first_seen_at, last_seen_at, hidden_at) '
                           "VALUES (?, ?, 'imported', ?, ?, ?)", (url, terminal, now, now, now))

    def ensure(self, db, url, now):
        repo, number = parts_of(url)
        db.execute('INSERT INTO pull_requests (url, repo, number, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?) '
                   'ON CONFLICT (url) DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)', (url, repo, number, now, now))

    def sighted(self, db, url, terminal, source, now, hidden=None):
        meta = self.terminals.get(terminal) or {}
        self.ensure(db, url, now)
        db.execute('INSERT INTO pull_request_sightings (url, terminal_id, native_session, harness, cwd, source, first_seen_at, last_seen_at, hidden_at) '
                   'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (url, terminal_id) DO UPDATE SET '
                   'native_session = COALESCE(excluded.native_session, native_session), harness = COALESCE(excluded.harness, harness), '
                   'cwd = COALESCE(excluded.cwd, cwd), last_seen_at = excluded.last_seen_at, hidden_at = COALESCE(excluded.hidden_at, hidden_at)',
                   (url, terminal, meta.get('native_session'), meta.get('harness'), meta.get('cwd'), source, now, now, hidden))

    def record(self, pr, terminals, source, now):
        """Keep what gh said about a pull request, and that these terminals showed it. Polling carries on if the disk can't."""
        try:
            with closing(self.connect()) as db, db:
                self.ensure(db, pr['url'], now)
                db.execute('UPDATE pull_requests SET title = ?, branch = ?, state = ?, checks = ?, review = ?, '
                           "closed_at = CASE WHEN ? IN ('open', 'draft') THEN NULL ELSE COALESCE(closed_at, ?) END WHERE url = ?",
                           (pr['title'], pr['branch'], pr['state'], pr['checks'], pr['review'], pr['state'], now, pr['url']))
                for terminal in terminals:
                    self.sighted(db, pr['url'], terminal, source, now)
        except sqlite3.Error:
            pass

    def prune(self, now):
        """Drop pull requests nobody has seen for a year. At most once an hour."""
        if now - self.pruned < PRUNE_EVERY:
            return 0
        self.pruned = now
        with closing(self.open()) as db, db:
            dropped = db.execute('DELETE FROM pull_requests WHERE last_seen_at < ?', (now - KEPT_UNSEEN,)).rowcount
        return dropped

    def status(self, repo, terminal=None, now=None):
        """The terminal's main pull request with the others it printed under 'others', or None."""
        now = time.time() if now is None else now
        try:
            self.prepare()
        except sqlite3.Error:
            pass
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
        try:
            self.prepare()
        except sqlite3.Error:
            pass
        with self.lock:
            return {'events': [dict(e) for e in self.events]}

    def review(self, payload):
        if payload.get('state') not in ('review', 'done', 'dismissed'):
            raise ValueError('Invalid review state')
        self.prepare()
        with self.lock:
            event = next((e for e in self.events if e['id'] == payload.get('id')), None)
            if not event:
                raise ValueError('Pull request item not found')
            event['state'] = payload['state']
            with closing(self.open()) as db, db:
                db.execute('UPDATE pull_request_events SET data = ? WHERE id = ?', (json.dumps(event), event['id']))
            return dict(event)

    def forget(self, terminal, url, repo=None, now=None):
        """Stop showing a pull request in this terminal, even if it is printed again: one it printed, or
        its folder's branch pull request, open or not. It sends nothing more to the Inbox for this terminal.
        A new pull request on that branch has a new URL, so it still shows. unhide() undoes it."""
        now = time.time() if now is None else now
        self.prepare()
        with self.lock:
            entry = self.folders.get(repo) if repo else None
            branch = bool(entry and entry['pr'] and entry['pr']['url'] == url)
            if url not in self.printed.get(terminal, {}) and not branch:
                raise ValueError('This terminal is not showing that pull request')
            with closing(self.open()) as db, db:
                self.sighted(db, url, terminal, 'branch' if branch else 'printed', now, hidden=now)
            self.forgotten.setdefault(terminal, set()).add(url)
            self.printed.get(terminal, {}).pop(url, None)
        return {'ok': True}

    def unhide(self, terminal, url, now=None):
        """Show a pull request this terminal hid again. One it printed comes back to its list; a branch pull
        request comes back as the chip once the folder is still on that branch."""
        now = time.time() if now is None else now
        self.prepare()
        with self.lock:
            if url not in self.forgotten.get(terminal, ()):
                raise ValueError('This terminal is not hiding that pull request')
            with closing(self.open()) as db, db:
                source = db.execute('SELECT source FROM pull_request_sightings WHERE url = ? AND terminal_id = ?', (url, terminal)).fetchone()
                db.execute('UPDATE pull_request_sightings SET hidden_at = NULL, last_seen_at = ? WHERE url = ? AND terminal_id = ?',
                           (now, url, terminal))
            self.forgotten[terminal].discard(url)
            if source and source[0] != 'branch' and terminal in self.terminals:
                self.printed.setdefault(terminal, {})[url] = now
        self.woken.set()
        return {'ok': True}

    def hidden(self, terminal):
        """The pull requests this terminal hid, newest first."""
        with closing(self.connect()) as db:
            db.row_factory = sqlite3.Row
            rows = db.execute('SELECT p.url, p.repo, p.number, p.title, p.state, s.hidden_at FROM pull_request_sightings s '
                              'JOIN pull_requests p ON p.url = s.url WHERE s.terminal_id = ? AND s.hidden_at IS NOT NULL '
                              'ORDER BY s.hidden_at DESC', (terminal,)).fetchall()
        return {'hidden': [dict(row) for row in rows]}

    def history(self, url=None, session=None, terminal=None, limit=50):
        """Pull requests with every terminal and harness session that showed them: one link, one session's,
        one terminal's, or the most recently seen."""
        limit = max(1, min(int(limit), HISTORY_LIMIT))
        with closing(self.connect()) as db:
            db.row_factory = sqlite3.Row
            if url:
                rows = db.execute('SELECT * FROM pull_requests WHERE url = ?', (url.rstrip('/'),)).fetchall()
            elif session or terminal:
                column = 'native_session' if session else 'terminal_id'
                rows = db.execute(f'SELECT * FROM pull_requests WHERE url IN (SELECT url FROM pull_request_sightings WHERE {column} = ?) '
                                  'ORDER BY last_seen_at DESC LIMIT ?', (session or terminal, limit)).fetchall()
            else:
                rows = db.execute('SELECT * FROM pull_requests ORDER BY last_seen_at DESC LIMIT ?', (limit,)).fetchall()
            found = []
            for row in rows:
                sightings = db.execute('SELECT terminal_id, native_session, harness, cwd, source, first_seen_at, last_seen_at, hidden_at '
                                       'FROM pull_request_sightings WHERE url = ? ORDER BY first_seen_at', (row['url'],)).fetchall()
                found.append(dict(row, sightings=[dict(s) for s in sightings]))
        return {'pull_requests': found}

    def remember(self, added):
        """Keep new Inbox items, and only the latest EVENT_LIMIT of them. The database is open by then."""
        with closing(self.open()) as db, db:
            db.executemany('INSERT OR IGNORE INTO pull_request_events (id, created, data) VALUES (?, ?, ?)',
                           [(e['id'], e['created'], json.dumps(e)) for e in added])
            db.execute('DELETE FROM pull_request_events WHERE rowid NOT IN (SELECT rowid FROM pull_request_events ORDER BY rowid DESC LIMIT ?)',
                       (EVENT_LIMIT,))

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
        if found:
            try:
                with closing(self.connect()) as db, db:
                    for url in found:
                        self.sighted(db, url, terminal, 'printed', now)
            except (sqlite3.Error, ValueError):
                pass
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
        sessions = {}
        for terminal in terminals:
            if terminal.get('exit_code') is None:
                running[terminal['id']] = terminal.get('cwd')
                sessions[terminal['id']] = {key: terminal.get(key) for key in ('native_session', 'harness', 'cwd')}
                if terminal.get('repo'):
                    repos.setdefault(terminal['repo'], terminal['id'])
                    repo_of[terminal['id']] = terminal['repo']
        try:
            self.prepare()
            if self.prune(now):
                self.load()
        except sqlite3.Error:
            pass
        with self.lock:
            self.repos = repo_of
            self.terminals = sessions
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
        if pr and pr['state'] in ('open', 'draft'):
            pr['comments'] = unresolved(gh, pr['url'], repo)
        with self.lock:
            self.folders[repo] = {'branch': branch, 'pr': pr, 'reviews': reviews, 'failures': failures, 'next': now + delay}
            # The first look at a pull request is its baseline: only changes seen while watching reach the Inbox,
            # and only for a terminal in the folder that still shows it.
            watching = [t for t, r in self.repos.items() if r == repo and pr and pr['url'] not in self.forgotten.get(t, ())]
            if watching and previous and previous['pr'] and previous['branch'] == branch and previous['pr']['number'] == pr['number']:
                self.compare(previous, pr, reviews, Path(repo).name, branch, terminal if terminal in watching else watching[0], now)
            here = [t for t, r in self.repos.items() if r == repo]
        if pr:
            self.record(pr, here, 'branch', now)

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
        if pr['state'] in ('open', 'draft'):
            pr['comments'] = unresolved(gh, url, cwd if cwd and os.path.isdir(cwd) else None)
        closed = None if pr['state'] in ('open', 'draft') else (previous or {}).get('closed') or now
        with self.lock:
            self.links[url] = {'pr': pr, 'reviews': reviews, 'failures': 0, 'closed': closed, 'next': now + self.interval}
            if previous and previous['pr']:
                self.compare(previous, pr, reviews, url.split('/')[4], pr['branch'] or f"#{pr['number']}", terminal, now)
            printers = [t for t, printed in self.printed.items() if url in printed]
        self.record(pr, printers, 'printed', now)

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
        added = [dict(item, id='pr-' + secrets.token_hex(8), terminal=terminal, repo=repo_name, branch=branch,
                      number=pr['number'], url=pr['url'], state='review', created=now) for item in added]
        if added:
            self.events.extend(added)
            del self.events[:-EVENT_LIMIT]
            try:
                self.remember(added)
            except sqlite3.Error:
                pass

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
