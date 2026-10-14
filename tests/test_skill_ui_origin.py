import io
import json
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.skill_ui import main


class SkillOriginTests(unittest.TestCase):
    def test_registration_keeps_or_explicitly_overrides_origin(self):
        for explicit, inherited, previous, pane, expected in [
            (None, None, 'coordinator-original', None, 'coordinator-original'),
            (None, 'coordinator-environment', 'coordinator-original', None, 'coordinator-environment'),
            ('coordinator-explicit', 'coordinator-environment', 'coordinator-original', None, 'coordinator-explicit'),
            # A plain pane owns the tools it opens, but never takes over one that already has an owner.
            (None, None, None, 'terminal-pane', 'terminal-pane'),
            (None, None, 'coordinator-original', 'terminal-pane', 'coordinator-original'),
        ]:
            with self.subTest(explicit=explicit, inherited=inherited, previous=previous, pane=pane), tempfile.TemporaryDirectory() as temp:
                target = Path(temp) / 'README.md'
                target.write_text('# Fixture\n')
                calls = []
                def request(req, **kwargs):
                    if isinstance(req, str):
                        return io.BytesIO(json.dumps({'uis':[{'id':'readme-origin', **({'agent_id':previous} if previous else {})}]}).encode())
                    calls.append(json.loads(req.data))
                    return io.BytesIO(b'{"endpoint":"/apps/readme-origin"}')
                argv = ['skill_ui.py', '--skill', 'readme-review', '--target', str(target), '--id', 'readme-origin']
                if explicit:
                    argv += ['--agent-id', explicit]
                env = {'AGENT_DESK_TOKEN':'fixture'}
                if inherited:
                    env['AGENT_DESK_AGENT_ID'] = inherited
                if pane:
                    env['AGENT_DESK_TERMINAL_ID'] = pane
                with patch('sys.argv', argv), patch.dict('os.environ', env, clear=True), patch('scripts.skill_ui.urlopen', side_effect=request), patch('agent_desk.tool_runtime.ToolRuntime') as runtime, redirect_stdout(io.StringIO()):
                    runtime.return_value.launch.return_value = {'url':'http://127.0.0.1:49001'}
                    main()
                self.assertEqual(calls[0]['agent_id'], expected)
                self.assertEqual(calls[0]['context'], str(target.resolve()))

    def test_code_review_sends_feedback_to_the_session_that_opened_it(self):
        for skill, pane, bridged in [('code-review', 'terminal-pane', True), ('code-review', None, False), ('readme-review', 'terminal-pane', False)]:
            with self.subTest(skill=skill, pane=pane), tempfile.TemporaryDirectory() as temp:
                def request(req, **kwargs):
                    return io.BytesIO(b'{"uis":[]}' if isinstance(req, str) else b'{"endpoint":"/apps/fixture"}')
                env = {'AGENT_DESK_TOKEN':'fixture'} | ({'AGENT_DESK_TERMINAL_ID':pane} if pane else {})
                argv = ['skill_ui.py', '--skill', skill, '--target', temp, '--desk', 'http://127.0.0.1:4399']
                with patch('sys.argv', argv), patch.dict('os.environ', env, clear=True), patch('scripts.skill_ui.urlopen', side_effect=request), patch('agent_desk.tool_runtime.ToolRuntime') as runtime, redirect_stdout(io.StringIO()):
                    runtime.return_value.launch.return_value = {'url':'http://127.0.0.1:49001'}
                    main()
                extra = runtime.return_value.launch.call_args.args[5]
                if not bridged:
                    self.assertEqual(extra, [])
                    continue
                self.assertEqual(extra[2:], ['--session-id', 'terminal-pane', '--harness', 'Agent Desk'])
                command = json.loads(extra[1])
                self.assertEqual(extra[0], '--feedback-command')
                self.assertEqual(Path(command[1]).name, 'tool_feedback.py')
                self.assertEqual(command[2:], ['--desk', 'http://127.0.0.1:4399', '--target', 'terminal-pane'])


class ToolFeedbackPromptTests(unittest.TestCase):
    def test_prompt_lists_open_comments_and_falls_back_to_the_tool_message(self):
        from scripts.tool_feedback import prompt
        event = {'message':'Saved submission', 'target':'/repo', 'snapshot_path':'/cache/s.json', 'annotations':[
            {'file':'src/signup.js', 'start':7, 'end':7, 'comment':'Name this\npattern.', 'status':'open', 'suggestion':None},
            {'file':'src/signup.js', 'start':8, 'end':9, 'comment':'Shorter', 'suggestion':'x'},
            {'kind':'general', 'comment':'Add a test'},
            {'file':'src/old.js', 'start':1, 'comment':'Done already', 'status':'addressed'}]}
        self.assertEqual(prompt(event), 'Review feedback on /repo:\n- src/signup.js:7 Name this pattern.\n- src/signup.js:8-9 Shorter (with a suggested replacement)\n- whole change Add a test\n'
                         'The full comments, with the quoted lines, are saved at /cache/s.json. Make the requested changes, verify them and report back.')
        self.assertEqual(prompt({'message':'Saved submission', 'annotations':[]}), 'Saved submission')
        self.assertEqual(prompt({'message':'Saved submission'}), 'Saved submission')

