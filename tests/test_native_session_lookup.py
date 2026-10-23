import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from agent_desk.native_session_lookup import find_conversation

class GrokLookupTests(unittest.TestCase):
    def test_exact_user_callback_required_and_ambiguous_sessions_rejected(self):
        with tempfile.TemporaryDirectory() as temp, patch('agent_desk.native_session_lookup.Path.home',return_value=Path(temp)):
            root=Path(temp)/'.grok/sessions/project'
            p=root/'session-one/chat_history.jsonl';p.parent.mkdir(parents=True)
            def write(role,text):p.write_text(json.dumps(dict(type=role,content=[dict(type='text',text=text)]))+'\n')
            write('assistant','reply task-123 --file /tmp/report')
            self.assertIsNone(find_conversation('grok','task-123'))
            write('user','Mention task-123')
            self.assertIsNone(find_conversation('grok','task-123'))
            write('user','Run reply task-123 --file /tmp/report')
            self.assertEqual(find_conversation('grok','task-123'),'session-one')
            q=root/'session-two/chat_history.jsonl';q.parent.mkdir();q.write_text(p.read_text())
            self.assertIsNone(find_conversation('grok','task-123'))


class PiLookupTests(unittest.TestCase):
    def test_session_header_names_the_conversation(self):
        with tempfile.TemporaryDirectory() as temp, patch('agent_desk.native_session_lookup.Path.home',return_value=Path(temp)):
            root=Path(temp)/'.pi/agent/sessions/--tmp-project--';root.mkdir(parents=True)
            def write(name,identity,role,text):
                (root/name).write_text(json.dumps(dict(type='session',version=3,id=identity))+'\n'+
                    json.dumps(dict(type='message',message=dict(role=role,content=[dict(type='text',text=text)])))+'\n')
            write('one.jsonl','01a1365c-37ba-7d59-a87c-65eb445012d2','assistant','reply task-123 --file /tmp/report')
            self.assertIsNone(find_conversation('pi','task-123'))
            write('one.jsonl','01a1365c-37ba-7d59-a87c-65eb445012d2','user','Run reply task-123 --file /tmp/report')
            self.assertEqual(find_conversation('pi','task-123'),'01a1365c-37ba-7d59-a87c-65eb445012d2')
            write('two.jsonl','02b2365c-37ba-7d59-a87c-65eb445012d2','user','Run reply task-123 --file /tmp/report')
            self.assertIsNone(find_conversation('pi','task-123'))


class CortexLookupTests(unittest.TestCase):
    def test_history_file_name_is_the_conversation(self):
        with tempfile.TemporaryDirectory() as temp, patch('agent_desk.native_session_lookup.Path.home',return_value=Path(temp)):
            root=Path(temp)/'.snowflake/cortex/conversations';root.mkdir(parents=True)
            def write(identity,role,text):
                (root/(identity+'.json')).write_text(json.dumps(dict(session_id=identity,working_directory='/tmp/project')))
                (root/(identity+'.history.jsonl')).write_text(json.dumps(dict(id='m1',role=role,content=[dict(type='text',text=text)]))+'\n')
            write('11111111-2222-4333-8444-555555555555','assistant','reply task-123 --file /tmp/report')
            self.assertIsNone(find_conversation('cortex','task-123'))
            write('11111111-2222-4333-8444-555555555555','user','Run reply task-123 --file /tmp/report')
            self.assertEqual(find_conversation('cortex','task-123'),'11111111-2222-4333-8444-555555555555')
            write('66666666-7777-4888-8999-aaaaaaaaaaaa','user','Run reply task-123 --file /tmp/report')
            self.assertIsNone(find_conversation('cortex','task-123'))


class OpenCodeLookupTests(unittest.TestCase):
    def test_user_text_part_in_a_top_level_session(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ,{'XDG_DATA_HOME':temp}):
            self.assertIsNone(find_conversation('opencode','task-123'))
            (Path(temp)/'opencode').mkdir()
            db=sqlite3.connect(Path(temp)/'opencode'/'opencode.db')
            db.executescript('CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT);CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT);'
                             'CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,data TEXT);')
            def add(session,parent,role,text):
                key=session+role
                db.execute('INSERT OR IGNORE INTO session VALUES(?,?)',(session,parent))
                db.execute('INSERT INTO message VALUES(?,?,?)',('msg_'+key,session,json.dumps(dict(role=role))))
                db.execute('INSERT INTO part VALUES(?,?,?,?)',('prt_'+key,'msg_'+key,session,json.dumps(dict(type='text',text=text))))
                db.commit()
            add('ses_one',None,'assistant','I ran reply task-123 --file /tmp/report')
            self.assertIsNone(find_conversation('opencode','task-123'))
            add('ses_child','ses_one','user','Run reply task-123 --file /tmp/report')
            self.assertIsNone(find_conversation('opencode','task-123'),'a subagent session is not the worker conversation')
            add('ses_one',None,'user','Run reply task-123 --file /tmp/report')
            self.assertEqual(find_conversation('opencode','task-123'),'ses_one')
            add('ses_two',None,'user','Run reply task-123 --file /tmp/report')
            self.assertIsNone(find_conversation('opencode','task-123'))
            db.close()


class ConversationIdentityTests(unittest.TestCase):
    def test_opencode_session_names_are_kept_and_other_ids_stay_uuids(self):
        from scripts.control_mailbox import Mailbox
        with tempfile.TemporaryDirectory() as temp:
            box=Mailbox(Path(temp)/'mailbox.sqlite3');desk='http://127.0.0.1:4310'
            for task in ('task-a','task-b','task-c'):box.create(desk,'controller','worker',task,task)
            box.remember_conversation(desk,'task-a','ses_2c58AbCd','opencode')
            box.remember_conversation(desk,'task-b','01A1365C-37BA-7D59-A87C-65EB445012D2','pi')
            for identity,harness in (('ses_2c58AbCd','pi'),('ses_bad/../x','opencode')):
                with self.assertRaises(ValueError):box.remember_conversation(desk,'task-c',identity,harness)
            with box.connect() as db:rows=dict(db.execute('SELECT task_id,session_id FROM worker_conversations'))
            self.assertEqual(rows,{'task-a':'ses_2c58AbCd','task-b':'01a1365c-37ba-7d59-a87c-65eb445012d2'})
