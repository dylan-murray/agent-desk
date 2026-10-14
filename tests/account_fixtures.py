"""Added accounts for tests, kept apart from the accounts saved in a developer's own data folder."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_desk import accounts

PERSONAL = [dict(id='claude-personal', harness='claude', name='Personal', config_dir='~/.claude-personal'),
            dict(id='codex-personal', harness='codex', name='Personal', config_dir='~/.codex-personal')]


def use_accounts(rows=PERSONAL):
    """Call from setUpModule. Child processes read the same file through AGENT_DESK_DATA_DIR."""
    folder = tempfile.TemporaryDirectory()
    unittest.addModuleCleanup(folder.cleanup)
    (Path(folder.name) / 'accounts.json').write_text(json.dumps(rows))
    for patcher in (patch.object(accounts, 'DATA_DIR', Path(folder.name)), patch.object(accounts, 'ACCOUNTS_FILE', Path(folder.name) / 'accounts.json'),
                    patch.dict(os.environ, {'AGENT_DESK_DATA_DIR': folder.name})):
        patcher.start()
        unittest.addModuleCleanup(patcher.stop)
