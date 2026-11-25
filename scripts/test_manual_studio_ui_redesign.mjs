import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = await mkdtemp(path.join(os.tmpdir(), 'munin-ui-redesign-'));
const port = 5174;
const base = `http://127.0.0.1:${port}`;
let server, browser;

try {
  // Static check: no undefined CSS variables remain in modular stylesheets.
  for (const name of ['base.css', 'layout.css', 'features.css', 'enhancements.css']) {
    const css = await readFile(path.join('apps/manual-studio/src/styles', name), 'utf8');
    assert.doesNotMatch(css, /var\(--(?:surface|border|text|error-color|accent-contrast)[),]/, `${name} must not reference undefined CSS tokens`);
  }

  await mkdir(path.join(root, 'docs/guide'), { recursive: true });
  await mkdir(path.join(root, 'docs/api'), { recursive: true });
  await mkdir(path.join(root, 'docs/assets'), { recursive: true });
  const png = await readFile('apps/manual-studio/src-tauri/icons/icon.png');
  await writeFile(path.join(root, 'docs/assets/sample.png'), png);
  await writeFile(
    path.join(root, 'manual_setting.json'),
    JSON.stringify({
      docs: 'docs',
      output: 'manual',
      assets: 'docs/assets',
      targets: ['docs'],
      connection_type: 'none',
      mkdocs: { site_name: 'Redesign Check', exclude_unused_assets: false },
    }),
  );
  await writeFile(
    path.join(root, 'docs/guide/index.md'),
    '# ガイド見出し\n\nAlpha alpha テスト文章。\n\n![サンプル画像](../assets/sample.png)\n\n## セクションA\n\n本文A。\n\n## セクションB\n\n本文B。\n\n```mermaid\ngraph TD\n  A[開始] --> B[完了]\n```\n',
  );
  await writeFile(
    path.join(root, 'docs/api/index.md'),
    '# APIリファレンス\n\nAPIの本文。\n',
  );

  server = spawn(
    process.execPath,
    [path.resolve('node_modules/vite/bin/vite.js'), '--config', 'apps/manual-studio/vite.config.ts', '--configLoader', 'native', '--port', String(port), '--strictPort'],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }

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
  await rpc('capture-resources-register', { json: { source: png.toString('base64'), name: 'UI Capture' } });

  browser = await chromium.launch({
    channel: process.env.MUNIN_TEST_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'),
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const idle = () => page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');

  // 1. Empty state shows recent workspaces when no project is open.
  await page.addInitScript((fixtureRoot) => {
    if (!localStorage.getItem('manual-studio-workspace-history')) {
      localStorage.setItem('manual-studio-workspace-history', JSON.stringify([fixtureRoot]));
    }
  }, root);
  await page.goto(base);
  await idle();
  await page.locator('#empty-recent-workspaces .empty-recent-entry').first().waitFor({ state: 'visible' });
  await page.locator('#empty-recent-workspaces .empty-recent-entry').first().click();
  await page.locator('#page-list details[data-folder="docs"]').waitFor({ state: 'visible' });
  await idle();

  // Open docs/guide/index.md via tree.
  const openTreePage = async (rel) => {
    for (const dir of rel.split('/').slice(0, -1).map((_, idx, arr) => arr.slice(0, idx + 1).join('/'))) {
      const closed = page.locator(`details[data-folder="${dir}"]:not([open]) > summary`);
      if (await closed.count()) await closed.click();
    }
    await page.locator(`[data-page="${rel}"]`).click();
    await idle();
  };
  await openTreePage('docs/guide/index.md');
  await page.waitForSelector('#milkdown-editor .ProseMirror');

  // 2. Slim header, distinct icons, no emoji in tree search, toast at top-right.
  const headerMetrics = await page.evaluate(() => ({
    headerHeight: Math.round(document.querySelector('.app-header').getBoundingClientRect().height),
    navHeight: Math.round(document.querySelector('.workspace-tabs').getBoundingClientRect().height),
    targetAppIcon: document.querySelector('#target-application-open').dataset.uiIcon,
    settingsIcon: document.querySelector('#application-settings').dataset.uiIcon,
    treeSearchHasSvg: Boolean(document.querySelector('#tree-search-toggle svg.ui-icon')),
    treeSearchText: document.querySelector('#tree-search-toggle').textContent.trim(),
    toastTop: parseFloat(getComputedStyle(document.querySelector('#studio-toast-stack')).top),
  }));
  assert.ok(headerMetrics.headerHeight <= 52, `Header should be slim (<=52px), got ${headerMetrics.headerHeight}`);
  assert.ok(headerMetrics.navHeight <= 40, `Workspace bar should be slim (<=40px), got ${headerMetrics.navHeight}`);
  assert.equal(headerMetrics.targetAppIcon, 'application');
  assert.equal(headerMetrics.settingsIcon, 'settings');
  assert.equal(headerMetrics.treeSearchHasSvg, true);
  assert.equal(headerMetrics.treeSearchText, '');
  assert.ok(headerMetrics.toastTop > 0 && headerMetrics.toastTop < 150, `Toast should sit near top-right, got top=${headerMetrics.toastTop}`);

  // 3. Shortcut help button & Ctrl+/ open #shortcut-help-dialog.
  await page.locator('#shortcut-help-open').click();
  await page.locator('#shortcut-help-dialog').waitFor({ state: 'visible' });
  assert.match(await page.locator('#shortcut-help-dialog').textContent(), /開いている原稿内を置換/);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#shortcut-help-dialog'));

  // 4. AI Collab Hub reachable from top bar even without opening AI terminal, with arrow-key tabs and grouped toolbar.
  await page.locator('#workspace-ai-hub-open').click();
  const hubDialog = page.locator('#ai-collab-hub-dialog');
  await hubDialog.waitFor({ state: 'visible' });
  assert.equal(await hubDialog.locator('.ai-hub-toolbar-group').count(), 2, 'Dashboard toolbar is organized into 2 groups');
  await hubDialog.locator('#ai-hub-tab-dashboard').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await hubDialog.locator('#ai-hub-tab-fact-check').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#ai-collab-hub-dialog'));

  // 5. Outline panel tab in left sidebar lists headings and navigates.
  await page.locator('#flexlayout-tabbutton-outline').click();
  await page.locator('#manuscript-outline-list .manuscript-outline-row').first().waitFor({ state: 'visible' });
  const outlineCount = await page.locator('#manuscript-outline-list .manuscript-outline-row').count();
  assert.equal(outlineCount, 3, 'Outline displays H1 + 2 H2 headings');
  await page.locator('#flexlayout-tabbutton-file-tree').click();

  // 6. Duplicate tab names show parent directory disambiguation.
  await openTreePage('docs/api/index.md');
  const tabTexts = await page.locator('#document-tabs [role=tab]').allTextContents();
  assert.ok(tabTexts.some(t => t.includes('guide')), `Expected guide dir on duplicate tab: ${tabTexts}`);
  assert.ok(tabTexts.some(t => t.includes('api')), `Expected api dir on duplicate tab: ${tabTexts}`);
  await page.locator('#document-tabs [data-document-page="guide/index.md"]').click();
  await idle();

  // 7. Footer displays word count & mode badge in Rich mode, and cursor updates.
  assert.equal(await page.locator('#editor-mode-badge').textContent(), 'リッチ');
  assert.match(await page.locator('#editor-word-count').textContent(), /文字/);

  // 8. In-document Find & Replace (Ctrl+F / Ctrl+H) with case toggle and ProseMirror decorations.
  await page.locator('#milkdown-editor .ProseMirror p').first().click();
  await page.keyboard.press('Control+f');
  await page.locator('#editor-find-bar').waitFor({ state: 'visible' });
  await page.locator('#editor-find-input').fill('alpha');
  await page.waitForFunction(() => document.querySelector('#editor-find-count')?.textContent === '1 / 2');
  assert.equal(await page.locator('.ProseMirror .editor-find-match').count(), 2, 'All matches highlighted in Rich mode');
  assert.equal(await page.locator('.ProseMirror .editor-find-match-current').count(), 1, 'Active match highlighted');
  await page.locator('#editor-find-case').click();
  await page.waitForFunction(() => document.querySelector('#editor-find-count')?.textContent === '1 / 1');
  await page.locator('#editor-find-case').click();
  await page.waitForFunction(() => document.querySelector('#editor-find-count')?.textContent === '1 / 2');

  // Replace via toggle.
  await page.locator('#editor-find-replace-toggle').click();
  await page.locator('#editor-replace-row').waitFor({ state: 'visible' });
  await page.locator('#editor-replace-input').fill('Beta');
  await page.locator('#editor-replace-all').click();
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('Beta Beta'));
  await page.locator('#editor-find-close').click();
  assert.equal(await page.locator('.ProseMirror .editor-find-match').count(), 0, 'Highlights clear on close');
  await page.locator('#save-page').click();
  await idle();

  // 9. Image action overlay uses SVG icon (no 🎨 emoji) and works cleanly.
  const imgBox = await page.locator('#milkdown-editor img').first().boundingBox();
  assert.ok(imgBox, 'Image rendered in Rich editor');
  await page.mouse.move(imgBox.x + imgBox.width / 2, imgBox.y + imgBox.height / 2);
  await page.locator('.milkdown-image-edit-btn').waitFor({ state: 'visible' });
  const editBtnText = await page.locator('.milkdown-image-edit-btn').textContent();
  assert.doesNotMatch(editBtnText, /🎨/, 'Image edit button uses SVG icon instead of emoji');
  assert.equal(await page.locator('.milkdown-image-edit-btn svg.ui-icon').count(), 1);

  // 10. Capture resources toolbar is single-row with labeled import & card buttons, real background color.
  await page.locator('#flexlayout-tabbutton-capture-resources').click();
  await page.locator('.capture-resource-card').first().waitFor({ state: 'visible' });
  assert.equal(await page.locator('#panel-capture-resources .capture-resource-toolbar').count(), 1);
  assert.match(await page.locator('#capture-resource-import-button').textContent(), /登録/);
  assert.match(await page.locator('.capture-resource-card .capture-resource-actions').first().textContent(), /編集/);
  assert.match(await page.locator('.capture-resource-card .capture-resource-actions').first().textContent(), /再撮影/);

  // 11. Settings dialog: save-mode badge on tabs, toolbar customization open by default, dark theme check.
  await page.locator('#application-settings').click();
  await page.locator('#panel-settings').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#settings-category-keyboard .settings-save-mode-badge').textContent(), 'ボタンで保存');
  await page.locator('#settings-tab-appearance').click();
  assert.equal(await page.locator('#settings-category-appearance .settings-save-mode-badge').textContent(), '即時反映・自動保存');
  assert.equal(await page.locator('#toolbar-customization').evaluate(el => el.open), true, 'Toolbar customization opens expanded');
  await page.locator('#ui-theme').selectOption('midnight');
  await page.locator('[data-close-dialog="panel-settings"]').click();

  // Verify dark theme tokens, capture card background, and Mermaid dark background.
  const darkChecks = await page.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement);
    const cardBg = getComputedStyle(document.querySelector('.capture-resource-card')).backgroundColor;
    const mermaidEl = document.querySelector('.mermaid-preview');
    return {
      warning: rootStyle.getPropertyValue('--warning').trim(),
      success: rootStyle.getPropertyValue('--success').trim(),
      cardBg,
      mermaidBg: mermaidEl ? getComputedStyle(mermaidEl).backgroundColor : null,
    };
  });
  assert.ok(darkChecks.warning.length > 0, '--warning defined in dark theme');
  assert.ok(darkChecks.success.length > 0, '--success defined in dark theme');
  assert.notEqual(darkChecks.cardBg, 'rgba(0, 0, 0, 0)', 'Capture card has opaque themed background');
  if (darkChecks.mermaidBg) {
    assert.notEqual(darkChecks.mermaidBg, 'rgb(255, 255, 255)', 'Mermaid preview avoids blinding white bg in dark theme');
  }

  // 12. AI Terminal shows status dot & cwd chip while keeping hidden accessibility badges.
  await page.locator('#view-menu-button').click();
  await page.locator('#view-menu-dropdown').getByRole('checkbox', { name: 'AIターミナル' }).check();
  await page.locator('#view-menu-button').click();
  await page.locator('#terminal-status-indicator').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#terminal-badge').isVisible(), false);
  assert.ok((await page.locator('#terminal-cwd-chip').textContent()).length > 0, 'Terminal shows working directory chip');

  // 13. HTML Export: no "HTMLを開く" button, visual theme presets + customizer sync & build output.
  assert.equal(await page.locator('#open-site-html').count(), 0, 'HTMLを開く button must be removed');
  await page.locator('#site-export-open').click();
  const exportDialog = page.locator('#site-export-dialog');
  await exportDialog.waitFor({ state: 'visible' });
  assert.equal(await exportDialog.locator('#open-site-html').count(), 0);
  assert.equal(await exportDialog.locator('.html-theme-preset-card').count(), 6, '6 visual preset cards rendered');
  await exportDialog.locator('[data-html-theme-preset="slate-dark"]').click();
  assert.equal(await exportDialog.locator('[data-html-theme-preset="slate-dark"]').getAttribute('aria-checked'), 'true');
  assert.equal(await exportDialog.locator('.html-theme-live-preview').getAttribute('data-scheme'), 'dark');
  assert.match(await exportDialog.locator('#site-export-settings-summary').textContent(), /スレートダーク/);

  // Fine-grained customization switches to custom and updates live preview.
  await exportDialog.locator('.html-theme-custom > summary').click();
  await exportDialog.locator('#site-export-theme-primary').fill('#12ab34');
  await exportDialog.locator('#site-export-theme-layout').selectOption('wide');
  assert.match(await exportDialog.locator('.html-theme-active-badge').textContent(), /カスタム/);
  assert.equal(await exportDialog.locator('.html-theme-live-preview').getAttribute('data-layout'), 'wide');

  // Build Single HTML and verify the customized theme is applied to the exported index.html.
  await exportDialog.locator('#site-engine').selectOption('build-single-html');
  await exportDialog.locator('#build-site').click();
  await page.waitForFunction(() => document.querySelector('#site-build-result')?.textContent?.includes('Single HTML:'));
  await idle();
  const exportedHtml = await readFile(path.join(root, 'manual/index.html'), 'utf8');
  assert.match(exportedHtml, /data-munin-theme="custom"/);
  assert.match(exportedHtml, /data-munin-scheme="dark"/);
  assert.match(exportedHtml, /--primary:\s*#12ab34/i);
  assert.match(exportedHtml, /max-width:\s*1160px/);

  // Settings -> HTML出力 reflects the exact synced theme.
  await exportDialog.locator('#site-export-open-settings').click();
  await page.locator('#panel-settings').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#settings-site-theme-primary').inputValue(), '#12ab34');
  assert.equal(await page.locator('#settings-site-theme-layout').inputValue(), 'wide');
  await page.locator('[data-close-dialog="panel-settings"]').click();

  assert.deepEqual(errors, [], `Unexpected page errors: ${errors.join('\n')}`);
  console.log('All UI redesign & polish regression checks passed.');
} finally {
  await browser?.close();
  server?.kill();
  await rm(root, { recursive: true, force: true });
}
