#!/usr/bin/env python3
"""Package the three sibling executables required by Munin Manual Studio."""
import argparse
import json
import os
from pathlib import Path
import shutil
import tempfile


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
        for binary in binaries:
            shutil.copy2(binary, package / binary.name)
        (package / 'README.txt').write_text(
            'Munin Manual Studio ' + version + '\n\n'
            'Extract the entire ZIP and run manual-studio' + extension + '.\n'
            'Keep markits-desktop and manualctl beside Munin Manual Studio.\n'
            'Linux requires WebKitGTK 4.1 and GTK 3 (Ubuntu 22.04 or newer).\n'
            'Windows requires Microsoft Edge WebView2 Runtime.\n'
            'macOS screen recording and accessibility permissions may be required.\n'
            'These portable executables are not code-signed.\n', encoding='utf-8')
        archive = shutil.make_archive(str(output / f'manual-studio-{version}-{args.platform}'), 'zip', package)
        print(archive)


if __name__ == '__main__':
    main()
