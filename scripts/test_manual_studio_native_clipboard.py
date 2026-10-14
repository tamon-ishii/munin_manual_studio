#!/usr/bin/python3
"""Actual bitmap clipboard -> Studio source Ctrl+V -> PNG/reference -> Undo.

The parent creates an isolated X11 server and DBus session so the user's
clipboard and windows are not targeted. No invoke or DOM event injection.
"""
import hashlib
import json
import os
import re
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time
import zlib
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
RESULTS = REPO / ('native-clipboard-probe-results' if '--probe' in sys.argv else 'native-clipboard-results')
BIN = Path(os.environ.get('MANUAL_NATIVE_BIN_DIR', str(REPO / 'target/debug')))
INITIAL = '# Insertion\n\nBefore text.\n\nAfter text.\n'
CURSOR = INITIAL.index('After')


def wait(check, label, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(.1)
    raise AssertionError(f'Timeout: {label}')


def identity():
    return json.loads(subprocess.check_output(['node', '--input-type=module', '-e', "import {verificationIdentity} from './scripts/lib/manual_ui_identity.mjs';console.log(JSON.stringify(await verificationIdentity(process.cwd())));"], cwd=REPO, text=True))


def stop(process):
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def bitmap():
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    rows = b''.join(b'\0' + b''.join(bytes((x * 3 % 256, y * 5 % 256, 150, 255)) for x in range(64)) for y in range(48))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', 64, 48, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')


def clipboard_worker():
    import gi
    gi.require_version('Gtk', '3.0')
    gi.require_version('Gdk', '3.0')
    gi.require_version('GdkPixbuf', '2.0')
    from gi.repository import Gtk, Gdk, GdkPixbuf
    image, ready = map(Path, sys.argv[2:4])
    Gtk.init([])
    clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
    clipboard.set_image(GdkPixbuf.Pixbuf.new_from_file(str(image)))
    ready.write_text('ready')
    Gtk.main()


def isolated_parent():
    RESULTS.mkdir(exist_ok=True)
    for name in ['result.json', 'failure-ui.json', 'failure.png', 'session-debug.json']:
        (RESULTS / name).unlink(missing_ok=True)
    initial_identity = identity()
    env = {**os.environ, 'GTK_MODULES': 'atk-bridge', 'NO_AT_BRIDGE': '0', 'WEBKIT_DISABLE_COMPOSITING_MODE': '1'}
    server = None
    with tempfile.TemporaryDirectory(prefix='munin-clipboard-session-') as runtime, open(RESULTS / 'display.log', 'w') as log:
        env['XDG_RUNTIME_DIR'] = runtime
        env['GDK_BACKEND'] = 'x11'
        env['GIO_USE_VFS'] = 'local'
        for name in ['AT_SPI_BUS_ADDRESS', 'WAYLAND_DISPLAY', 'DBUS_STARTER_ADDRESS', 'DBUS_STARTER_BUS_TYPE', 'GNOME_KEYRING_CONTROL']:
            env.pop(name, None)
        try:
            number = next(n for n in range(120, 250) if not Path(f'/tmp/.X11-unix/X{n}').exists() and not Path(f'/tmp/.X{n}-lock').exists())
            if shutil.which('Xvfb'):
                args = ['Xvfb', f':{number}', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp', '-ac']
            elif shutil.which('Xephyr') and os.environ.get('DISPLAY'):
                args = ['Xephyr', f':{number}', '-screen', '1440x1000', '-nolisten', 'tcp', '-ac', '-noreset']
            else:
                raise RuntimeError('An isolated X11 display requires Xvfb or Xephyr')
            server = subprocess.Popen(args, stdout=log, stderr=log)
            wait(lambda: Path(f'/tmp/.X11-unix/X{number}').exists(), 'isolated X11 display started')
            env['DISPLAY'] = f':{number}'
            # A separate accessibility bus is required as well as the separate display.
            completed = subprocess.run(['dbus-run-session', '--', '/usr/bin/python3', str(Path(__file__).resolve()), '--session', *(['--probe'] if '--probe' in sys.argv else [])], cwd=REPO, env=env, timeout=150)
            assert completed.returncode == 0, f'Native clipboard session exited {completed.returncode}'
            assert identity() == initial_identity, 'Source/build changed during isolated clipboard verification'
        except BaseException:
            (RESULTS / 'result.json').unlink(missing_ok=True)
            raise
        finally:
            stop(server)


def session():
    from lib.native_ui_driver import NativeUI
    import gi
    gi.require_version('GdkPixbuf', '2.0')
    from gi.repository import Atspi, GdkPixbuf
    started = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    initial_identity = identity()
    app = manager = provider = None
    RESULTS.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='munin-native-clipboard-') as directory:
        root = Path(directory)
        (root / 'docs/assets').mkdir(parents=True)
        (root / 'docs/index.md').write_text(INITIAL)
        other_content = '# Other\n\nOther text.\n'
        (root / 'docs/other.md').write_text(other_content)
        (root / 'manual_setting.json').write_text(json.dumps({'docs': 'docs', 'assets': 'docs/assets', 'targets': ['docs'], 'connection_type': 'none'}))
        source = root / 'clipboard.png'
        source.write_bytes(bitmap())
        original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        env = {**os.environ, 'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_DATA_HOME': str(root / 'data'), 'XDG_CACHE_HOME': str(root / 'cache')}
        try:
            manager_name = next((name for name in ['openbox', 'metacity'] if shutil.which(name)), None)
            if not manager_name:
                raise RuntimeError('An isolated window manager requires openbox or metacity')
            manager = subprocess.Popen([manager_name] + (['--sm-disable'] if manager_name == 'metacity' else []), env=env, stdout=subprocess.DEVNULL, stderr=open(RESULTS / 'manager.log', 'w'))
            wait(lambda: subprocess.run(['wmctrl', '-m'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0, 'isolated window manager ready')
            provider = subprocess.Popen(['/usr/bin/python3', str(Path(__file__).resolve()), '--clipboard', str(source), str(root / 'clipboard-ready')], env=env, stdout=subprocess.DEVNULL, stderr=open(RESULTS / 'clipboard.log', 'w'))
            wait(lambda: (root / 'clipboard-ready').exists(), 'actual bitmap clipboard ready')
            app = subprocess.Popen([str(BIN / 'manual-studio')], cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=open(RESULTS / 'studio.log', 'w'), start_new_session=True)
            ui = NativeUI(app.pid)
            ui.click('開く', owner=app.pid)
            ui.fill('フォルダーのパス', str(root))
            ui.click('開く', owner=app.pid)
            ui.find('プロジェクトを開きました。', 'status bar', app.pid, prefix=True)
            ui.click('Markdownソース', owner=app.pid)
            # WebKit exposes multiline textareas as text on some Linux versions.
            editor = ui.find('Markdown原稿', ('entry', 'text'), app.pid)

            def content():
                return Atspi.Text.get_text(editor, 0, -1)

            def chord(symbol):
                ui.front(app.pid)
                for key, down in [(65507, True), (symbol, True), (symbol, False), (65507, False)]:
                    ui.key(key, down)
                ui.x.XFlush(ui.display)
                ui.log.append({'action': 'physical source key chord', 'key': symbol, 'owner': app.pid})

            def select_cursor():
                ui.front(app.pid)
                assert editor.get_component_iface().grab_focus()
                chord(65360)  # Ctrl+Home
                for _ in range(CURSOR):
                    ui.key(65363, True)
                    ui.key(65363, False)
                ui.x.XFlush(ui.display)
                wait(lambda: Atspi.Text.get_caret_offset(editor) == CURSOR, 'original source caret selected')

            def saved(expected):
                chord(ord('s'))
                wait(lambda: (root / 'docs/index.md').read_text() == expected, 'actual manuscript saved')
                wait(lambda: editor.get_state_set().contains(Atspi.StateType.ENABLED), 'source editing enabled after save')
                ui.find('index.mdを保存しました。', 'status bar', app.pid)

            def decoded(filename):
                image = GdkPixbuf.Pixbuf.new_from_file(str(filename))
                assert (image.get_width(), image.get_height(), image.get_n_channels()) == (64, 48, 4)
                return b''.join(bytes(image.get_pixels()[row * image.get_rowstride():row * image.get_rowstride() + 64 * 4]) for row in range(48))

            assert content() == INITIAL
            baseline_pixels = decoded(source)
            select_cursor()
            before_files = set((root / 'docs/assets').glob('*.png'))
            chord(ord('v'))
            wait(lambda: '![' in content(), 'actual bitmap pasted into source')
            time.sleep(.8)  # Include any late browser paste delivery for the same physical chord.
            inserted = content()
            assert inserted.startswith(INITIAL[:CURSOR]) and inserted.endswith(INITIAL[CURSOR:])
            assert inserted.count('![') == 1, f'One physical paste must insert exactly one image: {inserted!r}'
            match = re.search(r'\]\((assets/[^)]+)\)', inserted)
            assert match, f'Expected relative image reference: {inserted!r}'
            pasted = root / 'docs' / match[1]
            assert decoded(pasted) == baseline_pixels
            assert set((root / 'docs/assets').glob('*.png')) - before_files == {pasted}, 'one actual clipboard event must create one PNG'
            saved(inserted)
            chord(ord('z'))
            wait(lambda: content() == INITIAL, 'physical Undo restored original manuscript')
            saved(INITIAL)
            assert pasted.exists(), 'Undo preserves the saved clipboard asset'
            assert Atspi.Text.get_caret_offset(editor) == CURSOR, 'Undo restores the original source caret'
            first_proof = {'reference': match[1], 'inserted': inserted, 'savedAfterUndo': (root / 'docs/index.md').read_text(), 'caretAfterUndo': Atspi.Text.get_caret_offset(editor), 'pngSha256': hashlib.sha256(pasted.read_bytes()).hexdigest(), 'pixelSha256': hashlib.sha256(decoded(pasted)).hexdigest()}
            ui.log.append({'action': 'verify one PNG/pixel identity, original cursor, saved reference, physical Undo and preserved PNG'})
            print('PASS actual OS bitmap clipboard: original cursor -> one PNG/reference -> actual save -> physical Undo', flush=True)

            # Real filesystem failure, then the same OS clipboard can be pasted again.
            select_cursor()
            assets = root / 'docs/assets'
            assets.chmod(0o500)
            before_retry = set(assets.glob('*.png'))
            chord(ord('v'))
            wait(lambda: any('失敗' in ui.text(node) or 'Permission denied' in ui.text(node) for node in ui.allnodes(app.pid) if node.get_role_name() == 'status bar'), 'clipboard save error visible')
            time.sleep(.8)
            assert content() == INITIAL
            assert set(assets.glob('*.png')) == before_retry
            assets.chmod(0o700)
            select_cursor(); chord(ord('v'))
            wait(lambda: '![' in content(), 'same actual clipboard retry inserted')
            time.sleep(.8)
            retried = content()
            assert retried.startswith(INITIAL[:CURSOR]) and retried.endswith(INITIAL[CURSOR:]) and retried.count('![') == 1
            retry_pngs = set(assets.glob('*.png')) - before_retry
            assert len(retry_pngs) == 1
            assert decoded(next(iter(retry_pngs))) == baseline_pixels
            saved(retried); chord(ord('z')); wait(lambda: content() == INITIAL, 'retry Undo restored manuscript'); saved(INITIAL)
            assert hashlib.sha256(source.read_bytes()).hexdigest() == original_hash
            assert Atspi.Text.get_caret_offset(editor) == CURSOR
            ui.log.append({'action': 'real unwritable asset directory failure, source/file retention, restore directory, same clipboard retry, one PNG, Undo'})
            # An actual X11 owner holds PNG SelectionRequests until the UI operation explicitly releases them.
            stop(provider)
            delayed_binary = root / 'delayed-clipboard'
            subprocess.run(['gcc', '-std=c11', '-D_POSIX_C_SOURCE=200809L', '-Wall', '-Wextra', '-Werror', str(REPO / 'scripts/fixtures/delayed_bitmap_clipboard.c'), '-lX11', '-o', str(delayed_binary)], check=True)
            handshake = root / 'clipboard-handshake'
            provider = subprocess.Popen([str(delayed_binary), str(source), str(handshake)], env=env, stdout=subprocess.DEVNULL, stderr=open(RESULTS / 'delayed-owner.log', 'w'))
            wait(lambda: Path(str(handshake) + '.ready').exists(), 'real delayed X11 clipboard owner ready')
            late_proofs = []
            for action in ('cancel', 'other-manuscript'):
                for suffix in ('.release', '.requested'):
                    Path(str(handshake) + suffix).unlink(missing_ok=True)
                Path(str(handshake) + '.arm').write_text(action)
                select_cursor()
                before_late = set(assets.glob('*.png'))
                chord(ord('v'))
                wait(lambda: Path(str(handshake) + '.requested').exists(), 'real PNG SelectionRequest held')
                assert content() == INITIAL and set(assets.glob('*.png')) == before_late
                if action == 'cancel':
                    ui.click('画像の挿入をキャンセル', owner=app.pid)
                    assert content() == INITIAL
                else:
                    ui.click('other.md', owner=app.pid)
                    wait(lambda: content() == other_content, 'actual tree switched while native clipboard read pending')
                Path(str(handshake) + '.release').write_text(action)
                late_pngs = wait(lambda: set(assets.glob('*.png')) - before_late, 'native clipboard produced actual PNG after handshake release')
                assert len(late_pngs) == 1, 'one late native response saves one retained asset'
                late_png = next(iter(late_pngs))
                wait(lambda: any('リソース一覧に残しています' in ui.text(node) and ('キャンセル' in ui.text(node) if action == 'cancel' else '原稿が変更' in ui.text(node)) for node in ui.allnodes(app.pid) if node.get_role_name() == 'status bar'), 'late clipboard result visibly rejected')
                assert decoded(late_png) == baseline_pixels
                expected = INITIAL if action == 'cancel' else other_content
                assert content() == expected
                assert (root / 'docs/index.md').read_text() == INITIAL
                assert (root / 'docs/other.md').read_text() == other_content
                if action == 'other-manuscript':
                    ui.click('index.md', owner=app.pid)
                    wait(lambda: content() == INITIAL, 'return original manuscript after rejected late bitmap')
                assert editor.get_component_iface().grab_focus()
                wait(lambda: Atspi.Text.get_caret_offset(editor) == CURSOR, 'late result retained original caret')
                late_proofs.append({'action': action, 'actualPng': late_png.relative_to(root).as_posix(), 'pixelSha256': hashlib.sha256(decoded(late_png)).hexdigest(), 'sourceAfterRelease': content(), 'otherSavedContent': (root / 'docs/other.md').read_text(), 'caretAfterReturn': Atspi.Text.get_caret_offset(editor)})
                ui.log.append({'action': 'real X11 PNG request held by owner, actual ' + action + ', explicit release, actual retained PNG/pixels, rejected late insertion, both saved manuscripts and original caret preserved'})
                Path(str(handshake) + '.arm').unlink()
            (RESULTS / 'clipboard-handshake.json').write_text(json.dumps({'requests': [json.loads(line) for line in Path(str(handshake) + '.log').read_text().splitlines()], 'proofs': late_proofs}, ensure_ascii=False, indent=2))
            print('PASS actual delayed X11 bitmap response: visible cancel / actual other manuscript -> explicit release -> real retained PNG -> no stale insertion -> original caret', flush=True)
            ui.screenshot(app.pid, RESULTS / 'final.png')
            assert identity() == initial_identity, 'No success evidence for changed source/build'
            registry = json.loads((REPO / 'scripts/fixtures/manual-studio-ui-inventory.json').read_text())
            case = next(case for case in registry['cases'] if case['id'] == 'P03.desktop-bitmap-paste')
            (RESULTS / 'storage-proof.json').write_text(json.dumps({'initial': INITIAL, 'cursor': CURSOR, 'originalPngSha256': original_hash, 'originalPixelSha256': hashlib.sha256(baseline_pixels).hexdigest(), 'firstPaste': first_proof, 'retry': {'inserted': retried, 'pngSha256': hashlib.sha256(next(iter(retry_pngs)).read_bytes()).hexdigest(), 'pixelSha256': hashlib.sha256(decoded(next(iter(retry_pngs)))).hexdigest(), 'savedAfterUndo': (root / 'docs/index.md').read_text(), 'caretAfterUndo': Atspi.Text.get_caret_offset(editor)}, 'steps': ui.log}, ensure_ascii=False, indent=2))
            artifacts = [{'path': name, 'sha256': hashlib.sha256((RESULTS / name).read_bytes()).hexdigest()} for name in ['final.png', 'storage-proof.json', 'clipboard-handshake.json']]
            results = [{'caseId': case['id'], 'entryPoint': entry, 'type': 'real-desktop', 'status': 'passed', 'steps': ui.log, 'assertions': dict.fromkeys(['visible', 'stored', 'preserved', 'returnTarget'], True), 'artifacts': artifacts} for entry in case['entryPoints']]
            if '--probe' not in sys.argv:
                (RESULTS / 'result.json').write_text(json.dumps({**initial_identity, 'executedAt': started, 'completedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'type': 'real-desktop', 'scope': 'actual bitmap clipboard and source physical Ctrl+V/Ctrl+Z in isolated X11/DBus session; real PNG/filesystem save failure/retry; real X11 owner held PNG response with explicit request/release handshake, visible cancellation and actual alternate manuscript late-result rejection; no clipboard file URI, rich paste or other OS proof', 'results': results}, ensure_ascii=False, indent=2))
            print('PASS actual OS clipboard filesystem failure -> same clipboard retry -> Undo; source and original pixels preserved', flush=True)
        except Exception:
            if app and 'ui' in locals():
                desktop = Atspi.get_desktop(0)
                (RESULTS / 'session-debug.json').write_text(json.dumps({'appPid': app.pid, 'appExit': app.poll(), 'windows': subprocess.check_output(['wmctrl', '-lp'], text=True), 'accessibleApplications': [[desktop.get_child_at_index(i).get_process_id(), desktop.get_child_at_index(i).get_name()] for i in range(desktop.get_child_count())]}, indent=2))
                (RESULTS / 'failure-ui.json').write_text(json.dumps(ui.dump(), ensure_ascii=False, indent=2))
                try:
                    ui.screenshot(app.pid, RESULTS / 'failure.png')
                except Exception:
                    pass
            raise
        finally:
            if (root / 'docs/assets').exists():
                (root / 'docs/assets').chmod(0o700)
            if app and app.poll() is None:
                os.killpg(app.pid, signal.SIGTERM)
                try:
                    app.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(app.pid, signal.SIGKILL); app.wait()
            stop(provider); stop(manager)


if __name__ == '__main__':
    if '--clipboard' in sys.argv:
        clipboard_worker()
    elif '--session' in sys.argv:
        session()
    else:
        isolated_parent()
