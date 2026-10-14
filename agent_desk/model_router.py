"""Model router: ask a decisions endpoint which model fits a worker task, then pick its harness.

The router only recommends. It receives the task text and the configured model
IDs, never provider credentials or worker output. Agent Desk still launches the
native harness with its own saved login. Contract: a model router service exposing `POST /v1/decide`.
"""
import json
import os
from pathlib import Path
import re
import threading
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from agent_desk.accounts import account as saved_account, sibling
from agent_desk.launch_profiles import login_shell

PREFERENCES = ('auto', 'auto-fast', 'auto-cheap')
HARNESS_LABELS = {'claude': 'Claude Code', 'codex': 'Codex', 'grok': 'Grok'}
DEFAULT_MODELS = [dict(model='gpt-6-luna', account=''), dict(model='claude-opus-5-5', account='')]
MAX_MODELS = 20
MAX_TASK_CHARS = 200_000
TIMEOUT = 20


class RouterError(ValueError):
    """The router could not supply a usable model; no worker is launched."""


def harness_for(model):
    """The harness that runs a model: GPT/o-series/Codex models in Codex, Claude models in Claude Code, Grok in Grok."""
    provider, _, name = model.strip().lower().rpartition('/')
    if provider in ('anthropic', 'claude') or name.startswith(('claude', 'opus', 'sonnet', 'haiku')):return 'claude'
    if provider in ('openai', 'codex') or name.startswith(('gpt', 'codex')) or re.match(r'o\d', name):return 'codex'
    if provider in ('xai', 'grok') or name.startswith('grok'):return 'grok'
    return None


def cli_model(model):
    """`openai/gpt-6-luna` → `gpt-6-luna`; native CLIs take bare model IDs."""
    return model.strip().rsplit('/', 1)[-1]


def worker_profile(harness, family, remote=False, account=''):
    """The worker profile for a harness: a pinned account, else the one that goes with the coordinator's account."""
    if harness == 'grok' or remote:return harness
    if pinned(harness, account):return account
    return sibling(family, harness) if family else harness


def pinned(harness, account):
    """'' follows the coordinator's account; an account ID pins that saved CLI login for the model's harness."""
    found = saved_account(account) if account else None
    return bool(found) and found['harness'] == harness


def stored_models(data):
    """Saved model entries as {model, account}; plain strings came from settings without accounts."""
    entries = data.get('models') or DEFAULT_MODELS
    rows = [dict(model=e, account='') if isinstance(e, str) else dict(model=e.get('model', ''), account=e.get('account', '')) for e in entries if isinstance(e, (str, dict))]
    for row in rows:
        harness = harness_for(row['model']) if isinstance(row['model'], str) else None
        # Earlier settings pinned the two fixed accounts by role.
        account = {'work': harness, 'personal': f'{harness}-personal'}.get(row['account'], row['account'])
        row['account'] = account if pinned(harness, account) else ''
    return rows


def harness_argv(profile, model):
    """A worker terminal command for a routed model, through the login shell so its account applies."""
    if profile == 'grok':return ['grok', '--model', model]
    return [login_shell(), '-lic', profile + ' "$@"', 'agent-desk', '--model', model]


def decide_url(endpoint):
    path = urlparse(endpoint).path.rstrip('/')
    return endpoint.rstrip('/') if path.endswith('/v1/decide') else endpoint.rstrip('/') + '/v1/decide'


def clean(text, limit=300):
    return ''.join(c for c in str(text) if c.isprintable())[:limit]


class _NoRedirect(HTTPRedirectHandler):
    # A redirect would replay the bearer key to another URL; ask for the final endpoint instead.
    def redirect_request(self, *args, **kwargs):return None


class ModelRouter:
    def __init__(self, path, opener=None):
        self.path = Path(path);self.lock = threading.Lock();self.opener = opener or build_opener(_NoRedirect)

    def _read(self):
        try:data = json.loads(self.path.read_text())
        except FileNotFoundError:return {}
        except ValueError:raise RouterError('Model router settings are unreadable; save them again') from None
        return data if isinstance(data, dict) else {}

    def status(self):
        """Settings safe to show in the browser: the API key is never returned."""
        data = self._read()
        return dict(configured=bool(data.get('endpoint')), endpoint=data.get('endpoint', ''), has_api_key=bool(data.get('api_key')),
                    preference=data.get('preference', 'auto'), preferences=list(PREFERENCES),
                    models=[dict(e, harness=harness_for(e['model']), harness_label=HARNESS_LABELS.get(harness_for(e['model']), '')) for e in stored_models(data)])

    def save(self, payload):
        endpoint = payload.get('endpoint');preference = payload.get('preference', 'auto');models = payload.get('models')
        if not isinstance(endpoint, str) or len(endpoint) > 500:raise ValueError('Enter the router URL')
        endpoint = endpoint.strip();url = urlparse(endpoint)
        if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError('Enter an http(s) router URL without credentials, query or fragment')
        if url.scheme == 'http' and url.hostname not in ('127.0.0.1', 'localhost', '::1'):
            raise ValueError('Use https for a remote router; the API key would otherwise travel unencrypted')
        if preference not in PREFERENCES:raise ValueError('Choose auto, auto-fast or auto-cheap')
        if not isinstance(models, list) or not 1 <= len(models) <= MAX_MODELS:raise ValueError(f'List 1–{MAX_MODELS} router models')
        seen = []
        for entry in models:
            model, account = (entry, '') if isinstance(entry, str) else (entry.get('model'), entry.get('account', '')) if isinstance(entry, dict) else (None, '')
            if not isinstance(model, str) or not model.strip() or len(model) > 200 or model.strip().startswith('-') or any(not c.isprintable() or c.isspace() for c in model.strip()):
                raise ValueError('Enter one model ID per line')
            if not harness_for(model):raise ValueError(f'No harness runs {model.strip()}: use a Claude, GPT/Codex or Grok model ID')
            if account and not pinned(harness_for(model), account):raise ValueError('Choose an account for the harness that runs '+model.strip())
            if all(e['model'] != model.strip() for e in seen):seen.append(dict(model=model.strip(), account='' if harness_for(model) == 'grok' else account))
        with self.lock:
            current = self._read();key = current.get('api_key', '')
            if payload.get('clear_api_key') is True:key = ''
            new_key = payload.get('api_key')
            if new_key:
                if not isinstance(new_key, str) or len(new_key) > 1000 or any(not c.isprintable() or c.isspace() for c in new_key.strip()):raise ValueError('Invalid API key')
                key = new_key.strip()
            data = dict(endpoint=endpoint, api_key=key, preference=preference, models=seen)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp = self.path.with_name(self.path.name + '.tmp')
            fd = os.open(temp, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as stream:stream.write(json.dumps(data, indent=2) + '\n')
            os.replace(temp, self.path)
        return self.status()

    def decide(self, task, harness=None):
        """Ask the router for the best configured model for `task`, optionally within one harness."""
        data = self._read()
        if not data.get('endpoint'):raise RouterError('Model router is not configured; add its URL in router settings')
        if not isinstance(task, str) or not task.strip():raise RouterError('Model router needs the worker task')
        accounts = {e['model']: e['account'] for e in stored_models(data)}
        models = [m for m in accounts if harness is None or harness_for(m) == harness]
        if not models:raise RouterError(f'No router models run in {HARNESS_LABELS.get(harness, harness)}; add one in router settings or leave the profile empty')
        body = dict(prompt=task[:MAX_TASK_CHARS], models=models, preference=data.get('preference', 'auto'))
        headers = {'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'agent-desk'}
        if data.get('api_key'):headers['Authorization'] = 'Bearer ' + data['api_key']
        url = decide_url(data['endpoint']);host = urlparse(url).netloc
        try:
            with self.opener.open(Request(url, json.dumps(body).encode(), headers, method='POST'), timeout=TIMEOUT) as response:
                raw = response.read(1_000_001)
        except HTTPError as error:
            try:message = json.loads(error.read(20_000)).get('error', {}).get('message', '')
            except (ValueError, AttributeError):message = ''
            finally:error.close()
            if 300 <= error.code < 400:message = 'redirects are not followed; enter the final router URL'
            raise RouterError(f'Model router at {host} returned {error.code}' + (': ' + clean(message) if message else '')) from None
        except (URLError, OSError) as error:
            raise RouterError(f'Model router at {host} is unreachable: {clean(getattr(error, "reason", error))}') from None
        try:reply = json.loads(raw) if len(raw) <= 1_000_000 else None
        except ValueError:reply = None
        if not isinstance(reply, dict) or not isinstance(reply.get('model'), str):raise RouterError(f'Model router at {host} returned no model decision')
        # The contract returns one of the offered strings verbatim; anything else could launch an unvetted model.
        if reply['model'] not in models:raise RouterError(f'Model router chose {clean(reply["model"], 80)}, which is not in the configured models')
        classifier = reply.get('classifier') if isinstance(reply.get('classifier'), dict) else {}
        ranked = [m for m in reply.get('ranked') or [] if m in models] if isinstance(reply.get('ranked'), list) else []
        return dict(model=cli_model(reply['model']), offered=reply['model'], harness=harness_for(reply['model']), account=accounts[reply['model']], candidates=models,
                    decision_id=clean(reply.get('decision_id', ''), 80), bucket=clean(reply.get('bucket', ''), 80), reason=clean(reply.get('reason', '')),
                    confidence=reply.get('confidence') if isinstance(reply.get('confidence'), (int, float)) else None,
                    policy_version=reply.get('policy_version') if isinstance(reply.get('policy_version'), int) else None,
                    fallback=classifier.get('fallback') is True, ranked=ranked, router=host)


def summary(routing):
    """One line for receipts: model, harness, and why the router chose it."""
    parts = [routing['bucket'] and 'task: ' + routing['bucket'], routing['reason'], routing['fallback'] and 'classifier fell back to its default bucket',
             routing['decision_id'] and 'decision ' + routing['decision_id']]
    return f"model router at {routing['router']} chose {routing['model']} → {HARNESS_LABELS[routing['harness']]}" + (' (' + '; '.join(p for p in parts if p) + ')' if any(parts) else '')
