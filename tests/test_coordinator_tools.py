import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from io import BytesIO
from agent_desk.coordinator_runtime import CoordinatorRuntime
from scripts.control_mailbox import Mailbox
from test_coordinator_runtime import FakeTerminals


class ToolHookTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        subprocess.run(['git','init','-b','main',str(self.root)],check=True,capture_output=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','Fixture'],check=True,capture_output=True)
        self.runtime=CoordinatorRuntime(self.root/'coord.db',FakeTerminals(),Mailbox(self.root/'mail.db'),lambda *a:None)
        self.c=self.runtime.create({'cwd':str(self.root),'name':'Review','profile':'claude'})
        self.runtime.tool_catalog=lambda:[{'id':'code-review','title':'Code review','target':'directory'},{'id':'diagram-doc-creator','title':'Diagram','target':'file'}]
        self.launched=[]
        def launch(*args):
            self.launched.append(args);return {'url':'http://127.0.0.1:54321','endpoint':'/apps/'+args[2]}
        self.runtime.tool_launcher=launch
        self.state={'digest':'diff-1','submission':{'n':0},'pr_request':{'n':0}}
        self.runtime.review_state=lambda url:self.state
        self.hook=self.runtime.save_hook({'id':self.c['id'],'event':'before_publish','skill':'code-review','instruction':'Review locally before publication.','enabled':True})['hooks'][0]
        self.payload={'id':self.c['id'],'target':str(self.root),'base':'main'}
    def tearDown(self):self.runtime.close();self.tmp.cleanup()
    def poll(self):
        self.runtime.review_poll_at=0
        with patch('agent_desk.coordinator_tools.build_opener') as opener:
            opener.return_value.open.side_effect=lambda *a,**kw:BytesIO(b'Note 1: fix the diff and reply locally')
            self.runtime.poll_tool_reviews()
    def test_launch_wait_feedback_approval_and_changed_diff(self):
        self.assertFalse(self.runtime.publish_check(self.payload)['allowed'])
        self.assertEqual(self.launched[0][0],'code-review');self.assertEqual(self.launched[0][-1],['--base',self.runtime.review_base(str(self.root),'main')])
        self.state['submission']={'n':1};self.poll();self.poll()
        with self.runtime.db() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM turns').fetchone()[0],1)
        self.assertFalse(self.runtime.publish_check(self.payload)['allowed'])
        self.state['pr_request']={'n':1,'draft':True};self.poll()
        self.assertTrue(self.runtime.publish_check(self.payload)['allowed'])
        self.state['submission']={'n':2};self.assertFalse(self.runtime.publish_check(self.payload)['allowed'])
        self.state['digest']='diff-2';self.assertFalse(self.runtime.publish_check(self.payload)['allowed'])
        self.state['submission']={'n':2};self.state['pr_request']={'n':2};self.poll()
        self.assertFalse(self.runtime.publish_check(self.payload)['allowed'])
    def test_paused_review_does_not_wake_or_approve(self):
        self.runtime.publish_check(self.payload);self.runtime.pause(self.c['id']);self.state['pr_request']={'n':1};self.poll()
        self.assertFalse(self.runtime.publish_check(self.payload)['allowed'])
    def test_explicit_review_project_allows_its_worktrees_only(self):
        with tempfile.TemporaryDirectory() as other:
            repo=Path(other)/'repo';wt=Path(other)/'worktree';unrelated=Path(other)/'unrelated';unrelated.mkdir()
            subprocess.run(['git','clone',str(self.root),str(repo)],check=True,capture_output=True)
            subprocess.run(['git','-C',str(repo),'worktree','add','-b','review',str(wt)],check=True,capture_output=True)
            with self.assertRaises(ValueError):self.runtime.tool_target(self.c['id'],str(wt))
            self.runtime.save_review_project({'id':self.c['id'],'project':str(repo)})
            self.assertEqual(self.runtime.tool_target(self.c['id'],str(wt)),str(wt.resolve()))
            self.assertFalse(self.runtime.publish_check(dict(self.payload,target=str(wt)))['allowed'])
            with self.assertRaises(ValueError):self.runtime.tool_target(self.c['id'],str(unrelated))
            other_c=self.runtime.create({'cwd':str(self.root),'profile':'claude'})
            with self.assertRaises(ValueError):self.runtime.tool_target(other_c['id'],str(wt))
            self.runtime.save_review_project({'id':self.c['id'],'project':str(repo),'remove':True})
            with self.assertRaises(ValueError):self.runtime.tool_target(self.c['id'],str(wt))

    def test_multiple_second_opinions_are_scoped_and_idempotent(self):
        review=self.runtime.publish_check(self.payload)['reviews'][0]
        payload={'id':self.c['id'],'tool_id':review['tool_id'],'profiles':['grok','claude'],'request_id':'request-fixture'}
        result=self.runtime.second_opinion(payload)
        self.assertEqual(len(result['workers']),2)
        self.assertEqual(self.runtime.second_opinion(payload),result)
        self.assertEqual(len(self.runtime.terminals.sessions),2)
        self.assertTrue(all(p['cwd']==str(self.root.resolve()) for p in self.runtime.terminals.launched))
        tasks=self.runtime.mailbox.inbox(self.runtime.desk,self.c['id'],True)
        self.assertEqual(len(tasks),2)
        self.assertTrue(all('review only' in t['task'] for t in tasks))
        other=self.runtime.create({'cwd':str(self.root),'profile':'claude'})
        with self.assertRaises(ValueError):self.runtime.second_opinion(dict(payload,id=other['id']))
        with self.assertRaises(ValueError):self.runtime.second_opinion(dict(payload,profiles=[]))

    def test_missing_tool_wrong_project_and_base_fail_closed(self):
        with self.assertRaises(ValueError):self.runtime.publish_check(dict(self.payload,base=''))
        with tempfile.TemporaryDirectory() as other:
            with self.assertRaises(ValueError):self.runtime.publish_check(dict(self.payload,target=other))
        self.runtime.tool_launcher=None
        with self.assertRaises(ValueError):self.runtime.publish_check(self.payload)
    def test_worker_instructions_and_default_tool_persistence(self):
        self.assertIn('publish-check',self.runtime.tool_hook_guidance(self.c['id']))
        self.runtime.save_hook({'id':self.c['id'],'defaults':True,'event':'before_publish','skill':'code-review','instruction':'Review first','enabled':True})
        other=self.runtime.create({'cwd':str(self.root),'profile':'claude'})
        self.assertEqual(self.runtime.hook_policies(other['id'])[0]['skill'],'code-review')
        with self.assertRaises(ValueError):self.runtime.save_hook({'id':self.c['id'],'event':'before_publish','skill':'diagram-doc-creator','instruction':'Wrong','enabled':True})

    def test_open_condition_persists_reaches_workers_and_tracks_tool(self):
        self.runtime.tool_catalog=lambda:[{'id':'document-builder','title':'Document review','target':'file'}]
        result=self.runtime.save_hook({'id':self.c['id'],'skill':'document-builder','instruction':'If creating a Notion doc, open our document review skill.','enabled':True})
        hook=next(h for h in result['hooks'] if h['skill']=='document-builder')
        self.assertEqual(hook['event'],'condition')
        self.assertIn('If creating a Notion doc',self.runtime.tool_hook_guidance(self.c['id']))
        draft=self.root/'draft.md';draft.write_text('# Draft')
        self.runtime.launch_hook_tool(self.c['id'],hook['id'],str(draft))
        self.assertEqual(self.launched[-1][0],'document-builder')
        self.assertEqual(self.runtime.launched_hook_tools(self.c['id'])[0]['target'],str(draft.resolve()))
        self.runtime.launch_hook_tool(self.c['id'],hook['id'],str(draft))
        self.assertEqual(len(self.runtime.launched_hook_tools(self.c['id'])),1)
        self.runtime.save_hook({'id':self.c['id'],'hook_id':hook['id'],'event':'condition','skill':'document-builder','instruction':hook['instruction'],'enabled':False})
        self.assertNotIn('If creating a Notion doc',self.runtime.tool_hook_guidance(self.c['id']))
        with self.assertRaises(ValueError):self.runtime.launch_hook_tool(self.c['id'],hook['id'],str(draft))

    def test_user_review_confirmation_is_durable_but_not_generic_push(self):
        self.runtime.publish_check(self.payload)
        self.runtime.message(dict(id=self.c['id'],text='push the PRs',request_id='push'))
        self.assertFalse(self.runtime.publish_check(self.payload)['allowed'])
        self.runtime.message(dict(id=self.c['id'],text='we already reviewed locally',request_id='approval'))
        self.assertTrue(self.runtime.publish_check(self.payload)['allowed'])
        self.state['digest']='changed'
        self.runtime.message(dict(id=self.c['id'],text='we already reviewed locally',request_id='approval'))
        self.assertFalse(self.runtime.publish_check(self.payload)['allowed'])
        self.runtime.message(dict(id=self.c['id'],text='we already reviewed locally',request_id='new-approval'))
        self.assertTrue(self.runtime.publish_check(self.payload)['allowed'])

    def test_open_pr_immediately_reconciles_without_waiting_for_poll(self):
        self.runtime.publish_check(self.payload)
        self.state['pr_request']={'n':1}
        with patch('agent_desk.coordinator_tools.build_opener') as opener:
            opener.return_value.open.side_effect=lambda *a,**kw:BytesIO(b'Reviewed')
            self.assertTrue(self.runtime.publish_check(self.payload)['allowed'])
            self.assertTrue(self.runtime.publish_check(self.payload)['allowed'])
        with self.runtime.db() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM turns').fetchone()[0],1)

    def test_equivalent_bases_share_review_but_different_commits_do_not(self):
        first=self.runtime.publish_check(self.payload)['reviews'][0]['tool_id']
        oid=self.runtime.review_base(str(self.root),'main')
        subprocess.run(['git','-C',str(self.root),'update-ref','refs/remotes/origin/main',oid],check=True)
        self.runtime.message(dict(id=self.c['id'],text='we already reviewed locally',request_id='approval'))
        for base in ('main','origin/main','refs/remotes/origin/main',oid):
            result=self.runtime.publish_check(dict(self.payload,base=base))
            self.assertTrue(result['allowed']);self.assertEqual(result['reviews'][0]['tool_id'],first)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','Different'],check=True,capture_output=True)
        # Bare main still uses the PR remote target, despite a different local main.
        self.assertTrue(self.runtime.publish_check(self.payload)['allowed'])
        result=self.runtime.publish_check(dict(self.payload,base='refs/heads/main'))
        self.assertFalse(result['allowed']);self.assertNotEqual(result['reviews'][0]['tool_id'],first)

    def test_legacy_ref_review_is_reused_and_unreachable_review_cannot_be_approved(self):
        first=self.runtime.publish_check(self.payload)['reviews'][0]['tool_id']
        with self.runtime.db() as db:db.execute('UPDATE coordinator_tool_reviews SET base=? WHERE id=?',('main',first))
        with patch.object(self.runtime,'review_state',side_effect=OSError('offline')):
            self.runtime.message(dict(id=self.c['id'],text='we already reviewed locally',request_id='offline'))
        self.assertFalse(self.runtime.publish_check(self.payload)['allowed'])
        self.runtime.message(dict(id=self.c['id'],text='we already reviewed locally',request_id='online'))
        result=self.runtime.publish_check(self.payload)
        self.assertTrue(result['allowed']);self.assertEqual(result['reviews'][0]['tool_id'],first)


    def test_direct_tool_launch_needs_no_hook_and_keeps_project_scope(self):
        doc=self.root/'draft.html';doc.write_text('<h1>Draft</h1>')
        with self.runtime.db() as db:before=db.execute('SELECT COUNT(*) FROM coordinator_hooks').fetchone()[0]
        result=self.runtime.launch_tool(self.c['id'],'diagram-doc-creator',str(doc))
        self.assertEqual(self.launched[-1][0],'diagram-doc-creator')
        self.assertEqual(result['target'],str(doc.resolve()))
        with self.runtime.db() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM coordinator_hooks').fetchone()[0],before)
        with self.assertRaisesRegex(ValueError,'installed tool ID'):
            self.runtime.launch_tool(self.c['id'],'unknown-tool',str(doc))
        with self.assertRaisesRegex(ValueError,'requires an enabled hook ID'):
            self.runtime.launch_hook_tool(self.c['id'],'diagram-doc-creator',str(doc))
        with tempfile.TemporaryDirectory() as other:
            outside=Path(other)/'draft.html';outside.write_text('Outside')
            with self.assertRaises(ValueError):self.runtime.launch_tool(self.c['id'],'diagram-doc-creator',str(outside))

    def test_direct_review_does_not_satisfy_before_publish_hook(self):
        self.runtime.launch_tool(self.c['id'],'code-review',str(self.root),'main')
        result=self.runtime.publish_check(self.payload)
        self.assertFalse(result['allowed'])
        self.assertEqual(len(self.launched),2)
        self.assertNotEqual(self.launched[0][2],self.launched[1][2])


    def test_invalid_hook_selection_is_recoverable_before_launch(self):
        action=dict(kind='launch_hook_tool',name='diagram-doc-creator',task=str(self.root/'draft.html'),model='')
        self.assertEqual(self.runtime.action(self.c,action,'invalid-selection'),'recall')
        self.assertEqual(self.launched,[])
        self.assertFalse(self.runtime.get(self.c['id'])['paused'])
        with self.runtime.db() as db:
            row=db.execute("SELECT state,detail FROM actions WHERE id='invalid-selection'").fetchone()
            self.assertEqual(row['state'],'failed')
            self.assertIn('launch_tool',row['detail'])
