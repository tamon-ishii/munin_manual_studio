import importlib.util
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('package_release', Path(__file__).with_name('package_release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseLayoutTests(unittest.TestCase):
    def test_each_release_has_host_and_helpers_in_the_same_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / 'repo'
            icon = repo / 'apps/manual-studio/src-tauri/icons/icon.icns'
            icon.parent.mkdir(parents=True)
            icon.write_bytes(b'icon')
            for platform in ('windows-x64', 'linux-x64', 'macos-arm64', 'macos-x64'):
                extension = '.exe' if platform.startswith('windows') else ''
                binaries = []
                source = root / ('source-' + platform)
                source.mkdir()
                for name in ('manual-studio', 'manualctl', 'markits-desktop'):
                    binary = source / (name + extension)
                    binary.write_bytes(name.encode())
                    binaries.append(binary)
                package = root / platform
                package.mkdir()
                release.assemble_package(package, binaries, repo, '0.2.1', platform)
                destination = package
                if platform.startswith('macos'):
                    contents = package / 'Munin Manual Studio.app/Contents'
                    destination = contents / 'MacOS'
                    info = plistlib.loads((contents / 'Info.plist').read_bytes())
                    self.assertEqual(info['CFBundleExecutable'], 'manual-studio')
                    self.assertEqual(info['CFBundleShortVersionString'], '0.2.1')
                    self.assertTrue((contents / 'Resources/manual-studio.icns').is_file())
                for binary in binaries:
                    self.assertEqual((destination / binary.name).read_bytes(), binary.read_bytes())
                self.assertIn('0.2.1', (package / 'README.txt').read_text())

    @unittest.skipUnless(sys.platform == 'darwin', 'requires macOS codesign')
    def test_macos_bundle_and_all_helpers_have_valid_signatures(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'main.rs'
            source.write_text('fn main() {}')
            executable = root / 'manual-studio'
            subprocess.run(['rustc', str(source), '-o', str(executable)], check=True)
            binaries = [executable]
            for name in ('manualctl', 'markits-desktop'):
                binary = root / name
                shutil.copy2(executable, binary)
                binaries.append(binary)
            package = root / 'package'
            package.mkdir()
            repo = Path(__file__).resolve().parent.parent
            release.assemble_package(package, binaries, repo, '0.2.1', 'macos-arm64')
            release.sign_macos_bundle(package)
            for binary in binaries:
                subprocess.run(['codesign', '--verify', '--strict',
                                str(package / 'Munin Manual Studio.app/Contents/MacOS' / binary.name)], check=True)


if __name__ == '__main__':
    unittest.main()
