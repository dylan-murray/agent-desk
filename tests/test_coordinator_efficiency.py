import json
import threading
import unittest

from agent_desk.coordinator_efficiency import bounded_context, encoded_size, CONTEXT_BYTES, usage_from_output
from agent_desk.coordinator_planners import NativePlanner
from agent_desk.coordinator_runtime import SCHEMA, RULES


class EfficiencyTests(unittest.TestCase):
    def test_large_context_retains_goal_latest_instruction_and_worker_identity(self):
        context={'original_goal':'Ship the fix without merging',
            'conversation':[{'kind':'worker','text':'long report '*2000} for _ in range(35)]+[{'kind':'user','text':'Do not push until I review'}],
            'workers':[{'id':'worker-1','cwd':'/tmp/worktree','task':'log'*100000}],
            'saved_workers':[{'worker':'old-1','session_id':'exact-session','profile':'codex-personal','metadata':'x'*200000}],
            'actions':[],'task_history':[{'id':'pending','worker_id':'worker-1','result':None,'task':'Finish tests'}]}
        result=bounded_context(context)
        self.assertLessEqual(encoded_size(result),CONTEXT_BYTES)
        self.assertTrue(result['context_policy']['trimmed'])
        self.assertEqual(result['original_goal'],context['original_goal'])
        self.assertEqual(result['conversation'][-1],context['conversation'][-1])
        self.assertEqual(result['saved_workers'][0]['session_id'],'exact-session')
        self.assertEqual(result['task_history'][0]['id'],'pending')
        self.assertEqual(len(context['conversation']),36) # source history untouched

    def test_essential_context_overflow_refuses_to_drop_instructions(self):
        with self.assertRaisesRegex(ValueError,'no planning call'):
            bounded_context({'original_goal':'x'*100000,'conversation':[]})

    def test_provider_cache_semantics_and_missing_counts(self):
        usage={'input_tokens':100,'output_tokens':20,'cache_read_input_tokens':900,'cache_creation_input_tokens':50}
        claude=usage_from_output('claude',json.dumps({'usage':usage}))
        self.assertEqual(claude['input_tokens'],1050)
        codex=usage_from_output('codex',json.dumps({'type':'turn.completed','usage':{'input_tokens':1000,'cached_input_tokens':900,'output_tokens':20}}))
        self.assertEqual(codex['input_tokens'],1000)
        self.assertEqual(codex['cached_input_tokens'],900)
        self.assertEqual(usage_from_output('grok','{"message":"done","actions":[]}'),{})
        self.assertEqual(usage_from_output('claude','{"usage":{"input_tokens":-1,"output_tokens":true}}'),{})

    def test_usage_survives_invalid_model_response(self):
        output=json.dumps({'usage':{'input_tokens':120,'output_tokens':8},'structured_output':{'not':'valid'}})
        planner=NativePlanner(SCHEMA,RULES,lambda *args:output)
        with self.assertRaises(ValueError) as failure:
            planner({'profile':'claude','cwd':'/tmp'}, {},threading.Event())
        self.assertEqual(failure.exception.coordinator_usage['input_tokens'],120)
        self.assertTrue(failure.exception.coordinator_usage['reported'])

    def test_prompt_overflow_never_invokes_cli(self):
        calls=[]
        planner=NativePlanner(SCHEMA,RULES,lambda *args:calls.append(args))
        with self.assertRaisesRegex(ValueError,'no planning call'):
            planner({'profile':'claude','cwd':'/tmp'}, {'text':'x'*150000},threading.Event())
        self.assertEqual(calls,[])
