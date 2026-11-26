import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:5191';
let server;
let browser;

try {
  server = spawn(
    process.execPath,
    [
      path.resolve('node_modules/vite/bin/vite.js'),
      '--config',
      'apps/manual-studio/vite.config.ts',
      '--configLoader',
      'native',
      '--port',
      '5191',
    ],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  browser = await chromium.launch({
    channel: process.env.MUNIN_TEST_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'),
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const state = {
    has_config: true,
    config: {
      docs: 'docs',
      assets: 'docs/assets',
      output: 'site',
      agent: 'codex',
      model: '',
      connection_type: 'none',
      cli_models: { codex: '', claude: '', agy: '' },
      mkdocs: {
        site_name: 'テストマニュアル',
        theme: 'material',
        language: 'ja',
        use_directory_urls: false,
        nav: [],
        exclude_unused_assets: false,
      },
    },
    brief: '',
    pages: ['index.md', 'guide.md'],
    project_entries: [
      { path: 'docs/index.md', directory: false },
      { path: 'docs/guide.md', directory: false },
    ],
    image_assets: {},
    agents: [{ id: 'codex', label: 'Codex', available: true }],
  };

  let indexDoc = '# はじめに\n\nフォルダを開きます。\n';
  let guideDoc = '# 詳細ガイド\n\n別のフォルダです。\n';
  let indexRev = 'r1';
  let guideRev = 'r1';
  let captureItems = [
    {
      id: 'capture-used',
      name: '使用中の画面',
      created_at: '2026-11-23T00:00:00Z',
      revision: 'abc1',
      recorded: true,
      derived: [{ id: 'default', path: 'docs/assets/captures/capture-used/default.png' }],
      usages: [{ page: 'docs/index.md', line: 3, start: 10, snippet: '![](...)' }],
    },
    {
      id: 'capture-unused',
      name: '未使用の画面',
      created_at: '2026-11-23T00:01:00Z',
      revision: 'abc2',
      recorded: false,
      derived: [{ id: 'default', path: 'docs/assets/captures/capture-unused/default.png' }],
      usages: [],
    },
  ];

  const savedHtmlPayloads = [];
  const builtActions = [];
  let savedNavPayload = null;
  let cleanupCalled = 0;
  let restoreTrashCalled = 0;
  let latestTrash = null;
  let archivedBackup = [];
  const batchSaves = [];

  await page.route('**/__manual/rpc', async (route) => {
    const req = route.request().postDataJSON();
    let output = {};
    switch (req.action) {
      case 'state':
        output = state;
        break;
      case 'workspace-tree':
        output = { pages: state.pages, project_entries: state.project_entries };
        break;
      case 'capture-resources-list':
        output = { items: captureItems, latest_trash: latestTrash };
        break;
      case 'capture-resources-thumbnail':
        output = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0e0AAAAASUVORK5CYII=';
        break;
      case 'capture-resources-cleanup-unused':
        cleanupCalled++;
        archivedBackup = captureItems.filter((item) => item.usages.length === 0);
        captureItems = captureItems.filter((item) => item.usages.length > 0);
        latestTrash = {
          trash_dir: '.munin/trash/capture-cleanup-2026',
          archived_at: '2026-11-23T11:30:00Z',
          count: archivedBackup.length,
        };
        output = {
          archived_count: archivedBackup.length,
          archived_ids: archivedBackup.map((i) => i.id),
          trash_dir: latestTrash.trash_dir,
          skipped: [],
        };
        break;
      case 'capture-resources-restore-trash':
        restoreTrashCalled++;
        captureItems = [...captureItems, ...archivedBackup];
        const count = archivedBackup.length;
        const dir = latestTrash?.trash_dir || '';
        archivedBackup = [];
        latestTrash = null;
        output = { restored_count: count, restored_ids: ['capture-unused'], trash_dir: dir };
        break;
      case 'editor-read':
        if (String(req.options.page).includes('guide')) {
          output = { page: 'docs/guide.md', content: guideDoc, revision: guideRev };
        } else {
          output = { page: 'docs/index.md', content: indexDoc, revision: indexRev };
        }
        break;
      case 'editor-read-if-changed':
        output = null;
        break;
      case 'image-generation-settings':
        output = { connection_type: 'none', endpoint_url: '', model: '' };
        break;
      case 'preview-page':
        output = '<html><body>Preview</body></html>';
        break;
      case 'agent-progress':
        output = { logs: [], total: 0 };
        break;
      case 'save-html-output':
        savedHtmlPayloads.push(req.options);
        state.config.output = req.options.output || state.config.output;
        if (req.options.json?.site_name) state.config.mkdocs.site_name = req.options.json.site_name;
        if (typeof req.options.json?.exclude_unused_assets === 'boolean') {
          state.config.mkdocs.exclude_unused_assets = req.options.json.exclude_unused_assets;
        }
        if (typeof req.options.json?.working_directory === 'string') {
          state.config.mkdocs.working_directory = req.options.json.working_directory;
        }
        output = { output: state.config.output };
        break;
      case 'build-single-html':
      case 'build-mkdocs':
      case 'build-zensical':
        builtActions.push({ action: req.action, options: req.options });
        output = req.action === 'build-single-html'
          ? 'site\nSingle HTML: site/index.html'
          : 'site\nSite: site';
        break;
      case 'project-dashboard':
        output = {
          total_pages: 2,
          total_errors: 0,
          total_warnings: 0,
          nav: state.config.mkdocs.nav,
          exclude_unused_assets: state.config.mkdocs.exclude_unused_assets,
          diagnostics: [],
          pages: [
            {
              page: 'docs/index.md',
              title: 'はじめに',
              audiences: ['user'],
              char_count: indexDoc.length,
              heading_count: 1,
              image_count: 0,
              incoming_count: 1,
              error_count: 0,
              warning_count: 0,
              ai_note_count: 0,
            },
            {
              page: 'docs/guide.md',
              title: '詳細ガイド',
              audiences: ['developer'],
              char_count: guideDoc.length,
              heading_count: 1,
              image_count: 0,
              incoming_count: 1,
              error_count: 0,
              warning_count: 0,
              ai_note_count: 0,
            },
          ],
        };
        break;
      case 'publication-nav-save':
        savedNavPayload = req.options.nav;
        state.config.mkdocs.nav = req.options.nav;
        output = { nav: req.options.nav };
        break;
      case 'quality-check': {
        const issues = [];
        const idxHit = indexDoc.indexOf('フォルダ');
        if (idxHit >= 0 && !indexDoc.slice(idxHit, idxHit + 5).startsWith('フォルダー')) {
          issues.push({
            page: 'docs/index.md',
            kind: 'glossary_violation',
            severity: 'warning',
            line: 3,
            start: idxHit,
            end: idxHit + 4,
            snippet: 'フォルダ',
            message: '用語集の表記ルール: 「フォルダ」は「フォルダー」に統一してください。',
            details: { preferred: 'フォルダー', matched: 'フォルダ', category: 'style' },
          });
        }
        const guideHit = guideDoc.indexOf('フォルダ');
        if (guideHit >= 0 && !guideDoc.slice(guideHit, guideHit + 5).startsWith('フォルダー')) {
          issues.push({
            page: 'docs/guide.md',
            kind: 'glossary_violation',
            severity: 'warning',
            line: 3,
            start: guideHit,
            end: guideHit + 4,
            snippet: 'フォルダ',
            message: '用語集の表記ルール: 「フォルダ」は「フォルダー」に統一してください。',
            details: { preferred: 'フォルダー', matched: 'フォルダ', category: 'style' },
          });
        }
        output = {
          passed: true,
          has_warnings: issues.length > 0,
          error_count: 0,
          warning_count: issues.length,
          issues,
        };
        break;
      }
      case 'glossary-replace-plan':
        output = {
          total_replacements: 2,
          documents: [
            {
              page: 'docs/index.md',
              revision: indexRev,
              before: indexDoc,
              after: indexDoc.replaceAll('フォルダ', 'フォルダー'),
              count: 1,
              replacements: [{ line: 3, matched: 'フォルダ', preferred: 'フォルダー', term_id: 'folder' }],
            },
            {
              page: 'docs/guide.md',
              revision: guideRev,
              before: guideDoc,
              after: guideDoc.replaceAll('フォルダ', 'フォルダー'),
              count: 1,
              replacements: [{ line: 3, matched: 'フォルダ', preferred: 'フォルダー', term_id: 'folder' }],
            },
          ],
        };
        break;
      case 'editor-batch-save': {
        batchSaves.push(req.options.json.documents);
        const before = [];
        const saved = [];
        for (const doc of req.options.json.documents) {
          if (doc.page.includes('guide')) {
            before.push({ page: 'docs/guide.md', content: guideDoc, revision: guideRev });
            guideDoc = doc.content;
            guideRev = `r${Number(guideRev.slice(1)) + 1}`;
            saved.push({ page: 'docs/guide.md', content: guideDoc, revision: guideRev });
          } else {
            before.push({ page: 'docs/index.md', content: indexDoc, revision: indexRev });
            indexDoc = doc.content;
            indexRev = `r${Number(indexRev.slice(1)) + 1}`;
            saved.push({ page: 'docs/index.md', content: indexDoc, revision: indexRev });
          }
        }
        output = { before, documents: saved };
        break;
      }
      default:
        output = {};
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        output: typeof output === 'string' ? output : JSON.stringify(output),
      }),
    });
  });

  await page.goto(`${base}/?root=C:/test-project`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#page-list [data-page]');

  // 1. HTML出力ダイアログ: MkDocsでワーキングフォルダ表示・保存 + 単一HTMLでは非表示 + 未使用画像除外 + 閉じる
  await page.click('#site-export-open');
  await page.waitForSelector('#site-export-dialog[open]');
  assert.equal(await page.locator('#site-working-directory-group').isVisible(), true);
  const mkdocsExportRect = await page.locator('#site-export-dialog').boundingBox();
  assert.ok(mkdocsExportRect && mkdocsExportRect.width <= 1366 && mkdocsExportRect.height <= 860, 'site-export-dialog (MkDocs) fits viewport');
  const engineBox = await page.locator('#site-engine').boundingBox();
  const outputPathBox = await page.locator('#site-output-path').boundingBox();
  const workingDirBox = await page.locator('#site-working-directory').boundingBox();
  assert.ok(engineBox && outputPathBox && workingDirBox, 'HTML export inputs have bounding boxes');
  assert.ok(outputPathBox.width >= engineBox.width * 0.7, `site-output-path should stretch horizontally (${outputPathBox.width} vs ${engineBox.width})`);
  assert.ok(workingDirBox.width >= engineBox.width * 0.7, `site-working-directory should stretch horizontally (${workingDirBox.width} vs ${engineBox.width})`);
  await page.fill('#site-working-directory', '..');
  await page.click('#build-site');
  await page.waitForFunction(() =>
    document.querySelector('#site-build-result')?.textContent?.includes('Site: site'),
  );
  await page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(savedHtmlPayloads.at(-1).json.working_directory, '..');
  assert.equal(builtActions.at(-1).action, 'build-mkdocs');
  assert.equal(builtActions.at(-1).options.working_directory, '..');

  await page.selectOption('#site-engine', 'build-single-html');
  assert.equal(await page.locator('#site-working-directory-group').isVisible(), false);
  await page.check('#site-exclude-unused-assets');
  await page.click('#build-site');
  await page.waitForFunction(() =>
    document.querySelector('#site-build-result')?.textContent?.includes('Single HTML'),
  );
  assert.equal(savedHtmlPayloads.at(-1).json.exclude_unused_assets, true);
  assert.equal(builtActions.at(-1).action, 'build-single-html');
  assert.equal(builtActions.at(-1).options.working_directory, undefined);
  const exportRect = await page.locator('#site-export-dialog').boundingBox();
  assert.ok(exportRect && exportRect.width <= 1366 && exportRect.height <= 860, 'site-export-dialog fits viewport');
  await page.locator('#site-export-dialog').getByRole('button', { name: '閉じる', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#site-export-dialog[open]'));

  // 1b. 設定 -> HTML出力タブ: exclude_unused_assets と working_directory が同期され保存できること
  await page.click('#application-settings');
  await page.waitForSelector('#panel-settings[open]');
  await page.locator('#panel-settings').getByRole('tab', { name: 'HTML出力' }).click();
  const settingsCardBox = await page.locator('#html-output-settings').boundingBox();
  const settingsSiteNameBox = await page.locator('#settings-site-name').boundingBox();
  const settingsOutputBox = await page.locator('#settings-site-output').boundingBox();
  const settingsWorkingDirBox = await page.locator('#settings-site-working-directory').boundingBox();
  assert.ok(settingsCardBox && settingsSiteNameBox && settingsOutputBox && settingsWorkingDirBox, 'Settings HTML output inputs have bounding boxes');
  assert.ok(settingsSiteNameBox.width >= settingsCardBox.width * 0.7, `settings-site-name should stretch horizontally (${settingsSiteNameBox.width} vs ${settingsCardBox.width})`);
  assert.ok(settingsOutputBox.width >= settingsCardBox.width * 0.7, `settings-site-output should stretch horizontally (${settingsOutputBox.width} vs ${settingsCardBox.width})`);
  assert.ok(settingsWorkingDirBox.width >= settingsCardBox.width * 0.7, `settings-site-working-directory should stretch horizontally (${settingsWorkingDirBox.width} vs ${settingsCardBox.width})`);
  assert.equal(await page.locator('#settings-site-exclude-unused').isChecked(), true);
  assert.equal(await page.locator('#settings-site-working-directory').inputValue(), '..');
  await page.locator('#settings-site-working-directory').fill('C:/shared-venv');
  await page.locator('#settings-site-exclude-unused').uncheck();
  await page.click('#settings-site-save');
  await page.waitForFunction(() =>
    document.querySelector('#settings-site-result')?.textContent?.includes('保存しました'),
  );
  assert.equal(state.config.mkdocs.exclude_unused_assets, false);
  assert.equal(state.config.mkdocs.working_directory, 'C:/shared-venv');
  await page.locator('[data-close-dialog="panel-settings"]').click();

  // 2. HTML出力 -> 目次順・非表示 / 読者別出力: 目次順の並び替え・セクション/表示名・保存 & 読者別単一HTML確認
  await page.click('#site-export-open');
  await page.waitForSelector('#site-export-dialog[open]');
  await page.click('#export-tab-nav');
  await page.waitForSelector('#hub-nav-pages .ai-hub-page-row');

  // Move guide.md up to first position, assign section and title override
  await page.click('button[aria-label="docs/guide.md を上へ移動"]');
  await page.fill('input[aria-label="docs/guide.md のセクション名"]', '導入ガイド');
  await page.fill('input[aria-label="docs/guide.md の目次表示名"]', '最初に読むガイド');
  await page.click('#hub-nav-save-btn');
  await page.waitForFunction(() =>
    document.querySelector('#hub-nav-status')?.textContent?.includes('目次順・公開設定'),
  );
  assert.equal(savedNavPayload.length, 2);
  assert.equal(savedNavPayload[0].page, 'docs/guide.md');
  assert.equal(savedNavPayload[0].section, '導入ガイド');
  assert.equal(savedNavPayload[0].title, '最初に読むガイド');

  // Switch to audience export tab and verify single-html is available
  await page.click('#export-tab-audience');
  await page.waitForSelector('#hub-audience-pages .audience-page-row');
  const audienceEngines = await page.$$eval('#hub-audience-build-engine option', (els) =>
    els.map((e) => e.value),
  );
  assert.ok(audienceEngines.includes('single-html'));
  await page.locator('#site-export-dialog').getByRole('button', { name: '閉じる', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#site-export-dialog[open]'));

  // 3. 原稿チェック -> 用語集違反の一括置換（Diff確認・適用・元に戻す）
  await page.click('#reader-review');
  await page.waitForSelector('#quality-check');
  await page.click('#quality-check');
  await page.waitForSelector('#quality-glossary-batch-replace');
  await page.click('#quality-glossary-batch-replace');
  await page.waitForSelector('#glossary-batch-replace-dialog[open]');
  const batchRect = await page.locator('#glossary-batch-replace-dialog').boundingBox();
  assert.ok(batchRect && batchRect.width <= 1366 && batchRect.height <= 860, 'glossary-batch-replace-dialog fits viewport');

  // Apply batch replacement
  await page.click('#glossary-batch-replace-dialog button.primary');
  await page.waitForFunction(() =>
    document
      .querySelector('#glossary-batch-replace-dialog [role="status"]')
      ?.textContent?.includes('2原稿の用語集違反を一括置換しました'),
  );
  assert.ok(indexDoc.includes('フォルダーを開きます'));
  assert.ok(guideDoc.includes('別のフォルダーです'));

  // Undo batch replacement and verify rollback
  await page.click('#glossary-batch-replace-dialog button:has-text("直前の一括置換を元に戻す")');
  await page.waitForFunction(() =>
    document
      .querySelector('#glossary-batch-replace-dialog [role="status"]')
      ?.textContent?.includes('元に戻しました'),
  );
  assert.ok(indexDoc.includes('フォルダを開きます'));
  assert.ok(guideDoc.includes('別のフォルダです'));
  await page.locator('#glossary-batch-replace-dialog').getByRole('button', { name: '閉じる', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#glossary-batch-replace-dialog[open]'));
  await page.keyboard.press('Escape');

  // 4. 撮影リソース一覧Dock -> 未使用を整理（キャンセル確認 + 実行確認）
  await page.locator('#flexlayout-tabbutton-capture-resources').click();
  await page.waitForSelector('#capture-resource-cleanup-btn');
  const cleanupText = await page.textContent('#capture-resource-cleanup-btn');
  assert.ok(cleanupText.includes('未使用を整理 (1)'), `Unexpected label: ${cleanupText}`);

  // First cancel
  await page.click('#capture-resource-cleanup-btn');
  await page.waitForSelector('dialog[data-confirm-action][open]');
  await page.click('dialog[data-confirm-action] button:has-text("キャンセル")');
  assert.equal(cleanupCalled, 0);

  // Then confirm cleanup
  await page.click('#capture-resource-cleanup-btn');
  await page.waitForSelector('dialog[data-confirm-action][open]');
  await page.click('dialog[data-confirm-action] button:has-text("未使用を整理する")');
  await page.waitForFunction(() => {
    const btn = document.querySelector('#capture-resource-cleanup-btn');
    return btn && btn.disabled === true;
  });
  assert.equal(cleanupCalled, 1);

  // Restore trash button must appear; test cancel then confirm restore
  await page.waitForSelector('#capture-resource-restore-trash-btn:not([hidden])');
  const restoreLabel = await page.textContent('#capture-resource-restore-trash-btn');
  assert.ok(restoreLabel.includes('整理を戻す (1)'), `Unexpected restore label: ${restoreLabel}`);

  await page.click('#capture-resource-restore-trash-btn');
  await page.waitForSelector('dialog[data-confirm-action][open]');
  await page.click('dialog[data-confirm-action] button:has-text("キャンセル")');
  assert.equal(restoreTrashCalled, 0);

  await page.click('#capture-resource-restore-trash-btn');
  await page.waitForSelector('dialog[data-confirm-action][open]');
  await page.click('dialog[data-confirm-action] button:has-text("元に戻す")');
  await page.waitForFunction(() => {
    const restoreBtn = document.querySelector('#capture-resource-restore-trash-btn');
    const cleanBtn = document.querySelector('#capture-resource-cleanup-btn');
    return restoreBtn?.hidden === true && cleanBtn?.disabled === false;
  });
  assert.equal(restoreTrashCalled, 1);

  assert.deepEqual(errors, [], `Page errors: ${errors.join('\n')}`);
  console.log('ALL PUBLICATION / NAV / GLOSSARY-BATCH / CLEANUP UI TESTS PASSED');
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
