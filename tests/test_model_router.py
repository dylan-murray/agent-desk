import base64
import http.server
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from agent_desk import desk_tokens, model_router, server
from agent_desk.coordinator_runtime import CoordinatorRuntime
from agent_desk.model_router import ModelRouter, RouterError, harness_for, worker_profile
from agent_desk.terminals import TerminalManager
from agent_desk.terminal_owners import TerminalOwners
from scripts.agent_control import DeskClient
from scripts.control_mailbox import Mailbox
from test_coordinator_runtime import FakeTerminals
from account_fixtures import use_accounts


def setUpModule():
    use_accounts()


class StubRouter:
    """A loopback stand-in for a model router's POST /v1/decide that records each request."""
    def __init__(self):
        self.requests = [];self.reply = lambda body:(200, {'decision_id':'dec_1','model':body['models'][0],'bucket':'deep-build','confidence':.8,
            'reason':'our top pick for deep-build (auto)','ranked':body['models'],'classifier':{'path':'rules','fallback':False},'policy_version':3})
        stub = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                stub.requests.append(dict(path=self.path, body=body, auth=self.headers.get('Authorization')))
                status, reply = stub.reply(body)
                data = json.dumps(reply).encode()
                self.send_response(status)
                if status in (301, 302, 307):self.send_header('Location', 'http://127.0.0.1:9/v1/decide')
                self.send_header('Content-Type', 'application/json');self.send_header('Content-Length', str(len(data)));self.end_headers()
                self.wfile.write(data)
        self.http = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.http.server_port}'

    def close(self):self.http.shutdown();self.http.server_close()


def choose(model):
    return lambda body:(200, {'decision_id':'dec_'+model,'model':model,'bucket':'deep-build','reason':'our top pick for deep-build (auto)','ranked':[model],'classifier':{'fallback':False}})


class HarnessTests(unittest.TestCase):
    def test_models_map_to_the_harness_that_runs_them(self):
        for model, harness in [('gpt-6-luna','codex'),('openai/gpt-6-luna','codex'),('o4-mini','codex'),('codex-mini','codex'),
                               ('claude-opus-5-5','claude'),('anthropic/claude-opus-5-5','claude'),('opus','claude'),('Claude-Sonnet-5-5','claude'),
                               ('grok-4.6','grok'),('xai/grok-4.6','grok'),('gemini-3.1-pro',None),('olmo-2',None)]:
            self.assertEqual(harness_for(model), harness, model)

    def test_profiles_keep_the_account_family(self):
        self.assertEqual(worker_profile('codex','claude-personal'),'codex-personal')
        self.assertEqual(worker_profile('claude','codex'),'claude')
        self.assertEqual(worker_profile('codex','grok'),'codex')
        self.assertEqual(worker_profile('grok','claude-personal'),'grok')
        self.assertEqual(worker_profile('codex','codex-personal',remote=True),'codex')
        self.assertEqual(worker_profile('claude',None),'claude')
        self.assertEqual(worker_profile('codex','claude-personal',account='codex'),'codex')
        self.assertEqual(worker_profile('claude','codex',account='claude-personal'),'claude-personal')
        self.assertEqual(worker_profile('claude','codex',remote=True,account='claude-personal'),'claude')

    def test_harness_command_resolves_work_and_personal_aliases(self):
        self.assertEqual(model_router.harness_argv('codex-personal','gpt-6-luna')[2:],['codex-personal "$@"','agent-desk','--model','gpt-6-luna'])
        self.assertEqual(model_router.harness_argv('grok','grok-4.6'),['grok','--model','grok-4.6'])


class RouterClientTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory();self.stub = StubRouter()
        self.router = ModelRouter(Path(self.temp.name)/'model-router.json')
    def tearDown(self):self.stub.close();self.temp.cleanup()
    def save(self, **extra):
        return self.router.save({'endpoint':self.stub.url,'api_key':'router-secret','preference':'auto','models':['gpt-6-luna','claude-opus-5-5'],**extra})

    def test_settings_never_return_the_key_and_are_private(self):
        status = self.save()
        self.assertNotIn('router-secret', json.dumps(status));self.assertTrue(status['has_api_key'])
        self.assertEqual([(m['model'],m['harness']) for m in status['models']],[('gpt-6-luna','codex'),('claude-opus-5-5','claude')])
        self.assertEqual(stat.S_IMODE(os.stat(self.router.path).st_mode), 0o600)
        # A blank key keeps the saved one; clearing removes it.
        self.assertTrue(self.router.save({'endpoint':self.stub.url,'api_key':'','models':['gpt-6-luna']})['has_api_key'])
        self.assertFalse(self.router.save({'endpoint':self.stub.url,'clear_api_key':True,'models':['gpt-6-luna']})['has_api_key'])

    def test_settings_reject_unsafe_or_unroutable_input(self):
        for bad in [{'endpoint':'http://router.example.com'},{'endpoint':'ftp://127.0.0.1'},{'endpoint':'https://user:pw@router.example.com'},
                    {'endpoint':'https://router.example.com?key=1'},{'models':['gemini-3.1-pro']},{'models':[]},{'models':['--model']},
                    {'models':['gpt 6']},{'preference':'fastest'}]:
            with self.assertRaises(ValueError, msg=bad):self.save(**bad)
        self.assertFalse(self.router.status()['configured'])
        self.assertEqual(self.save(endpoint='https://router.example.com')['endpoint'],'https://router.example.com')

    def test_decision_follows_the_router_contract(self):
        self.save();self.stub.reply = choose('gpt-6-luna')
        routing = self.router.decide('Refactor the auth module')
        request = self.stub.requests[-1]
        self.assertEqual(request['path'],'/v1/decide');self.assertEqual(request['auth'],'Bearer router-secret')
        self.assertEqual(request['body'],{'prompt':'Refactor the auth module','models':['gpt-6-luna','claude-opus-5-5'],'preference':'auto'})
        self.assertEqual((routing['model'],routing['harness'],routing['decision_id'],routing['bucket']),('gpt-6-luna','codex','dec_gpt-6-luna','deep-build'))
        self.assertIn('chose gpt-6-luna → Codex', model_router.summary(routing))
        # A harness limits the offered models; a full /v1/decide URL is not doubled.
        self.save(endpoint=self.stub.url+'/v1/decide');self.stub.reply = choose('claude-opus-5-5')
        self.assertEqual(self.router.decide('Write docs','claude')['model'],'claude-opus-5-5')
        self.assertEqual(self.stub.requests[-1]['body']['models'],['claude-opus-5-5']);self.assertEqual(self.stub.requests[-1]['path'],'/v1/decide')
        with self.assertRaisesRegex(RouterError,'No router models run in Grok'):self.router.decide('Task','grok')

    def test_models_can_pin_an_account_and_old_settings_still_load(self):
        status = self.save(models=[{'model':'gpt-6-luna','account':'codex'},{'model':'claude-opus-5-5','account':'claude-personal'},'grok-4.6'])
        self.assertEqual([(m['model'],m['account']) for m in status['models']],[('gpt-6-luna','codex'),('claude-opus-5-5','claude-personal'),('grok-4.6','')])
        for account in ('team','claude-personal'):
            with self.assertRaises(ValueError):self.save(models=[{'model':'gpt-6-luna','account':account}])
        self.stub.reply = choose('claude-opus-5-5')
        self.assertEqual(self.router.decide('Task')['account'],'claude-personal')
        self.assertEqual(self.stub.requests[-1]['body']['models'],['gpt-6-luna','claude-opus-5-5','grok-4.6'])
        # Settings written before accounts existed hold plain strings.
        self.router.path.write_text(json.dumps({'endpoint':self.stub.url,'models':['gpt-6-luna']}))
        self.assertEqual(self.router.status()['models'][0]['account'],'')
        self.stub.reply = choose('gpt-6-luna');self.assertEqual(self.router.decide('Task')['account'],'')

    def test_provider_prefixed_models_launch_with_bare_ids(self):
        self.save(models=['openai/gpt-6-luna']);self.stub.reply = choose('openai/gpt-6-luna')
        self.assertEqual(self.router.decide('Task')['model'],'gpt-6-luna')

    def test_failures_are_explicit(self):
        with self.assertRaisesRegex(RouterError,'not configured'):self.router.decide('Task')
        self.save()
        self.stub.reply = lambda body:(401,{'error':{'type':'authentication_error','message':'a router API key is required'}})
        with self.assertRaisesRegex(RouterError,'returned 401: a router API key is required'):self.router.decide('Task')
        self.stub.reply = choose('claude-fable-5-1')
        with self.assertRaisesRegex(RouterError,'not in the configured models'):self.router.decide('Task')
        self.stub.reply = lambda body:(200,{'decision_id':'dec'})
        with self.assertRaisesRegex(RouterError,'no model decision'):self.router.decide('Task')
        self.stub.reply = lambda body:(302,{})
        count = len(self.stub.requests)
        with self.assertRaisesRegex(RouterError,'redirects are not followed'):self.router.decide('Task')
        self.assertEqual(len(self.stub.requests), count+1)
        self.stub.close()
        with self.assertRaisesRegex(RouterError,'unreachable'):self.router.decide('Task')


class RoutedCoordinatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory();self.root = Path(self.temp.name);self.stub = StubRouter()
        self.terminals = FakeTerminals();self.box = Mailbox(self.root/'mail.sqlite3')
        self.plan = lambda c,ctx,cancel:dict(message='Ready',actions=[]);self.contexts = []
        def planner(c,ctx,cancel):self.contexts.append(ctx);return self.plan(c,ctx,cancel)
        self.runtime = CoordinatorRuntime(self.root/'coordinator.sqlite3', self.terminals, self.box, planner)
    def tearDown(self):self.runtime.close();self.stub.close();self.temp.cleanup()
    def configure_router(self):
        self.runtime.model_router.save({'endpoint':self.stub.url,'models':['gpt-6-luna','claude-opus-5-5']})
    def coordinator(self, profile='claude-personal', router=True):
        return self.runtime.create(dict(cwd=str(self.root),name='Routed',profile=profile,router=router))
    def launch(self, c, key, **fields):
        return self.runtime.action(c,{**dict(kind='launch',name='Worker',profile='',model='',task='Refactor the auth module',worker_id='',cwd=''),**fields},key)
    def detail(self, key):
        with self.runtime.db() as db:return db.execute('SELECT state,detail,payload FROM actions WHERE id=?',(key,)).fetchone()

    def test_router_must_be_configured_before_it_is_enabled(self):
        with self.assertRaisesRegex(ValueError,'Set up the model router'):self.coordinator()
        with self.assertRaises(ValueError):self.runtime.create(dict(cwd=str(self.root),name='Routed',profile='claude',router='yes'))
        self.configure_router()
        self.assertEqual(self.coordinator()['router'],1)

    def test_routed_model_picks_the_harness_and_keeps_the_account_family(self):
        self.configure_router();c = self.coordinator('claude-personal')
        self.stub.reply = choose('gpt-6-luna');self.launch(c,'luna')
        launched = self.terminals.launched[-1]
        self.assertEqual(launched['launch_profile'],'codex-personal')
        self.assertEqual(launched['argv'][2],'codex-personal "$@"')
        self.assertEqual(launched['argv'][launched['argv'].index('--model')+1],'gpt-6-luna')
        self.assertEqual(self.stub.requests[-1]['body']['prompt'],'Refactor the auth module')
        state, detail, payload = self.detail('luna')
        self.assertEqual(state,'done');self.assertIn('codex-personal · Model: gpt-6-luna',detail)
        self.assertIn('model router at 127.0.0.1',detail);self.assertIn('decision dec_gpt-6-luna',detail)
        self.assertEqual(json.loads(payload)['routing']['harness'],'codex')
        self.stub.reply = choose('claude-opus-5-5');self.launch(c,'opus')
        launched = self.terminals.launched[-1]
        self.assertEqual(launched['launch_profile'],'claude-personal')
        self.assertEqual(launched['argv'][launched['argv'].index('--model')+1],'claude-opus-5-5')
        self.assertIn('--settings',launched['argv'])  # Claude workers keep their turn-end observer

    def test_pinned_account_overrides_the_coordinator_family(self):
        self.runtime.model_router.save({'endpoint':self.stub.url,'models':[{'model':'gpt-6-luna','account':'codex'},{'model':'claude-opus-5-5','account':''}]})
        c = self.coordinator('claude-personal')
        self.stub.reply = choose('gpt-6-luna');self.launch(c,'pinned')
        self.assertEqual(self.terminals.launched[-1]['launch_profile'],'codex')
        self.stub.reply = choose('claude-opus-5-5');self.launch(c,'family')
        self.assertEqual(self.terminals.launched[-1]['launch_profile'],'claude-personal')
        # A profile the planner names explicitly keeps its own account.
        self.stub.reply = choose('gpt-6-luna');self.launch(c,'explicit',profile='codex-personal')
        self.assertEqual(self.terminals.launched[-1]['launch_profile'],'codex-personal')

    def test_explicit_model_skips_routing_and_profile_limits_it(self):
        self.configure_router();c = self.coordinator('codex')
        self.launch(c,'explicit',profile='claude',model='sonnet')
        self.assertEqual(self.stub.requests,[]);self.assertEqual(self.terminals.launched[-1]['launch_profile'],'claude')
        self.stub.reply = choose('claude-opus-5-5');self.launch(c,'limited',profile='claude')
        self.assertEqual(self.stub.requests[-1]['body']['models'],['claude-opus-5-5'])

    def test_router_failure_launches_nothing_and_reserves_no_task(self):
        self.configure_router();c = self.coordinator()
        self.stub.reply = lambda body:(500,{'error':{'type':'api_error','message':'internal router error; not billed'}})
        with self.assertRaises(RouterError):self.launch(c,'down')
        self.assertEqual(self.terminals.launched,[]);self.assertEqual(self.box.inbox(self.runtime.desk,c['id'],True),[])
        state, detail, _ = self.detail('down')
        self.assertEqual(state,'failed');self.assertIn('returned 500: internal router error; not billed. No worker was launched.',detail)

    def test_routing_off_keeps_existing_behavior(self):
        self.configure_router();c = self.coordinator('claude',router=False)
        self.launch(c,'plain',profile='codex')
        self.assertEqual(self.stub.requests,[]);self.assertNotIn('--model',self.terminals.launched[-1]['argv'])
        with self.assertRaisesRegex(ValueError,'Invalid worker configuration'):self.launch(c,'no-profile')

    def test_toggle_persists_and_reaches_the_planner_context(self):
        c = self.runtime.create(dict(cwd=str(self.root),name='Routed',profile='claude'))
        with self.assertRaisesRegex(ValueError,'Set up the model router'):self.runtime.configure({'id':c['id'],'model':'','router':True})
        self.configure_router()
        c = self.runtime.configure({'id':c['id'],'model':'opus','router':True})
        self.assertEqual((c['router'],c['model']),(1,'opus'))
        self.assertEqual(self.runtime.configure({'id':c['id'],'model':'opus'})['router'],1)  # model-only edits keep routing
        self.assertEqual(self.runtime.snapshot()['coordinators'][0]['router'],1)
        context = self.runtime.context(self.runtime.get(c['id']))
        self.assertEqual(context['model_router']['models'],{'gpt-6-luna':'codex','claude-opus-5-5':'claude'})
        texts = [m['text'] for m in self.runtime.snapshot(c['id'])['messages']]
        self.assertTrue(any(t.startswith('Model router on') for t in texts))
        self.runtime.configure({'id':c['id'],'model':'opus','router':False})
        self.assertNotIn('model_router',self.runtime.context(self.runtime.get(c['id'])))

    def test_planner_turn_routes_outside_the_runtime_lock(self):
        self.configure_router();c = self.coordinator('claude')
        held = []
        def slow(body):
            held.append(self.runtime.lock.acquire(blocking=False))
            if held[-1]:self.runtime.lock.release()
            return choose('gpt-6-luna')(body)
        self.stub.reply = slow
        self.plan = lambda c,ctx,cancel:dict(message='Assigning',actions=[] if self.terminals.launched else [dict(kind='launch',name='Auth refactor',profile='',model='',task='Refactor the auth module',worker_id='',cwd='')])
        self.runtime.message(dict(id=c['id'],text='Refactor auth',request_id='one'))
        self.runtime.step()
        deadline = time.monotonic()+5
        while (self.runtime.running or not self.terminals.launched) and time.monotonic()<deadline:time.sleep(.025)
        self.assertEqual(held,[True])
        self.assertEqual(self.terminals.launched[0]['launch_profile'],'codex')
        self.assertIn('model_router',self.contexts[0])


class RoutedControllerLaunchTests(unittest.TestCase):
    """Terminal controllers: agent_control.py launch --route-task through the real HTTP server."""
    def test_routed_launch_opens_the_matching_harness_under_the_parent(self):
        temp = tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);stub = StubRouter();self.addCleanup(stub.close)
        router = ModelRouter(Path(temp.name)/'model-router.json');router.save({'endpoint':stub.url,'api_key':'router-secret','models':['gpt-6-luna',{'model':'claude-opus-5-5','account':'claude'}]})
        manager = TerminalManager();self.addCleanup(manager.close)
        # Stand in for the harness CLIs; the real command shape is covered by harness_argv tests.
        fake = lambda profile, model:['/bin/sh','-c','echo HARNESS "$@"; sleep 30','harness',profile,'--model',model]
        # The running server routes through the supervisor proxy, not a bare manager.
        with patch.object(server,'TERMINALS',server.DeskTerminals(TerminalOwners(manager))),patch.object(server.COORDINATORS,'model_router',router),patch.object(model_router,'harness_argv',fake):
            http_server = server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
            threading.Thread(target=http_server.serve_forever,daemon=True).start();self.addCleanup(http_server.server_close);self.addCleanup(http_server.shutdown)
            # A real controller reads the desk's terminal token from its file. Here that is two files: this
            # process and the CLI child resolve the data directory at different times (see account_fixtures).
            for folder in (None,os.environ.get('AGENT_DESK_DATA_DIR')):
                self.addCleanup(desk_tokens.write_token('terminal',http_server.server_port,server.TERMINAL_TOKEN,folder).unlink,missing_ok=True)
            client = DeskClient('http://127.0.0.1:'+str(http_server.server_port))
            parent = client.request('/api/terminals/launch',{'cwd':temp.name,'argv':['/bin/sh','-c','sleep 30'],'name':'Controller · fixture','launch_profile':'claude-personal'})
            stub.reply = choose('gpt-6-luna')
            worker = client.request('/api/model-router/launch',{'cwd':temp.name,'name':'Auth refactor','parent_id':parent['id'],'task':'Refactor the auth module'})
            self.assertEqual((worker['profile'],worker['routing']['model'],worker['parent_id']),('codex-personal','gpt-6-luna',parent['id']))
            self.assertEqual(manager.get(worker['id']).launch_profile,'codex-personal')
            deadline = time.time()+5;text = ''
            while time.time()<deadline and 'HARNESS' not in text:
                text = base64.b64decode(manager.get(worker['id']).output(0)['data']).decode(errors='replace');time.sleep(.1)
            self.assertIn('HARNESS codex-personal --model gpt-6-luna',text)
            self.assertEqual(stub.requests[-1]['auth'],'Bearer router-secret')
            self.assertNotIn('router-secret',json.dumps(client.request('/api/model-router/settings',{})))
            stub.reply = choose('claude-opus-5-5')
            pinned = client.request('/api/model-router/launch',{'cwd':temp.name,'name':'Docs','parent_id':parent['id'],'task':'Draft a design doc'})
            self.assertEqual(pinned['profile'],'claude')  # pinned default account beats the personal controller
            # The controller-facing CLI, as a controller agent runs it.
            cli = [sys.executable,str(Path(__file__).resolve().parents[1]/'scripts'/'agent_control.py'),'--desk',f'http://127.0.0.1:{http_server.server_port}','launch','--parent',parent['id'],'--cwd',temp.name,'--name','CLI worker']
            stub.reply = choose('gpt-6-luna')
            routed = subprocess.run([*cli,'--route-task','Fix the failing unit test'],capture_output=True,text=True,timeout=60)
            self.assertEqual(routed.returncode,0,routed.stderr)
            self.assertEqual(json.loads(routed.stdout)['profile'],'codex-personal');self.assertEqual(stub.requests[-1]['body']['prompt'],'Fix the failing unit test')
            for extra in (['--route-task','Task','--','codex'],['--harness','codex','--','codex']):
                rejected = subprocess.run([*cli,*extra],capture_output=True,text=True,timeout=60)
                self.assertEqual(rejected.returncode,1);self.assertIn('error',json.loads(rejected.stderr))
            stub.reply = lambda body:(503,{'error':{'message':'upstream down'}})
            with self.assertRaisesRegex(ValueError,'returned 503: upstream down'):
                client.request('/api/model-router/launch',{'cwd':temp.name,'name':'Nope','parent_id':parent['id'],'task':'Task'})
            self.assertEqual(len([s for s in manager.list() if s.get('parent_id')==parent['id']]),3)


if __name__ == '__main__':
    unittest.main()
