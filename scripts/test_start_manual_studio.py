"""Launcher recovery when a vendored MarkIts checkout becomes a submodule."""

import io
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("studio_launcher", Path(__file__).resolve().parents[1] / "start_manual_studio.py")
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class MarkItsRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "project"
        self.root.mkdir()
        (self.root / ".git").mkdir()
        (self.root / ".gitmodules").write_text("[submodule]\n")
        self.source = self.root / "crates/markits"
        self.root_patch = patch.object(launcher, "PROJECT_ROOT", self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)

    def checkout(self, *args, **kwargs):
        (self.source / "apps/desktop").mkdir(parents=True)
        (self.source / "Cargo.toml").write_text("[package]\n")
        (self.source / "apps/desktop/package.json").write_text("{}")

    def test_ready_sources_need_no_git_or_network(self):
        self.checkout()
        with patch.object(launcher.subprocess, "run") as run:
            launcher.prepare_markits_sources()
        run.assert_not_called()

    def test_recovery_messages_work_with_windows_legacy_encoding(self):
        output = io.BytesIO()
        stream = io.TextIOWrapper(output, encoding="cp1252")
        with patch.object(launcher.sys, "stdout", stream), patch.object(launcher, "required_tool", return_value="git"), patch.object(launcher.subprocess, "run", side_effect=self.checkout):
            launcher.prepare_markits_sources()
        stream.flush()
        self.assertIn(b"MarkIts", output.getvalue())

    def test_missing_sources_are_checked_out_before_build(self):
        with patch.object(launcher, "required_tool", return_value="git"), patch.object(launcher.subprocess, "run", side_effect=self.checkout) as run:
            launcher.prepare_markits_sources()
        run.assert_called_once_with(
            ["git", "submodule", "update", "--init", "--recursive", "--", "crates/markits"],
            cwd=self.root, check=True,
        )
        self.assertTrue((self.source / "apps/desktop/package.json").is_file())

    def test_old_cache_is_reused_and_manuscripts_are_preserved(self):
        cache = self.source / "apps/desktop/node_modules"
        cache.mkdir(parents=True)
        (cache / "cached-package").write_text("cached")
        manuscript = self.source / "manual/notes.md"
        manuscript.parent.mkdir()
        manuscript.write_text("Keep this manuscript")
        backup = Path(self.temporary.name) / "backup"
        backup.mkdir()
        with patch.object(launcher.tempfile, "mkdtemp", return_value=str(backup)), patch.object(launcher, "required_tool", return_value="git"), patch.object(launcher.subprocess, "run", side_effect=self.checkout):
            launcher.prepare_markits_sources()
        self.assertEqual((cache / "cached-package").read_text(), "cached")
        self.assertEqual((backup / "markits/manual/notes.md").read_text(), "Keep this manuscript")

    def test_download_failure_keeps_original_files_in_backup(self):
        self.source.mkdir(parents=True)
        (self.source / "user-data").write_text("Keep me")
        backup = Path(self.temporary.name) / "backup"
        backup.mkdir()
        failure = subprocess.CalledProcessError(1, ["git", "submodule"])
        with patch.object(launcher.tempfile, "mkdtemp", return_value=str(backup)), patch.object(launcher, "required_tool", return_value="git"), patch.object(launcher.subprocess, "run", side_effect=failure):
            with self.assertRaises(subprocess.CalledProcessError):
                launcher.prepare_markits_sources()
        self.assertEqual((backup / "markits/user-data").read_text(), "Keep me")

    def test_source_archive_reports_missing_sources_without_moving_files(self):
        (self.root / ".git").rmdir()
        with self.assertRaisesRegex(RuntimeError, "recurse-submodules"):
            launcher.prepare_markits_sources()


if __name__ == "__main__":
    unittest.main()
