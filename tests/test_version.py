"""Version identity across source, installed packages and bundled desktop code."""
import os
import base64
import io
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
import zipfile

import agent_desk


class VersionTests(unittest.TestCase):
    def test_source_version_matches_project(self):
        root = Path(__file__).resolve().parent.parent
        with (root / "pyproject.toml").open("rb") as stream:
            self.assertEqual(agent_desk.__version__, tomllib.load(stream)["project"]["version"])

    def test_isolated_source_bundle_and_installed_metadata(self):
        for bundled in (True, False):
            with self.subTest(bundled=bundled), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                package = root / "agent_desk"
                package.mkdir()
                shutil.copyfile(agent_desk.__file__, package / "__init__.py")
                if bundled:
                    (root / "pyproject.toml").write_text('[project]\nname = "agent-desk"\nversion = "0.7.3"\n')
                else:
                    metadata = root / "agent_desk-0.7.3.dist-info"
                    metadata.mkdir()
                    (metadata / "METADATA").write_text('Metadata-Version: 2.1\nName: agent-desk\nVersion: 0.7.3\n')
                result = subprocess.run(
                    [sys.executable, "-I", "-B", "-c",
                     "import sys; sys.path.insert(0, sys.argv[1]); import agent_desk; print(agent_desk.__version__)", os.fspath(root)],
                    capture_output=True, text=True, check=True,
                )
                self.assertEqual(result.stdout.strip(), "0.7.3")

    def test_remote_bundle_imports_without_distribution_metadata(self):
        from agent_desk.remote_environments import bundle

        with tempfile.TemporaryDirectory() as directory:
            payload = bundle()
            with zipfile.ZipFile(io.BytesIO(base64.b64decode(payload["bundle"]))) as archive:
                archive.extractall(directory)
            result = subprocess.run(
                [sys.executable, "-I", "-B", "-c",
                 "import sys; sys.path.insert(0, sys.argv[1]); import agent_desk; print(agent_desk.__version__)", directory],
                capture_output=True, text=True, check=True,
            )
            self.assertEqual(result.stdout.strip(), agent_desk.__version__)
