import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = await mkdtemp(path.join(os.tmpdir(), 'munin-asset-organizer-'));
const base = 'http://127.0.0.1:5174';
let server, browser;

const exists = async (target) => {
  try { await access(target); return true; } catch { return false; }
};

try {
  await mkdir(path.join(root, 'docs/assets'), { recursive: true });
  await mkdir(path.join(root, 'manual/assets'), { recursive: true });
  const png = await readFile('apps/manual-studio/src-tauri/icons/icon.png');
  await writeFile(
    path.join(root, 'manual_setting.json'),
    JSON.stringify({
      docs: 'docs',
      output: 'manual',
      assets: 'docs/assets',
      targets: ['docs'],
      connection_type: 'none',
    }),
  );
  await writeFile(path.join(root, 'docs/assets/used.png'), png);
  await writeFile(path.join(root, 'docs/assets/unused-one.png'), png);
  await writeFile(path.join(root, 'docs/assets/unused-two.png'), png);
  await writeFile(path.join(root, 'manual/assets/built-copy.png'), png);
  await writeFile(
    path.join(root, 'docs/index.md'),
    '# トップページ\n\n使用中の画像:\n\n![使用中](assets/used.png)\n',
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  const idle = () => page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');

  await page.goto(`${base}/?root=${encodeURIComponent(root)}&page=index.md`);
  await idle();

  // Verify the replacement button exists and the removed AI template button does not.
  assert.equal(await page.locator('#create-ai-template').count(), 0);
  await page.locator('#assets-organizer-open').waitFor({ state: 'visible' });

  // Open an unused image tab first to verify deletion closes its tab cleanly.
  const docsClosed = page.locator('details[data-folder="docs"]:not([open]) > summary');
  if (await docsClosed.count()) await docsClosed.click();
  const assetsClosed = page.locator('details[data-folder="docs/assets"]:not([open]) > summary');
  if (await assetsClosed.count()) await assetsClosed.click();
  await page.locator('[data-image="docs/assets/unused-two.png"]').click();
  await idle();
  assert.equal(await page.locator('[data-image-page="docs/assets/unused-two.png"]').count(), 1);

  // Switch back to index.md and introduce an unsaved edit to test safety guard.
  await page.locator('[data-document-page="index.md"]').click();
  await idle();
  await page.locator('#markdown-editor').evaluate(node => {
    node.value += '\n未保存の追記\n';
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // Open Asset Organizer dialog.
  await page.locator('#assets-organizer-open').click();
  const dialog = page.locator('#asset-organizer-dialog');
  await dialog.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('#asset-organizer-list .asset-organizer-item').length === 3);

  // Verify initial dialog dimensions (~760x840) and zero wasted bottom space below the list.
  const layoutMetrics = await page.evaluate(() => {
    const dlg = document.querySelector('#asset-organizer-dialog');
    const list = document.querySelector('#asset-organizer-list');
    const dlgRect = dlg.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    return {
      width: Math.round(dlgRect.width),
      height: Math.round(dlgRect.height),
      bottomGap: Math.round(dlgRect.bottom - listRect.bottom),
      initialWidthAttr: dlg.dataset.dialogInitialWidth,
      initialHeightAttr: dlg.dataset.dialogInitialHeight,
    };
  });
  assert.equal(layoutMetrics.initialWidthAttr, '760');
  assert.equal(layoutMetrics.initialHeightAttr, '840');
  assert.ok(layoutMetrics.width >= 720 && layoutMetrics.width <= 800, `Unexpected initial width: ${layoutMetrics.width}`);
  assert.ok(layoutMetrics.height >= 800 && layoutMetrics.height <= 860, `Unexpected initial height: ${layoutMetrics.height}`);
  assert.ok(layoutMetrics.bottomGap >= 0 && layoutMetrics.bottomGap <= 24, `Unexpected bottom gap below list: ${layoutMetrics.bottomGap}px`);

  // Verify all thumbnails load without broken/hidden images.
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('#asset-organizer-list .asset-organizer-thumb img')];
    return imgs.length === 3 && imgs.every(img => !img.hidden && img.src.startsWith('data:image/'));
  });

  // Verify focused select uses inset outline so left edge is never clipped by overflow containers.
  await dialog.locator('#asset-organizer-filter').focus();
  const focusOffset = await dialog.locator('#asset-organizer-filter').evaluate(el => getComputedStyle(el).outlineOffset);
  assert.equal(focusOffset, '-2px', 'focused select draws focus ring inside border box without left-edge clipping');

  // Output directory image is excluded from the asset list.
  const listedPaths = await dialog.locator('.asset-organizer-item').evaluateAll(nodes =>
    nodes.map(node => node.dataset.assetPath),
  );
  assert.deepEqual(listedPaths.sort(), [
    'docs/assets/unused-one.png',
    'docs/assets/unused-two.png',
    'docs/assets/used.png',
  ]);

  // Filter works for unused / used / all and search input.
  await dialog.locator('#asset-organizer-filter').selectOption('unused');
  assert.equal(await dialog.locator('.asset-organizer-item').count(), 2);
  await dialog.locator('#asset-organizer-filter').selectOption('used');
  assert.equal(await dialog.locator('.asset-organizer-item').count(), 1);
  assert.equal(await dialog.locator('.asset-organizer-item').first().getAttribute('data-asset-path'), 'docs/assets/used.png');
  await dialog.locator('#asset-organizer-filter').selectOption('all');
  await dialog.locator('#asset-organizer-search').fill('unused-one');
  assert.equal(await dialog.locator('.asset-organizer-item').count(), 1);
  await dialog.locator('#asset-organizer-search').fill('');
  assert.equal(await dialog.locator('.asset-organizer-item').count(), 3);

  // Sort selector reorders assets cleanly.
  await dialog.locator('#asset-organizer-sort').selectOption('name');
  const sortedByName = await dialog.locator('.asset-organizer-item').evaluateAll(nodes =>
    nodes.map(node => node.dataset.assetPath),
  );
  assert.deepEqual(sortedByName, [
    'docs/assets/unused-one.png',
    'docs/assets/unused-two.png',
    'docs/assets/used.png',
  ]);
  await dialog.locator('#asset-organizer-sort').selectOption('unused');

  // Selecting one unused asset updates bulk button label to selected count.
  const firstUnusedCheck = dialog.locator('.asset-organizer-item[data-asset-path="docs/assets/unused-one.png"] .asset-organizer-select');
  await firstUnusedCheck.check();
  assert.match(await dialog.locator('#asset-organizer-delete-unused').textContent(), /選択した未使用を削除 \(1件\)/);
  await firstUnusedCheck.uncheck();
  assert.match(await dialog.locator('#asset-organizer-delete-unused').textContent(), /未使用アセットを削除 \(2件\)/);

  // Unsaved document prevents deleting unused assets.
  await dialog.locator('#asset-organizer-delete-unused').click();
  assert.match(await dialog.locator('#asset-organizer-feedback').textContent(), /未保存の原稿/);
  assert.equal(await exists(path.join(root, 'docs/assets/unused-one.png')), true);

  // Close dialog, save document, and reopen Asset Organizer.
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.locator('#save-page').click();
  await idle();

  await page.locator('#assets-organizer-open').click();
  await dialog.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('#asset-organizer-list .asset-organizer-item').length === 3);

  // Delete a single unused asset.
  await dialog.locator('[data-delete-asset="docs/assets/unused-one.png"]').click();
  await page.locator('[data-confirm-action] [data-confirm-accept]').click();
  await page.waitForFunction(() => document.querySelectorAll('#asset-organizer-list .asset-organizer-item').length === 2);
  assert.equal(await exists(path.join(root, 'docs/assets/unused-one.png')), false);
  assert.equal(await exists(path.join(root, 'docs/assets/unused-two.png')), true);

  // Delete remaining unused assets via bulk button.
  await dialog.locator('#asset-organizer-delete-unused').click();
  await page.locator('[data-confirm-action] [data-confirm-accept]').click();
  await page.waitForFunction(() => document.querySelectorAll('#asset-organizer-list .asset-organizer-item').length === 1);
  assert.equal(await exists(path.join(root, 'docs/assets/unused-two.png')), false);
  assert.equal(await exists(path.join(root, 'docs/assets/used.png')), true);
  assert.equal(await exists(path.join(root, 'manual/assets/built-copy.png')), true);
  assert.equal(await dialog.locator('#asset-organizer-delete-unused').isDisabled(), true);

  // Deleted image tab was closed and backup exists in .munin/file-deletions.
  assert.equal(await page.locator('[data-image-page="docs/assets/unused-two.png"]').count(), 0);
  const backups = await readdir(path.join(root, '.munin/file-deletions'));
  assert.ok(backups.length >= 2, `Expected backups in .munin/file-deletions, got: ${backups}`);

  // Clicking usage link jumps to the document and closes dialog.
  await dialog.locator('.asset-organizer-usage-link').first().click();
  await page.waitForFunction(() => !document.querySelector('#asset-organizer-dialog'));

  assert.deepEqual(errors, []);
  console.log('Asset organizer test passed: listing, filtering, unsaved guard, single & bulk unused deletion with backup, tab cleanup, and usage jump.');
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill();
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}
