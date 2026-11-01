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

    def test_windows_build_avoids_the_running_legacy_executable(self):
        target = self.root / "target"
        legacy = target / "debug/manual-studio.exe"
        legacy.parent.mkdir(parents=True)
        legacy.write_bytes(b"running old app")
        with patch.object(launcher.sys, "platform", "win32"), patch.object(launcher, "required_tool", side_effect=lambda name: name), patch.object(launcher, "prepare_frontend"), patch.object(launcher.subprocess, "run") as run:
            binary = launcher.build_application(target)
        self.assertEqual(binary, target / "debug/manual-studio-launcher.exe")
        command = run.call_args_list[-1].args[0]
        self.assertEqual(command[:2], ["cargo", "rustc"])
        self.assertEqual(command[-3:], ["--", "-o", str(binary)])
        self.assertIn("--locked", command)
        self.assertEqual(legacy.read_bytes(), b"running old app")

    def test_windows_runs_private_copies_and_preserves_build_artifacts(self):
        binary = self.root / "target/debug/manual-studio-launcher.exe"
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b"new app")
        cli = binary.parent / "manualctl.exe"
        cli.write_bytes(b"cli")
        observed = []
        def run(command, **kwargs):
            executable = Path(command[0])
            observed.append(executable)
            self.assertNotEqual(executable, binary)
            self.assertEqual(executable.read_bytes(), b"new app")
            self.assertEqual((executable.parent / "manualctl.exe").read_bytes(), b"cli")
            self.assertEqual(kwargs["env"]["PATH"].split(launcher.os.pathsep)[0], str(executable.parent))
            return subprocess.CompletedProcess(command, 7)
        with patch.object(launcher.sys, "platform", "win32"), patch.object(launcher.subprocess, "run", side_effect=run):
            self.assertEqual(launcher.launch(binary), 7)
        self.assertFalse(observed[0].exists())
        self.assertEqual(binary.read_bytes(), b"new app")
        self.assertEqual(cli.read_bytes(), b"cli")

    def test_windows_launcher_artifact_is_reused_without_rebuilding(self):
        target = self.root / "target"
        binary = target / "debug/manual-studio-launcher.exe"
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b"app")
        binary.chmod(0o755)
        (binary.parent / "manualctl.exe").write_bytes(b"cli")
        with patch.object(launcher.sys, "platform", "win32"), patch.object(launcher, "source_is_newer", return_value=False):
            self.assertEqual(launcher.cached_binary(target), binary)


if __name__ == "__main__":
    unittest.main()
