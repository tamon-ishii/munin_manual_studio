import unittest
from lib.cargo_rustc_command import cargo_rustc_command


class CargoRustcCommandTests(unittest.TestCase):
    def test_colored_ci_command_preserves_arguments_and_environment(self):
        output = (
            '     Fresh dependency v1.0\n'
            '\x1b[1m\x1b[92m     Running\x1b[0m '
            "`CARGO=/toolchain/cargo CARGO_PKG_AUTHORS='' "
            "LD_LIBRARY_PATH='/build with spaces/deps:/lib' "
            '/toolchain/rustc --crate-name manual_studio --edition=2021 '
            "apps/manual-studio/src-tauri/src/main.rs --cfg 'feature=\"default\"' "
            '--print cfg`\n'
        )
        self.assertEqual(cargo_rustc_command(output, 'manual_studio'), [
            'CARGO=/toolchain/cargo', 'CARGO_PKG_AUTHORS=',
            'LD_LIBRARY_PATH=/build with spaces/deps:/lib', '/toolchain/rustc',
            '--crate-name', 'manual_studio', '--edition=2021',
            'apps/manual-studio/src-tauri/src/main.rs', '--cfg', 'feature="default"',
            '--print', 'cfg',
        ])

    def test_selects_requested_crate_without_requiring_cargo_env_first(self):
        output = (
            ' Running `rustc --crate-name other`\n'
            ' Running `OUT_DIR=/build CARGO=/cargo rustc --crate-name manual_studio --print cfg`\n'
        )
        self.assertEqual(cargo_rustc_command(output, 'manual_studio')[-4:],
                         ['--crate-name', 'manual_studio', '--print', 'cfg'])

    def test_missing_compilation_command_reports_setup_failure(self):
        with self.assertRaisesRegex(AssertionError, 'manual_studio'):
            cargo_rustc_command('Fresh manual-studio v0.9.8', 'manual_studio')


if __name__ == '__main__':
    unittest.main()
