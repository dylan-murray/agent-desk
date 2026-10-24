"""Read-only, per-profile account allowance. Never starts a model turn.

Claude's /api/oauth/usage is an internal CLI endpoint, not a public API contract.
Read existing credentials only; never rotate tokens or alter either login store.
"""
import copy
from datetime import datetime
import getpass
import hashlib
import json
import math
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.request

from agent_desk.accounts import account, config_folder, harness_of, label as account_label
from agent_desk.launch_profiles import profile_command, terminal_environment



class QuotaError(ValueError):
    pass


def number(value):
    return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)


def window(label, used, reset):
    if not number(used) or used<0:return None
    if isinstance(reset,str):
        try:reset=datetime.fromisoformat(reset.replace('Z','+00:00')).timestamp()
        except ValueError:reset=None
    if not number(reset) or reset<=0:reset=None
    return dict(label=label,used_percent=used,remaining_percent=max(0,100-used),resets_at=reset)


def claude_windows(data):
    if not isinstance(data,dict):return []
    result=[]
    for key,label in [('five_hour','5 hours'),('seven_day','Weekly'),('seven_day_opus','Opus weekly'),('seven_day_sonnet','Sonnet weekly')]:
        item=data.get(key)
        if isinstance(item,dict):
            row=window(label,item.get('utilization'),item.get('resets_at'))
            if row:result.append(row)
    extra=data.get('extra_usage')
    if isinstance(extra,dict) and extra.get('is_enabled') is True:
        row=window('Monthly extra-usage budget',extra.get('utilization'),None)
        if row:result.append(row)
    if not result:
        spend=data.get('spend')
        if isinstance(spend,dict) and spend.get('enabled') is True:
            used=spend.get('used') or {};limit=spend.get('limit') or {}
            a,b=used.get('amount_minor'),limit.get('amount_minor')
            if number(a) and number(b) and b>0 and used.get('currency')==limit.get('currency') and used.get('exponent')==limit.get('exponent'):
                row=window('Spending allowance',100*a/b,None)
                if row:result.append(row)
    return result


def codex_windows(data):
    buckets=data.get('rateLimitsByLimitId')
    if not isinstance(buckets,dict) or not buckets:buckets={'codex':data.get('rateLimits')}
    result=[]
    for key,bucket in sorted(buckets.items(),key=lambda pair:pair[0]!='codex')[:12]:
        if not isinstance(bucket,dict):continue
        for name in ('primary','secondary'):
            item=bucket.get(name)
            if not isinstance(item,dict):continue
            minutes=item.get('windowDurationMins')
            label=('Weekly' if minutes==10080 else f'{minutes/60:g} hours' if number(minutes) and minutes>=60 else f'{minutes:g} min' if number(minutes) else name.title())
            if len(buckets)>1:label=str(bucket.get('limitName') or key)[:80]+' · '+label
            row=window(label,item.get('usedPercent'),item.get('resetsAt'))
            if row:
                row['bucket']=str(bucket.get('limitName') or key)[:80]
                row['account_bucket']=True
                result.append(row)
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None


def claude_token(profile):
    folder=config_folder(profile)
    raw=None
    if sys.platform=='darwin':
        suffix='-'+hashlib.sha256(unicodedata.normalize('NFC',str(folder)).encode()).hexdigest()[:8] if account(profile)['config_dir'] else ''
        service='Claude Code-credentials'+suffix
        proc=subprocess.run(['/usr/bin/security','find-generic-password','-s',service,'-a',getpass.getuser(),'-w'],capture_output=True,timeout=8)
        if proc.returncode==0:raw=proc.stdout
    if raw is None:
        path=folder/'.credentials.json'
        if path.is_symlink() or not path.is_file() or path.stat().st_size>1_000_000:raise QuotaError('Saved CLI login is unavailable')
        raw=path.read_bytes()
    credentials=json.loads(raw).get('claudeAiOauth',{})
    token=credentials.get('accessToken')
    if not isinstance(token,str) or not token:raise QuotaError('No subscription login in this profile')
    expires=credentials.get('expiresAt')
    if number(expires) and expires/1000<=time.time():raise QuotaError('Saved login expired; use this profile’s Claude CLI to refresh it')
    return token


def fetch_claude(profile):
    token=claude_token(profile)
    request=urllib.request.Request('https://api.anthropic.com/api/oauth/usage',headers={'Authorization':'Bearer '+token,'anthropic-beta':'oauth-2025-04-20','Accept':'application/json'})
    try:
        with urllib.request.build_opener(NoRedirect).open(request,timeout=10) as response:
            data=response.read(1_000_001)
        if len(data)>1_000_000:raise QuotaError('Quota response exceeded its size limit')
        return claude_windows(json.loads(data))
    except urllib.error.HTTPError as error:
        if error.code in (401,403):raise QuotaError('Quota unavailable for this saved login; check /usage in its Claude CLI') from None
        if error.code==429:raise QuotaError('Usage service is busy; retrying later') from None
        raise QuotaError('Claude usage service is unavailable') from None


def fetch_codex(profile):
    env=terminal_environment(os.environ,profile)
    argv=profile_command(['/bin/zsh','-lic',profile+' "$@"','agent-desk','app-server','--listen','stdio://'],profile)
    # No thread/start or turn/start is ever sent. Authentication stays inside Codex.
    with subprocess.Popen(argv,env=env,cwd=str(Path.home()),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True) as proc:
        def send(obj):proc.stdin.write((json.dumps(obj)+'\n').encode());proc.stdin.flush()
        try:
            send({'id':1,'method':'initialize','params':{'clientInfo':{'name':'agentdesk_quota','version':'1.0'}}})
            pending=b'';total=0;deadline=time.monotonic()+18
            with selectors.DefaultSelector() as selector:
                selector.register(proc.stdout,selectors.EVENT_READ)
                while time.monotonic()<deadline:
                    if not selector.select(.2):continue
                    chunk=os.read(proc.stdout.fileno(),65536)
                    if not chunk:break
                    pending+=chunk;total+=len(chunk)
                    if total>1_000_000:raise QuotaError('Quota response exceeded its size limit')
                    while b'\n' in pending:
                        line,pending=pending.split(b'\n',1)
                        try:event=json.loads(line)
                        except ValueError:continue
                        if not isinstance(event,dict):continue
                        if event.get('id')==1:
                            if 'error' in event:raise QuotaError('Installed Codex does not support quota queries')
                            send({'method':'initialized'})
                            send({'id':2,'method':'account/rateLimits/read'})
                        elif event.get('id')==2:
                            if 'error' in event:raise QuotaError('Quota unavailable for this Codex login')
                            return codex_windows(event.get('result',{}))
            raise QuotaError('Codex quota request timed out')
        finally:
            if proc.poll() is None:
                os.killpg(proc.pid,signal.SIGTERM)
                try:proc.wait(2)
                except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait()


class AccountQuota:
    """One in-flight fetch per account profile, shared across coordinator panes."""
    def __init__(self,fetcher=None,clock=time.time):
        self.fetcher=fetcher or (lambda profile:fetch_claude(profile) if harness_of(profile)=='claude' else fetch_codex(profile))
        self.clock=clock;self.lock=threading.Lock();self.cache={};self.pending=set();self.attempted={}

    def read(self,profile,refresh=False):
        if profile!='grok' and not account(profile):raise QuotaError('Unknown account profile')
        base={'profile':profile,'label':account_label(profile),'windows':[],'fetched_at':None}
        if harness_of(profile)=='grok':
            return base|{'state':'unsupported','message':'Grok account allowance is not connected to Agent Desk. Use /usage inside Grok; its usage CLI subcommand only reports session spending.'}
        if harness_of(profile) not in ('claude','codex'):
            return base|{'state':'unsupported','message':account_label(profile)+' account allowance is not connected to Agent Desk.'}
        with self.lock:
            now=self.clock()
            if profile not in self.pending and now-self.attempted.get(profile,-float('inf'))>=(15 if refresh else 120):
                self.pending.add(profile);self.attempted[profile]=now
                threading.Thread(target=self._fetch,args=(profile,),daemon=True,name='quota-'+profile).start()
            data=copy.deepcopy(self.cache.get(profile,base|{'state':'loading','message':'Checking account quota…'}))
            data['refreshing']=profile in self.pending
            if data.get('fetched_at') and (now-data['fetched_at']>300 or any(w['resets_at'] and w['resets_at']<=now for w in data['windows'])):
                data['state']='stale'
            return data

    def _fetch(self,profile):
        try:
            rows=self.fetcher(profile)
            update={'profile':profile,'label':account_label(profile),'windows':rows,'fetched_at':self.clock(),'state':'ready' if rows else 'unavailable','message':'' if rows else 'No quota windows reported for this account'}
        except Exception as error:
            # Never expose CLI stderr, credentials or raw provider response bodies.
            message=str(error) if isinstance(error,QuotaError) else 'Could not retrieve account quota; retrying later'
            update={'profile':profile,'label':account_label(profile),'windows':[],'fetched_at':None,'state':'unavailable','message':message}
        with self.lock:
            if update['state']=='unavailable' and self.cache.get(profile,{}).get('windows'):
                update=self.cache[profile]|{'state':'stale','message':update['message']}
            self.cache[profile]=update;self.pending.discard(profile)
