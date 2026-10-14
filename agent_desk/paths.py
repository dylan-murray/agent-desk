"""Application assets and writable state, independent of the launch directory."""
import os
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = PACKAGE_DIR.parent
STATIC_DIR = PACKAGE_DIR / "static"
SCRIPTS_DIR = PROJECT_DIR / "scripts"
# Source checkouts retain existing sessions. Installed wheels use user-owned state.
_default_data = PROJECT_DIR / "data" if (PROJECT_DIR / "pyproject.toml").is_file() else Path.home() / ".local" / "share" / "agent-desk"
DATA_DIR = Path(os.environ.get("AGENT_DESK_DATA_DIR", str(_default_data))).expanduser().resolve()
