#!/usr/bin/env python3
"""Launch Manual Studio from any working directory using only the standard library."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys


PROJECT_ROOT = Path(__file__).resolve().parent
BUILD_INPUTS = (
    "Cargo.toml",
    "Cargo.lock",
    "package.json",
    "package-lock.json",
    "apps/manual-studio/index.html",
    "apps/manual-studio/vite.config.ts",
    "apps/manual-studio/src",
    "apps/manual-studio/src-tauri",
    "crates/manual-core/src",
    "crates/manual-core/Cargo.toml",
    "crates/analysis-core/src",
    "crates/analysis-core/assets",
    "crates/analysis-core/Cargo.toml",
    "skills/moduleloom-diagnostics/SKILL.md",
    "crates/markits/src",
    "crates/markits/Cargo.toml",
    "crates/markits/Cargo.lock",
    "crates/markits/apps/desktop/src",
    "crates/markits/apps/desktop/src-tauri",
    "crates/markits/apps/desktop/package.json",
    "crates/markits/apps/desktop/package-lock.json",
)


def source_is_newer(binary: Path) -> bool:
    built_at = binary.stat().st_mtime
    for relative in BUILD_INPUTS:
        source = PROJECT_ROOT / relative
        files = source.rglob("*") if source.is_dir() else (source,)
        if any(path.is_file() and path.stat().st_mtime > built_at for path in files):
            return True
    return False


def required_tool(name: str) -> str:
    executable = shutil.which(name)
    if executable is None:
        raise RuntimeError(f"初回ビルドには {name} が必要です。インストールしてください。")
    return executable


def prepare_frontend(npm: str, directory: Path = PROJECT_ROOT) -> None:
    if not (directory / "node_modules").is_dir():
        subprocess.run([npm, "ci"], cwd=directory, check=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Manual Studioをローカルで起動します。初回は自動でビルドします。")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--build", action="store_true", help="現在のソースからビルドして起動")
    mode.add_argument("--dev", action="store_true", help="変更を反映する開発モードで起動")
    return parser.parse_args()


def target_directory() -> Path:
    target = Path(os.environ.get("CARGO_TARGET_DIR", "target"))
    return target if target.is_absolute() else PROJECT_ROOT / target


def cached_binary(target: Path) -> Path | None:
    binary_name = "manual-studio.exe" if sys.platform == "win32" else "manual-studio"
    markits_binary_name = "markits-desktop.exe" if sys.platform == "win32" else "markits-desktop"
    candidates = [target / profile / binary_name for profile in ("debug", "release")]
    candidates = [candidate for candidate in candidates if candidate.is_file() and os.access(candidate, os.X_OK)]
    if not candidates:
        return None
    latest = max(candidates, key=lambda candidate: candidate.stat().st_mtime)
    manualctl_name = "manualctl.exe" if sys.platform == "win32" else "manualctl"
    if source_is_newer(latest) or not (latest.parent / markits_binary_name).is_file() or not (latest.parent / manualctl_name).is_file():
        return None
    return latest


def build_application(target: Path) -> Path:
    print("Manual Studioの変更を検出したため、最新のソースからビルドします。", flush=True)
    npm = required_tool("npm")
    cargo = required_tool("cargo")
    markits_frontend = PROJECT_ROOT / "crates/markits/apps/desktop"
    prepare_frontend(npm)
    subprocess.run([npm, "run", "manual:build"], cwd=PROJECT_ROOT, check=True)
    prepare_frontend(npm, markits_frontend)
    subprocess.run([npm, "run", "build"], cwd=markits_frontend, check=True)
    subprocess.run(
        [cargo, "build", "--locked", "--manifest-path", "crates/markits/apps/desktop/src-tauri/Cargo.toml", "--target-dir", str(target)],
        cwd=PROJECT_ROOT,
        check=True,
    )
    subprocess.run([cargo, "build", "--locked", "-p", "manual-core", "--bin", "manualctl", "--target-dir", str(target)], cwd=PROJECT_ROOT, check=True)
    subprocess.run([cargo, "build", "--locked", "-p", "manual-studio", "--target-dir", str(target)], cwd=PROJECT_ROOT, check=True)
    binary_name = "manual-studio.exe" if sys.platform == "win32" else "manual-studio"
    return target / "debug" / binary_name


def launch(binary: Path) -> int:
    environment = os.environ.copy()
    environment["PATH"] = str(binary.parent) + os.pathsep + environment.get("PATH", "")
    return subprocess.run([str(binary)], cwd=PROJECT_ROOT, env=environment, check=False).returncode


def run_development_mode() -> int:
    npm = required_tool("npm")
    cargo = required_tool("cargo")
    prepare_frontend(npm)
    markits_frontend = PROJECT_ROOT / "crates/markits/apps/desktop"
    prepare_frontend(npm, markits_frontend)
    subprocess.run([npm, "run", "manual:build"], cwd=PROJECT_ROOT, check=True)
    subprocess.run([npm, "run", "build"], cwd=markits_frontend, check=True)
    target = target_directory()
    subprocess.run([cargo, "build", "--locked", "--manifest-path", "crates/markits/apps/desktop/src-tauri/Cargo.toml", "--target-dir", str(target)], cwd=PROJECT_ROOT, check=True)
    subprocess.run([cargo, "build", "--locked", "-p", "manual-core", "--bin", "manualctl", "--target-dir", str(target)], cwd=PROJECT_ROOT, check=True)
    environment = os.environ.copy()
    environment["PATH"] = str(target / "debug") + os.pathsep + environment.get("PATH", "")
    return subprocess.run([npm, "run", "manual:app"], cwd=PROJECT_ROOT, env=environment, check=False).returncode


def main() -> int:
    args = parse_args()

    try:
        if args.dev:
            return run_development_mode()
        target = target_directory()
        binary = None if args.build else cached_binary(target)
        return launch(binary or build_application(target))
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"起動できませんでした: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
