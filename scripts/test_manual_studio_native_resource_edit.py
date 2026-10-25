#!/usr/bin/python3
"""Studio resource button -> actual MarkIts -> candidate -> compare -> adopt.

No invoke mocking and no direct annotation process launch. All data is isolated.
Requires X11, a window manager, GI/AT-SPI/Gdk, wmctrl and built debug binaries.
"""
import base64
import hashlib
import json
import os
import signal
import struct
import subprocess
import tempfile
import time
import zlib
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from lib.native_ui_driver import NativeUI
from gi.repository import Atspi

REPO = Path(__file__).resolve().parents[1]
BIN = Path(os.environ.get('MANUAL_NATIVE_BIN_DIR', REPO / 'target/debug')).resolve()
RESULTS = Path(os.environ.get('MUNIN_NATIVE_RESULTS', REPO / 'native-workflow-results')).resolve()
RESULTS.mkdir(parents=True, exist_ok=True)
(RESULTS / 'result.json').unlink(missing_ok=True)


def terminate_request(*_):
    raise SystemExit('Native verification was terminated; no success evidence written')


signal.signal(signal.SIGTERM, terminate_request)


def build_identity():
    return json.loads(subprocess.check_output(['node', '--input-type=module', '-e', "import {verificationIdentity} from './scripts/lib/manual_ui_identity.mjs';console.log(JSON.stringify(await verificationIdentity(process.cwd(),process.env.MANUAL_NATIVE_BIN_DIR)));"], cwd=REPO, text=True))


initial_identity = build_identity()


def png():
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    raw = (b'\0' + bytes([238, 245, 252, 255]) * 640) * 400
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', 640, 400, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


def wait(check, label, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(.2)
    raise AssertionError(f'Timeout: {label}')


with tempfile.TemporaryDirectory(prefix='munin-resource-edit-native-') as temporary:
    root = Path(temporary)
    (root / 'docs/assets').mkdir(parents=True)
    (root / 'manual_setting.json').write_text(json.dumps({'docs': 'docs', 'assets': 'docs/assets', 'output': 'manual', 'targets': ['docs'], 'connection_type': 'none'}))
    source = png()
    (root / 'docs/assets/ordinary.png').write_bytes(source)
    scene = {'canvas': {'width': 640, 'height': 400}, 'annotations': [{'type': 'rect', 'target': [30, 40, 120, 80], 'style': 'primary'}]}
    elements = [{'role': 'button', 'name': 'Save fixture', 'x': 30, 'y': 40, 'width': 120, 'height': 80}]

    def rpc(action, options=None):
        result = subprocess.check_output([str(BIN / 'manualctl'), '--request', json.dumps({'root': str(root), 'action': action, 'options': options or {}})], text=True, timeout=15)
        try:
            return json.loads(result)
        except json.JSONDecodeError:
            return result

    shots = []
    for name, ui in [('array', elements), ('elements', {'elements': elements})]:
        if os.environ.get('MUNIN_NATIVE_FAULT_SHAPE') and name != os.environ['MUNIN_NATIVE_FAULT_SHAPE']:
            continue
        result = rpc('screenshots-register', {'json': {'source': base64.b64encode(source).decode(), 'scene': scene, 'ui': ui, 'name': f'Native {name}'}})
        shots.append((name, result['screenshot']['id']))
    references = [rpc('screenshots-reference', {'id': sid, 'page': 'index.md'}) for _, sid in shots]
    class ImageAPI(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get('Content-Length', 0)))
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'data': [{'b64_json': base64.b64encode(source).decode()}]}).encode())
        def log_message(self, *args):
            pass
    image_api = ThreadingHTTPServer(('127.0.0.1', 0), ImageAPI)
    threading.Thread(target=image_api.serve_forever, daemon=True).start()
    try:
        rpc('image-generation-settings', {'json': {'save': True, 'provider': 'api', 'model': 'native-fixture', 'endpoint': f'http://127.0.0.1:{image_api.server_port}/images/generations'}})
        generated = rpc('image-generate', {'json': {'prompt': 'Native fixture image', 'provider': 'api', 'api_key': 'isolated-fixture-key'}})
        generated_bytes = (root / generated['path']).read_bytes()
        assert generated_bytes[:8] == source[:8]
        assert struct.unpack('!II', generated_bytes[16:24]) == (640, 400)
        assert list((root / '.munin/generated-images').glob('*.json'))
    finally:
        image_api.shutdown()
        image_api.server_close()
    manuscript = '# Native resource edit\n\n' + '\n\n'.join(references) + '\n\n![Ordinary](assets/ordinary.png)\n'
    (root / 'docs/index.md').write_text(manuscript)
    (root / 'docs/other.md').write_text('# Other\n\n' + references[0])
    env = {**os.environ, 'XDG_DATA_HOME': str(root / 'data'), 'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_CACHE_HOME': str(root / 'cache')}
    app = subprocess.Popen([str(BIN / 'manual-studio')], cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=open(RESULTS / 'studio.log', 'w'), start_new_session=True)
    ui = NativeUI(app.pid)
    results = []
    target = subprocess.Popen(['/usr/bin/python3', str(REPO / 'scripts/fixtures/manual_capture_target.py'), '--arguments-output', str(root / 'target-arguments.json'), ' value with spaces ', '$(literal)'], cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait(lambda: (root / 'target-arguments.json').exists(), 'fixture application launched')
        assert json.loads((root / 'target-arguments.json').read_text()) == [' value with spaces ', '$(literal)']
        ui.click('開く', owner=app.pid)
        ui.fill('フォルダーのパス', str(root))
        ui.click('開く', owner=app.pid)
        ui.find('プロジェクトを開きました。', 'status bar', app.pid, prefix=True)
        registry = json.loads((REPO / 'scripts/fixtures/manual-studio-ui-inventory.json').read_text())
        if not os.environ.get('MUNIN_NATIVE_ORDINARY_ONLY'):
            ui.click('撮影一覧', owner=app.pid)
            for name, sid in shots:
                ui.click('原稿を編集', owner=app.pid)
                baseline_pixels = ui.image_pixels(f'Native {name}')
                ui.click('撮影一覧', owner=app.pid)
                ui.fill('撮影を検索', sid)
                before = rpc('screenshots-image', {'id': sid})
                original = rpc('screenshots-image', {'id': sid, 'json': {'original': True}})['data']
                assert before['edit']['ui'] == (elements if name == 'array' else {'elements': elements})
                assert rpc('screenshots-list')['items'][next(i for i, s in enumerate(rpc('screenshots-list')['items']) if s['id'] == sid)]['usage'], 'fixture must have a referencing manuscript'
                begin = len(ui.log)
                ui.click(f'Native {name}の操作', 'unknown', app.pid)
                ui.click('編集', owner=app.pid)
                editor = ui.find('Background Canvas', 'image')
                editor_pid = ui.window_pid(editor.get_process_id())
                assert editor_pid != app.pid and ui.owned(editor_pid)
                ui.find('1. rect', owner=editor_pid)
                ui.rectangle(editor_pid)
                ui.find('2. rect', owner=editor_pid)
                ui.screenshot(editor_pid, RESULTS / f'{name}-markits.png')
                ui.click('編集終了（Manual Studioへ返す）', owner=editor_pid)
                candidate = wait(lambda: (d if len(d['screenshot']['edits']) == len(before['screenshot']['edits']) + 1 else None) if (d := rpc('screenshots-image', {'id': sid})) else None, 'candidate saved')
                newest = rpc('screenshots-image', {'id': sid, 'json': {'revision': candidate['screenshot']['edits'][-1]['id']}})
                assert len(newest['edit']['scene']['annotations']) == 2
                candidate = wait(lambda: (d if d['screenshot']['adopted'] == newest['edit']['id'] else None) if (d := rpc('screenshots-image', {'id': sid})) else None, 'edited image adopted automatically')
                assert candidate['data'] == newest['data']
                saved_status = ui.find('編集内容を反映しました。', 'status bar', app.pid, prefix=True, showing=False)
                saved_status.get_component_iface().scroll_to(Atspi.ScrollType.ANYWHERE)
                ui.find('編集内容を反映しました。', 'status bar', app.pid, prefix=True)
                ui.front(app.pid)
                ui.click('履歴・管理', 'unknown', app.pid)
                ui.click('選択版を表示', owner=app.pid)
                ui.find('画像の比較・採用前の確認', 'dialog', app.pid)
                ui.find('採用済み', ('caption', 'chart', 'figure', 'label'), app.pid)
                ui.find('選択版', ('caption', 'chart', 'figure', 'label'), app.pid)
                ui.screenshot(app.pid, RESULTS / f'{name}-compare.png')
                ui.click('閉じる', owner=app.pid)
                # Comparison navigation retains the expanded operations and management.
                ui.click('選択版を採用', owner=app.pid)
                ui.click('続ける', owner=app.pid)
                adopted = wait(lambda: (d if d['screenshot']['adopted'] != before['screenshot']['adopted'] else None) if (d := rpc('screenshots-image', {'id': sid})) else None, 'selected candidate adopted')
                assert len(adopted['edit']['scene']['annotations']) == 2
                assert adopted['data'] != before['data']
                assert rpc('screenshots-image', {'id': sid, 'json': {'original': True}})['data'] == original
                assert (root / 'docs/index.md').read_text() == manuscript, 'return/adoption unexpectedly changed manuscript'
                assert (root / adopted['screenshot']['output']).read_bytes() == base64.b64decode(adopted['data'].split(',')[1])
                ui.click('原稿を編集', owner=app.pid)
                ui.find('Markdownプレビュー', owner=app.pid)
                # The loaded document must expose the adopted resource, not just a successful backend call.
                ui.find(f'Native {name}', 'image', app.pid)
                visible_pixels = wait(lambda: count if (count := ui.image_pixels(f'Native {name}')) > baseline_pixels + 20 else None, 'adopted rectangle pixels displayed in referencing manuscript')
                ui.image_pixels(f'Native {name}', RESULTS / f'{name}-document-image.png')
                ui.screenshot(app.pid, RESULTS / f'{name}-adopted-document.png')
                ui.click('撮影一覧', owner=app.pid)
                registry = json.loads((REPO / 'scripts/fixtures/manual-studio-ui-inventory.json').read_text())
                action = next(a for a in registry['actions'] if a['file'].endswith('screenshotLibrary.ts') and a['kind'] == 'factory' and a['expression'].startswith("button('編集'"))
                artifacts = [{'path': f'{name}-{suffix}.png', 'sha256': hashlib.sha256((RESULTS / f'{name}-{suffix}.png').read_bytes()).hexdigest()} for suffix in ['markits', 'compare', 'adopted-document', 'document-image']]
                results.append({'caseId': f'P05.resource-{name}', 'entryPoint': action['id'], 'status': 'passed', 'type': 'real-desktop', 'steps': ui.log[begin:], 'assertions': {'visible': True, 'stored': True, 'preserved': True, 'returnTarget': True}, 'artifacts': artifacts, 'adopted': adopted['screenshot']['adopted'], 'visibleDarkPixels': visible_pixels, 'originalHash': hashlib.sha256(original.encode()).hexdigest()})
                print(f'PASS {name}: Studio button -> real MarkIts -> candidate -> compare -> adopt -> referenced document', flush=True)
            if not os.environ.get('MUNIN_NATIVE_RESOURCE_ONLY'):
                # The manuscript entry must preserve the same candidate contract.
                sid = shots[0][1]
                before = rpc('screenshots-image', {'id': sid})
                original = rpc('screenshots-image', {'id': sid, 'json': {'original': True}})['data']
                begin = len(ui.log)
                ui.click('原稿を編集', owner=app.pid)
                ui.click('編集のみ', 'toggle button', owner=app.pid)
                ui.hover_image('Native array')
                ui.click('🎨 画像の編集', owner=app.pid)
                editor_pid = ui.window_pid(ui.find('Background Canvas', 'image').get_process_id())
                ui.find('1. rect', owner=editor_pid)
                ui.find('2. rect', owner=editor_pid)
                ui.rectangle(editor_pid, (.72, .12, .9, .28))
                ui.find('3. rect', owner=editor_pid)
                ui.screenshot(editor_pid, RESULTS / 'document-editor.png')
                ui.click('編集終了（Manual Studioへ返す）', owner=editor_pid)
                candidate = wait(lambda: (d if len(d['screenshot']['edits']) == len(before['screenshot']['edits']) + 1 else None) if (d := rpc('screenshots-image', {'id': sid})) else None, 'manuscript edit candidate saved')
                newest = rpc('screenshots-image', {'id': sid, 'json': {'revision': candidate['screenshot']['edits'][-1]['id']}})
                assert len(newest['edit']['scene']['annotations']) == 3
                candidate = wait(lambda: (d if d['screenshot']['adopted'] == newest['edit']['id'] else None) if (d := rpc('screenshots-image', {'id': sid})) else None, 'edited image adopted automatically')
                assert candidate['data'] == newest['data']
                assert len(candidate['screenshot']['edits']) == len(before['screenshot']['edits']) + 1
                assert rpc('screenshots-image', {'id': sid, 'json': {'original': True}})['data'] == original
                assert (root / 'docs/index.md').read_text() == manuscript, 'return/adoption unexpectedly changed manuscript'
                (RESULTS / 'document-editor-check.json').write_text(json.dumps({'status': 'passed', 'entry': 'manuscript image edit', 'steps': ui.log[begin:], 'assertions': {'savedMarksRestored': True, 'candidateSaved': True, 'adoptedPreserved': True, 'originalPreserved': True, 'manuscriptPreserved': True}}, ensure_ascii=False, indent=2))
                registry = json.loads((REPO / 'scripts/fixtures/manual-studio-ui-inventory.json').read_text())
                case = next(case for case in registry['cases'] if case['id'] == 'P05.manuscript-managed')
                for entry in case['entryPoints']:
                    results.append({'caseId': case['id'], 'entryPoint': entry, 'status': 'passed', 'type': 'real-desktop', 'steps': ui.log[begin:], 'assertions': {'visible': True, 'stored': True, 'preserved': True, 'returnTarget': True}, 'artifacts': [{'path': 'document-editor.png', 'sha256': hashlib.sha256((RESULTS / 'document-editor.png').read_bytes()).hexdigest()}]})
                print('PASS manuscript image edit: saved marks restored -> candidate saved -> adopted image preserved', flush=True)
                # Real child failure and import retry must preserve the adopted asset.
                ui.click('撮影一覧', owner=app.pid)
                ui.fill('撮影を検索', sid)
                before = rpc('screenshots-image', {'id': sid})
                begin = len(ui.log)
                ui.click('編集', owner=app.pid)
                child = ui.window_pid(ui.find('Background Canvas', 'image').get_process_id())
                assert ui.owned(child) and child != app.pid
                ui.find('3. rect', owner=child)
                ui.front(child)
                ui.key(65513, True)
                ui.key(65473, True)
                ui.key(65473, False)
                ui.key(65513, False)
                ui.x.XFlush(ui.display)
                ui.log.append({'action': 'close owned MarkIts window with Alt+F4', 'pid': child})
                wait(lambda: any('編集を中止しました' in ui.text(node) for node in ui.allnodes(app.pid)), 'cancellation feedback')
                assert rpc('screenshots-image', {'id': sid})['screenshot']['edits'] == before['screenshot']['edits']
                assert rpc('screenshots-image', {'id': sid})['data'] == before['data']
                ui.click('編集', owner=app.pid)
                child = ui.window_pid(ui.find('Background Canvas', 'image').get_process_id())
                assert ui.owned(child) and child != app.pid
                ui.find('3. rect', owner=child)
                os.kill(child, signal.SIGKILL)
                ui.log.append({'action': 'fault: terminate owned MarkIts before completion', 'pid': child})
                wait(lambda: any('編集完了前に終了しました' in ui.text(node) for node in ui.allnodes(app.pid)), 'early exit feedback')
                after_exit = rpc('screenshots-image', {'id': sid})
                assert after_exit['screenshot']['edits'] == before['screenshot']['edits']
                assert after_exit['data'] == before['data']
                assert not any(ui.text(node) == '編集結果を再確認' and node.get_state_set().contains(Atspi.StateType.SHOWING) for node in ui.allnodes(app.pid)), 'Abandoned sessions must not leave an unusable retry control'
                assert rpc('screenshots-image', {'id': sid})['screenshot']['edits'] == before['screenshot']['edits']
                ui.click('編集', owner=app.pid)
                child = ui.window_pid(ui.find('Background Canvas', 'image').get_process_id())
                ui.find('3. rect', owner=child)
                ui.rectangle(child, (.15, .73, .32, .9))
                ui.find('4. rect', owner=child)
                rpc('screenshots-change', {'id': sid, 'json': {'protected': True}})
                ui.log.append({'action': 'fault: protect asset before import'})
                ui.click('編集終了（Manual Studioへ返す）', owner=child)
                wait(lambda: any('保護を解除' in ui.text(node) for node in ui.allnodes(app.pid)), 'failed import feedback')
                assert rpc('screenshots-image', {'id': sid})['screenshot']['edits'] == before['screenshot']['edits']
                rpc('screenshots-change', {'id': sid, 'json': {'protected': False}})
                ui.log.append({'action': 'remove import fault'})
                ui.click('編集結果を再確認', owner=app.pid)
                retried = wait(lambda: (d if len(d['screenshot']['edits']) == len(before['screenshot']['edits']) + 1 else None) if (d := rpc('screenshots-image', {'id': sid})) else None, 'retry saves one candidate')
                retried = wait(lambda: (d if d['screenshot']['adopted'] == d['screenshot']['edits'][-1]['id'] else None) if (d := rpc('screenshots-image', {'id': sid})) else None, 'retried edit adopted automatically')
                assert retried['data'] != before['data']
                newest = rpc('screenshots-image', {'id': sid, 'json': {'revision': retried['screenshot']['edits'][-1]['id']}})
                assert len(newest['edit']['scene']['annotations']) == 4
                wait(lambda: not any(ui.text(node) == '編集結果を再確認' and node.get_state_set().contains(Atspi.StateType.SHOWING) for node in ui.allnodes(app.pid)), 'successful retry clears retry control')
                time.sleep(1)
                assert rpc('screenshots-image', {'id': sid})['screenshot']['edits'] == retried['screenshot']['edits']
                assert rpc('screenshots-image', {'id': sid, 'json': {'original': True}})['data'] == original
                assert (root / 'docs/index.md').read_text() == manuscript, 'return/adoption unexpectedly changed manuscript'
                ui.screenshot(app.pid, RESULTS / 'failure-retry.png')
                case = next(case for case in registry['cases'] if case['id'] == 'P05.resource-exit-import-retry')
                for entry in case['entryPoints']:
                    results.append({'caseId': case['id'], 'entryPoint': entry, 'status': 'passed', 'type': 'real-desktop', 'steps': ui.log[begin:], 'assertions': {'visible': True, 'stored': True, 'preserved': True, 'returnTarget': True}, 'artifacts': [{'path': 'failure-retry.png', 'sha256': hashlib.sha256((RESULTS / 'failure-retry.png').read_bytes()).hexdigest()}]})
                print('PASS early child exit and import failure: preserve -> reopen -> retry -> no duplicate candidates', flush=True)
        # Ordinary image editing has separate-copy semantics from both entries.
        if not os.environ.get('MUNIN_NATIVE_RESOURCE_ONLY'):
            for entry_name in ['resource', 'manuscript']:
                begin = len(ui.log)
                def open_ordinary():
                    existing = set((root / 'docs/assets/edited').glob('*.png'))
                    if entry_name == 'resource':
                        ui.click('撮影一覧', owner=app.pid)
                        ui.fill('撮影を検索', 'ordinary.png')
                        try:
                            ui.find('編集', owner=app.pid, timeout=1)
                        except RuntimeError:
                            ui.click('ordinary.pngの操作', 'unknown', app.pid)
                        ui.click('編集', owner=app.pid)
                    else:
                        ui.click('原稿を編集', owner=app.pid)
                        ui.hover_image('Ordinary')
                        ui.click('🎨 画像の編集', owner=app.pid)
                    child = ui.window_pid(ui.find('Background Canvas', 'image').get_process_id())
                    assert child != app.pid and ui.owned(child)
                    copied = wait(lambda: next(iter(set((root / 'docs/assets/edited').glob('*.png')) - existing), None), 'one ordinary edit copy created')
                    assert len(set((root / 'docs/assets/edited').glob('*.png')) - existing) == 1
                    assert (root / 'docs/assets/ordinary.png').read_bytes() == source
                    return child, copied, copied.read_bytes()

                child, cancelled_copy, cancelled_bytes = open_ordinary()
                ui.front(child)
                for symbol, down in [(65513, True), (65473, True), (65473, False), (65513, False)]:
                    ui.key(symbol, down)
                ui.x.XFlush(ui.display)
                ui.log.append({'action': 'cancel ordinary copy window', 'entry': entry_name})
                wait(lambda: any('編集を中止しました' in ui.text(node) for node in ui.allnodes(app.pid)), 'ordinary cancel feedback')
                assert cancelled_copy.read_bytes() == cancelled_bytes
                child, killed_copy, killed_bytes = open_ordinary()
                os.kill(child, signal.SIGKILL)
                ui.log.append({'action': 'terminate ordinary edit child', 'entry': entry_name})
                wait(lambda: any('編集完了前に終了しました' in ui.text(node) for node in ui.allnodes(app.pid)), 'ordinary abnormal exit feedback')
                assert killed_copy.read_bytes() == killed_bytes
                child, copy, copy_bytes = open_ordinary()
                ui.rectangle(child)
                ui.find('1. rect', owner=child)
                copy.chmod(0o400)
                ui.log.append({'action': 'fault: make edit copy unwritable', 'entry': entry_name})
                ui.click('編集終了（Manual Studioへ返す）', owner=child)
                wait(lambda: any('編集結果は保持しています' in ui.text(node) for node in ui.allnodes(app.pid)), 'ordinary failed save preserves result')
                assert copy.read_bytes() == copy_bytes
                count = len(list((root / 'docs/assets/edited').glob('*.png')))
                copy.chmod(0o600)
                ui.click('画像の編集保存を再試行', owner=app.pid)
                wait(lambda: copy.read_bytes() != copy_bytes, 'ordinary retry writes edited copy')
                wait(lambda: any('編集コピーを保存しました' in ui.text(node) for node in ui.allnodes(app.pid)), 'ordinary completion feedback')
                assert len(list((root / 'docs/assets/edited').glob('*.png'))) == count
                assert (root / 'docs/assets/ordinary.png').read_bytes() == source
                assert (root / 'docs/index.md').read_text() == manuscript, 'return/adoption unexpectedly changed manuscript'
                assert not any(ui.text(node) == '画像の編集保存を再試行' and node.get_state_set().contains(Atspi.StateType.SHOWING) for node in ui.allnodes(app.pid))
                ui.screenshot(app.pid, RESULTS / f'ordinary-{entry_name}.png')
                case = next(case for case in registry['cases'] if case['id'] == f'P05.ordinary-{entry_name}')
                for entry in case['entryPoints']:
                    results.append({'caseId': case['id'], 'entryPoint': entry, 'status': 'passed', 'type': 'real-desktop', 'steps': ui.log[begin:], 'assertions': {'visible': True, 'stored': True, 'preserved': True, 'returnTarget': True}, 'artifacts': [{'path': f'ordinary-{entry_name}.png', 'sha256': hashlib.sha256((RESULTS / f'ordinary-{entry_name}.png').read_bytes()).hexdigest()}], 'copy': str(copy.relative_to(root)), 'originalHash': hashlib.sha256(source).hexdigest()})
                print(f'PASS ordinary {entry_name}: cancel -> abnormal exit -> copy -> failed save -> retry without duplicate; original/prose preserved', flush=True)
        identity = build_identity()
        assert identity == initial_identity, 'Sources or binary changed during the native test; no valid success evidence'
        (RESULTS / 'result.json').write_text(json.dumps({**identity, 'executedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'results': results}, ensure_ascii=False, indent=2))
    except Exception:
        (RESULTS / 'failure-ui.json').write_text(json.dumps(ui.dump(), ensure_ascii=False, indent=2))
        try:
            ui.screenshot(app.pid, RESULTS / 'failure.png')
        except Exception:
            pass
        raise
    finally:
        target.terminate()
        try:
            target.wait(timeout=5)
        except subprocess.TimeoutExpired:
            target.kill()
            target.wait()
        try:
            os.killpg(app.pid, signal.SIGTERM)
            app.wait(timeout=5)
        except ProcessLookupError:
            pass
        except subprocess.TimeoutExpired:
            os.killpg(app.pid, signal.SIGKILL)
            app.wait()
