#!/usr/bin/env node
// Native MarkIts ↔ Manual Studio handoff smoke test. Uses only an isolated temp
// project and terminates only child processes spawned by this script.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repo, 'target/debug');
const markits = path.join(bin, process.platform === 'win32' ? 'manual-studio.exe' : 'manual-studio');
const manualctl = path.join(bin, process.platform === 'win32' ? 'manualctl.exe' : 'manualctl');
const fixturePython = process.env.MANUAL_NATIVE_PYTHON || (process.platform === 'linux' ? '/usr/bin/python3' : process.platform === 'win32' ? 'python' : 'python3');
const timeoutMs = 120_000;
const deadline = Date.now() + timeoutMs;
const tempRoot = await mkdtemp(path.join(tmpdir(), 'markits-manual-studio-native-'));
let app;
const children = new Set();
const childErrors = new WeakMap();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typeBuf = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}
function pngWithText(textChunks) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(640, 0); ihdr.writeUInt32BE(400, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((640 * 4 + 1) * 400);
  for (let y = 0; y < 400; y++) {
    const offset = y * (640 * 4 + 1); raw[offset] = 0;
    for (let x = 0; x < 640; x++) {
      const i = offset + 1 + x * 4;
      raw[i] = 248; raw[i + 1] = 249; raw[i + 2] = 246; raw[i + 3] = 255;
    }
  }
  const texts = textChunks.map(([key, value]) => chunk('tEXt', Buffer.concat([Buffer.from(key), Buffer.from([0]), Buffer.from(value)])));
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), ...texts, chunk('IEND', Buffer.alloc(0))]);
}
function pngTextChunks(png) {
  const chunks = new Map();
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > png.length) throw new Error('malformed PNG chunk length');
    if (type === 'tEXt') {
      const payload = png.subarray(start, end);
      const separator = payload.indexOf(0);
      if (separator >= 0) chunks.set(payload.toString('latin1', 0, separator), payload.toString('utf8', separator + 1));
    }
    offset = end + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}
function remaining() {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new Error(`120s test deadline exceeded${app ? ` (MarkIts pid ${app.pid})` : ''}`);
  return ms;
}
function spawnTracked(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  children.add(child);
  child.once('error', (error) => { childErrors.set(child, error); children.delete(child); });
  child.once('exit', () => children.delete(child));
  return child;
}
function requireRunning(child, label) {
  const error = childErrors.get(child);
  if (error) throw new Error(`${label} could not start: ${error.message}`);
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`${label} exited before completing the operation (${child.signalCode || child.exitCode})`);
  }
}
async function run(command, args, options = {}) {
  const child = spawnTracked(command, args, options);
  let stdout = ''; let stderr = '';
  child.stdout?.on('data', (b) => { stdout += b; });
  child.stderr?.on('data', (b) => { stderr += b; });
  const ms = Math.min(remaining(), options.timeoutMs ?? remaining());
  let timer;
  let result;
  try {
    result = await Promise.race([
      new Promise((resolve, reject) => child.once('error', reject).once('close', (code) => resolve(code))),
      new Promise((_, reject) => { timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${path.basename(command)} timed out`)); }, ms); }),
    ]);
  } finally { clearTimeout(timer); }
  if (result !== 0) throw new Error(`${path.basename(command)} exited ${result}: ${stderr.trim()}`);
  if (command === '/usr/bin/python3' && stdout.trim()) console.log(stdout.trim());
  return { stdout, stderr };
}
async function listWindows() {
  const { stdout } = await run(manualctl, ['list-windows', '--root', tempRoot]);
  return JSON.parse(stdout);
}
async function waitForNewWindow(beforeIds) {
  while (remaining() > 0) {
    requireRunning(app, 'MarkIts');
    const matches = (await listWindows()).filter((w) => !beforeIds.has(String(w.id)) && /markits/i.test(w.title));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`複数の新しいMarkItsウィンドウを検出: ${JSON.stringify(matches)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('テストの制限時間内に起動したMarkItsのウィンドウが見つかりません');
}
async function cleanup() {
  for (const child of children) if (child.pid && child.exitCode === null) child.kill('SIGTERM');
  if (app?.pid && app.exitCode === null) app.kill('SIGTERM');
  if (children.size || (app && app.exitCode === null)) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    for (const child of children) if (child.pid && child.exitCode === null) child.kill('SIGKILL');
    if (app?.pid && app.exitCode === null) app.kill('SIGKILL');
  }
  await rm(tempRoot, { recursive: true, force: true });
}

try {
  await mkdir(path.join(tempRoot, 'docs'), { recursive: true });
  await mkdir(path.join(tempRoot, 'manual'), { recursive: true });
  const docs = path.join(tempRoot, 'docs');
  const input = path.join(tempRoot, 'source.png');
  const output = path.join(tempRoot, 'annotated-output.png');
  const completion = path.join(tempRoot, 'completion.marker');
  const annotations = JSON.stringify({ canvas: { width: 640, height: 400 }, annotations: [{ type: 'rect', target: [30, 40, 120, 80], style: 'primary' }] });
  const uiElements = JSON.stringify([{ role: 'button', name: 'Fixture UI: 保存', x: 12, y: 16, width: 110, height: 32 }]);
  await writeFile(input, pngWithText([['markits:annotations', annotations], ['markits:ui_elements', uiElements]]));
  await writeFile(path.join(tempRoot, 'manual_setting.json'), JSON.stringify({ docs: 'docs', output: 'manual', format: 'mkdocs', connection_type:'none', agent: 'codex', model: '', targets: ['docs', 'README.md'] }));
  await writeFile(path.join(tempRoot, 'README.md'), '# native handoff smoke\n');
  await writeFile(path.join(docs, 'index.md'), '# Native handoff fixture\n');
  const scenarioPath = path.join(tempRoot, 'handoff.json');
  const scenario = {
    version: 1,
    platform: 'desktop',
    window: '',
    steps: [
      { expect_visible: 'button[name*="編集終了"]' },
      { press: 'button[name*="編集終了"]' },
    ],
  };
  await writeFile(scenarioPath, JSON.stringify(scenario, null, 2));
  {
    const fixture = path.join(tempRoot,'recording fixture.py');
    const argsFile = path.join(tempRoot,'launch-args.json');
    const eventsFile = path.join(tempRoot,'recorded-events.jsonl');
    await writeFile(fixture,`import tkinter as tk,json,sys\nfrom pathlib import Path\nPath(sys.argv[1]).write_text(json.dumps(sys.argv[2:]))\nroot=tk.Tk();root.title("Munin Recording Fixture");root.geometry("640x400")\ntk.Button(root,text="Record target",command=lambda:root.title("Munin Recording Fixture clicked")).place(x=30,y=40,width=120,height=80)\nroot.mainloop()\n`);
    const argumentsSnapshot = [' value with spaces ', '$(literal);&"quoted"'];
    await run(fixturePython, ['-c', 'import tkinter']);
    const target = spawnTracked(fixturePython,[fixture,argsFile,...argumentsSnapshot],{stdio:'ignore'});
    let targetWindow;
    while (!targetWindow) {
      requireRunning(target, 'Recording fixture');
      remaining(); targetWindow=(await listWindows()).find(window=>window.title==='Munin Recording Fixture');
      if (!targetWindow) await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.deepEqual(JSON.parse(await readFile(argsFile,'utf8')),argumentsSnapshot,'real application receives exact argument boundaries');
    const recorder = spawnTracked(markits,['--manual-studio-record-input',eventsFile],{stdio:'ignore'});
    while (true) { try { await readFile(eventsFile); break; } catch {} requireRunning(recorder, 'Input recorder'); remaining();await new Promise(resolve=>setTimeout(resolve,100)); }
    const recordingScenario = path.join(tempRoot,'record-input.json');
    await writeFile(recordingScenario,JSON.stringify({version:1,platform:'desktop',window:"Munin Recording Fixture",steps:[{wait_ms:600},{click:{x:80,y:80}},{wait_ms:500}]}));
    await run(manualctl,['scenario-run','--root',tempRoot,'--input',recordingScenario]);
    const events=(await readFile(eventsFile,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    assert.ok(events.some(event=>event.kind==='click'),`real ${process.platform} input is recorded by the Studio helper`);
    recorder.kill('SIGTERM');target.kill('SIGTERM');
    console.log(`PASS: real application launch preserves spaced/special arguments; Studio recorder captures a ${process.platform} click.`);
  }
  const before = new Set((await listWindows()).map((w) => String(w.id)));
  app = spawnTracked(markits, ['--manual-studio-annotate', '--manual-studio-input', input, '--manual-studio-output', output, '--manual-studio-completion', completion], { stdio: 'ignore' });
  if (!app.pid) throw new Error('MarkIts Desktop was not spawned');
  const window = await waitForNewWindow(before);
  scenario.window = `pid:${app.pid}:${window.title}`;
  await writeFile(scenarioPath, JSON.stringify(scenario, null, 2));
  console.log(`MarkIts pid=${app.pid}, window=${window.id} (${window.title})`);
  try {
    await run(manualctl, ['scenario-run', '--root', tempRoot, '--input', scenarioPath]);
  } catch (error) {
    if (process.platform === 'win32') {
      try {
        const diagnostics = path.join(repo, 'native-smoke-results');
        await mkdir(diagnostics, { recursive: true });
        const captured = await run('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
          path.join(repo, 'scripts/native_webview2_window.ps1'),
          '-OwnerPid', String(app.pid), '-Action', 'capture',
          '-OutputPath', path.join(diagnostics, 'markits-failure.png'),
        ], { windowsHide: true });
        await writeFile(path.join(diagnostics, 'markits-window.json'), captured.stdout);
        console.log('Saved the owned MarkIts failure window to native-smoke-results.');
      } catch (diagnosticError) {
        console.error(`Could not capture the owned MarkIts window: ${diagnosticError.message}`);
      }
    }
    throw error;
  }
  const completedAt = Date.now();
  while (remaining() > 0) {
    try { if ((await readFile(completion, 'utf8')) === 'saved') break; } catch {}
    requireRunning(app, 'MarkIts');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if ((await readFile(completion, 'utf8')) !== 'saved') throw new Error('completion marker was not written');
  const saved = await readFile(output);
  if (!saved.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('output is not a PNG');
  const outputChunks = pngTextChunks(saved);
  const savedAnnotations = JSON.parse(outputChunks.get('markits:annotations') ?? 'null');
  const savedUiElements = JSON.parse(outputChunks.get('markits:ui_elements') ?? 'null');
  const knownAnnotation = savedAnnotations?.annotations?.find((item) => item.type === 'rect' && JSON.stringify(item.target) === '[30,40,120,80]');
  const knownUiElement = savedUiElements?.find((item) => item.role === 'button' && item.name === 'Fixture UI: 保存');
  if (!knownAnnotation) throw new Error('known annotation type/target was not preserved in output PNG');
  if (!knownUiElement) throw new Error('known UI element role/name was not preserved in output PNG');
  console.log(`PASS: completion marker, annotation JSON, and UI metadata verified in ${Date.now() - completedAt}ms`);
  const rpc = async (action, options = {}) => { const {stdout}=await run(manualctl, ['--request', JSON.stringify({root:tempRoot,action,options})]); try { return JSON.parse(stdout); } catch { return stdout; } };
  const registered = await rpc('screenshots-register',{json:{source:saved.toString('base64'),import:true}});
  const id = registered.screenshot.id;
  const original = await rpc('screenshots-image',{id,json:{original:true}});
  const originalHash = createHash('sha256').update(original.data).digest('hex');
  async function editAgain(sourceFile, name, operation) {
    const outputFile = path.join(tempRoot,`${name}.png`);
    const completionFile = path.join(tempRoot,`${name}.marker`);
    const beforeIds = new Set((await listWindows()).map(w=>String(w.id)));
    app = spawnTracked(markits,['--manual-studio-annotate','--manual-studio-input',sourceFile,'--manual-studio-output',outputFile,'--manual-studio-completion',completionFile],{stdio:'ignore'});
    const window = await waitForNewWindow(beforeIds);
    const steps = [{expect_visible:operation},{press:operation},{press:'button[name*="編集終了"]'}];
    await writeFile(scenarioPath,JSON.stringify({version:1,platform:'desktop',window:`pid:${app.pid}:${window.title}`,steps}));
    await run(manualctl,['scenario-run','--root',tempRoot,'--input',scenarioPath]);
    for (;;) {
      try { if ((await readFile(completionFile,'utf8'))==='saved') break; } catch {}
      requireRunning(app, 'MarkIts');
      remaining(); await new Promise(resolve=>setTimeout(resolve,100));
    }
    return {file:outputFile,bytes:await readFile(outputFile)};
  }
  const cropped = await editAgain(output,'cropped','button[name*="マークでクロップ"]');
  const cropChunks = pngTextChunks(cropped.bytes);
  assert.ok(cropChunks.has('markits:base_image'),'cropping persists the full base image');
  assert.ok(cropChunks.has('markits:crop_info'),'cropping persists coordinate offsets');
  assert.ok(cropped.bytes.readUInt32BE(16)<640,'native crop reduces the image width');
  const expanded = await editAgain(cropped.file,'expanded','button[name*="クロップ解除"]');
  assert.equal(expanded.bytes.readUInt32BE(16),640);
  assert.equal(expanded.bytes.readUInt32BE(20),400);
  const restoredScene = JSON.parse(pngTextChunks(expanded.bytes).get('markits:annotations'));
  assert.ok(restoredScene.annotations.some(mark=>mark.type==='rect'&&JSON.stringify(mark.target)==='[30,40,120,80]'),'expansion restores annotation coordinates');
  const candidate = await rpc('screenshots-register',{json:{id,source:original.data,render:expanded.bytes.toString('base64'),scene:restoredScene,adopt:false}});
  await rpc('screenshots-change',{id,json:{adopt:candidate.revision}});
  const reference = await rpc('screenshots-reference',{id,page:'index.md'});
  assert.ok(reference,'reference is generated independently of AI');
  const document = await rpc('editor-read',{page:'index.md'});
  await rpc('editor-save',{page:'index.md',json:{content:'# Native screenshot\n\n'+reference,revision:document.revision}});
  assert.equal((await rpc('screenshots-list')).items[0].usage.length,1);
  assert.equal(createHash('sha256').update((await rpc('screenshots-image',{id,json:{original:true}})).data).digest('hex'),originalHash);
  const build = await run(manualctl,['build-mkdocs','--root',tempRoot]);
  if (!build.stdout.includes('Site:')) throw new Error('Real HTML publication requires MkDocs (set PATH to its executable)');
  const html = await readFile(path.join(tempRoot,'manual/index.html'),'utf8');
  assert.ok(html.includes(id),'published HTML references the adopted image');
  const publicImage = await readFile(path.join(tempRoot,candidate.screenshot.output));
  assert.equal(pngTextChunks(publicImage).size,0,'public image excludes originals and edit metadata');
  console.log('PASS: real MarkIts crop/save/reopen/expand, immutable library original, Markdown insertion and HTML publication (AI disabled).');
  if (process.platform === 'linux') await run('/usr/bin/python3', [path.join(repo, 'scripts/smoke_manual_studio_native_library.py')]);

} finally {
  await cleanup();
}
