#!/usr/bin/python3
"""Verify the actual WebKit menu on an isolated display and clipboard."""
import ctypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'scripts'))
from test_manual_studio_native_clipboard import wait, stop

RESULTS = REPO / 'native-context-menu-results'
INITIAL = '# Guide\n\nBefore text.\n\nAfter text.\n'


def parent():
    RESULTS.mkdir(exist_ok=True)
    for name in ['result.json', 'failure-ui.json', 'failure.png']:
        (RESULTS / name).unlink(missing_ok=True)
    env = {**os.environ, 'GTK_MODULES': 'atk-bridge', 'NO_AT_BRIDGE': '0',
           'WEBKIT_DISABLE_COMPOSITING_MODE': '1', 'GDK_BACKEND': 'x11', 'GIO_USE_VFS': 'local'}
    for name in ['AT_SPI_BUS_ADDRESS', 'WAYLAND_DISPLAY', 'DBUS_STARTER_ADDRESS', 'DBUS_STARTER_BUS_TYPE']:
        env.pop(name, None)
    display = next(n for n in range(120, 250) if not Path(f'/tmp/.X11-unix/X{n}').exists() and not Path(f'/tmp/.X{n}-lock').exists())
    server = None
    host = connection = host_window = None
    if not shutil.which('Xvfb'):
        host = ctypes.CDLL('libX11.so.6')
        host.XOpenDisplay.restype = ctypes.c_void_p
        host.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        host.XDefaultRootWindow.restype = ctypes.c_ulong
        host.XCreateSimpleWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_ulong]
        host.XCreateSimpleWindow.restype = ctypes.c_ulong
        host.XFlush.argtypes = [ctypes.c_void_p]
        host.XCloseDisplay.argtypes = [ctypes.c_void_p]
        connection = host.XOpenDisplay(None)
        assert connection, 'Host display for isolated Xephyr'
        host_window = host.XCreateSimpleWindow(connection, host.XDefaultRootWindow(connection), 0, 0, 1440, 1000, 0, 0, 0)
        host.XFlush(connection)  # Leave the parent unmapped; the user's desktop stays untouched.
    with tempfile.TemporaryDirectory(prefix='munin-context-display-') as runtime, open(RESULTS / 'display.log', 'w') as log:
        env['XDG_RUNTIME_DIR'] = runtime
        command = ['Xvfb', f':{display}', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp', '-ac'] if shutil.which('Xvfb') else ['Xephyr', f':{display}', '-parent', str(host_window), '-screen', '1440x1000', '-nolisten', 'tcp', '-ac', '-noreset']
        try:
            server = subprocess.Popen(command, stdout=log, stderr=log)
            wait(lambda: Path(f'/tmp/.X11-unix/X{display}').exists(), 'isolated display')
            env['DISPLAY'] = f':{display}'
            subprocess.run(['dbus-run-session', '--', '/usr/bin/python3', str(Path(__file__).resolve()), '--session'], cwd=REPO, env=env, check=True, timeout=150)
        finally:
            stop(server)
            if connection:
                host.XCloseDisplay(connection)


def session():
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
    from lib.native_ui_driver import NativeUI
    app = manager = None
    with tempfile.TemporaryDirectory(prefix='munin-context-menu-') as directory:
        root = Path(directory)
        (root / 'docs').mkdir()
        (root / 'docs/index.md').write_text(INITIAL)
        (root / 'manual_setting.json').write_text(json.dumps({'docs': 'docs', 'targets': ['docs'], 'connection_type': 'none'}))
        env = {**os.environ, 'LANG': 'C.UTF-8', 'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_DATA_HOME': str(root / 'data'), 'XDG_CACHE_HOME': str(root / 'cache')}
        try:
            wm = next(name for name in ['openbox', 'metacity'] if shutil.which(name))
            manager = subprocess.Popen([wm] + (['--sm-disable'] if wm == 'metacity' else []), env=env, stdout=subprocess.DEVNULL, stderr=open(RESULTS / 'manager.log', 'w'))
            wait(lambda: subprocess.run(['wmctrl', '-m'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0, 'window manager')
            app = subprocess.Popen([str(REPO / 'target/debug/manual-studio')], cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=open(RESULTS / 'studio.log', 'w'))
            ui = NativeUI(app.pid)
            ui.find('開く', 'push button', timeout=30)
            ui.click('開く')
            ui.fill('フォルダーのパス', str(root))
            ui.click('開く')
            ui.find('プロジェクトを開きました。', 'status bar', prefix=True)
            ui.click('Markdownソース')
            editor = ui.source_editor()

            def chord(*keys):
                ui.front(app.pid)
                for key in keys:
                    ui.key(key, True)
                for key in reversed(keys):
                    ui.key(key, False)
                ui.x.XFlush(ui.display)

            def menu(select=True, mouse=False):
                assert editor.get_component_iface().grab_focus()
                if select:
                    chord(65507, ord('a'))
                    wait(lambda: Atspi.Text.get_n_selections(editor) == 1, 'source selection')
                time.sleep(.3)
                if mouse:
                    box = Atspi.Text.get_character_extents(editor, 2, Atspi.CoordType.SCREEN)
                    ui.t.XTestFakeMotionEvent(ui.display, -1, box.x + 2, box.y + 2, 0)
                    ui.t.XTestFakeButtonEvent(ui.display, 3, True, 0)
                    ui.t.XTestFakeButtonEvent(ui.display, 3, False, 0)
                    ui.x.XFlush(ui.display)
                else:
                    chord(65383)  # Actual Menu key: use the native context menu.
                return ui.find('選択範囲をAIで修正', 'menu item')

            item = menu()
            assert item.get_state_set().contains(Atspi.StateType.ENABLED)
            names = [node.get_name() for node in ui.allnodes() if node.get_role_name() == 'menu item']
            for label in ['Cut', 'Copy', 'Paste', 'Select All']:
                assert any(label in name.replace('_', '') for name in names), (label, names)
            ui.screenshot(app.pid, RESULTS / 'native-menu.png')
            ui.click('選択範囲をAIで修正', 'menu item')
            ui.find('選択範囲をAIで修正', 'heading')
            assert any(NativeUI.text(node) == INITIAL for node in ui.allnodes()), 'instruction preview retains the exact selected text'
            assert (root / 'docs/index.md').read_text() == INITIAL
            ui.click('閉じる')
            menu(mouse=True)
            copy = next(node for node in ui.allnodes() if node.get_role_name() == 'menu item' and 'Copy' in node.get_name())
            assert copy.get_action_iface().do_action(0)
            assert editor.get_component_iface().grab_focus()
            chord(65507, 65367)  # Ctrl+End
            item = menu(select=False)
            assert not item.get_state_set().contains(Atspi.StateType.ENABLED), 'AI edit requires selected text'
            paste = next(node for node in ui.allnodes() if node.get_role_name() == 'menu item' and 'Paste' in node.get_name())
            assert paste.get_action_iface().do_action(0)
            wait(lambda: Atspi.Text.get_text(editor, 0, -1) == INITIAL + INITIAL, 'native Copy/Paste remains functional')
            chord(65507, ord('z'))
            wait(lambda: Atspi.Text.get_text(editor, 0, -1) == INITIAL, 'Undo preserves existing history')
            bounds = editor.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
            ui.click('Milkdown編集')
            ui.front(app.pid)
            ui.t.XTestFakeMotionEvent(ui.display, -1, bounds.x + 65, bounds.y + 210, 0)
            ui.t.XTestFakeButtonEvent(ui.display, 1, True, 0)
            ui.t.XTestFakeButtonEvent(ui.display, 1, False, 0)
            ui.x.XFlush(ui.display)
            chord(65507, ord('a'))
            ui.find('選択範囲をAIで修正', 'push button')
            time.sleep(.3)
            ui.t.XTestFakeButtonEvent(ui.display, 3, True, 0)
            ui.t.XTestFakeButtonEvent(ui.display, 3, False, 0)
            ui.x.XFlush(ui.display)
            ui.click('選択範囲をAIで修正', 'menu item')
            ui.find('選択範囲をAIで修正', 'heading')
            assert (root / 'docs/index.md').read_text() == INITIAL
            ui.fill('AIへの指示', 'Make this concise')
            chord(65383)
            time.sleep(.3)
            assert not any(node.get_role_name() == 'menu item' and node.get_name() == '選択範囲をAIで修正' for node in ui.allnodes()), 'other text fields retain their existing menus'
            chord(65307)  # Escape the native menu.
            ui.click('閉じる')
            (RESULTS / 'result.json').write_text(json.dumps({'status': 'passed', 'menu': names, 'checks': ['native stock actions retained', 'AI selection preview', 'no edits before adoption', 'physical right click', 'native Copy/Paste', 'Undo', 'rich selection', 'other fields unchanged']}, ensure_ascii=False, indent=2))
            print('Native editor context menu passed: existing actions, AI selection capture, Copy/Paste and Undo.', flush=True)
        except BaseException:
            if app:
                try:
                    (RESULTS / 'failure-ui.json').write_text(json.dumps(ui.dump(), ensure_ascii=False, indent=2))
                    ui.screenshot(app.pid, RESULTS / 'failure.png')
                except Exception as error:
                    print('Failure capture:', error, flush=True)
            raise
        finally:
            stop(app)
            stop(manager)


if __name__ == '__main__':
    session() if '--session' in sys.argv else parent()
