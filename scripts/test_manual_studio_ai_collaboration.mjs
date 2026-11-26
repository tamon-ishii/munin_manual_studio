import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:5189';
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
      '5189',
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
      mkdocs: { site_name: 'Test', theme: 'material', language: 'ja', use_directory_urls: true },
    },
    brief: '',
    pages: ['index.md', 'guide.md'],
    project_entries: [
      { path: 'docs/index.md', directory: false },
      { path: 'docs/guide.md', directory: false },
    ],
    image_assets: {},
    agents: [
      { id: 'codex', label: 'Codex', available: true },
      { id: 'claude', label: 'Claude', available: true },
      { id: 'agy', label: 'Agy', available: true },
    ],
  };

  let glossary = { version: 1, terms: [] };
  let docText = '# 使い方\n\n![画面](assets/step.png)\n\nフォルダを選びます。\n';
  let revision = 'r1';
  const ptyWrites = [];
  const snapshotApplies = [];
  let snapshotCreated = 0;
  let snapshotCleared = 0;
  let externalChanges = [];
  const savedAudiences = [];
  let audienceBuilt = 0;
  const createdPages = [];

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
        output = { items: [] };
        break;
      case 'editor-read':
        output = { page: req.options.page, content: docText, revision };
        break;
      case 'editor-read-if-changed':
        output = null;
        break;
      case 'editor-save':
        if (req.options.page && req.options.page !== 'index.md') {
          createdPages.push({ page: req.options.page, content: req.options.json.content });
          if (!state.pages.includes(req.options.page)) {
            state.pages.push(req.options.page);
            state.project_entries.push({ path: `docs/${req.options.page}`, directory: false });
          }
          output = { page: req.options.page, content: req.options.json.content, revision: 'r1' };
        } else {
          docText = req.options.json.content;
          revision = `r${Number(revision.slice(1)) + 1}`;
          output = { page: req.options.page, content: docText, revision };
        }
        break;
      case 'image-generation-settings':
        output = { connection_type: 'none', endpoint_url: '', model: '' };
        break;
      case 'preview-page':
        output = '<html><body>Preview</body></html>';
        break;
      case 'preview-asset':
        output = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0e0AAAAASUVORK5CYII=';
        break;
      case 'agent-progress':
        output = { logs: [], total: 0 };
        break;
      case 'glossary-read':
        output = glossary;
        break;
      case 'glossary-save': {
        const terms = (req.options.json.terms || []).map((t, idx) => ({
          ...t,
          id: t.id || `term-${idx + 1}`,
        }));
        glossary = { version: 1, terms };
        output = glossary;
        break;
      }
      case 'glossary-uimap-candidates':
        output = {
          scanned_images: 1,
          candidates: [
            {
              name: '撮影するアプリを登録',
              roles: ['button'],
              sources: ['docs/assets/step.png'],
              count: 2,
              registered: glossary.terms.some((t) => t.preferred === '撮影するアプリを登録'),
            },
          ],
        };
        break;
      case 'quality-check': {
        const folderIdx = docText.indexOf('フォルダ');
        const noteMatch = /<!--\s*ai-note\s*:\s*([\s\S]*?)\s*-->/.exec(docText);
        const issues = [
          {
            page: 'docs/index.md',
            kind: 'annotation_step_mismatch',
            severity: 'warning',
            line: 3,
            start: docText.indexOf('![画面]'),
            end: docText.indexOf('![画面]') + '![画面](assets/step.png)'.length,
            snippet: '![画面](assets/step.png)',
            message: '画像の注釈番号 ②（対象:「保存」）が直後の本文に言及されていません。',
            details: {
              image: 'docs/assets/step.png',
              image_steps: [1, 2],
              text_steps: [1],
              missing_in_text: [2],
            },
          },
        ];
        if (folderIdx >= 0 && !docText.slice(folderIdx, folderIdx + 5).startsWith('フォルダー')) {
          issues.push({
            page: 'docs/index.md',
            kind: 'glossary_violation',
            severity: 'warning',
            line: 5,
            start: folderIdx,
            end: folderIdx + 4,
            snippet: 'フォルダ',
            message: '用語集の表記ルール: 「フォルダ」は「フォルダー」に統一してください。',
            details: { preferred: 'フォルダー', matched: 'フォルダ', category: 'style' },
          });
        }
        if (noteMatch) {
          issues.push({
            page: 'docs/index.md',
            kind: 'unresolved_ai_note',
            severity: 'warning',
            line: docText.slice(0, noteMatch.index).split('\n').length,
            start: noteMatch.index,
            end: noteMatch.index + noteMatch[0].length,
            snippet: noteMatch[0],
            message: `未解決のAIメモが残っています: ${noteMatch[1].trim()}`,
            details: { note: noteMatch[1].trim() },
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
      case 'terminal-prepare':
        output = { prompt: 'Read guide.md' };
        break;
      case 'pty-spawn':
        output = { session_id: 'term-1' };
        break;
      case 'pty-read':
        output = { data: '', alive: true };
        break;
      case 'pty-write':
        ptyWrites.push(req.options.data);
        output = { ok: true };
        break;
      case 'pty-kill':
      case 'pty-close-owner':
        output = { ok: true };
        break;
      case 'external-snapshot-create':
        snapshotCreated++;
        output = { session_id: `snap-${snapshotCreated}`, file_count: 2 };
        break;
      case 'external-snapshot-diff':
        output = { session_id: req.options.id, changes: externalChanges };
        break;
      case 'external-snapshot-apply':
        snapshotApplies.push(req.options);
        externalChanges = externalChanges.filter((c) => c.page !== req.options.page);
        output = { page: req.options.page, applied: true, deleted: req.options.content === null };
        break;
      case 'external-snapshot-clear':
        snapshotCleared++;
        externalChanges = [];
        output = { cleared: true };
        break;
      case 'project-dashboard':
        output = {
          total_pages: 2,
          total_errors: 0,
          total_warnings: 1,
          diagnostics: [
            {
              kind: 'orphan_page',
              severity: 'warning',
              pages: ['docs/guide.md'],
              message: '「docs/guide.md」は他のどのページからもリンクされていません（孤立ページ）。',
            },
          ],
          pages: [
            {
              page: 'docs/index.md',
              title: '使い方',
              audiences: ['user'],
              char_count: 80,
              heading_count: 1,
              image_count: 1,
              incoming_count: 0,
              error_count: 0,
              warning_count: 1,
              ai_note_count: 1,
            },
            {
              page: 'docs/guide.md',
              title: 'ガイド',
              audiences: [],
              char_count: 60,
              heading_count: 1,
              image_count: 0,
              incoming_count: 0,
              error_count: 0,
              warning_count: 0,
              ai_note_count: 0,
            },
          ],
        };
        break;
      case 'page-audience-save':
        savedAudiences.push(req.options);
        output = { page: req.options.page, audiences: req.options.audiences };
        break;
      case 'build-audience':
        audienceBuilt++;
        output = { audience: req.options.audience, output: `site-${req.options.audience}`, summary: 'ok' };
        break;
      case 'manuscript-fact-check':
        output = {
          page: req.options.page,
          indexed_source_files: 12,
          indexed_uimap_labels: 4,
          supported: 1,
          unverified: 1,
          findings: [
            {
              kind: 'code_token',
              claim: '--studio-tools',
              verdict: 'supported',
              line: 3,
              evidence: { source_type: 'source', location: 'src/main.rs:10', excerpt: 'const FLAG = "--studio-tools";' },
            },
            {
              kind: 'ui_label',
              claim: '存在しない設定',
              verdict: 'unverified',
              line: 5,
              evidence: null,
            },
          ],
        };
        break;
      case 'app-impact-analyze':
        output = {
          changed_files: ['src/settings.ts'],
          impacted_pages: [
            {
              page: 'docs/index.md',
              score: 6,
              reasons: ['変更されたUI文言・識別子と一致: 保存'],
              matched_lines: [{ line: 3, token: '保存' }],
            },
          ],
          impacted_screenshots: [
            { resource_id: 'res-1', name: '設定画面', matched_ui_elements: ['保存'] },
          ],
        };
        break;
      case 'operation-draft-sources':
        output = {
          items: [
            {
              resource_id: 'res-1',
              name: '設定画面',
              has_script: true,
              has_operations: true,
              has_annotations: true,
              uimap_elements: 3,
            },
          ],
        };
        break;
      case 'operation-draft-generate':
        output = {
          markdown: '## 設定手順\n\n1. 「**設定**」ボタンをクリックします。\n',
          source_kind: 'operation_script',
          step_count: 1,
          uimap_elements: 3,
          image: 'docs/assets/step.png',
          ai_refined: false,
        };
        break;
      case 'derivative-generate':
        output = {
          kind: req.options.kind,
          suggested_page: 'faq.md',
          source_pages: req.options.pages,
          markdown: '# FAQ\n\n## 使い方\n\n### Q. よくある質問\n\n回答です。\n',
          ai_refined: false,
        };
        break;
      case 'translation-diff-plan':
        output = {
          source_page: req.options.source_page,
          target_page: req.options.target_page,
          target_language: req.options.target_language || 'English',
          base_ref: req.options.base_ref || 'HEAD~1',
          has_git_diff: true,
          git_diff: '@@ -1 +1 @@\n-古い説明\n+新しい説明',
          changed_headings: ['## 使い方'],
          target_before: '# Guide\n',
          proposed_after: null,
          handoff_prompt: '基準言語の差分だけを翻訳先へ反映してください。',
        };
        break;
      default:
        output = {};
    }
    await route.fulfill({
      json: { output: typeof output === 'string' ? output : JSON.stringify(output) },
    });
  });

  await page.goto(base + '/?root=collab-project');
  await page.waitForFunction(
    () =>
      document.body.getAttribute('aria-busy') === 'false' &&
      document.querySelector('#save-page') &&
      !document.querySelector('#save-page').disabled,
  );

  // 1. Glossary settings: add term, import from UIMap, search, edit, close
  await page.locator('#application-settings').click();
  await page.locator('#settings-tab-glossary').click();
  const glossaryCheckRow = await page.evaluate(() => {
    const label = document.querySelector('#glossary-case-sensitive')?.closest('label');
    return label ? getComputedStyle(label).flexDirection : null;
  });
  assert.equal(glossaryCheckRow, 'row', 'glossary checkbox label must render horizontally');
  await page.locator('#glossary-preferred').fill('フォルダー');
  await page.locator('#glossary-category').selectOption('style');
  await page.locator('#glossary-avoid').fill('フォルダ, ディレクトリ');
  await page.locator('#glossary-note').fill('長音ありで統一');
  await page.locator('#glossary-submit-btn').click();
  await page.locator('#glossary-list .glossary-row').filter({ hasText: 'フォルダー' }).waitFor();
  assert.equal(glossary.terms.length, 1);

  await page.locator('#glossary-import-uimap').click();
  const uimapItem = page.locator('#glossary-uimap-panel .glossary-uimap-item').filter({ hasText: '撮影するアプリを登録' });
  await uimapItem.waitFor();
  await uimapItem.locator('input[type="checkbox"]').check();
  await page.locator('#glossary-uimap-panel button.primary').click();
  await page.locator('#glossary-list .glossary-row').filter({ hasText: '撮影するアプリを登録' }).waitFor();
  assert.equal(glossary.terms.length, 2);

  await page.locator('#glossary-search').fill('撮影');
  assert.equal(await page.locator('#glossary-list .glossary-row').count(), 1);
  await page.locator('#glossary-search').fill('');
  assert.equal(await page.locator('#glossary-list .glossary-row').count(), 2);
  await page.locator('[data-close-dialog="panel-settings"]').click();

  // 2. Insert AI Note via 原稿チェック dialog (cancel first, then insert)
  await page.locator('#reader-review').click();
  await page.getByRole('button', { name: 'AIメモを挿入', exact: true }).click();
  const noteDialog = page.locator('#ai-note-insert-dialog');
  await noteDialog.waitFor({ state: 'visible' });
  assert.equal(await noteDialog.getAttribute('data-dialog-size'), 'compact');
  await noteDialog.getByRole('button', { name: 'キャンセル', exact: true }).click();
  assert.equal(await noteDialog.isVisible(), false);
  assert.equal((await page.locator('#markdown-editor').inputValue()).includes('ai-note:'), false);

  await page.locator('#reader-review').click();
  await page.getByRole('button', { name: 'AIメモを挿入', exact: true }).click();
  await noteDialog.locator('textarea').fill('②の手順を追記する');
  await noteDialog.getByRole('button', { name: 'メモを挿入', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('<!-- ai-note: ②の手順を追記する -->'));
  // Rich mode AI notes banner must become visible
  await page.locator('#rich-ai-notes-banner').waitFor({ state: 'visible' });
  assert.match(await page.locator('#rich-ai-notes-banner').textContent(), /AIメモ 1件/);
  await page.locator('#save-page').click();
  await page.waitForFunction(() => document.querySelector('#save-state').textContent === '保存済み');

  // 3. Quality check: MarkIts annotation mismatch + glossary violation + unresolved ai-note
  await page.locator('#reader-review').click();
  await page.locator('#quality-check').click();
  await page.locator('.quality-summary').filter({ hasText: '警告 3件' }).waitFor();
  assert.equal(await page.locator('.quality-issue').count(), 3);

  // Filter by annotation
  await page.locator('.quality-filter-bar select').selectOption('annotation');
  assert.equal(await page.locator('.quality-issue').count(), 1);
  await page.locator('.quality-filter-bar select').selectOption('glossary');
  assert.equal(await page.locator('.quality-issue').count(), 1);

  // One-click glossary replacement
  await page.getByRole('button', { name: '「フォルダー」に置換', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('フォルダーを選びます。'));

  // Switch filter to annotation and open terminal handoff dialog, verify layout & copy fallback, then cancel
  await page.locator('.quality-filter-bar select').selectOption('annotation');
  await page.getByRole('button', { name: 'AIターミナルで補正', exact: true }).click();
  const handoffDialog = page.locator('#terminal-handoff-dialog');
  await handoffDialog.waitFor({ state: 'visible' });
  assert.equal(await handoffDialog.getAttribute('data-dialog-size'), null, 'handoff dialog must not be cramped to compact height');
  const checkboxLayout = await handoffDialog.evaluate(() => {
    const label = document.querySelector('#terminal-handoff-dialog label.setting-checkbox');
    const input = label.querySelector('input[type="checkbox"]');
    const span = label.querySelector('span');
    const style = getComputedStyle(label);
    const inRect = input.getBoundingClientRect();
    const textRect = span.getBoundingClientRect();
    return {
      flexDirection: style.flexDirection,
      inputWidth: inRect.width,
      sideBySide: textRect.left >= inRect.right - 2 && Math.abs(inRect.top - textRect.top) < 16,
    };
  });
  assert.equal(checkboxLayout.flexDirection, 'row', 'checkbox label must render horizontally');
  assert.ok(checkboxLayout.inputWidth <= 24, `checkbox width must stay compact, got ${checkboxLayout.inputWidth}`);
  assert.equal(checkboxLayout.sideBySide, true, 'checkbox and label text must sit side by side');
  assert.match(await handoffDialog.locator('textarea').inputValue(), /annotation_step_mismatch|注釈番号/);
  // Simulate unfocused parent document rejection on navigator.clipboard.writeText and verify fallback succeeds
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException('Document is not focused.', 'NotAllowedError')) },
    });
  });
  await handoffDialog.getByRole('button', { name: 'プロンプトをコピー', exact: true }).click();
  await handoffDialog.locator('.terminal-handoff-status').filter({ hasText: 'クリップボードにコピーしました。' }).waitFor();
  await handoffDialog.getByRole('button', { name: 'キャンセル', exact: true }).click();
  assert.equal(await handoffDialog.isVisible(), false);
  // Close quality check dialog
  await page.keyboard.press('Escape');

  // Save clean draft before external-change tray test
  await page.locator('#save-page').click();
  await page.waitForFunction(() => document.querySelector('#save-state').textContent === '保存済み');

  // 4. AI Terminal connection, snapshot creation, and context handoff (paste vs submit)
  await page.locator('#view-menu-button').click();
  await page.locator('#view-menu-dropdown').getByRole('checkbox', { name: 'AIターミナル' }).check();
  await page.locator('#view-menu-button').click();
  await page.locator('#terminal-container .xterm').waitFor();
  await page.locator('#terminal-connect-btn').click();
  await page.waitForFunction(() => document.querySelector('#terminal-badge').textContent.includes('接続中'));
  assert.equal(snapshotCreated, 1, 'terminal connection must create an external-change snapshot');

  // Send editor context (paste without Enter)
  await page.locator('#terminal-send-editor-btn').click();
  await handoffDialog.waitFor({ state: 'visible' });
  await handoffDialog.locator('textarea').fill('手順を簡潔にしてください');
  await handoffDialog.getByRole('button', { name: '入力欄に貼り付け', exact: true }).click();
  assert.equal(ptyWrites.length >= 1, true);
  const pasted = ptyWrites.at(-1);
  assert.match(pasted, /対象原稿: docs\/index\.md/);
  assert.match(pasted, /手順を簡潔にしてください/);
  assert.equal(pasted.endsWith('\r'), false, 'default handoff pastes without Enter');

  // Send AI notes manager batch to terminal with submit checked (button label updates to そのまま送信)
  await page.locator('#reader-review').click();
  await page.getByRole('button', { name: /AIメモ一覧・依頼/ }).click();
  const notesDialog = page.locator('#ai-notes-dialog');
  await notesDialog.waitFor({ state: 'visible' });
  await notesDialog.getByRole('button', { name: '選んだメモをAIターミナルへ依頼', exact: true }).click();
  await handoffDialog.waitFor({ state: 'visible' });
  await handoffDialog.locator('input[type="checkbox"]').check();
  await handoffDialog.getByRole('button', { name: 'そのまま送信', exact: true }).click();
  const submitted = ptyWrites.at(-1);
  assert.match(submitted, /②の手順を追記する/);
  assert.equal(submitted.endsWith('\r'), true, 'checked submit appends Enter');

  // 5. External change review tray
  externalChanges = [
    {
      page: 'docs/guide.md',
      status: 'modified',
      before: '# ガイド\n元の1行目\n共通行\n元の2行目',
      after: '# ガイド\nAIの1行目\n共通行\nAIの2行目',
      base_sha256: 'base1',
      current_sha256: 'cur1',
      added_lines: 2,
      removed_lines: 2,
    },
    {
      page: 'docs/new-page.md',
      status: 'added',
      before: '',
      after: '# 新規ページ\nAIが作成',
      base_sha256: '',
      current_sha256: 'cur2',
      added_lines: 2,
      removed_lines: 0,
    },
  ];
  // Trigger focus refresh
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const trayBtn = page.locator('#terminal-external-changes-btn');
  await trayBtn.waitFor({ state: 'visible' });
  assert.equal(await trayBtn.textContent(), '外部変更を確認 (2)');

  await trayBtn.click();
  const trayDialog = page.locator('#external-change-tray-dialog');
  await trayDialog.waitFor({ state: 'visible' });
  assert.equal(await trayDialog.locator('.external-tray-file-btn').count(), 2);

  // Uncheck the second diff hunk to keep the original second line while accepting the first hunk
  const hunkChecks = trayDialog.locator('[data-diff-part]');
  assert.equal(await hunkChecks.count(), 2);
  await hunkChecks.nth(1).uncheck();
  await trayDialog.getByRole('button', { name: '選んだ変更を確定', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#external-change-tray-dialog .external-tray-file-btn').length === 1);
  assert.equal(snapshotApplies.length, 1);
  assert.equal(snapshotApplies[0].page, 'docs/guide.md');
  assert.equal(snapshotApplies[0].expected_sha256, 'cur1');
  assert.equal(snapshotApplies[0].content, '# ガイド\nAIの1行目\n共通行\n元の2行目');

  // Approve all remaining and close tray
  await trayDialog.getByRole('button', { name: 'すべて承認してトレーを閉じる', exact: true }).click();
  await trayDialog.waitFor({ state: 'hidden' });
  assert.equal(snapshotCleared, 1);
  assert.equal(await trayBtn.isVisible(), false);

  // Verify dirty-page guard inside external change tray
  await page.locator('#markdown-editor').evaluate((el) => {
    el.value += '\n未保存の編集です。\n';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  externalChanges = [
    {
      page: 'docs/index.md',
      status: 'modified',
      before: '# 使い方\n元',
      after: '# 使い方\n外部変更',
      base_sha256: 'b2',
      current_sha256: 'c2',
      added_lines: 1,
      removed_lines: 1,
    },
  ];
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await trayBtn.waitFor({ state: 'visible' });
  await trayBtn.click();
  await trayDialog.waitFor({ state: 'visible' });
  await trayDialog.locator('.external-tray-warning').waitFor({ state: 'visible' });
  assert.equal(
    await trayDialog.getByRole('button', { name: '選んだ変更を確定', exact: true }).isDisabled(),
    true,
    'dirty page must disable direct overwrite from external change tray',
  );
  await page.keyboard.press('Escape');
  await trayDialog.waitFor({ state: 'hidden' });

  // 6. Goal-organized dialogs: HTML出力(読者別出力) / 原稿チェック(構成・裏取り・影響) / 原稿作成支援(操作記録・派生・多言語)
  // 6a. HTML出力 -> 読者別出力
  await page.locator('#site-export-open').click();
  const exportDialog = page.locator('#site-export-dialog');
  await exportDialog.waitFor({ state: 'visible' });
  await exportDialog.locator('#export-tab-audience').click();
  await exportDialog.locator('#hub-audience-status').filter({ hasText: '全 2 ページ' }).waitFor();
  const guideAudienceRow = exportDialog.locator('#hub-audience-pages .audience-page-row').nth(1);
  await guideAudienceRow.locator('select.audience-scope-select').selectOption('restricted');
  await guideAudienceRow.locator('input[type="checkbox"][value="user"]').check();
  await exportDialog.locator('#hub-audience-save-all').click();
  await exportDialog.locator('#hub-audience-status').filter({ hasText: '読者設定を保存しました' }).waitFor();
  assert.equal(savedAudiences.length, 1);
  assert.deepEqual(savedAudiences[0].audiences, ['user']);
  await exportDialog.locator('#hub-audience-build-btn').click();
  await exportDialog.locator('#hub-audience-status').filter({ hasText: 'site-user' }).waitFor();
  assert.equal(audienceBuilt, 1);
  await page.keyboard.press('Escape');
  await exportDialog.waitFor({ state: 'hidden' });

  // 6b. 原稿チェック -> ページ構成・孤立診断 / ソースとの裏取り / アプリ変更の影響
  await page.locator('#reader-review').click();
  const checkDialog = page.locator('#manuscript-check-dialog');
  await checkDialog.waitFor({ state: 'visible' });
  await checkDialog.locator('#check-tab-structure').click();
  await checkDialog.locator('#hub-dashboard-status').filter({ hasText: '全 2 ページ' }).waitFor();
  assert.equal(await checkDialog.locator('#hub-dashboard-diagnostics .ai-hub-card').count(), 1);

  await checkDialog.locator('#check-tab-fact-check').click();
  await checkDialog.locator('#hub-fact-run').click();
  await checkDialog.locator('#hub-fact-status').filter({ hasText: '根拠あり 1件 / 未確認 1件' }).waitFor();
  await checkDialog.locator('#hub-fact-filter').selectOption('unverified');
  assert.equal(await checkDialog.locator('#hub-fact-list .ai-hub-card').count(), 1);

  await checkDialog.locator('#check-tab-impact').click();
  await checkDialog.locator('#hub-impact-run').click();
  await checkDialog.locator('#hub-impact-status').filter({ hasText: '影響ページ 1件' }).waitFor();
  assert.equal(await checkDialog.locator('#hub-impact-list .ai-hub-card').count(), 2);
  await page.keyboard.press('Escape');
  await checkDialog.waitFor({ state: 'hidden' });

  // 6c. 原稿作成支援 -> 操作記録から手順書 / FAQ・要約を作成 / 多言語の差分翻訳
  await page.locator('#workspace-ai-hub-open').click();
  const hubDialog = page.locator('#ai-collab-hub-dialog');
  await hubDialog.waitFor({ state: 'visible' });
  await hubDialog.locator('#hub-rec-resource').selectOption('res-1');
  await hubDialog.locator('#hub-rec-generate').click();
  await hubDialog.locator('#hub-rec-preview').waitFor({ state: 'visible' });
  await hubDialog.locator('#hub-rec-insert').click();
  const diffDialog = page.locator('#selection-diff-dialog');
  await diffDialog.waitFor({ state: 'visible' });
  await diffDialog.getByRole('button', { name: '選んだ変更を反映', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('「**設定**」ボタンをクリックします。'));

  await page.locator('#workspace-ai-hub-open').click();
  await hubDialog.waitFor({ state: 'visible' });
  await hubDialog.locator('#ai-hub-tab-translation').click();
  await hubDialog.locator('#hub-trans-run').click();
  await hubDialog.locator('#hub-trans-diff').waitFor({ state: 'visible' });
  await hubDialog.locator('#ai-hub-tab-derivative').click();
  await hubDialog.locator('#hub-deriv-run').click();
  await hubDialog.locator('#hub-deriv-preview').waitFor({ state: 'visible' });
  await hubDialog.locator('#hub-deriv-create').click();
  await hubDialog.waitFor({ state: 'hidden' });
  assert.equal(createdPages.some((p) => p.page === 'faq.md'), true);

  assert.deepEqual(errors, []);
  console.log('AI collaboration UI E2E checks passed.');
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
