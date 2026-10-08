#!/usr/bin/python3
"""Real Studio workflow in an isolated X11 session application and project.

Requires the built Studio/manualctl, system Python GI/GTK3/AT-SPI, wmctrl/xprop, and MkDocs.
Only descendants of the spawned Studio are inspected or terminated.
"""
import os, subprocess, tempfile, time, json, shutil, ctypes, hashlib, sys
from pathlib import Path
REPO = Path(__file__).resolve().parents[1]
BIN = REPO / 'target/debug'
if sys.platform != 'linux':
    raise SystemExit('This Studio GUI check requires Linux X11 and AT-SPI.')
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi
root = tempfile.mkdtemp(prefix='munin-studio-native-ui-')
os.mkdir(root + '/docs')
open(root + '/docs/index.md', 'w').write('# Native UI fixture\n')
open(root + '/manual_setting.json', 'w').write(json.dumps({'docs': 'docs', 'connection_type': 'none'}))
env = os.environ.copy()
for name, sub in [('XDG_DATA_HOME', 'data'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache')]:
    env[name] = root + '/' + sub
app = subprocess.Popen([str(BIN / 'manual-studio')], cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)

def owned(pid):
    for _ in range(20):
        if pid == app.pid:
            return True
        try:
            pid = int(open('/proc/%d/stat' % pid).read().rsplit(')', 1)[1].split()[1])
        except:
            return False
    return False

def visit(node, depth=0):
    if depth > 18:
        return
    try:
        role = node.get_role_name()
        name = node.get_name()
        states = node.get_state_set()
        if name and states.contains(Atspi.StateType.SHOWING):
            print(role, repr(name[:100]))
        for i in range(min(node.get_child_count(), 100)):
            visit(node.get_child_at_index(i), depth + 1)
    except:
        pass

def nodes(node, depth=0):
    if depth > 18:
        return
    try:
        yield node
        for i in range(min(node.get_child_count(), 100)):
            yield from nodes(node.get_child_at_index(i), depth + 1)
    except:
        pass

def node_text(node):
    name = node.get_name()
    if name:
        return name
    try:
        return Atspi.Text.get_text(node, 0, -1)
    except Exception:
        pass
    return ''

def find(name, role=None, prefix=False):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        desktop = Atspi.get_desktop(0)
        matches = []
        for i in range(desktop.get_child_count()):
            a = desktop.get_child_at_index(i)
            if a is None or not owned(a.get_process_id()):
                continue
            for n in nodes(a):
                try:
                    if (node_text(n).startswith(name) if prefix else node_text(n) == name) and (role is None or n.get_role_name() == role) and n.get_state_set().contains(Atspi.StateType.SHOWING):
                        matches.append(n)
                except:
                    pass
        if matches:
            return matches[-1]
        time.sleep(0.2)
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        a = desktop.get_child_at_index(i)
        if a is not None and owned(a.get_process_id()):
            visit(a)
    print('ASSET FILES', list(__import__('pathlib').Path(root).glob('.munin/screenshots/*/manifest.json')), flush=True)
    raise RuntimeError('Accessible control not found: ' + name)

def click(name, role=None):
    n = find(name, role, prefix=name == '編集終了')
    action = n.get_action_iface()
    if not action or not action.do_action(0):
        box = Atspi.Component.get_extents(n, Atspi.CoordType.SCREEN)
        assert box.width > 0 and box.height > 0, name
        xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
        xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
        xtst.XTestFakeMotionEvent(display, -1, box.x + box.width // 2, box.y + box.height // 2, 0)
        xtst.XTestFakeButtonEvent(display, 1, 1, 0)
        xtst.XTestFakeButtonEvent(display, 1, 0, 0)
        x11.XFlush(display)
    time.sleep(0.4)

def fill(name, value, prefix=False):
    field = find(name, 'entry', prefix)
    box = Atspi.Component.get_extents(field, Atspi.CoordType.SCREEN)
    assert box.width > 0 and box.height > 0
    xtst.XTestFakeMotionEvent(display, -1, box.x + box.width // 2, box.y + box.height // 2, 0)
    xtst.XTestFakeButtonEvent(display, 1, 1, 0)
    xtst.XTestFakeButtonEvent(display, 1, 0, 0)
    control = x11.XKeysymToKeycode(display, 65507)
    key_a = x11.XKeysymToKeycode(display, ord('a'))
    xtst.XTestFakeKeyEvent(display, control, 1, 0)
    xtst.XTestFakeKeyEvent(display, key_a, 1, 0)
    xtst.XTestFakeKeyEvent(display, key_a, 0, 0)
    xtst.XTestFakeKeyEvent(display, control, 0, 0)
    x11.XFlush(display)
    time.sleep(0.1)
    for ch in value:
        symbol = 65293 if ch == '\n' else ord(ch)
        key = x11.XKeysymToKeycode(display, symbol)
        assert key
        shifted = x11.XkbKeycodeToKeysym(display, key, 0, 0) != symbol
        if shifted:
            assert x11.XkbKeycodeToKeysym(display, key, 0, 1) == symbol
        if shifted:
            xtst.XTestFakeKeyEvent(display, shift, 1, 0)
        xtst.XTestFakeKeyEvent(display, key, 1, 0)
        xtst.XTestFakeKeyEvent(display, key, 0, 0)
        if shifted:
            xtst.XTestFakeKeyEvent(display, shift, 0, 0)
        x11.XFlush(display)
        time.sleep(0.04)
    time.sleep(0.5)
    assert Atspi.Text.get_text(field, 0, -1) == value, (name, Atspi.Text.get_text(field, 0, -1))
try:
    for _ in range(60):
        desktop = Atspi.get_desktop(0)
        apps = [desktop.get_child_at_index(i) for i in range(desktop.get_child_count())]
        selected = [a for a in apps if a is not None and owned(a.get_process_id())]
        if selected:
            time.sleep(3)
            click('開く', 'push button')
            field = find('プロジェクトのフォルダー', 'entry')
            box = Atspi.Component.get_extents(field, Atspi.CoordType.SCREEN)
            assert Atspi.generate_mouse_event(box.x + box.width // 2, box.y + box.height // 2, 'b1c')
            assert field.get_component_iface().grab_focus()
            x11 = ctypes.CDLL('libX11.so.6')
            xtst = ctypes.CDLL('libXtst.so.6')
            x11.XOpenDisplay.restype = ctypes.c_void_p
            display = x11.XOpenDisplay(None)
            x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
            x11.XKeysymToKeycode.restype = ctypes.c_uint
            x11.XkbKeycodeToKeysym.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_int]
            x11.XkbKeycodeToKeysym.restype = ctypes.c_ulong
            x11.XFlush.argtypes = [ctypes.c_void_p]
            xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
            xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
            xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
            shift = x11.XKeysymToKeycode(display, 65505)
            subprocess.run(['wmctrl', '-Fa', 'Munin Manual Studio'], check=True)
            time.sleep(0.3)
            fill('プロジェクトのフォルダー', root)
            click('開く', 'push button')
            time.sleep(2)
            click('設定')
            click('対象アプリ', 'push button')
            click('＋ コマンドを追加', 'push button')
            target_studio = os.environ.get('MANUAL_NATIVE_TARGET_STUDIO')
            if target_studio:
                target_root = root + '/target-project'
                nested = Path(target_root) / 'docs/recording-chapter/recording-section'
                nested.mkdir(parents=True)
                (Path(target_root) / 'docs/index.md').write_text('# Target home\n')
                (Path(target_root) / 'manual_setting.json').write_text(json.dumps({'docs':'docs','connection_type':'none'}))
                (nested / 'detail.md').write_text('# Hierarchy captured\n\nNested screen replay fixture.\n')
                fill('起動コマンド / アプリ', target_studio, True)
            else:
                fixture = root + '/target.py'
                report = root + '/arguments.json'
                open(fixture, 'w').write('import gi,sys,json\nfrom pathlib import Path\ngi.require_version("Gtk","3.0")\nfrom gi.repository import Gtk\nPath(sys.argv[1]).write_text(json.dumps(sys.argv[2:]))\nw=Gtk.Window(title="Munin Native Recording Target");w.set_default_size(640,400)\nb=Gtk.Button(label="Record target");b.connect("clicked",lambda b:b.set_label("Clicked"));w.add(b);w.connect("destroy",Gtk.main_quit);w.show_all();Gtk.main()\n')
                fill('起動コマンド / アプリ', '/usr/bin/python3', True)
                fill('起動引数（1行に1つ）', '\n'.join([fixture, report, ' value with spaces ', '$(literal)']))
            click('共通コマンドを保存', 'push button')
            click('閉じる', 'push button')
            click('スクリーンショット一覧', 'push button')
            click('操作を記録して撮影', 'push button')
            click('記録を開始', 'push button')
            time.sleep(3)
            if target_studio:
                def physical_click(name):
                    subprocess.run(['wmctrl', '-Fa', 'Manual Studio'], check=True)
                    time.sleep(0.2)
                    node = find(name)
                    box = Atspi.Component.get_extents(node, Atspi.CoordType.SCREEN)
                    xtst.XTestFakeMotionEvent(display, -1, box.x + box.width // 2, box.y + box.height // 2, 0)
                    xtst.XTestFakeButtonEvent(display, 1, 1, 0)
                    xtst.XTestFakeButtonEvent(display, 1, 0, 0)
                    x11.XFlush(display)
                    time.sleep(0.8)
                physical_click('⚙ ワークスペース')
                fill('プロジェクトのフォルダー', target_root)
                physical_click('開く')
                physical_click('recording-chapter フォルダー')
                physical_click('recording-section フォルダー')
                physical_click('▦ detail.md')
                print('RECORDED: real Manual Studio hierarchy recording-chapter/recording-section/detail.md', flush=True)
            else:
                assert json.load(open(report)) == [' value with spaces ', '$(literal)']
                operation = root + '/target-click.json'
                open(operation, 'w').write(json.dumps({'version': 1, 'platform': 'desktop', 'window': 'Munin Native Recording Target', 'steps': [{'wait_ms': 400}, {'click': {'x': 80, 'y': 80}}, {'wait_ms': 400}]}))
                subprocess.run([str(BIN / 'manualctl'), 'scenario-run', '--root', root, '--input', operation], check=True, stdout=subprocess.DEVNULL, timeout=15)
            click('スクリーンショットを実行', 'push button')
            click('⬜ 矩形', 'push button')
            canvas = find('Background Canvas', 'image')
            box = Atspi.Component.get_extents(canvas, Atspi.CoordType.SCREEN)
            assert box.width > 100 and box.height > 100
            start = (box.x + int(box.width * 0.1), box.y + int(box.height * 0.1))
            end = (box.x + int(box.width * 0.3), box.y + int(box.height * 0.3))
            xtst.XTestFakeMotionEvent(display, -1, *start, 0)
            xtst.XTestFakeButtonEvent(display, 1, 1, 0)
            x11.XFlush(display)
            time.sleep(0.1)
            for index in range(1, 11):
                xtst.XTestFakeMotionEvent(display, -1, int(start[0] + (end[0] - start[0]) * index / 10), int(start[1] + (end[1] - start[1]) * index / 10), 0)
                x11.XFlush(display)
                time.sleep(0.04)
            xtst.XTestFakeButtonEvent(display, 1, 0, 0)
            x11.XFlush(display)
            time.sleep(0.3)
            click('編集終了', 'push button')
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                manifests = list(Path(root).glob('.munin/screenshots/*/manifest.json'))
                if len(manifests) == 1:
                    shot = json.load(open(manifests[0]))
                    if shot['adopted']:
                        break
                time.sleep(0.3)
            assert len(manifests) == 1
            assert shot['adopted'] and len(shot['recipe']['steps']) > 1
            assert shot['edits'][-1]['scene']['annotations'], 'a native drag must create an annotation'
            scene_before = shot['edits'][-1]['scene']
            source_files = list(manifests[0].parent.glob('originals/*.png'))
            hashes_before = {f.name: hashlib.sha256(f.read_bytes()).hexdigest() for f in source_files}
            if target_studio:
                shutil.copyfile(source_files[0], '/tmp/munin-native-hierarchy-before.png')
            print('REGISTERED NATIVE CAPTURE', shot['id'], flush=True)
            click('MarkItsで編集', 'push button')
            click('編集終了', 'push button')
            time.sleep(2)
            after = json.load(open(manifests[0]))
            assert after['edits'][-1]['scene'] == scene_before, 're-edit must restore the annotations exactly'
            assert {f.name: hashlib.sha256(f.read_bytes()).hexdigest() for f in source_files} == hashes_before
            subprocess.run(['wmctrl', '-Fa', 'Munin Manual Studio'], check=True)
            time.sleep(0.3)
            click('再撮影', 'push button')
            # WebKit's JavaScript dialog is not exposed as AT-SPI children.
            # Use its OK button in this fixture's fixed native window geometry.
            frame = find('Munin Manual Studio', 'frame')
            box = Atspi.Component.get_extents(frame, Atspi.CoordType.SCREEN)
            xtst.XTestFakeMotionEvent(display, -1, box.x + box.width // 2 + 135, box.y + box.height // 2 + 81, 0)
            xtst.XTestFakeButtonEvent(display, 1, 1, 0)
            xtst.XTestFakeButtonEvent(display, 1, 0, 0)
            x11.XFlush(display)
            completion = find('再撮影が完了しました。', prefix=True)
            assert '成功 1件' in node_text(completion), node_text(completion)
            active = subprocess.check_output(['xprop', '-root', '_NET_ACTIVE_WINDOW'], text=True).strip().split()[-1]
            active_name = subprocess.check_output(['xprop', '-id', active, '_NET_WM_NAME'], text=True)
            assert 'Munin Manual Studio' in active_name, active_name
            runs = list(Path(root).glob('.munin/recaptures/*.json'))
            assert len(runs) == 1 and json.load(open(runs[0]))['items'][0]['status'] == 'succeeded'
            if target_studio:
                candidates = list(manifests[0].parent.glob('originals/*.png'))
                latest = max(candidates, key=lambda path: path.stat().st_mtime_ns)
                shutil.copyfile(latest, '/tmp/munin-native-hierarchy-after.png')
            print('PASS: real recapture completes, shows its result, and returns Studio to the foreground.', flush=True)
            click('文書に挿入', 'push button')
            click('原稿を編集', 'push button')
            click('保存 ⌘ / Ctrl S', 'push button')
            time.sleep(1)
            assert 'screenshot:ref' in open(root + '/docs/index.md').read()
            result = subprocess.run([str(BIN / 'manualctl'), 'build-mkdocs', '--root', root], check=True, capture_output=True, text=True, timeout=30, env=os.environ.copy())
            assert 'Site:' in result.stdout
            assert shot['id'] in open(root + '/manual/index.html').read()
            print('PASS: real Studio settings, operation recording, capture library, MarkIts edit/re-edit, Studio return, Markdown insertion and HTML publication without AI.', flush=True)
            break
        time.sleep(0.5)
    else:
        raise RuntimeError('No accessible Studio application within 30 seconds')
finally:
    try:
        os.killpg(app.pid, 15)
    except ProcessLookupError:
        pass
    try:
        app.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(app.pid, 9)
        except ProcessLookupError:
            pass
        app.wait()
    for event_file in __import__('pathlib').Path('/tmp').glob('manual-studio-recorder-%d-*.jsonl' % app.pid):
        event_file.unlink(missing_ok=True)
    if os.environ.get('MANUAL_NATIVE_KEEP_FIXTURE'):
        print('NATIVE FIXTURE:', root, flush=True)
    else:
        shutil.rmtree(root, ignore_errors=True)
