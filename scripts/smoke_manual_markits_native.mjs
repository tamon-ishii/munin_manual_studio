#!/usr/bin/env node
// Native MarkIts ↔ Manual Studio handoff smoke test. Uses only an isolated temp
// project and terminates only child processes spawned by this script.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repo, 'target/debug');
const markits = path.join(bin, 'markits-desktop');
const manualctl = path.join(bin, 'manualctl');
const timeoutMs = 30_000;
const deadline = Date.now() + timeoutMs;
const tempRoot = await mkdtemp(path.join(tmpdir(), 'markits-manual-studio-native-'));
let app;
const children = new Set();

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
  if (ms <= 0) throw new Error(`30s test deadline exceeded${app ? ` (MarkIts pid ${app.pid})` : ''}`);
  return ms;
}
function spawnTracked(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}
async function run(command, args, options = {}) {
  const child = spawnTracked(command, args, options);
  let stdout = ''; let stderr = '';
  child.stdout?.on('data', (b) => { stdout += b; });
  child.stderr?.on('data', (b) => { stderr += b; });
  const ms = Math.min(remaining(), options.timeoutMs ?? remaining());
  const result = await Promise.race([
    new Promise((resolve, reject) => child.once('error', reject).once('close', (code) => resolve(code))),
    new Promise((_, reject) => setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${path.basename(command)} timed out`)); }, ms)),
  ]);
  if (result !== 0) throw new Error(`${path.basename(command)} exited ${result}: ${stderr.trim()}`);
  return { stdout, stderr };
}
async function listWindows() {
  const { stdout } = await run(manualctl, ['list-windows', '--root', tempRoot]);
  return JSON.parse(stdout);
}
async function waitForNewWindow(beforeIds) {
  while (remaining() > 0) {
    const matches = (await listWindows()).filter((w) => !beforeIds.has(String(w.id)) && /markits/i.test(w.title));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`複数の新しいMarkItsウィンドウを検出: ${JSON.stringify(matches)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('30秒以内に起動したMarkItsのウィンドウが見つかりません');
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
  await writeFile(path.join(tempRoot, 'manual_setting.json'), JSON.stringify({ docs: 'docs', output: 'manual', format: 'mkdocs', agent: 'codex', model: '', targets: ['docs', 'README.md'] }));
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
  const before = new Set((await listWindows()).map((w) => String(w.id)));
  app = spawnTracked(markits, ['--manual-studio-input', input, '--manual-studio-output', output, '--manual-studio-completion', completion], { stdio: 'ignore' });
  if (!app.pid) throw new Error('MarkIts Desktop was not spawned');
  const window = await waitForNewWindow(before);
  scenario.window = `pid:${app.pid}:${window.title}`;
  await writeFile(scenarioPath, JSON.stringify(scenario, null, 2));
  console.log(`MarkIts pid=${app.pid}, window=${window.id} (${window.title})`);
  await run(manualctl, ['scenario-run', '--root', tempRoot, '--input', scenarioPath]);
  const completedAt = Date.now();
  while (remaining() > 0) {
    try { if ((await readFile(completion, 'utf8')) === 'saved') break; } catch {}
    if (app.exitCode !== null) throw new Error(`MarkIts exited ${app.exitCode} before completion marker`);
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
} finally {
  await cleanup();
}
