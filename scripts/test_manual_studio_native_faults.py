#!/usr/bin/env python3
"""Compile isolated Studio source mutants; reuse immutable dependency artifacts.
The normal binary and working sources are never replaced. Each mutant must fail
at its intended native route, rather than through an unrelated setup failure.
"""
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import time

REPO = Path(__file__).resolve().parents[1]
RESULTS = REPO / 'native-workflow-results/faults'
RESULTS.mkdir(parents=True, exist_ok=True)
BIN = REPO / 'target/debug/manual-studio'
SOURCE = REPO / 'apps/manual-studio/src-tauri/src/main.rs'

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def run(args, env, log, timeout=180):
    with log.open('w') as output:
        process = subprocess.Popen(args, cwd=REPO, env=env, stdout=output, stderr=subprocess.STDOUT)
        try:
            return process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            raise AssertionError(f'Fault verification timed out: {log}')

def build_identity():
    return json.loads(subprocess.check_output(['node', '--input-type=module', '-e', "import {verificationIdentity} from './scripts/lib/manual_ui_identity.mjs';console.log(JSON.stringify(await verificationIdentity(process.cwd())));"], cwd=REPO, text=True))

initial_identity = build_identity()
started_at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
original_binary = digest(BIN)
original_source = digest(SOURCE)
# --print cfg emits a real Cargo rustc invocation without relinking the normal
# binary. The distinct cfg prevents Cargo from hiding the command as Fresh.
probe_log = RESULTS / 'compile-command.log'
code = run(['cargo', 'rustc', '-p', 'manual-studio', '--bin', 'manual-studio', '-vv', '--', '--print', 'cfg', '--cfg', f'munin_fault_probe_{time.time_ns()}'], dict(os.environ), probe_log)
assert code == 0 and digest(BIN) == original_binary, 'Command discovery altered normal binary or failed'
line = next(line.strip()[9:-1] for line in probe_log.read_text().splitlines() if 'Running `CARGO=' in line and 'rustc --crate-name manual_studio' in line)
command = shlex.split(line)
env = dict(os.environ)
while '=' in command[0] and not command[0].startswith('/'):
    key, value = command.pop(0).split('=', 1)
    env[key] = value
index = command.index('--print')
del command[index:index + 2]
conversion = 'let elements = edit["ui"].get("elements").unwrap_or(&edit["ui"]);'
return_line = '        Ok(result.to_string())\n    }).await.map_err(|e|e.to_string())?\n}\n\nfn prepare_library_screenshot'
faults = [
    ('array-conversion', 'array', conversion, 'let elements = edit["ui"].get("elements").unwrap_or(&serde_json::Value::Null);', '画面要素データを読み込めません'),
    ('elements-conversion', 'elements', conversion, 'let elements = &edit["ui"];', '画面要素データを読み込めません'),
    ('return-manuscript', 'array', return_line, '        fs::write(root.join("docs/index.md"), "").map_err(|e|e.to_string())?;\n' + return_line, 'return/adoption unexpectedly changed manuscript'),
]
records = []
try:
    for name, shape, old, new, expected_failure in faults:
        assert SOURCE.read_text().count(old) == 1, f'Mutation anchor changed: {name}'
        with tempfile.TemporaryDirectory(prefix=f'munin-{name}-') as temporary:
            home = Path(temporary)
            shutil.copytree(SOURCE.parent, home / 'src')
            mutant = home / 'src/main.rs'
            mutant.write_text(mutant.read_text().replace(old, new, 1))
            (home / 'bin').mkdir()
            (home / 'bin/manualctl').symlink_to(REPO / 'target/debug/manualctl')
            args = command.copy()
            args[args.index('apps/manual-studio/src-tauri/src/main.rs')] = str(mutant)
            args[args.index('--out-dir') + 1] = str(home / 'bin')
            for index, arg in enumerate(args):
                if arg.startswith('incremental='):
                    args[index] = 'incremental=' + str(home / 'incremental')
                if arg.startswith('extra-filename='):
                    args[index] = 'extra-filename='
                if arg == 'debuginfo=2':
                    args[index] = 'debuginfo=0'
            assert run(args, env, RESULTS / f'{name}-compile.log') == 0, f'Mutant did not compile: {name}'
            (home / 'bin/manual_studio').rename(home / 'bin/manual-studio')
            artifacts = RESULTS / name
            native_env = {**os.environ, 'MANUAL_NATIVE_BIN_DIR': str(home / 'bin'), 'MUNIN_NATIVE_RESULTS': str(artifacts), 'MUNIN_NATIVE_FAULT_SHAPE': shape, 'MUNIN_NATIVE_RESOURCE_ONLY': '1', 'GTK_MODULES': 'atk-bridge', 'NO_AT_BRIDGE': '0', 'WEBKIT_DISABLE_COMPOSITING_MODE': '1'}
            log = RESULTS / f'{name}-run.log'
            result = run(['/usr/bin/python3', str(REPO / 'scripts/test_manual_studio_native_resource_edit.py')], native_env, log)
            observed = log.read_text() + (artifacts / 'failure-ui.json').read_text()
            assert result != 0 and expected_failure in observed, f'Mutation escaped or failed for an unrelated reason: {name}'
            assert not (artifacts / 'result.json').exists(), 'Failed route left success proof'
            record = {'fault': name, 'shape': shape, 'exitCode': result, 'expectedFailure': expected_failure, 'mutantSourceHash': digest(mutant), 'mutantBuildHash': digest(home / 'bin/manual-studio'), 'logHash': digest(log), 'sourceRestored': digest(SOURCE) == original_source, 'binaryRestored': digest(BIN) == original_binary}
            assert record['sourceRestored'] and record['binaryRestored']
            records.append(record)
            print(f'PASS mutation rejected through real Studio button: {name}', flush=True)
finally:
    (RESULTS / 'result.json').write_text(json.dumps({**initial_identity, 'executedAt': started_at, 'completedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'identityStable': build_identity() == initial_identity, 'sourceFileHash': original_source, 'normalBinaryHash': original_binary, 'results': records, 'complete': len(records) == len(faults), 'sourceRestored': digest(SOURCE) == original_source, 'binaryRestored': digest(BIN) == original_binary}, ensure_ascii=False, indent=2))
