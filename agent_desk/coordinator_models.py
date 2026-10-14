"""Model choices from native profile caches; custom IDs remain supported."""
import json
import os
from pathlib import Path

from agent_desk.accounts import config_folder, harness_of


def model_options(profile):
    harness=harness_of(profile)
    if not harness:
        raise ValueError('Choose a supported coordinator provider')
    models=[];source='Enter a model ID supported by this CLI. Empty uses its configured default.'
    if harness=='claude':
        models=['sonnet','opus','haiku'];source='Claude model aliases; you can also enter an exact model ID.'
    elif harness=='codex':
        folder=Path(os.environ.get('CODEX_HOME', str(Path.home()/'.codex'))) if os.environ.get('AGENT_DESK_REMOTE_NATIVE')=='1' else config_folder(profile)
        try:
            path=folder/'models_cache.json'
            if path.stat().st_size<=2_000_000:
                data=json.loads(path.read_text())
                models=[r['slug'] for r in data.get('models',[]) if isinstance(r,dict) and r.get('visibility')=='list' and isinstance(r.get('slug'),str)][:40]
                source='Models from this Codex account’s local cache; account availability may change. Custom IDs are supported.'
        except (OSError,ValueError,TypeError):pass
    return {'models':models,'source':source}
