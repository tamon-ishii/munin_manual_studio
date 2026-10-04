#!/usr/bin/env python3
"""Package the three sibling executables required by Munin Manual Studio."""
import argparse
import json
import os
import plistlib
import subprocess
from pathlib import Path
import shutil
import tempfile


def assemble_package(package, binaries, repo, version, platform):
    """Keep helpers next to the host executable, including inside macOS bundles."""
    macos = platform.startswith('macos-')
    destination = package
    if macos:
        contents = package / 'Munin Manual Studio.app' / 'Contents'
        destination = contents / 'MacOS'
        resources = contents / 'Resources'
        destination.mkdir(parents=True)
        resources.mkdir()
        shutil.copy2(repo / 'apps/manual-studio/src-tauri/icons/icon.icns', resources / 'manual-studio.icns')
        with (contents / 'Info.plist').open('wb') as stream:
            plistlib.dump({
                'CFBundleExecutable': 'manual-studio',
                'CFBundleIdentifier': 'com.moduleloom.manualstudio',
                'CFBundleName': 'Munin Manual Studio',
                'CFBundleDisplayName': 'Munin Manual Studio',
                'CFBundlePackageType': 'APPL',
                'CFBundleShortVersionString': version,
                'CFBundleVersion': version,
                'CFBundleIconFile': 'manual-studio.icns',
                'NSHighResolutionCapable': True,
                'NSAppleEventsUsageDescription': 'Control the selected application while recording manual steps.',
            }, stream)
    for binary in binaries:
        target = destination / binary.name
        shutil.copy2(binary, target)
        if macos:
            target.chmod(target.stat().st_mode | 0o111)
    launch = 'Munin Manual Studio.app' if macos else 'manual-studio' + ('.exe' if platform.startswith('windows-') else '')
    (package / 'README.txt').write_text(
        'Munin Manual Studio ' + version + '\n\n'
        'Extract the entire ZIP and open ' + launch + '.\n'
        'Keep all bundled helper executables in their original locations.\n'
        'Linux requires WebKitGTK 4.1 and GTK 3 (Ubuntu 22.04 or newer).\n'
        'Windows requires Microsoft Edge WebView2 Runtime.\n'
        'macOS requires Screen Recording and Accessibility permissions for capture and input recording.\n'
        'macOS bundles use an ad-hoc signature and are not notarized; other executables are unsigned.\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True)
    parser.add_argument('--platform', required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    version = json.loads((repo / 'apps/manual-studio/src-tauri/tauri.conf.json').read_text())['version']
    tag = os.environ.get('RELEASE_TAG', '')
    if tag and tag.removeprefix('v') != version:
        raise SystemExit(f'Release tag {tag!r} does not match application version {version!r}')
    extension = '.exe' if 'windows' in args.target else ''
    binaries = [repo / 'target' / args.target / 'release' / (name + extension)
                for name in ('manual-studio', 'manualctl', 'markits-desktop')]
    for binary in binaries:
        if not binary.is_file():
            raise SystemExit(f'Missing release executable: {binary}')
    output = repo / 'release'
    output.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='manual-studio-release-') as temporary:
        package = Path(temporary)
        assemble_package(package, binaries, repo, version, args.platform)
        if args.platform.startswith('macos-'):
            subprocess.run(['codesign', '--force', '--deep', '--sign', '-',
                            str(package / 'Munin Manual Studio.app')], check=True)
        archive = shutil.make_archive(str(output / f'manual-studio-{version}-{args.platform}'), 'zip', package)
        print(archive)


if __name__ == '__main__':
    main()
