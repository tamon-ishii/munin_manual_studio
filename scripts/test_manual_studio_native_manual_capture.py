#!/usr/bin/python3
"""Real editor manual capture, MarkIts handoff, insertion, restart and Undo."""
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
BIN = Path(os.environ.get('MANUAL_NATIVE_BIN_DIR', REPO / 'target/debug'))
RESULTS = REPO / ('native-manual-capture-probe-results' if '--probe' in sys.argv else 'native-manual-capture-results')
INITIAL = '# Capture\n\nBefore.\n\nAfter.\n'
CURSOR = INITIAL.index('After')


def wait(check, label, timeout=30):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = check()
        if value:
            return value
        time.sleep(.15)
    raise AssertionError(f'Timeout: {label}')


def identity():
    return json.loads(subprocess.check_output(['node', '--input-type=module', '-e', "import {verificationIdentity} from './scripts/lib/manual_ui_identity.mjs';console.log(JSON.stringify(await verificationIdentity(process.cwd())));"], cwd=REPO, text=True))


def stop(process):
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill(); process.wait()


def parent():
    RESULTS.mkdir(exist_ok=True)
    for name in ('result.json', 'failure-ui.json', 'failure.png', 'session-debug.json'):
        (RESULTS / name).unlink(missing_ok=True)
    initial = identity()
    build = json.loads((REPO / 'ui-coverage-results/build.json').read_text())
    probe = '--probe' in sys.argv
    if not probe:
        assert all(build[key] == initial[key] for key in ('sourceHash', 'buildHash', 'os')), 'Build stamp is stale; rebuild before native capture verification'
    env = {**os.environ, 'GTK_MODULES': 'atk-bridge', 'NO_AT_BRIDGE': '0', 'WEBKIT_DISABLE_COMPOSITING_MODE': '1'}
    display = None
    with tempfile.TemporaryDirectory(prefix='munin-manual-capture-session-') as runtime, open(RESULTS / 'display.log', 'w') as log:
        env.update(XDG_RUNTIME_DIR=runtime, GDK_BACKEND='x11', GIO_USE_VFS='local')
        for name in ('AT_SPI_BUS_ADDRESS', 'WAYLAND_DISPLAY', 'DBUS_STARTER_ADDRESS', 'DBUS_STARTER_BUS_TYPE', 'GNOME_KEYRING_CONTROL'):
            env.pop(name, None)
        try:
            number = next(n for n in range(120, 250) if not Path(f'/tmp/.X11-unix/X{n}').exists() and not Path(f'/tmp/.X{n}-lock').exists())
            if shutil.which('Xvfb'):
                args = ['Xvfb', f':{number}', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp', '-ac']
            elif shutil.which('Xephyr') and os.environ.get('DISPLAY'):
                args = ['Xephyr', f':{number}', '-screen', '1440x1000', '-nolisten', 'tcp', '-ac', '-noreset']
            else:
                raise RuntimeError('An isolated X11 display requires Xvfb or Xephyr')
            display = subprocess.Popen(args, stdout=log, stderr=log)
            wait(lambda: Path(f'/tmp/.X11-unix/X{number}').exists(), 'isolated X11 display')
            env['DISPLAY'] = f':{number}'
            completed = subprocess.run(['dbus-run-session', '--', '/usr/bin/python3', str(Path(__file__).resolve()), '--session', *(['--probe'] if probe else [])], cwd=REPO, env=env, timeout=240)
            assert completed.returncode == 0, f'Manual capture session exited {completed.returncode}'
            assert identity() == initial, 'Source/build changed during manual capture verification'
        except BaseException:
            (RESULTS / 'result.json').unlink(missing_ok=True)
            raise
        finally:
            stop(display)


def session():
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
    from lib.native_ui_driver import NativeUI
    initial = identity()
    started = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    app = manager = None
    with tempfile.TemporaryDirectory(prefix='munin-native-manual-capture-') as directory:
        root = Path(directory)
        (root / 'docs').mkdir()
        (root / 'docs/index.md').write_text(INITIAL)
        other_content = '# Other\n\nOther text.\n'
        (root / 'docs/other.md').write_text(other_content)
        (root / 'manual_setting.json').write_text(json.dumps({'docs': 'docs', 'targets': ['docs'], 'connection_type': 'none'}))
        (root / '.munin').mkdir()
        fixture = REPO / 'scripts/fixtures/manual_capture_target.py'
        profile = {'id': 'app-native-manual-fixture', 'name': 'GTK fixture', 'program': '/usr/bin/python3', 'args': [str(fixture), '--arguments-output', str(root / 'target-arguments.json')]}
        (root / '.munin/launch_commands.json').write_text(json.dumps([profile]))
        env = {**os.environ, 'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_DATA_HOME': str(root / 'data'), 'XDG_CACHE_HOME': str(root / 'cache')}
        try:
            manager_name = next((name for name in ('openbox', 'metacity') if shutil.which(name)), None)
            if not manager_name:
                raise RuntimeError('An isolated window manager requires openbox or metacity')
            manager = subprocess.Popen([manager_name] + (['--sm-disable'] if manager_name == 'metacity' else []), env=env, stdout=subprocess.DEVNULL, stderr=open(RESULTS / 'manager.log', 'w'))
            wait(lambda: subprocess.run(['wmctrl', '-m'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0, 'isolated window manager')
            app = subprocess.Popen([str(BIN / 'manual-studio')], cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=open(RESULTS / 'studio.log', 'w'), start_new_session=True)
            ui = NativeUI(app.pid)
            ui.click('開く', owner=app.pid)
            ui.fill('フォルダーのパス', str(root))
            ui.click('開く', owner=app.pid)
            ui.find('プロジェクトを開きました。', 'status bar', app.pid, prefix=True)
            ui.click('Markdownソース', owner=app.pid)
            editor = ui.find('Markdown原稿', 'entry', app.pid)
            content = lambda: Atspi.Text.get_text(editor, 0, -1)

            def chord(symbol):
                ui.front(app.pid)
                for key, down in ((65507, True), (symbol, True), (symbol, False), (65507, False)):
                    ui.key(key, down)
                ui.x.XFlush(ui.display)
                ui.log.append({'action': 'physical source key chord', 'key': symbol})

            def cursor():
                ui.front(app.pid)
                assert editor.get_component_iface().grab_focus()
                chord(65360)
                for _ in range(CURSOR):
                    ui.key(65363, True); ui.key(65363, False)
                ui.x.XFlush(ui.display)
                wait(lambda: Atspi.Text.get_caret_offset(editor) == CURSOR, 'original source caret')

            def begin():
                cursor()
                ui.click('スクリーンショットを挿入', owner=app.pid)
                ui.click('手動で撮影', owner=app.pid)
                ui.click('記録を開始', owner=app.pid)
                ui.find('スクリーンショットを実行', owner=app.pid)
                assert content() == INITIAL

            def capture():
                ui.click('スクリーンショットを実行', owner=app.pid)
                canvas = ui.find('Background Canvas', 'image', app.pid, timeout=35)
                markits = ui.window_pid(canvas.get_process_id())
                assert markits != app.pid and ui.owned(markits)
                ui.screenshot(markits, RESULTS / 'markits.png')
                ui.click('編集終了（Manual Studioへ返す）', owner=markits)
                ui.find('スクショを確認して挿入', 'dialog', app.pid, timeout=60)
                assert content() == INITIAL

            assert content() == INITIAL
            cursor()
            ui.click('スクリーンショットを挿入', owner=app.pid)
            ui.click('手動で撮影', owner=app.pid)
            ui.click('キャンセル', owner=app.pid)
            assert content() == INITIAL
            assert editor.get_component_iface().grab_focus()
            wait(lambda: Atspi.Text.get_caret_offset(editor) == CURSOR, 'method cancellation preserved the original source caret')
            begin(); capture()
            first = json.loads(subprocess.check_output([str(BIN / 'manualctl'), '--request', json.dumps({'root': str(root), 'action': 'screenshots-list'})], text=True))
            assert len(first['items']) == 1 and first['items'][0]['adopted'], 'captured and edited image must persist before insertion'
            first_id = first['items'][0]['id']
            ui.click('閉じる', owner=app.pid)
            assert content() == INITIAL
            assert editor.get_component_iface().grab_focus()
            wait(lambda: Atspi.Text.get_caret_offset(editor) == CURSOR, 'preview cancellation preserved the original source caret')
            ui.log.append({'action': 'cancel preview and retain captured image and original cursor'})

            begin()
            target = ui.find('Save fixture', 'push button', app.pid)
            target_pid = target.get_process_id()
            assert target_pid != app.pid and ui.owned(target_pid), 'failure injection must target only Studio-launched GTK fixture'
            os.kill(target_pid, signal.SIGKILL)
            ui.log.append({'action': 'fault: terminate owned GTK capture target before screenshot', 'pid': target_pid})
            wait(lambda: not any(ui.text(node) == 'Save fixture' and node.get_state_set().contains(Atspi.StateType.SHOWING) for node in ui.allnodes(app.pid)), 'capture target window disappeared')
            ui.click('スクリーンショットを実行', owner=app.pid)
            failure_message = ui.text(ui.find('撮影に失敗しました:', owner=app.pid, prefix=True, timeout=35))
            assert '撮影に失敗しました:' in failure_message
            ui.click('閉じてMunin Manual Studioに戻る', owner=app.pid)
            wait(lambda: not any(ui.text(node) == '手動でスクショを撮影' and node.get_state_set().contains(Atspi.StateType.SHOWING) for node in ui.allnodes(app.pid)), 'failed recording dialog cleared')
            assert content() == INITIAL
            assert editor.get_component_iface().grab_focus()
            wait(lambda: Atspi.Text.get_caret_offset(editor) == CURSOR, 'capture failure preserved original source caret')
            after_failure = json.loads(subprocess.check_output([str(BIN / 'manualctl'), '--request', json.dumps({'root': str(root), 'action': 'screenshots-list'})], text=True))
            assert [item['id'] for item in after_failure['items']] == [first_id], 'failed capture must not create another screenshot'
            ui.log.append({'action': 'verify native failure event cleared recording, returned to original source caret, and preserved screenshot library'})
            (RESULTS / 'failure-control.json').write_text(json.dumps({'message': failure_message, 'targetPid': target_pid, 'screenshotIdsAfterFailure': [first_id], 'sourceAfterFailure': content(), 'caretAfterFailure': Atspi.Text.get_caret_offset(editor)}, ensure_ascii=False, indent=2))

            begin(); capture()
            ui.click('この位置に挿入', owner=app.pid)
            inserted = wait(lambda: text if 'screenshot:ref' in (text := content()) else None, 'source screenshot inserted')
            assert inserted.startswith(INITIAL[:CURSOR]) and inserted.endswith(INITIAL[CURSOR:])
            assert inserted.count('<!-- screenshot:ref id=') == 1
            shot_id = re.search(r'<!-- screenshot:ref id=([^ >]+)', inserted).group(1)
            assert shot_id != first_id
            wait(lambda: (root / 'docs/index.md').read_text() == inserted, 'captured reference saved to real manuscript')
            assert editor.get_component_iface().grab_focus()
            chord(ord('z'))
            wait(lambda: content() == INITIAL, 'physical Undo restored manuscript')
            chord(ord('s'))
            wait(lambda: (root / 'docs/index.md').read_text() == INITIAL, 'Undo saved to manuscript')
            assert Atspi.Text.get_caret_offset(editor) == CURSOR
            # Closing insertion preserves the capture operation; its eventual result belongs to the library.
            begin()
            ui.click('閉じる', owner=app.pid)
            ui.click('other.md', owner=app.pid)
            wait(lambda: content() == other_content, 'switch to separate manuscript during cancelled capture')
            ui.click('スクリーンショットを実行', owner=app.pid)
            canvas = ui.find('Background Canvas', 'image', app.pid, timeout=35)
            markits = ui.window_pid(canvas.get_process_id())
            assert markits != app.pid and ui.owned(markits)
            ui.click('編集終了（Manual Studioへ返す）', owner=markits)
            def completed_cancelled_capture():
                shots = json.loads(subprocess.check_output([str(BIN / 'manualctl'), '--request', json.dumps({'root': str(root), 'action': 'screenshots-list'})], text=True))['items']
                return shots if len(shots) == 3 and all(item['adopted'] for item in shots) else None
            cancelled_late_shots = wait(completed_cancelled_capture, 'cancelled capture preserved in real screenshot library', timeout=40)
            assert content() == other_content
            assert (root / 'docs/other.md').read_text() == other_content
            assert (root / 'docs/index.md').read_text() == INITIAL
            assert not any(ui.text(node) == 'スクショを確認して挿入' and node.get_state_set().contains(Atspi.StateType.SHOWING) for node in ui.allnodes(app.pid)), 'late cancelled capture must not offer insertion into another manuscript'
            ui.click('index.md', owner=app.pid)
            wait(lambda: content() == INITIAL, 'return to original manuscript')
            assert editor.get_component_iface().grab_focus()
            wait(lambda: Atspi.Text.get_caret_offset(editor) == CURSOR, 'return restored original source caret')
            ui.log.append({'action': 'cancel insertion, switch actual manuscript, complete real GTK/MarkIts capture, preserve both files and library image, return original manuscript/cursor'})
            ui.screenshot(app.pid, RESULTS / 'final.png')
            assert identity() == initial, 'Source/build changed during verification'
            proof = {'initial': INITIAL, 'cursor': CURSOR, 'previewCancelledScreenshot': first_id, 'failure': failure_message, 'insertedScreenshot': shot_id, 'inserted': inserted, 'savedAfterUndo': (root / 'docs/index.md').read_text(), 'otherManuscriptAfterLateCapture': (root / 'docs/other.md').read_text(), 'screenshotIdsAfterLateCapture': [item['id'] for item in cancelled_late_shots], 'steps': ui.log}
            (RESULTS / 'storage-proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2))
            registry = json.loads((REPO / 'scripts/fixtures/manual-studio-ui-inventory.json').read_text())
            case = next(case for case in registry['cases'] if case['id'] == 'P04.editor-manual')
            artifacts = [{'path': name, 'sha256': hashlib.sha256((RESULTS / name).read_bytes()).hexdigest()} for name in ('markits.png', 'final.png', 'storage-proof.json', 'failure-control.json')]
            records = [{'caseId': case['id'], 'entryPoint': entry, 'type': 'real-desktop', 'status': 'passed', 'steps': ui.log, 'assertions': dict.fromkeys(('visible', 'stored', 'preserved', 'returnTarget'), True), 'artifacts': artifacts} for entry in case['entryPoints']]
            if '--probe' not in sys.argv:
                (RESULTS / 'result.json').write_text(json.dumps({**initial, 'executedAt': started, 'completedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'type': 'real-desktop', 'scope': 'isolated X11 editor manual capture, actual GTK target and MarkIts, preview cancel, target-terminated capture failure, Studio return, fresh recording from same cursor, source insertion/save/physical Undo, cancelled late capture after real manuscript switch and original cursor return', 'results': records}, ensure_ascii=False, indent=2))
            print('PASS actual manual capture: same source cursor -> preview cancel -> target loss/failure -> fresh recording -> MarkIts -> save -> physical Undo', flush=True)
        except BaseException:
            if app and 'ui' in locals():
                try:
                    (RESULTS / 'failure-ui.json').write_text(json.dumps(ui.dump(), ensure_ascii=False, indent=2))
                    ui.screenshot(app.pid, RESULTS / 'failure.png')
                except Exception:
                    pass
            raise
        finally:
            if app and app.poll() is None:
                os.killpg(app.pid, signal.SIGTERM)
                try:
                    app.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(app.pid, signal.SIGKILL); app.wait()
            stop(manager)


if __name__ == '__main__':
    session() if '--session' in sys.argv else parent()
