import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = await mkdtemp(path.join(os.tmpdir(), 'munin-ux-polish-'));
const base = 'http://127.0.0.1:5174';
let server, browser;

try {
  await mkdir(path.join(root, 'docs/assets'), { recursive: true });
  const png = await readFile('apps/manual-studio/src-tauri/icons/icon.png');
  await writeFile(
    path.join(root, 'manual_setting.json'),
    JSON.stringify({
      docs: 'docs',
      output: 'manual',
      assets: 'docs/assets',
      targets: ['docs'],
      connection_type: 'none',
      mkdocs: { site_name: 'Polish Guide', exclude_unused_assets: false },
    }),
  );
  await writeFile(
    path.join(root, 'docs/index.md'),
    '# トップページ\n\n検索テストの段落です。\n\n<!-- ai-note: 表現を見直す -->\n\nもう一つの検索テスト段落です。\n',
  );
  await writeFile(path.join(root, 'docs/second.md'), '# 2番目のページ\n\n本文。\n');
  await writeFile(path.join(root, 'docs/third.md'), '# 3番目のページ\n\n本文。\n');

  server = spawn(
    process.execPath,
    [path.resolve('node_modules/vite/bin/vite.js'), '--config', 'apps/manual-studio/vite.config.ts'],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }

  // Register one capture resource via RPC so badge count is 1.
  const rpc = async (action, options = {}) => {
    const res = await fetch(`${base}/__manual/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, action, options }),
    });
    const payload = await res.json();
    if (payload.error) throw new Error(payload.error);
    return payload.output;
  };
  await rpc('capture-resources-register', { json: { source: png.toString('base64'), name: 'Sample Capture' } });

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
  await page.waitForSelector('#milkdown-editor .ProseMirror');
  await idle();

  // #8: Capture resources tab shows live count badge
  await page.waitForSelector('#flexlayout-tabbutton-capture-resources .capture-tab-badge');
  assert.equal(
    await page.locator('#flexlayout-tabbutton-capture-resources .capture-tab-badge').textContent(),
    '1',
    'capture resources tab displays count badge',
  );

  // #2: Tree search toggle button shows and hides #tree-filters
  assert.equal(await page.locator('#tree-filters').isVisible(), false);
  await page.locator('#tree-search-toggle').click();
  await page.locator('#tree-filters').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#tree-search-toggle').getAttribute('aria-expanded'), 'true');
  await page.locator('#tree-search-toggle').click();
  assert.equal(await page.locator('#tree-filters').isVisible(), false);
  assert.equal(await page.locator('#tree-search-toggle').getAttribute('aria-expanded'), 'false');

  // Floating menus (#tree-create-menu, #view-menu-dropdown, Milkdown top-bar dropdown) must not clip at panel/viewport borders
  const assertMenuUnclipped = async (menuSelector, buttonSelector, label) => {
    const info = await page.evaluate(({ menuSel, btnSel }) => {
      const menu = document.querySelector(menuSel);
      const btn = document.querySelector(btnSel);
      if (!menu || !btn) return null;
      const m = menu.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      const leftHit = document.elementFromPoint(b.left + 6, b.top + b.height / 2);
      const rightHit = document.elementFromPoint(b.right - 6, b.top + b.height / 2);
      return {
        vw: window.innerWidth,
        vh: window.innerHeight,
        menu: { left: m.left, right: m.right, top: m.top, bottom: m.bottom, width: m.width, height: m.height },
        btn: { left: b.left, right: b.right, top: b.top, bottom: b.bottom },
        leftHitOk: Boolean(leftHit && btn.contains(leftHit)),
        rightHitOk: Boolean(rightHit && btn.contains(rightHit)),
      };
    }, { menuSel: menuSelector, btnSel: buttonSelector });
    assert.ok(info, `${label}: menu and button exist`);
    assert.ok(info.menu.left >= 0 && info.menu.right <= info.vw, `${label}: menu stays within horizontal viewport (${JSON.stringify(info.menu)}, vw=${info.vw})`);
    assert.ok(info.menu.top >= 0 && info.menu.bottom <= info.vh, `${label}: menu stays within vertical viewport (${JSON.stringify(info.menu)}, vh=${info.vh})`);
    assert.equal(info.leftHitOk, true, `${label}: button left side is hit-testable (not clipped)`);
    assert.equal(info.rightHitOk, true, `${label}: button right side is hit-testable (not clipped by adjacent pane)`);
  };
  await page.locator('#tree-create-menu > summary').click();
  await assertMenuUnclipped('.editor-more-menu[data-menu-owner="tree-create-menu"]', '#new-page', 'tree-create-menu #new-page (1440px)');
  await assertMenuUnclipped('.editor-more-menu[data-menu-owner="tree-create-menu"]', '#new-folder', 'tree-create-menu #new-folder (1440px)');
  // Clicking the right half of #new-folder must open the dialog and close the menu
  const folderBox = await page.locator('#new-folder').boundingBox();
  await page.mouse.click(folderBox.x + folderBox.width - 10, folderBox.y + folderBox.height / 2);
  await page.locator('#new-folder-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#tree-create-menu').getAttribute('open'), null);
  await page.locator('#cancel-new-folder').click();

  await page.locator('#view-menu-button').click();
  await assertMenuUnclipped('#view-menu-dropdown', '#view-menu-dropdown .view-menu-reset-btn', 'view-menu-dropdown (1440px)');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#view-menu-dropdown').isVisible(), false);

  await page.setViewportSize({ width: 700, height: 700 });
  await page.locator('#tree-create-menu > summary').click();
  await assertMenuUnclipped('.editor-more-menu[data-menu-owner="tree-create-menu"]', '#new-folder', 'tree-create-menu #new-folder (700px)');
  await page.locator('#panel-editor').click({ position: { x: 10, y: 10 } });
  assert.equal(await page.locator('#tree-create-menu').getAttribute('open'), null);
  await page.locator('#view-menu-button').click();
  await assertMenuUnclipped('#view-menu-dropdown', '#view-menu-dropdown .view-menu-reset-btn', 'view-menu-dropdown (700px)');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 960 });

  await page.locator('#milkdown-editor .milkdown-top-bar .top-bar-heading-button').first().click();
  await assertMenuUnclipped('#milkdown-editor .top-bar-heading-dropdown', '#milkdown-editor .top-bar-heading-dropdown button', 'milkdown top-bar heading dropdown');
  await page.keyboard.press('Escape');

  // #3: Ctrl+F opens in-document find bar (not tree search) and matches in rich mode
  await page.locator('#milkdown-editor .ProseMirror p').first().click();
  await page.keyboard.press('Control+f');
  await page.locator('#editor-find-bar').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#tree-filters').isVisible(), false, 'Ctrl+F does not steal focus to tree filters');
  await page.locator('#editor-find-input').fill('検索テスト');
  await page.waitForFunction(() => document.querySelector('#editor-find-count')?.textContent === '1 / 2');
  await page.locator('#editor-find-input').press('Enter');
  assert.equal(await page.locator('#editor-find-count').textContent(), '2 / 2');
  await page.locator('#editor-find-input').press('Escape');
  assert.equal(await page.locator('#editor-find-bar').isVisible(), false);

  // #1: Pasting an image file into Milkdown saves to docs/assets/image-YYYYMMDD-HHMMSS.png (not Base64)
  await page.keyboard.press('ArrowRight');
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = new File([bytes], 'pasted.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const target = document.querySelector('#milkdown-editor .ProseMirror');
    target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  }, png.toString('base64'));
  await page.waitForFunction(() => /assets\/image-\d{8}-\d{6}/.test(document.querySelector('#markdown-editor').value));
  const afterPaste = await page.locator('#markdown-editor').inputValue();
  assert.doesNotMatch(afterPaste, /data:image\//, 'rich paste saves asset file instead of embedding Base64');
  const assetFiles = await readdir(path.join(root, 'docs/assets'));
  assert.ok(assetFiles.some(name => /^image-\d{8}-\d{6}(?:-\d+)?\.png$/.test(name)), `saved asset exists: ${assetFiles}`);

  // #4: Dirty state shows #save-state and highlights #save-page; saving hides #save-state and shows toast
  assert.equal(await page.locator('#save-state').isVisible(), true, 'unsaved indicator is visible when dirty');
  assert.equal(await page.locator('#save-page').getAttribute('data-dirty'), 'true');
  await page.locator('#save-page').click();
  await idle();
  assert.equal(await page.locator('#save-state').isVisible(), false, 'cleanly saved state stays unobtrusive');
  assert.equal(await page.locator('#save-page').getAttribute('data-dirty'), 'false');

  // #10: Toast notification appeared on save and status history dialog opens on click
  assert.ok((await page.locator('.studio-toast').count()) >= 1, 'toast notification is shown');
  await page.locator('#status').click();
  await page.locator('#status-history-dialog').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#status-history-dialog .status-history-item').count()) >= 1);
  await page.locator('#status-history-dialog').getByRole('button', { name: '閉じる', exact: true }).click();

  // #5: Jumping to an AI note auto-switches to source mode with return banner -> one-click back to rich mode
  await page.locator('#rich-ai-notes-banner button').click();
  await page.locator('#ai-notes-dialog').waitFor({ state: 'visible' });
  await page.locator('#ai-notes-dialog').getByRole('button', { name: '移動', exact: true }).click();
  await page.locator('#source-return-banner').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#markdown-editor').isVisible(), true);
  await page.locator('#return-to-rich-editor').click();
  assert.equal(await page.locator('#source-return-banner').isVisible(), false);
  assert.equal(await page.locator('#markdown-editor').isVisible(), false);

  // #6: Tab drag reorder and middle-click close
  const openDoc = async (name) => {
    const closed = page.locator('details[data-folder="docs"]:not([open]) > summary');
    if (await closed.count()) await closed.click();
    await page.locator(`[data-page="docs/${name}"]`).click();
    await idle();
  };
  await openDoc('second.md');
  await openDoc('third.md');
  const getTabOrder = () => page.locator('#document-tabs [role=tab]').evaluateAll(els => els.map(el => el.dataset.documentPage));
  assert.deepEqual(await getTabOrder(), ['index.md', 'second.md', 'third.md']);
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#document-tabs .document-tab')];
    const dt = new DataTransfer();
    tabs[2].dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    tabs[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    tabs[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    tabs[2].dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  });
  assert.deepEqual(await getTabOrder(), ['third.md', 'index.md', 'second.md'], 'dragging reorders document tabs');
  await page.locator('#document-tabs [data-document-page="second.md"]').click({ button: 'middle' });
  await idle();
  assert.deepEqual(await getTabOrder(), ['third.md', 'index.md'], 'middle-click closes tab');

  // #7: Clicking a non-Markdown/non-image file shows helpful file info dialog
  await page.locator('#page-list [data-file="manual_setting.json"]').click();
  await page.locator('#static-file-info-dialog').waitFor({ state: 'visible' });
  assert.match(await page.locator('#static-file-info-dialog').textContent(), /manual_setting\.json/);
  await page.locator('#static-file-info-dialog').getByRole('button', { name: '閉じる', exact: true }).click();

  // #9: HTML output dialog shows site name summary, syncs settings, and links directly to Settings -> HTML出力
  await page.locator('#site-export-open').click();
  await page.locator('#site-export-dialog').waitFor({ state: 'visible' });
  assert.match(await page.locator('#site-export-settings-summary').textContent(), /Polish Guide/);
  await page.locator('#site-export-open-settings').click();
  await page.locator('#panel-settings').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#settings-tab-html-output').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#settings-site-name').inputValue(), 'Polish Guide');
  await page.locator('[data-close-dialog="panel-settings"]').click();

  assert.equal(await page.locator('#create-ai-template').count(), 0, 'AI template creation button is removed');
  assert.equal(await page.locator('#site-export-open > svg.ui-icon').count(), 1, 'HTML export button renders export icon');
  assert.deepEqual(errors, [], `Unexpected page errors: ${errors.join('\n')}`);
  console.log('All 10 UX polish checks passed.');
} finally {
  await browser?.close();
  server?.kill();
  await rm(root, { recursive: true, force: true });
}
