"""Agent Desk: a local workspace for coding agents."""

from importlib.metadata import version as _distribution_version
from pathlib import Path as _Path
import tomllib as _tomllib


def _project_version():
    project_file = _Path(__file__).resolve().parent.parent / "pyproject.toml"
    if project_file.is_file():
        with project_file.open("rb") as stream:
            project = _tomllib.load(stream).get("project", {})
        if project.get("name") == "agent-desk":
            return project["version"]
    return _distribution_version("agent-desk")


try:
    # Remote source bundles carry generated metadata without a package install.
    from agent_desk._version import VERSION as __version__
except ModuleNotFoundError as error:
    if error.name != "agent_desk._version":
        raise
    __version__ = _project_version()
