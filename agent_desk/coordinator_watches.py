"""Durable GitHub PR monitors: read-only polling, no model work when unchanged."""
import hashlib
import json
import os
import re
import secrets
import shutil
import threading
import time
from urllib.request import Request, urlopen
from agent_desk.coordinator_planners import run_command

PR_URL=re.compile(r'https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)/?$')


def pr_fingerprint(data):
    def stamp(items):
        return sorted((str(x.get('id','')),x.get('updatedAt',x.get('updated_at',x.get('submittedAt',''))),
                       hashlib.sha256(str(x.get('body','')).encode()).hexdigest(),x.get('state','')) for x in items)
    checks=sorted((x.get('name',x.get('context','')),x.get('status',''),x.get('conclusion',x.get('state',''))) for x in data.get('statusCheckRollup',[]))
    return json.dumps(dict(state=data.get('state'),head=data.get('headRefOid'),decision=data.get('reviewDecision'),
                           checks=checks,comments=stamp(data.get('comments',[])),reviews=stamp(data.get('reviews',[])),inline=stamp(data.get('inlineComments',[]))),sort_keys=True)


class CoordinatorWatches:
    def init_watches(self):
        self.watch_thread=None;self.watch_poll_lock=threading.Lock()
        with self.db() as db:db.execute('''CREATE TABLE IF NOT EXISTS coordinator_watches(
            id TEXT PRIMARY KEY,coordinator TEXT,url TEXT,state TEXT,baseline TEXT,next_check REAL,last_change REAL,
            expires REAL,failures INTEGER,generation TEXT,detail TEXT)''')

    def watches(self,identity):
        with self.db() as db:return [dict(r) for r in db.execute('SELECT id,url,state,next_check,last_change,expires,failures,detail FROM coordinator_watches WHERE coordinator=? ORDER BY rowid DESC',(identity,))]

    def watch_pr(self,payload):
        identity=payload.get('id');self.get(identity);url=payload.get('url','')
        if not isinstance(url,str) or not PR_URL.fullmatch(url):raise ValueError('Use a github.com pull request URL')
        url=url.rstrip('/')
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            existing=db.execute("SELECT id FROM coordinator_watches WHERE coordinator=? AND url=? AND state='watching'",(identity,url)).fetchone()
            if existing:return {'id':existing['id'],'watching':True,'reused':True}
            if db.execute("SELECT COUNT(*) FROM coordinator_watches WHERE state='watching'").fetchone()[0]>=32:raise ValueError('Monitor limit reached (32); stop an existing monitor first')
            key='watch-'+secrets.token_hex(10);now=time.time()
            db.execute('INSERT INTO coordinator_watches VALUES(?,?,?,?,?,?,?,?,?,?,?)',(key,identity,url,'watching','',now,now,now+86400,0,secrets.token_hex(8),'Waiting for first GitHub check'))
        return {'id':key,'watching':True,'reused':False}

    def stop_watch(self,payload):
        identity=payload.get('id');self.get(identity)
        with self.db() as db:
            if not db.execute('SELECT 1 FROM coordinator_watches WHERE id=? AND coordinator=?',(payload.get('watch_id'),identity)).fetchone():raise ValueError('PR monitor not found in this coordinator')
            db.execute("UPDATE coordinator_watches SET state='stopped',detail='Stopped by user' WHERE id=? AND coordinator=?",(payload.get('watch_id'),identity))
        return {'stopped':True}

    def fetch_pr(self,c,url):
        gh=shutil.which('gh')
        if not gh:raise ValueError('GitHub CLI is unavailable; sign in with gh before enabling PR monitoring')
        owner,repo,number=PR_URL.fullmatch(url).groups()
        fields='state,mergedAt,headRefOid,reviewDecision,statusCheckRollup,comments,reviews'
        output=run_command([gh,'pr','view',url,'--json',fields],c['cwd'],os.environ,'',self.stopping,timeout=25)
        data=json.loads(output)
        # Latest edited inline comments are bounded independently of the main PR query.
        output=run_command([gh,'api','--method','GET',f'repos/{owner}/{repo}/pulls/{number}/comments?per_page=100&sort=updated&direction=desc'],c['cwd'],os.environ,'',self.stopping,timeout=25)
        data['inlineComments']=json.loads(output)
        if data.get('state') not in ('OPEN','CLOSED','MERGED'):raise ValueError('GitHub returned an unknown PR state')
        return data

    def fetch_watch(self, kind, url, cwd):
        """Shared observations for the coordinator poller and external event sources."""
        if kind == 'pr':
            data = self.fetch_pr({'cwd': cwd}, url)
            stamp = hashlib.sha256(pr_fingerprint(data).encode()).hexdigest()
            payload = dict(url=url, state=data['state'], head=data.get('headRefOid'),
                           review_decision=data.get('reviewDecision'), fingerprint=stamp,
                           checks=[{key: str(check.get(key, ''))[:200] for key in ('name', 'status', 'conclusion', 'state')}
                                   for check in data.get('statusCheckRollup', [])[:30]])
            return payload, stamp
        with urlopen(Request(url, headers={'User-Agent': 'Agent-Desk-local-watch'}), timeout=10) as response:
            content = response.read(1024 * 1024 + 1)
            if len(content) > 1024 * 1024:
                raise ValueError('URL response exceeds 1 MiB; choose a smaller resource')
            payload = dict(url=url, status=response.status, sha256=hashlib.sha256(content).hexdigest())
            return payload, json.dumps(payload, sort_keys=True)

    def poll_watches(self,now=None):
        if not self.watch_poll_lock.acquire(blocking=False):return
        try:
            now=time.time() if now is None else now
            with self.db() as db:rows=[dict(r) for r in db.execute("SELECT * FROM coordinator_watches WHERE state='watching' AND next_check<=? ORDER BY next_check LIMIT 8",(now,))]
            bus = getattr(self, 'event_bus', None)
            if bus:
                rows += [dict(row, bus_source=True) for row in bus.jobs(('pr', 'url'), now)]
                rows = sorted(rows, key=lambda row: row['next_check'])[:8]
            observations = {}
            for row in rows:
                if self.stopping.is_set():break
                if row.get('bus_source'):
                    try:
                        key = (row['kind'], row['settings']['url'])
                        if key not in observations:
                            observations[key] = self.fetch_watch(*key, str(bus.runtime.path.parent))
                        payload, baseline = observations[key]
                        bus.observe(row, payload, baseline, now)
                    except Exception as exc:
                        bus.observation_error(row, exc, now)
                    continue
                state='watching';event=None;baseline=row['baseline'];last=row['last_change'];failures=0;detail='No relevant changes';delay=180
                try:
                    if now>=row['expires']:
                        state='expired';event='PR monitor reached its 24-hour limit; monitoring stopped.'
                    else:
                        data=self.fetch_pr(self.get(row['coordinator']),row['url']);fresh=pr_fingerprint(data)
                        changed=baseline!=fresh
                        failed=any(x.get('conclusion',x.get('state','')) in ('FAILURE','ERROR','TIMED_OUT','CANCELLED','ACTION_REQUIRED') for x in data.get('statusCheckRollup',[]))
                        if data['state']!='OPEN':state=data['state'].lower();event='PR is '+state+'; monitoring stopped.'
                        elif changed and (baseline or failed):event='PR state changed'+(' · failing checks' if failed else '')+'. Inspect the snapshot before deciding whether work is needed.'
                        elif not changed and now-last>=7200:state='idle';event='PR monitor saw no relevant changes for two hours; monitoring stopped.'
                        if changed:last=now
                        baseline=fresh
                        if event:
                            ref=self.artifact(row['coordinator'],'GitHub snapshot '+row['url'],json.dumps(data,ensure_ascii=False,indent=2))
                            event+='\n'+row['url']+'\nSnapshot: '+ref+'\nThis is a GitHub observation, not a worker completion report. Existing workers still need their own final reply.'
                        detail=event.split('\n')[0] if event else 'Checked GitHub; no action needed'
                except Exception:
                    failures=row['failures']+1;delay=min(1800,180*2**min(failures,4))
                    detail='GitHub check failed; check gh login/network. Retrying with backoff.'
                    if failures==1:event=detail+'\n'+row['url']
                    if now>=row['expires']:state='expired'
                if event:detail=event.split('\n')[0]
                with self.lock,self.db() as db:
                    current=db.execute('SELECT state,generation FROM coordinator_watches WHERE id=?',(row['id'],)).fetchone()
                    if not current or current['state']!='watching' or current['generation']!=row['generation']:continue
                    if self.stopping.is_set():continue
                    if event:
                        event_key=row['id']+':'+secrets.token_hex(8)
                        self.append(db,row['coordinator'],'system',event,event_key)
                        db.execute('INSERT INTO turns VALUES(?,?,?,?,?)',(event_key,row['coordinator'],'pending',0,now))
                    db.execute('UPDATE coordinator_watches SET state=?,baseline=?,next_check=?,last_change=?,failures=?,detail=? WHERE id=?',(state,baseline,now+delay,last,failures,detail,row['id']))
                if event:self.wake.set()
        finally:self.watch_poll_lock.release()

    def start_watches(self):
        def loop():
            while not self.stopping.is_set():
                try:self.poll_watches()
                except Exception:pass
                self.stopping.wait(5)
        self.watch_thread=threading.Thread(target=loop,daemon=True);self.watch_thread.start()
