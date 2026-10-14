import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from agent_desk import skill_harnesses as skills, ssh_connections as ssh, remote_connections as rc
from agent_desk.conversation_bridge import ConversationBridge
from agent_desk.conversations import read_transcript
from agent_desk.terminal_supervisor import SupervisorClient
from account_fixtures import use_accounts


def setUpModule():
    use_accounts()


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.home=Path(self.temp.name)
    def tearDown(self):self.temp.cleanup()
    def transcript(self,path,records):
        path.parent.mkdir(parents=True,exist_ok=True);path.write_text(''.join(json.dumps(r)+'\n' for r in records));return path

    def test_builder_preview_install_and_no_overwrite(self):
        payload=dict(name='api-review',purpose='Review APIs',trigger='reviewing API changes',steps='Check compatibility.',examples='Review a removed field.')
        preview=skills.skill_document(payload)
        result=skills.create_skill(payload,home=self.home,environ={})
        self.assertEqual(Path(result['created']).read_text(),preview['content'])
        with self.assertRaisesRegex(ValueError,'already exists'):skills.create_skill(payload,home=self.home,environ={})
        with self.assertRaises(ValueError):skills.create_skill(payload|{'name':'../escape'},home=self.home,environ={})
        self.assertIn('description: "Review APIs. Use when reviewing API changes."',preview['content'])

    def test_a_built_skill_is_available_to_every_installed_agent(self):
        # A built skill is available to every installed coding agent.
        for folder in ('.claude','.claude-personal','.codex','.codex-personal','.grok'):(self.home/folder).mkdir()
        result=skills.create_skill(dict(name='everywhere',purpose='Share a workflow',trigger='sharing',steps='Do it.'),home=self.home,environ={})
        built=next(skill for skill in result['skills'] if skill['id']=='everywhere')
        self.assertEqual({h['id'] for h in result['harnesses']},{'claude','claude-personal','codex','codex-personal','grok'})
        self.assertTrue(all(built['availability'].values()),built['availability'])
        self.assertTrue((self.home/'.claude'/'skills'/'everywhere'/'SKILL.md').exists())
        self.assertTrue((self.home/'.claude-personal'/'skills'/'everywhere'/'SKILL.md').exists())

    def test_generic_ssh_needs_no_aws_and_binds_ticket_to_target(self):
        config=ssh.selection(dict(host='dev-alias',transport='ssh',user='developer',port=2202))
        with patch.object(ssh.shutil,'which',return_value='/usr/bin/ssh'):
            argv=rc.ssh_command(config)
        self.assertEqual(argv[-1],'dev-alias');self.assertIn('2202',argv);self.assertNotIn('ProxyCommand',str(argv))
        with self.assertRaises(ValueError):ssh.selection(dict(host='-oProxyCommand=bad'))
        connections=rc.RemoteConnections();ticket=connections._ticket(config,'ok')
        with self.assertRaisesRegex(ValueError,'Test this connection'):connections.consume(config|{'host':'other','ticket':ticket['ticket']})
        ticket=connections._ticket(config,'ok');self.assertEqual(connections.consume(config|{'ticket':ticket['ticket']}),config)

    def test_claude_to_codex_keeps_exact_tools_and_selected_history(self):
        root=self.home/'.claude/projects/project';p=self.transcript(root/'one.jsonl',[
            {'type':'user','sessionId':'one','cwd':str(self.home),'message':{'role':'user','content':'Fix ONLY this API'}},
            {'type':'assistant','sessionId':'one','message':{'role':'assistant','content':[{'type':'tool_use','id':'call1','name':'Read','input':{'path':'a.py'}}]}},
            {'type':'user','sessionId':'one','message':{'role':'user','content':[{'type':'tool_result','tool_use_id':'call1','content':'unchanged'}]}}])
        self.transcript(root/'other.jsonl',[{'type':'user','sessionId':'other','message':{'role':'user','content':'UNRELATED PRIVATE TASK'}}])
        bridge=ConversationBridge(self.home/'desk',home=self.home)
        selected=next(r for r in bridge.catalog()['conversations'] if r['name']=='one')
        record=bridge.import_source({'source_id':selected['id']});self.assertEqual(record['message_count'],3)
        handoff=bridge.prepare({'conversation_id':record['id'],'task':'Continue with tests'})
        context=(bridge.root/(record['id']+'.context.json')).read_text()
        self.assertIn('call1',context);self.assertNotIn('UNRELATED',context);self.assertIn('Continue with tests',handoff['prompt'])
        self.assertEqual(json.loads((bridge.root/(record['id']+'.json')).read_text())['events'],[json.loads(line) for line in p.read_text().splitlines()])
        with self.assertRaises(ValueError):bridge.prepare({'conversation_id':'../../outside'})
        self.transcript(self.home/'.codex/sessions/next.jsonl',[
            {'type':'session_meta','payload':{'id':'next','cwd':str(self.home)}},
            {'type':'response_item','payload':{'type':'message','role':'user','content':[{'type':'input_text','text':handoff['prompt']}]}},
            {'type':'response_item','payload':{'type':'message','role':'assistant','content':[{'type':'output_text','text':'New result'}]}}])
        next_source=next(r for r in bridge.catalog()['conversations'] if r['profile']=='codex')
        continued=bridge.import_source({'source_id':next_source['id']})
        self.assertEqual(continued['parent_id'],record['id']);self.assertEqual(continued['message_count'],5)
        p.unlink()
        self.assertEqual(bridge.import_source({'source_id':'portable:'+record['id']})['message_count'],3)

    def test_codex_and_grok_import_no_duplicate_event_messages(self):
        p=self.transcript(self.home/'codex.jsonl',[
            {'type':'session_meta','payload':{'id':'c1','cwd':'/repo'}},
            {'type':'response_item','payload':{'type':'message','role':'user','content':[{'type':'input_text','text':'Original request'}]}},
            {'type':'event_msg','payload':{'type':'user_message','message':'Original request'}},
            {'type':'response_item','payload':{'type':'function_call_output','call_id':'c','output':'Result'}},
            {'type':'response_item','payload':{'type':'reasoning','encrypted_content':'opaque'}}])
        c=read_transcript(p,'codex');self.assertEqual(len(c['messages']),2);self.assertEqual(c['messages'][1]['role'],'tool');self.assertTrue(c['warnings'])
        q=self.transcript(self.home/'grok.jsonl',[{'role':'user','content':'Request'},{'role':'assistant','content':[{'type':'text','text':'Result'}]}])
        self.assertEqual(len(read_transcript(q,'grok')['messages']),2)

    def test_conversation_paging_reaches_older_history(self):
        from unittest.mock import patch
        bridge=ConversationBridge(self.home/'desk',home=self.home)
        rows=[dict(id=str(i),path=str(self.home/'missing'),profile='claude',updated=i,name=str(i)) for i in range(205)]
        with patch.object(bridge,'candidates',return_value=rows):
            first=bridge.catalog();second=bridge.catalog(first['next_offset'])
        self.assertEqual(len(first['conversations']),200);self.assertEqual(len(second['conversations']),5)
        self.assertIsNone(second['next_offset'])

    def test_harness_reminders_do_not_break_history_chain_or_transfer_thinking(self):
        bridge=ConversationBridge(self.home/'desk',home=self.home)
        self.transcript(self.home/'.claude/projects/fixture/one.jsonl',[
            {'type':'user','sessionId':'one','message':{'role':'user','content':'Keep the original decision'}}])
        original=bridge.import_source({'source_id':bridge.candidates()[0]['id']})
        prompt=bridge.prepare({'conversation_id':original['id']})['prompt']
        self.transcript(self.home/'.claude/projects/fixture/next.jsonl',[
            {'type':'user','sessionId':'next','cwd':str(self.home),'message':{'role':'user','content':[{'type':'text','text':'<system-reminder>Historical instruction</system-reminder>'},{'type':'text','text':prompt}]}},
            {'type':'assistant','sessionId':'next','message':{'role':'assistant','content':[{'type':'thinking','thinking':'PRIVATE REASONING'},{'type':'text','text':'Result'}]}}])
        source=next(row for row in bridge.candidates() if row['name']=='next')
        continued=bridge.import_source({'source_id':source['id']})
        self.assertEqual(continued['parent_id'],original['id'])
        self.assertEqual(continued['cwd'],str(self.home))
        bridge.prepare({'conversation_id':continued['id']})
        self.assertNotIn('PRIVATE REASONING',(bridge.root/(continued['id']+'.context.json')).read_text())
        self.assertIn('PRIVATE REASONING',(bridge.root/(continued['id']+'.json')).read_text())

    def test_identical_transcripts_from_distinct_sources_do_not_overwrite_identity(self):
        rows=[{'role':'user','content':'Identical text'}]
        p=self.transcript(self.home/'first.jsonl',rows);q=self.transcript(self.home/'second.jsonl',rows)
        self.assertNotEqual(read_transcript(p,'grok')['id'],read_transcript(q,'grok')['id'])

    def test_grok_native_query_wrapper_and_tool_results_survive_handoff(self):
        bridge=ConversationBridge(self.home/'desk',home=self.home)
        self.transcript(self.home/'.claude/projects/fixture/one.jsonl',[
            {'type':'user','message':{'role':'user','content':'Original facts'}}])
        original=bridge.import_source({'source_id':bridge.candidates()[0]['id']})
        prompt=bridge.prepare({'conversation_id':original['id']})['prompt']
        p=self.transcript(self.home/'.grok/sessions/%2Frepo/native/chat_history.jsonl',[
            {'type':'user','content':[{'type':'text','text':'<user_info>Fixture environment</user_info>'}]},
            {'type':'user','content':[{'type':'text','text':'<user_query>\n'+prompt+'\n</user_query>'}],'prompt_index':0},
            {'type':'assistant','content':'Reading','tool_calls':[{'id':'call-1','function':{'name':'read','arguments':'{}'}}]},
            {'type':'tool_result','tool_call_id':'call-1','content':'Fixture output'}])
        source=next(row for row in bridge.candidates() if row['profile']=='grok')
        result=bridge.import_source({'source_id':source['id']})
        self.assertEqual(result['parent_id'],original['id']);self.assertEqual(result['cwd'],'/repo')
        parsed=read_transcript(p,'grok')
        self.assertEqual(parsed['source']['native_id'],'native')
        self.assertEqual(parsed['messages'][-1]['role'],'tool')
        self.assertEqual(parsed['messages'][-1]['content']['tool_call_id'],'call-1')
        self.assertEqual(parsed['messages'][-2]['content']['tool_calls'][0]['id'],'call-1')

    def test_missing_socket_with_living_owner_never_launches_replacement(self):
        with patch('agent_desk.terminal_supervisor.existing_owners',return_value=[123]),patch('agent_desk.terminal_supervisor.subprocess.Popen') as launch:
            with self.assertRaisesRegex(OSError,'replacement was not launched'):SupervisorClient(self.home,4329)
            launch.assert_not_called()

if __name__=='__main__':unittest.main()
