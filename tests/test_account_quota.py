import json
import threading
import time
import unittest
from unittest.mock import patch
from agent_desk.account_quota import AccountQuota, QuotaError, claude_windows, codex_windows, fetch_claude, claude_token
from account_fixtures import use_accounts


def setUpModule():
    use_accounts()


class QuotaTests(unittest.TestCase):
    def settle(self,service,profile):
        deadline=time.monotonic()+2
        while profile in service.pending and time.monotonic()<deadline:time.sleep(.005)
        self.assertNotIn(profile,service.pending)
        return service.read(profile)

    def test_window_validation_and_multiple_codex_buckets(self):
        rows=claude_windows({'five_hour':{'utilization':7,'resets_at':'2026-09-09T00:00:00Z'},'seven_day':{'utilization':True},'seven_day_opus':{'utilization':float('nan')}})
        self.assertEqual(len(rows),1);self.assertEqual(rows[0]['remaining_percent'],93)
        self.assertIsInstance(rows[0]['resets_at'],float)
        rows=codex_windows({'rateLimitsByLimitId':{'spark':{'primary':{'usedPercent':1,'windowDurationMins':300}},'codex':{'secondary':{'usedPercent':33,'windowDurationMins':10080}}}})
        self.assertEqual(rows[0]['label'],'codex · Weekly');self.assertEqual(rows[0]['remaining_percent'],67)
        self.assertEqual(codex_windows({'rateLimits':{'primary':{'usedPercent':100,'windowDurationMins':300}}})[0]['remaining_percent'],0)
        self.assertEqual(claude_windows({}),[])

    def test_claude_spending_allowance_is_not_discarded(self):
        rows=claude_windows({'five_hour':None,'seven_day':None,'extra_usage':{'is_enabled':True,'monthly_limit':10000,'used_credits':2500,'utilization':25}})
        self.assertEqual(rows[0]['label'],'Monthly extra-usage budget')
        self.assertAlmostEqual(rows[0]['remaining_percent'],75)
        self.assertIsNone(rows[0]['resets_at'])
        self.assertEqual(claude_windows({'extra_usage':{'is_enabled':False,'utilization':0}}),[])
        self.assertEqual(claude_windows({'spend':{'enabled':True,'used':{'amount_minor':25,'currency':'USD','exponent':2},'limit':{'amount_minor':100,'currency':'USD','exponent':2}}})[0]['remaining_percent'],75)
        self.assertEqual(claude_windows({'spend':{'enabled':True,'used':{'amount_minor':25},'limit':{'amount_minor':0}}}),[])

    def test_singleflight_cache_isolation_and_failed_refresh(self):
        now=[1000];calls=[];release=threading.Event();fail=[False]
        def fetch(profile):
            calls.append(profile);release.wait(2)
            if fail[0]:raise QuotaError('Login unavailable')
            return [{'label':'Weekly','remaining_percent':80,'used_percent':20,'resets_at':2000}]
        service=AccountQuota(fetch,lambda:now[0])
        for _ in range(10):service.read('claude')
        service.read('claude-personal');release.set()
        self.assertEqual(self.settle(service,'claude')['state'],'ready')
        self.settle(service,'claude-personal')
        self.assertEqual(sorted(calls),['claude','claude-personal'])
        fail[0]=True;now[0]+=121;service.read('claude')
        result=self.settle(service,'claude')
        self.assertEqual(result['state'],'stale');self.assertEqual(result['windows'][0]['remaining_percent'],80)
        self.assertEqual(result['fetched_at'],1000)
        self.assertEqual(service.read('grok')['state'],'unsupported')
        self.assertNotIn('grok',calls)

    def test_unknown_is_not_zero_and_errors_do_not_leak(self):
        def fetch(profile):raise RuntimeError('secret-token-value')
        service=AccountQuota(fetch)
        service.read('codex');result=self.settle(service,'codex')
        self.assertEqual(result['windows'],[]);self.assertEqual(result['state'],'unavailable')
        self.assertNotIn('secret-token-value',json.dumps(result))

    def test_reset_marks_previous_reading_stale(self):
        now=[1000];service=AccountQuota(lambda _:[],lambda:now[0])
        service.cache['claude']={'state':'ready','fetched_at':990,'windows':[{'resets_at':999}]}
        service.attempted['claude']=990
        self.assertEqual(service.read('claude')['state'],'stale')

    @patch('agent_desk.account_quota.sys.platform','darwin')
    @patch('agent_desk.account_quota.subprocess.run')
    def test_keychain_profiles_are_distinct_and_read_only(self,run):
        run.return_value.returncode=0
        run.return_value.stdout=json.dumps({'claudeAiOauth':{'accessToken':'fixture','expiresAt':9999999999999}}).encode()
        self.assertEqual(claude_token('claude'),'fixture');self.assertEqual(claude_token('claude-personal'),'fixture')
        commands=[call.args[0] for call in run.call_args_list]
        self.assertEqual(commands[0][1],'find-generic-password')
        self.assertEqual(commands[0][3],'Claude Code-credentials')
        self.assertTrue(commands[1][3].startswith('Claude Code-credentials-'))
        self.assertNotEqual(commands[0][3],commands[1][3])

    @patch('agent_desk.account_quota.claude_token',return_value='fixture-secret')
    @patch('agent_desk.account_quota.urllib.request.build_opener')
    def test_claude_request_is_read_only_and_fixed_destination(self,opener,token):
        opener.return_value.open.return_value.__enter__.return_value.read.return_value=b'{"five_hour":{"utilization":7}}'
        self.assertEqual(fetch_claude('claude-personal')[0]['remaining_percent'],93)
        request=opener.return_value.open.call_args.args[0]
        self.assertEqual(request.get_method(),'GET')
        self.assertEqual(request.full_url,'https://api.anthropic.com/api/oauth/usage')
        token.assert_called_once_with('claude-personal')

if __name__=='__main__':unittest.main()
