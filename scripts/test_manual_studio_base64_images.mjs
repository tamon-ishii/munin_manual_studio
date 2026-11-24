import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = await mkdtemp(path.join(os.tmpdir(), 'munin-base64-images-'));
const base = 'http://127.0.0.1:5174';
let server, browser;

try {
  await mkdir(path.join(root, 'docs/assets'), { recursive: true });
  const png = await readFile('apps/manual-studio/src-tauri/icons/icon.png');
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  await writeFile(path.join(root, 'docs/assets/existing.png'), png);
  await writeFile(
    path.join(root, 'manual_setting.json'),
    JSON.stringify({ docs: 'docs', assets: 'docs/assets', targets: ['docs'], connection_type: 'none' }),
  );
  await writeFile(
    path.join(root, 'docs/index.md'),
    `# Base64画像テスト\n\n![貼り付け画像](${dataUrl})\n\n![既存画像](assets/existing.png)\n`,
  );

  server = spawn(
    process.execPath,
    [path.resolve('node_modules/vite/bin/vite.js'), '--config', 'apps/manual-studio/vite.config.ts'],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }

  browser = await chromium.launch({
    channel: process.env.MUNIN_TEST_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'),
    headless: true,
  });
  const context = await browser.newContext();
  const page = await context.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const idle = () => page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');

  await page.goto(`${base}/?root=${encodeURIComponent(root)}&page=index.md`);
  await page.waitForSelector('#milkdown-editor .ProseMirror img');
  await idle();

  const images = page.locator('#milkdown-editor .ProseMirror img');
  assert.equal(await images.count(), 2, 'both Base64 and file images render in Milkdown');

  // 1. Hover over Base64 image -> overlay shows edit + save-to-file + presentation, hides recapture/ask
  await images.nth(0).hover();
  const overlay = page.locator('.milkdown-image-action-overlay');
  await overlay.waitFor({ state: 'visible' });
  assert.equal(await overlay.locator('.milkdown-image-edit-btn').isVisible(), true, 'Base64 image exposes edit button');
  assert.equal(await overlay.locator('.milkdown-image-save-btn').isVisible(), true, 'Base64 image exposes save-to-file button');
  assert.equal(await overlay.locator('.milkdown-image-save-btn').textContent(), '画像に保存する');
  assert.equal(await overlay.locator('.milkdown-image-recapture-btn').isVisible(), false, 'Base64 image hides recapture button');
  assert.equal(await overlay.locator('.milkdown-image-ask-ai-btn').isVisible(), false, 'Base64 image hides ask-AI button');

  // 2. Hover over existing file image -> overlay hides save-to-file, shows edit/recapture/ask
  await images.nth(1).hover();
  await overlay.waitFor({ state: 'visible' });
  assert.equal(await overlay.locator('.milkdown-image-edit-btn').isVisible(), true);
  assert.equal(await overlay.locator('.milkdown-image-save-btn').isVisible(), false, 'file image hides save-to-file button');
  assert.equal(await overlay.locator('.milkdown-image-recapture-btn').isVisible(), true);
  assert.equal(await overlay.locator('.milkdown-image-ask-ai-btn').isVisible(), true);

  // 3. Click "画像に保存する" on Base64 image, test Cancel first
  await images.nth(0).hover();
  await overlay.locator('.milkdown-image-save-btn').click();
  const dialog = page.locator('#image-save-dialog');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await dialog.locator('h2').textContent(), 'Base64画像をファイルに保存');
  assert.equal(await page.locator('#image-save-alt').inputValue(), '貼り付け画像');
  await page.locator('#cancel-image-save').click();
  await dialog.waitFor({ state: 'hidden' });
  assert.match(await page.locator('#markdown-editor').inputValue(), /data:image\/png;base64,/, 'cancel preserves Base64 markdown');

  // 4. Click "画像に保存する" again and confirm save + replace
  await images.nth(0).hover();
  await overlay.locator('.milkdown-image-save-btn').click();
  await dialog.waitFor({ state: 'visible' });
  await page.locator('#image-save-filename').fill('saved-pasted.png');
  await page.locator('#image-save-alt').fill('保存した貼り付け画像');
  await page.locator('#confirm-image-save').click();
  await dialog.waitFor({ state: 'hidden' });
  await idle();

  const savedFile = await readFile(path.join(root, 'docs/assets/saved-pasted.png'));
  assert.equal(Buffer.compare(savedFile, png), 0, 'saved PNG bytes match original Base64 payload');
  const updatedMarkdown = await page.locator('#markdown-editor').inputValue();
  assert.doesNotMatch(updatedMarkdown, /data:image\/png;base64,/, 'Base64 data URL is replaced in markdown');
  assert.match(updatedMarkdown, /!\[保存した貼り付け画像\]\(<?assets\/saved-pasted\.png>?\)/, 'markdown references the saved relative file');

  // 5. Hover over the replaced image -> "画像に保存する" is now hidden
  await images.nth(0).hover();
  await overlay.waitFor({ state: 'visible' });
  assert.equal(await overlay.locator('.milkdown-image-save-btn').isVisible(), false, 'replaced image no longer shows save-to-file button');
  assert.equal(await overlay.locator('.milkdown-image-edit-btn').isVisible(), true, 'replaced image stays editable');

  assert.deepEqual(errors, [], `Unexpected page errors: ${errors.join('\n')}`);
  console.log('Base64 image edit menu and save-to-file checks passed.');
} finally {
  await browser?.close();
  server?.kill();
  await rm(root, { recursive: true, force: true });
}
