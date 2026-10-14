"""Read a rustc command from Cargo's verbose output, including colored CI logs."""
import re
import shlex


def cargo_rustc_command(output, crate_name):
    for line in output.splitlines():
        clean = re.sub(r'\x1b\[[0-9;]*m', '', line).strip()
        _, separator, command = clean.partition('Running `')
        if not separator or not command.endswith('`'):
            continue
        args = shlex.split(command[:-1])
        if '--crate-name' in args:
            index = args.index('--crate-name')
            if index + 1 < len(args) and args[index + 1] == crate_name:
                return args
    raise AssertionError(f'Cargo did not report a rustc command for {crate_name}')
