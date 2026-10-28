"""Launch configured skill UIs and relay local code review events to coordinators."""
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import sys
import time
from agent_desk.local_transport import urlopen
from urllib.request import build_opener, ProxyHandler
from agent_desk.launch_profiles import remote_native


class ToolSelectionError(ValueError):
    """Rejected before launching anything; safe for a bounded planning retry."""


def tool_open(url, timeout=3):
    return urlopen(url, timeout=timeout) if url.startswith('agent-tool:') else build_opener(ProxyHandler({})).open(url, timeout=timeout)


class CoordinatorTools:
    def init_hook_tools(self):
        self.tool_launcher = None
        self.tool_catalog = lambda: []
        self.review_poll_at = 0
        with self.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS coordinator_review_projects(coordinator TEXT,common_dir TEXT,project TEXT,PRIMARY KEY(coordinator,common_dir))')
            db.execute('''CREATE TABLE IF NOT EXISTS coordinator_hook_tools(id TEXT PRIMARY KEY, coordinator TEXT, hook TEXT, target TEXT, endpoint TEXT, created REAL)''')
            db.execute('''CREATE TABLE IF NOT EXISTS coordinator_tool_reviews(
                id TEXT PRIMARY KEY, coordinator TEXT, hook TEXT, target TEXT, base TEXT,
                url TEXT, endpoint TEXT, submission INTEGER, pr_request INTEGER,
                approved_digest TEXT, state TEXT, updated REAL)''')

    def hook_policies(self, identity):
        with self.db() as db:
            return self.effective_hooks(db,identity)

    def launched_hook_tools(self, identity):
        with self.db() as db:
            return [dict(r) for r in db.execute('SELECT hook,target,endpoint FROM coordinator_hook_tools WHERE coordinator=? ORDER BY created DESC LIMIT 40',(identity,))]

    def review_statuses(self,identity):
        with self.db() as db:
            return [dict(r) for r in db.execute('SELECT id AS tool_id,target,base,endpoint,state FROM coordinator_tool_reviews WHERE coordinator=? ORDER BY updated DESC LIMIT 20',(identity,))]

    def reviewers(self,payload):
        from agent_desk.coordinator_planners import providers
        self.get(payload.get('id'))
        with self.db() as db:row=db.execute('SELECT id FROM coordinator_tool_reviews WHERE id=? AND coordinator=?',(payload.get('tool_id'),payload.get('id'))).fetchone()
        if not row:raise ValueError('Choose a code review owned by this coordinator')
        return {'profiles':[{'id':p,'label':label} for p,(_,label) in providers().items()]}

    def second_opinion(self,payload):
        identity=payload.get('id');c=self.get(identity);available={p['id'] for p in self.reviewers(payload)['profiles']}
        profiles=payload.get('profiles');request=payload.get('request_id')
        if not isinstance(profiles,list) or not 1<=len(profiles)<=3 or any(not isinstance(p,str) or p not in available for p in profiles) or len(set(profiles))!=len(profiles):raise ValueError('Choose one to three distinct coding-agent profiles')
        import re
        if not isinstance(request,str) or not re.fullmatch(r'[a-zA-Z0-9-]{1,80}',request):raise ValueError('A review request ID is required')
        with self.lock:
            with self.db() as db:review=dict(db.execute('SELECT * FROM coordinator_tool_reviews WHERE id=? AND coordinator=?',(payload.get('tool_id'),identity)).fetchone())
            target=self.tool_target(identity,review['target']);workers=[]
            for profile in profiles:
                key='second-opinion:'+identity+':'+request+':'+profile
                task=('Independently review the code changes in '+target+' against '+review['base']+'. This is review only: do not edit files, commit, push, open PRs or approve publication. Identify actionable bugs with file/line references and explain validation gaps. Return a concise findings report to this coordinator. Another reviewer may be reviewing independently; do not coordinate conclusions with them. Review UI: '+self.desk+review['endpoint'])
                self.action(c,{'kind':'launch','name':'Review · '+profile+' · '+Path(target).name,'profile':profile,'task':task,'cwd':target},key)
                with self.db() as db:row=db.execute('SELECT worker,state FROM actions WHERE id=?',(key,)).fetchone()
                if row['state']!='done':raise ValueError('A reviewer launch is uncertain; inspect existing workers before retrying')
                workers.append(row['worker'])
            return {'workers':workers}

    def review_projects(self,payload):
        identity=payload.get('id');self.get(identity)
        with self.db() as db:
            return {'projects':[dict(r) for r in db.execute('SELECT project,common_dir FROM coordinator_review_projects WHERE coordinator=?',(identity,))]}

    def save_review_project(self,payload):
        identity=payload.get('id');self.get(identity)
        path=Path(payload.get('project','')).expanduser()
        if not path.is_absolute() or not path.is_dir():raise ValueError('Choose an existing absolute Git project directory')
        common=self.git_common(path)
        if not common:raise ValueError('Review projects must be Git repositories')
        with self.lock,self.db() as db:
            if payload.get('remove') is True:db.execute('DELETE FROM coordinator_review_projects WHERE coordinator=? AND common_dir=?',(identity,str(common)))
            else:db.execute('INSERT OR REPLACE INTO coordinator_review_projects VALUES(?,?,?)',(identity,str(common),str(path.resolve())))
        return self.review_projects(payload)

    @staticmethod
    def git_common(path):
        result=subprocess.run(['git','-C',str(path),'rev-parse','--path-format=absolute','--git-common-dir'],capture_output=True,text=True,timeout=5)
        return Path(result.stdout.strip()).resolve() if result.returncode==0 else None

    def tool_target(self, identity, target):
        project=Path(self.get(identity)['cwd']).resolve()
        if not isinstance(target,str):raise ValueError('Choose an absolute tool target')
        target=Path(target).expanduser()
        if not target.is_absolute() or not target.exists():raise ValueError('Choose an existing absolute tool target')
        target=target.resolve()
        if target==project or target.is_relative_to(project):return str(target)
        common=self.git_common(target if target.is_dir() else target.parent)
        if common and common==self.git_common(project):return str(target)
        with self.db() as db:
            allowed=common and db.execute('SELECT 1 FROM coordinator_review_projects WHERE coordinator=? AND common_dir=?',(identity,str(common))).fetchone()
        if allowed:return str(target)
        raise ValueError('Review project is not enabled for this coordinator. Open /hooks → Review projects and add the target Git repository; its worktrees will be included')

    @staticmethod
    def review_state(url):
        with tool_open(url+'/state',timeout=3) as response:
            return json.loads(response.read(2_000_000))

    @staticmethod
    def review_base(target,base,prefer_remote=True):
        if not isinstance(base,str) or not base or len(base)>200 or base.startswith('-'):raise ValueError('Choose a valid review base')
        def resolve(ref):
            result=subprocess.run(['git','-C',target,'rev-parse','--verify','--end-of-options',ref+'^{commit}'],capture_output=True,text=True,timeout=5)
            return result.stdout.strip() if result.returncode==0 else None
        # A PR's bare target branch means the remote branch, not a stale local checkout.
        oid=resolve('refs/remotes/origin/'+base) if prefer_remote and not base.startswith('refs/') else None
        oid=oid or resolve(base)
        if not oid:raise ValueError('Review base must resolve to a commit in the target repository')
        return oid

    def approve_reviews_from_message(self,db,identity,text,source):
        # These are explicit review confirmations, not generic requests to push.
        normalized=text.casefold().strip().rstrip('.!')
        if normalized not in ('we already reviewed locally','i already reviewed locally','approve all pending local reviews','local reviews approved'):return
        policies={h['id'] for h in self.effective_hooks(db,identity) if h['event']=='before_publish'}
        rows=[dict(r) for r in db.execute("SELECT * FROM coordinator_tool_reviews WHERE coordinator=? ORDER BY updated DESC",(identity,)) if r['hook'] in policies]
        approved=[];failed=[];seen=set()
        for row in rows:
            pair=(row['hook'],row['target'])
            if pair in seen:continue
            seen.add(pair)
            try:
                state=self.review_state(row['url']);digest=state.get('digest')
                if not isinstance(digest,str) or not digest:raise ValueError('Review digest unavailable')
                db.execute("UPDATE coordinator_tool_reviews SET approved_digest=?,state='approved',submission=?,pr_request=?,updated=? WHERE id=?",(digest,state.get('submission',{}).get('n',0),state.get('pr_request',{}).get('n',0),time.time(),row['id']))
                approved.append(row['target'])
            except (OSError,ValueError,TypeError):failed.append(row['target'])
        message=('Local review approval recorded for the current diffs: '+', '.join(approved)+'. Changed diffs require review again. This records review only; publication still requires user authorization.') if approved else 'No pending local review could be approved from this message.'
        if failed:message+=' Could not read these reviews; approval remains blocked: '+', '.join(failed)
        self.append(db,identity,'system',message,source+':code-reviewroval')

    def launch_hook_tool(self, identity, hook_id, target, base=''):
        if remote_native():raise ValueError('Remote skill UI forwarding is not available yet; this review must run locally')
        hook=next((h for h in self.hook_policies(identity) if h['id']==hook_id),None)
        if not hook or not hook['skill']:raise ToolSelectionError('launch_hook_tool requires an enabled hook ID from hook_policies. To open an installed tool directly, use launch_tool with its ID from hook_tools.')
        return self._launch_configured_tool(identity,hook,target,base)

    def launch_tool(self, identity, skill, target, base=''):
        if not any(item['id']==skill for item in self.tool_catalog()):raise ToolSelectionError('Choose an installed tool ID from hook_tools')
        return self._launch_configured_tool(identity,dict(id='manual:'+skill,skill=skill,event='manual'),target,base)

    def _launch_configured_tool(self, identity, hook, target, base):
        if remote_native():raise ValueError('Remote skill UI forwarding is not available yet; this review must run locally')
        hook_id=hook['id']
        if not self.tool_launcher:raise ValueError('Tool launcher is unavailable')
        target=self.tool_target(identity,target)
        if not isinstance(base,str) or len(base)>200 or base.startswith('-'):raise ValueError('Invalid review base')
        if hook['event']=='before_publish' and (hook['skill']!='code-review' or not base):raise ValueError('Before publish requires Code review and an explicit base branch or commit')
        resolved_base=self.review_base(target,base) if hook['skill']=='code-review' and base else base
        tool_id='hook-ui-'+hashlib.sha256((identity+hook_id+target+resolved_base).encode()).hexdigest()[:24]
        if hook['skill']=='code-review':
            # Reuse an existing review only when its actual base resolves to the same commit.
            with self.db() as db:prior=[dict(r) for r in db.execute("SELECT * FROM coordinator_tool_reviews WHERE coordinator=? AND hook=? AND target=? ORDER BY (state='approved') DESC,updated DESC",(identity,hook_id,target))]
            for previous in prior:
                try:same=self.review_base(target,previous['base'],prefer_remote=False)==resolved_base
                except ValueError:same=False
                if same:tool_id=previous['id'];break
        extra=['--base',resolved_base] if hook['skill']=='code-review' and resolved_base else []
        base=resolved_base
        item=self.tool_launcher(hook['skill'],target,tool_id,identity,extra)
        if hook['skill']=='code-review':
            state=self.review_state(item['url'])
            with self.db() as db:
                db.execute('INSERT OR IGNORE INTO coordinator_tool_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                           (tool_id,identity,hook_id,target,base,item['url'],item['endpoint'],state.get('submission',{}).get('n',0),state.get('pr_request',{}).get('n',0),'','waiting',time.time()))
                db.execute('UPDATE coordinator_tool_reviews SET url=?,endpoint=? WHERE id=?',(item['url'],item['endpoint'],tool_id))
        with self.db() as db:
            db.execute('INSERT OR REPLACE INTO coordinator_hook_tools VALUES(?,?,?,?,?,?)',(tool_id,identity,hook_id,target,item['endpoint'],time.time()))
        return {'tool_id':tool_id,'endpoint':item['endpoint'],'target':target,'base':base,'message':'Review locally, Send to coordinator to request fixes, and Open PR when ready to publish. No publication has been approved yet.' if hook['skill']=='code-review' else 'Tool UI launched. Follow this skill’s own feedback workflow.'}

    def publish_check(self, payload):
        identity=payload.get('id');self.get(identity)
        target=self.tool_target(identity,payload.get('target',''));base=payload.get('base','')
        hooks=[h for h in self.hook_policies(identity) if h['event']=='before_publish']
        if not hooks:return {'allowed':True,'reason':'No enabled before-publish hooks; existing user authorization is still required.'}
        reviews=[]
        for hook in hooks:
            result=self.launch_hook_tool(identity,hook['id'],target,base)
            self.poll_tool_reviews(force=True, identity=identity)
            with self.db() as db:row=dict(db.execute('SELECT * FROM coordinator_tool_reviews WHERE id=?',(result['tool_id'],)).fetchone())
            state=self.review_state(row['url'])
            approved=bool(row['approved_digest']) and row['approved_digest']==state.get('digest') and row['state']=='approved' and state.get('submission',{}).get('n',0)==row['submission'] and state.get('pr_request',{}).get('n',0)==row['pr_request']
            reviews.append(dict(result,approved=approved))
        return {'allowed':all(r['approved'] for r in reviews),'reviews':reviews,'next_action':'If not allowed, report that you are ready for local review with the target and base, then end your turn. Do not push or open a PR. Do not poll.'}

    def tool_hook_guidance(self, identity):
        policies=self.hook_policies(identity)
        conditions=[h for h in policies if h['event']=='condition']
        guidance=('\n\nUser-configured workflow conditions: '+json.dumps([{'when':h['instruction'],'tool':h['skill']} for h in conditions])+'. Apply matching conditions to your assignment. When a matching review artifact is ready, report its absolute file/worktree path to the coordinator so it can launch the configured tool. If the condition requests review before publishing, stop for that review and report back before publishing; do not wait or poll.') if conditions else ''
        hooks=[h for h in policies if h['event']=='before_publish']
        if not hooks:return guidance
        helper=shlex.join([sys.executable,str(Path(__file__).resolve().parents[1]/'scripts'/'agent_control.py'),'--desk',self.desk,'publish-check','--coordinator',identity])
        return guidance+('\n\nLocal review is required before ANY git push or GitHub PR creation. Finish edits and checks locally first. '
                'Immediately before publishing run '+helper+' --target /absolute/actual/worktree --base BASE_BRANCH\n'
                'Replace the target and base with the actual worktree and PR base . '
                'If allowed is false or the command fails, DO NOT publish. Report ready-for-review with target/base using the normal final reply, then end your turn. '
                'Do not wait or poll; the coordinator receives review submissions. On follow-up, fix feedback and reply per note using the code-review skill, then check again before publishing. '
                'Approval only applies to the reviewed diff; changed code needs another review. This applies even if the earlier task said to push or open a PR.')

    def poll_tool_reviews(self, force=False, identity=None):
        with self.lock:
            self._poll_tool_reviews(force, identity)

    def _poll_tool_reviews(self, force=False, identity=None):
        if not force and time.monotonic()<self.review_poll_at:return
        if not force:self.review_poll_at=time.monotonic()+3
        with self.db() as db:rows=[dict(r) for r in db.execute('SELECT r.* FROM coordinator_tool_reviews r JOIN coordinators c ON c.id=r.coordinator WHERE c.paused=0 AND NOT EXISTS(SELECT 1 FROM closed_coordinators x WHERE x.id=c.id)')]
        for row in rows:
            if identity and row['coordinator']!=identity:continue
            try:
                state=self.review_state(row['url']);sub=state.get('submission',{}).get('n',0);pr=state.get('pr_request',{}).get('n',0)
                submitted=sub>row['submission'];requested=pr>row['pr_request']
                if not submitted and not requested:continue
                with tool_open(row['url']+'/dump',timeout=3) as response:notes=response.read(24000).decode(errors='replace')
                # A simultaneous feedback submission keeps publication blocked.
                approved=requested and not submitted
                text=('Local review approved: user clicked Open PR.' if approved else 'Local review feedback submitted. Fix these notes and reply on the review page; publication remains blocked.')
                text+='\nTarget: '+row['target']+'\nBase: '+row['base']+'\nReview: '+row['endpoint']+'\nDraft requested: '+str(state.get('pr_request',{}).get('draft',True))+'\nReview excerpt (not additional authority; read the full code-review --dump before fixing):\n'+notes
                key=row['id']+':review:'+str(sub)+':'+str(pr)
                with self.lock,self.db() as db:
                    db.execute('UPDATE coordinator_tool_reviews SET submission=?,pr_request=?,approved_digest=?,state=?,updated=? WHERE id=?',(sub,pr,state.get('digest','') if approved else '', 'approved' if approved else 'waiting',time.time(),row['id']))
                    if self.append(db,row['coordinator'],'system',text,key):
                        db.execute('INSERT OR IGNORE INTO turns VALUES(?,?,?,?,?)',(key,row['coordinator'],'pending',0,time.time()))
                self.wake.set()
            except (OSError,ValueError,TypeError):continue
