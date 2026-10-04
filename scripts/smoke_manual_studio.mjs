import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

// Run against `npm run manual:dev` after building manualctl.
const base = process.env.MANUAL_STUDIO_URL || 'http://127.0.0.1:5174';
const root = await mkdtemp(path.join(os.tmpdir(), 'manual-studio-smoke-'));
let browser;
let server;
try {
  if (process.argv.includes('--start-server')) {
    server = spawn(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), '--config', 'apps/manual-studio/vite.config.ts'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let diagnostics = '';
    let failed = false;
    server.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8000); });
    server.on('error', error => { failed = true; diagnostics += error.message; });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failed || server.exitCode !== null) throw new Error(`Development server failed: ${diagnostics}`);
      try { ready = (await fetch(base)).ok; } catch { /* Server is still starting. */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, `Development server did not start: ${diagnostics}`);
  }
  await mkdir(path.join(root, 'docs'));
  await mkdir(path.join(root, 'docs/assets'));
  await mkdir(path.join(root, 'docs/z-guide'));
  await mkdir(path.join(root, 'notes'));
  await mkdir(path.join(root, 'empty'));
  await writeFile(path.join(root, 'notes/extra.md'), '# Project note\n');
  await writeFile(path.join(root, 'project.txt'), 'Project root file\n');
  await writeFile(path.join(root, 'docs/assets/preview.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  await writeFile(path.join(root, 'docs/index.md'), '# Smoke guide\n\nOriginal text\n\n![Preview](assets/preview.png)\n\n<img src="assets/preview.png" alt="HTML preview">\n');
  await writeFile(path.join(root, 'docs/z-guide/intro.md'), '# Nested guide\n');
  await writeFile(path.join(root, 'docs/z-guide/diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const secondProject = path.join(root, 'second-project');
  await mkdir(path.join(secondProject, 'docs'), { recursive: true });
  await writeFile(path.join(secondProject, 'docs/only.md'), '# Second project document\n');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    localStorage.setItem('manual-studio-sidebar-width', 'Infinity');
    localStorage.setItem('manual-studio-editor-ratio', 'NaN');
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Expose private async entry points only in this smoke run to force request races.
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({ response, body: `${source}\nwindow.__manualStudioRaceTest = { openPage, openProject, saveDocument, refreshWorkspace, get documentState() { return documentState; } };\n` });
  });
  const idle = async (target = page) => {
    await target.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  };
  const awaitRpcObserved = (promise, label, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  await page.goto(`${base}/?root=${encodeURIComponent(root)}`);
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('Original text'));
  await idle();
  const initialPaneValues = await page.evaluate(() => ({
    sidebarWidth: Number.parseFloat(document.querySelector('#app-layout').style.getPropertyValue('--sidebar-width')),
    editorRatio: Number(document.querySelector('#editor-resizer').dataset.ratio),
  }));
  assert.ok(Number.isFinite(initialPaneValues.sidebarWidth), 'invalid saved sidebar width must use a finite default');
  assert.ok(Number.isFinite(initialPaneValues.editorRatio), 'invalid saved editor ratio must use a finite default');
  assert.equal(await page.locator('#generate-page').innerText(), 'この文書のAIタグを更新');
  const editorHeight = await page.locator('#markdown-editor').evaluate(node => node.clientHeight);
  assert.ok(editorHeight > 400, `editor must preserve vertical room: ${editorHeight}px`);
  const setTagPosition = async position => {
    await page.locator('[data-tab="appearance"]').click();
    await page.locator('#document-tags-position').selectOption(position);
    await page.locator('[data-tab="editor"]').click();
  };
  await setTagPosition('left');
  let paneBounds = await page.locator('#document-tags-pane').boundingBox();
  let splitBounds = await page.locator('.editor-split').boundingBox();
  assert.ok(paneBounds.x < splitBounds.x, 'left dock places tags before editor');
  await setTagPosition('right');
  paneBounds = await page.locator('#document-tags-pane').boundingBox();
  splitBounds = await page.locator('.editor-split').boundingBox();
  assert.ok(paneBounds.x >= splitBounds.x + splitBounds.width, 'right dock places tags after editor');
  const tagHandle = page.locator('#document-tags-handle strong');
  const tagHandleBounds = await tagHandle.boundingBox();
  await page.mouse.move(tagHandleBounds.x + 15, tagHandleBounds.y + 7);
  await page.mouse.down();
  await page.mouse.move(tagHandleBounds.x - 90, tagHandleBounds.y + 90, { steps: 5 });
  await page.mouse.up();
  assert.equal(await page.locator('#document-tags-position').inputValue(), 'floating', 'drag detaches the tags pane');
  assert.equal(await page.locator('#document-tags-pane').evaluate(node => getComputedStyle(node).position), 'fixed');
  await setTagPosition('right');
  assert.equal(await page.locator('#document-tags-pane select, #document-tags-collapse, [data-open-all-tags]').count(), 0, 'tag pane has no placement, collapse, or all-tags controls');
  await page.screenshot({ path: '/tmp/munin-editor-layout.png' });

  for (const handleId of ['sidebar-resizer', 'editor-resizer']) {
    const handle = page.locator(`#${handleId}`);
    await handle.evaluate(node => {
      window.__smokePointerId = null;
      node.addEventListener('pointerdown', event => { window.__smokePointerId = event.pointerId; }, { once: true });
    });
    const bounds = await handle.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.waitForFunction(() => document.body.classList.contains('pane-resizing'));
    await page.evaluate(handleId => {
      const target = document.getElementById(handleId);
      target.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: window.__smokePointerId }));
    }, handleId);
    await page.waitForFunction(() => !document.body.classList.contains('pane-resizing'));
    await page.mouse.up();
  }
  assert.equal(await page.locator('#panel-editor').isVisible(), true);
  await page.waitForFunction(() => {
    const images = [...(document.querySelector('#markdown-preview').contentDocument?.querySelectorAll('img') || [])];
    return images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0);
  });
  const originalMarkdown = await readFile(path.join(root, 'docs/index.md'), 'utf8');
  await page.locator('#markdown-editor').evaluate(node => {
    const start = node.value.indexOf('Original text');
    node.setSelectionRange(start, start + 'Original text'.length);
  });
  await page.locator('[data-format="bold"]').click();
  assert.match(await page.locator('#markdown-editor').inputValue(), /\*\*Original text\*\*/);
  await page.frameLocator('#markdown-preview').locator('strong').filter({ hasText: 'Original text' }).waitFor();
  assert.equal(await page.locator('#undo-edit').isEnabled(), true);
  await page.locator('#undo-edit').click();
  assert.equal(await page.locator('#markdown-editor').inputValue(), originalMarkdown);
  assert.equal(await page.locator('#redo-edit').isEnabled(), true);
  await page.locator('#redo-edit').click();
  assert.match(await page.locator('#markdown-editor').inputValue(), /\*\*Original text\*\*/);
  await page.locator('#markdown-editor').press('Control+z');
  assert.equal(await page.locator('#markdown-editor').inputValue(), originalMarkdown);
  await page.locator('#markdown-editor').press('Control+y');
  assert.match(await page.locator('#markdown-editor').inputValue(), /\*\*Original text\*\*/);
  await page.locator('#undo-edit').click();
  await page.locator('[data-format="italic"]').click();
  assert.equal(await page.locator('#redo-edit').isEnabled(), false);
  await page.locator('#markdown-editor').fill(originalMarkdown);
  await page.locator('#markdown-editor').evaluate(node => {
    const start = node.value.indexOf('Original text');
    node.setSelectionRange(start, start + 'Original text'.length);
  });
  await page.locator('[data-format="link"]').click();
  assert.match(await page.locator('#markdown-editor').inputValue(), /\[Original text\]\(https:\/\/example\.com\)/);
  assert.equal(await page.locator('#markdown-editor').evaluate(node => node.value.slice(node.selectionStart, node.selectionEnd)), 'https://example.com');
  await page.locator('#markdown-editor').fill(originalMarkdown);
  await page.locator('#markdown-editor').evaluate(node => node.setSelectionRange(node.value.length, node.value.length));
  await page.locator('[data-format="table"]').click();
  const tableDialog = page.locator('#markdown-table-dialog');
  await tableDialog.waitFor({ state: 'visible' });
  await tableDialog.getByRole('textbox', { name: '行1・列1', exact: true }).fill('名前 | 種別');
  await tableDialog.getByRole('textbox', { name: '行1・列2', exact: true }).fill('説明');
  await tableDialog.getByRole('combobox', { name: '列2の配置' }).selectOption('center');
  await tableDialog.locator('[data-table-add-row]').click();
  await tableDialog.locator('[data-table-add-column]').click();
  await tableDialog.getByRole('textbox', { name: '見出し・列3', exact: true }).fill('備考');
  await tableDialog.locator('button[type="submit"]').click();
  assert.match(await page.locator('#markdown-editor').inputValue(), /\| 項目 \| 内容 \| 備考 \|\n\| --- \| :---: \| --- \|/);
  await page.frameLocator('#markdown-preview').locator('table').waitFor();
  await page.locator('#markdown-editor').evaluate(node => { const start = node.value.indexOf('| 項目'); node.setSelectionRange(start, start); });
  await page.locator('[data-format="table"]').click();
  assert.equal(await tableDialog.getByRole('textbox', { name: '行1・列1', exact: true }).inputValue(), '名前 | 種別');
  await tableDialog.getByRole('button', { name: '行3を削除', exact: true }).click();
  await tableDialog.getByRole('button', { name: '列3を削除', exact: true }).click();
  await tableDialog.locator('button[type="submit"]').click();
  assert.equal((await page.locator('#markdown-editor').inputValue()).includes('備考'), false);
  await page.locator('#undo-edit').click();
  assert.equal((await page.locator('#markdown-editor').inputValue()).includes('備考'), true);
  await page.locator('[data-format="table"]').click();
  await tableDialog.locator('[data-table-cancel]').click();
  await page.locator('#markdown-editor').fill(originalMarkdown);
  assert.equal(await page.locator('#page-list [data-page="docs/index.md"]').count(), 1);
  assert.equal(await page.locator('#page-list .tree-static[title="project.txt"]').count(), 1);
  assert.equal(await page.locator('#page-list [data-page="docs/z-guide/intro.md"]').count(), 1);
  await page.locator('#page-list details[data-folder="notes"] summary').click();
  await page.locator('#page-list [data-page="notes/extra.md"]').click();
  await page.waitForFunction(() => document.querySelector('#unsaved-changes-dialog') || document.body.getAttribute('aria-busy') === 'false');
  if (await page.locator('#unsaved-changes-dialog').count()) await page.locator('[data-unsaved-action=discard]').click();
  await idle();
  assert.match(await page.locator('#markdown-editor').inputValue(), /Project note/);
  assert.equal(await page.locator('#undo-edit').isEnabled(), false);
  const originalNote = await page.locator('#markdown-editor').inputValue();
  await page.locator('#markdown-editor').fill(originalNote + '\nUnsaved dialog check\n');
  await page.locator('#page-list [data-page="docs/index.md"]').click();
  assert.equal(await page.locator('#unsaved-changes-dialog button').count(), 3);
  await page.locator('[data-unsaved-action=cancel]').click();
  await idle();
  assert.match(await page.locator('#markdown-editor').inputValue(), /Unsaved dialog check/);
  assert.equal(await readFile(path.join(root, 'notes/extra.md'), 'utf8'), originalNote);
  await page.locator('#page-list [data-page="docs/index.md"]').click();
  await page.locator('[data-unsaved-action=save]').click();
  await idle();
  assert.match(await readFile(path.join(root, 'notes/extra.md'), 'utf8'), /Unsaved dialog check/);
  await page.locator('#page-list [data-page="notes/extra.md"]').click();
  await idle();
  await page.locator('#markdown-editor').fill('This change must be discarded');
  await page.locator('#page-list [data-page="docs/index.md"]').click();
  await page.locator('[data-unsaved-action=discard]').click();
  await idle();
  assert.match(await readFile(path.join(root, 'notes/extra.md'), 'utf8'), /Unsaved dialog check/);
  await page.locator('#page-list [data-page="docs/index.md"]').click();
  await idle();
  await page.locator('#page-list details[data-folder="docs/z-guide"] summary').click();
  assert.equal(await page.locator('#page-list .tree-static[title="docs/z-guide/diagram.svg"]').count(), 1);
  await page.locator('#page-list [data-page="docs/z-guide/intro.md"]').click();
  await idle();
  assert.match(await page.locator('#markdown-editor').inputValue(), /Nested guide/);
  await page.locator('#page-list [data-page="docs/index.md"]').click();
  await idle();
  await page.locator('#open-existing-workspace').click();
  await page.locator('#project-root').fill(path.join(root, 'docs'));
  await page.locator('#project-form button[type="submit"]').click();
  await idle();
  assert.equal(await page.locator('#project-root').inputValue(), path.join(root, 'docs'));
  assert.equal(await page.locator('#page-list [data-page="index.md"]').count(), 1);
  await page.locator('#open-existing-workspace').click();
  await page.locator('#project-root').fill(root);
  await page.locator('#project-form button[type="submit"]').click();
  await idle();
  await page.locator('#workspace-name').click();
  const historyDialog = page.locator('#workspace-history-dialog');
  await historyDialog.waitFor();
  const historyRoots = await historyDialog.locator('[data-workspace-root]').evaluateAll(buttons => buttons.map(button => button.dataset.workspaceRoot));
  assert.deepEqual(historyRoots.slice(0, 2), [root, path.join(root, 'docs')]);
  assert.equal(new Set(historyRoots).size, historyRoots.length);
  await historyDialog.locator('[data-workspace-root]').nth(1).click();
  await idle();
  assert.equal(await page.locator('#project-root').inputValue(), path.join(root, 'docs'));
  await page.locator('#workspace-name').click();
  await page.locator('#workspace-history-dialog [data-workspace-root]').nth(1).click();
  await idle();
  assert.equal(await page.locator('#project-root').inputValue(), root);
  await assert.rejects(readFile(path.join(root, 'manual_setting.json'), 'utf8'), { code: 'ENOENT' });
  let releaseOldRead;
  let oldReadStarted;
  const oldReadGate = new Promise(resolve => { releaseOldRead = resolve; });
  const oldReadObserved = new Promise(resolve => { oldReadStarted = resolve; });
  let holdOldDocumentRead = true;
  await page.route('**/__manual/rpc', async route => {
    const request = route.request().postDataJSON();
    if (holdOldDocumentRead && request.action === 'editor-read' && request.root === root && request.options.page === 'docs/index.md') {
      holdOldDocumentRead = false;
      oldReadStarted();
      await oldReadGate;
    }
    await route.continue();
  });
  await page.evaluate(() => {
    window.__oldDocumentRead = window.__manualStudioRaceTest.openPage('docs/index.md', false);
  });
  await awaitRpcObserved(oldReadObserved, 'delayed old editor-read');
  await page.evaluate(() => {
    window.__newDocumentRead = window.__manualStudioRaceTest.openPage('docs/z-guide/intro.md', false);
  });
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('Nested guide'));
  releaseOldRead();
  await page.evaluate(() => Promise.all([window.__oldDocumentRead, window.__newDocumentRead]));
  assert.match(await page.locator('#markdown-editor').inputValue(), /Nested guide/);

  let releaseOldProject;
  let oldProjectStarted;
  const oldProjectGate = new Promise(resolve => { releaseOldProject = resolve; });
  const oldProjectObserved = new Promise(resolve => { oldProjectStarted = resolve; });
  let holdOldProjectState = true;
  await page.unroute('**/__manual/rpc');
  await page.route('**/__manual/rpc', async route => {
    const request = route.request().postDataJSON();
    if (holdOldProjectState && request.action === 'state' && request.root === root) {
      holdOldProjectState = false;
      oldProjectStarted();
      await oldProjectGate;
    }
    await route.continue();
  });
  await page.evaluate(() => {
    const oldRoot = decodeURIComponent(new URLSearchParams(window.location.search).get('root'));
    window.__oldProjectRead = window.__manualStudioRaceTest.openProject(oldRoot);
  });
  await awaitRpcObserved(oldProjectObserved, 'delayed old project state');
  await page.evaluate(secondRoot => {
    window.__newProjectRead = window.__manualStudioRaceTest.openProject(secondRoot);
  }, secondProject);
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('Second project document'));
  releaseOldProject();
  await page.evaluate(() => Promise.all([window.__oldProjectRead, window.__newProjectRead]));
  assert.match(await page.locator('#markdown-editor').inputValue(), /Second project document/);
  assert.equal(await page.locator('#tree-root-label').innerText(), 'second-project');
  await page.unroute('**/__manual/rpc');
  await page.evaluate(originalRoot => window.__manualStudioRaceTest.openProject(originalRoot), root);
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('Original text'));
  await idle();

  // A late save response must not replace the editor state after navigation.
  const oldSavePage = await page.evaluate(() => window.__manualStudioRaceTest.documentState.page);
  const newerPage = await page.locator('#page-list [data-page]').evaluateAll(nodes => nodes.map(node => node.dataset.page).find(candidate => candidate?.endsWith('/intro.md')));
  assert.ok(newerPage, 'fixture project must expose its nested guide page');
  await page.locator('#markdown-editor').fill('# Save response from old document\n');
  let releaseOldSave;
  let oldSaveStarted;
  const oldSaveGate = new Promise(resolve => { releaseOldSave = resolve; });
  const oldSaveObserved = new Promise(resolve => { oldSaveStarted = resolve; });
  let holdOldSave = true;
  await page.route('**/__manual/rpc', async route => {
    const request = route.request().postDataJSON();
    if (holdOldSave && request.action === 'editor-save' && request.root === root && request.options.page === oldSavePage) {
      holdOldSave = false;
      oldSaveStarted();
      await oldSaveGate;
    }
    await route.continue();
  });
  await page.evaluate(() => {
    window.__oldSaveResponse = window.__manualStudioRaceTest.saveDocument(false);
  });
  await awaitRpcObserved(oldSaveObserved, 'delayed old editor-save');
  await page.evaluate(pagePath => window.__manualStudioRaceTest.openPage(pagePath, false), newerPage);
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('Nested guide'));
  const nestedRevision = await page.evaluate(() => window.__manualStudioRaceTest.documentState.revision);
  releaseOldSave();
  await page.evaluate(() => window.__oldSaveResponse);
  assert.match(await page.locator('#markdown-editor').inputValue(), /Nested guide/);
  assert.equal(await page.locator('#editor-title').innerText(), newerPage);
  assert.equal(await page.evaluate(() => window.__manualStudioRaceTest.documentState.revision), nestedRevision);
  await page.unroute('**/__manual/rpc');

  // A refresh response cannot discard edits made while its document read waits.
  await page.evaluate(pagePath => window.__manualStudioRaceTest.openPage(pagePath, false), oldSavePage);
  let releaseRefreshRead;
  let refreshReadStarted;
  const refreshReadGate = new Promise(resolve => { releaseRefreshRead = resolve; });
  const refreshReadObserved = new Promise(resolve => { refreshReadStarted = resolve; });
  let holdRefreshRead = true;
  await page.route('**/__manual/rpc', async route => {
    const request = route.request().postDataJSON();
    if (holdRefreshRead && request.action === 'editor-read' && request.root === root && request.options.page === oldSavePage) {
      holdRefreshRead = false;
      refreshReadStarted();
      await refreshReadGate;
    }
    await route.continue();
  });
  await page.evaluate(() => {
    window.__pendingWorkspaceRefresh = window.__manualStudioRaceTest.refreshWorkspace(true);
  });
  await awaitRpcObserved(refreshReadObserved, 'refresh editor-read');
  await page.locator('#markdown-editor').fill('# User edit during refresh\n');
  releaseRefreshRead();
  await page.evaluate(() => window.__pendingWorkspaceRefresh);
  assert.equal(await page.locator('#markdown-editor').inputValue(), '# User edit during refresh\n');
  assert.match(await page.locator('#save-state').innerText(), /未保存/);
  await page.unroute('**/__manual/rpc');

  const longDraft = Array.from({ length: 120 }, (_, index) => `Paragraph ${index + 1}: scroll synchronization check.\n\n`).join('');
  await page.locator('#markdown-editor').fill(`# Long draft\n\n${longDraft}`);
  await page.frameLocator('#markdown-preview').locator('body').filter({ hasText: 'Paragraph 120' }).waitFor();
  await page.locator('#markdown-editor').evaluate(node => {
    node.scrollTop = (node.scrollHeight - node.clientHeight) * 0.65;
    node.dispatchEvent(new Event('scroll'));
  });
  await page.waitForFunction(() => {
    const preview = document.querySelector('#markdown-preview').contentDocument?.scrollingElement;
    return preview && preview.scrollTop > 0 && preview.scrollTop / (preview.scrollHeight - preview.clientHeight) > 0.5;
  });
  await page.frameLocator('#markdown-preview').locator('body').evaluate(node => {
    const scroller = node.ownerDocument.scrollingElement;
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * 0.25;
    node.ownerDocument.defaultView.dispatchEvent(new Event('scroll'));
  });
  await page.waitForFunction(() => {
    const editor = document.querySelector('#markdown-editor');
    const ratio = editor.scrollTop / (editor.scrollHeight - editor.clientHeight);
    return ratio > 0.15 && ratio < 0.35;
  });
  await page.locator('#markdown-editor').fill('# Edited guide\n\n**Saved content**\n');
  await page.locator('#save-page').click();
  await idle();
  assert.match(await readFile(path.join(root, 'docs/index.md'), 'utf8'), /Saved content/);
  await page.frameLocator('#markdown-preview').locator('strong').waitFor();
  await page.locator('[data-tab="tasks"]').click();
  assert.equal(await page.locator('#generate-all-pages').count(), 1);
  await page.locator('[data-tab="publish"]').click();
  assert.ok(['codex', 'claude', 'grok', 'agy'].includes(await page.locator('#ai-agent').inputValue()));
  // Saving a choice does not require running that CLI on the smoke machine.
  await page.locator('#ai-agent option[value="claude"]').evaluate(node => { node.disabled = false; });
  await page.locator('#ai-agent').selectOption('claude');
  await page.waitForFunction(() => document.querySelector('#ai-save-state').textContent === '保存済み');
  const savedAiConfig = JSON.parse(await readFile(path.join(root, 'manual_setting.json'), 'utf8'));
  assert.equal(savedAiConfig.workspace_history, undefined);
  assert.equal(savedAiConfig.agent, 'claude', 'changing CLI persists without pressing Save');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('Saved content'));
  await idle();
  assert.equal(await page.locator('#ai-agent').inputValue(), 'claude', 'saved CLI is retained after reload even when unavailable');
  await page.locator('[data-tab="publish"]').click();
  assert.equal(await page.locator('#panel-publish #docs-path').count(), 0, 'workspace paths are not in AI settings');
  await page.locator('#open-workspace-settings').click();
  await page.locator('#docs-path').fill('unfinished-folder');
  await page.locator('#cancel-workspace-settings').click();
  await page.locator('#ai-connection-type').selectOption('local_llm');
  await page.locator('#ai-model').fill('local-test-model');
  await page.locator('#ai-endpoint-url').fill('http://localhost:11434/v1');
  await page.locator('#ai-api-key').fill('smoke-local-key');
  await page.waitForFunction(() => document.querySelector('#ai-save-state').textContent === '保存済み');
  const savedAllAi = JSON.parse(await readFile(path.join(root, 'manual_setting.json'), 'utf8'));
  assert.equal(savedAllAi.connection_type, 'local_llm');
  assert.equal(savedAllAi.model, 'local-test-model');
  assert.equal(savedAllAi.endpoint_url, 'http://localhost:11434/v1');
  assert.equal(savedAllAi.docs, 'docs', 'AI autosave leaves unrelated edits unsaved');
  assert.ok(!JSON.stringify(savedAllAi).includes('smoke-local-key'), 'API key stays local');
  let failAiSave = true;
  const failSaveRoute = async route => {
    if (route.request().postDataJSON().action === 'save' && failAiSave) {
      failAiSave = false;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Smoke save failure' }) });
    } else await route.continue();
  };
  await page.route('**/__manual/rpc', failSaveRoute);
  await page.locator('#ai-model').fill('retry-test-model');
  await page.locator('#ai-save-retry').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#ai-model').inputValue(), 'retry-test-model', 'save failure retains input');
  await page.locator('#ai-save-retry').click();
  await page.waitForFunction(() => document.querySelector('#ai-save-state').textContent === '保存済み');
  await page.unroute('**/__manual/rpc', failSaveRoute);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('Saved content'));
  assert.equal(await page.locator('#ai-model').inputValue(), 'retry-test-model');
  assert.equal(await page.locator('#ai-connection-type').inputValue(), 'local_llm');
  assert.equal(await page.locator('#ai-api-key').inputValue(), 'smoke-local-key');
  await page.locator('#open-workspace-settings').click();
  await page.locator('#site-name').fill('Workspace smoke site');
  await page.locator('#save-workspace-settings').click();
  await page.waitForFunction(() => document.querySelector('#workspace-save-state').textContent === '保存済み');
  const savedWorkspace = JSON.parse(await readFile(path.join(root, 'manual_setting.json'), 'utf8'));
  assert.equal(savedWorkspace.mkdocs.site_name, 'Workspace smoke site');
  assert.equal(savedWorkspace.model, 'retry-test-model', 'workspace save preserves AI settings');
  await page.locator('#cancel-workspace-settings').click();
  await page.locator('[data-tab="editor"]').click();

  const popupPromise = page.waitForEvent('popup');
  await page.locator('#detach-editor').click();
  const popup = await popupPromise;
  await popup.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('Saved content'));
  await idle(popup);
  await popup.locator('#markdown-editor').fill('# Updated in another window\n');
  await popup.locator('#save-page').click();
  await idle(popup);
  await page.locator('#markdown-editor').fill('# Stale edit\n');
  await page.locator('#save-page').click();
  await idle();
  assert.match(await page.locator('#status').innerText(), /原稿が更新/);
  assert.equal(await readFile(path.join(root, 'docs/index.md'), 'utf8'), '# Updated in another window\n');
  await page.locator('#reload-page').click();
  await page.locator('[data-unsaved-action=save]').click();
  await page.waitForFunction(() => document.querySelector('#unsaved-changes-error')?.textContent.includes('保存できませんでした'));
  assert.equal(await page.locator('#markdown-editor').inputValue(), '# Stale edit\n');
  await page.locator('[data-unsaved-action=discard]').click();
  await idle();
  assert.equal(await page.locator('#markdown-editor').inputValue(), '# Updated in another window\n');
  await popup.close();

  await page.locator('#open-existing-workspace').click();
  await page.locator('#project-root').fill(path.join(root, 'empty'));
  await page.locator('#project-form button[type=submit]').click();
  await idle();
  assert.equal(await page.locator('#markdown-editor').inputValue(), '');
  assert.equal(await page.locator('#markdown-editor').isDisabled(), true);
  assert.equal(await page.locator('#editor-title').innerText(), 'Markdownを編集する');
  assert.equal(await page.locator('#markdown-preview').getAttribute('srcdoc'), '');

  await page.locator('#new-page').click();
  await page.locator('#new-page-path').fill('new.md');
  await page.locator('#new-page-title').fill('New guide');
  await page.locator('#new-page-form button[type=submit]').click();
  await idle();
  assert.match(await readFile(path.join(root, 'empty/docs/new.md'), 'utf8'), /# New guide/);
  const project = path.join(root, 'empty');

  const generatedPrompt = '画面を開いてからボタンを押す';
  const generatedPromptB64 = Buffer.from(generatedPrompt, 'utf8').toString('base64');
  const generatedExample = `# New guide\n\n<!-- ai:generated id=smoke-generated kind=screenshot prompt-b64=${generatedPromptB64} -->\nGenerated text\n<!-- /ai:generated -->\n`;
  await page.locator('#markdown-editor').fill(generatedExample);
  const documentTags = page.locator('#document-tag-list [data-tag-start]');
  assert.equal(await documentTags.count(), 1, 'the document list includes generated-only tags from unsaved editor text');
  const middleContent = Array.from({ length: 80 }, (_, index) => `Paragraph ${index}`).join('\n');
  await page.locator('#markdown-editor').fill(`# New guide\n\n${middleContent}\n\n<!-- ai:task id=smoke-generated kind=screenshot\n${generatedPrompt}\n-->\n<!-- ai:generated id=smoke-generated kind=screenshot prompt-b64=${generatedPromptB64} -->\nGenerated text\n<!-- /ai:generated -->\n\n<!-- ai:task id=unsaved-text kind=text\nUnsaved instruction\n-->\n`);
  assert.equal(await documentTags.count(), 2, 'task and generated tags with the same id are merged while unsaved instructions appear');
  assert.match(await page.locator('#document-tag-list [data-tag-start]').filter({ hasText: 'smoke-generated' }).innerText(), /未確定/);
  await page.locator('#document-tag-list [data-tag-start]').filter({ hasText: 'unsaved-text' }).locator('[data-tag-jump]').click();
  assert.ok(await page.locator('#markdown-editor').evaluate(node => node.scrollTop > 0), 'selecting a tag lower in the document scrolls the editor to it');
  assert.equal(await page.locator('#markdown-editor').evaluate(node => node.value.slice(node.selectionStart).startsWith('<!-- ai:task id=unsaved-text')), true);
  await page.locator('#document-tag-list [data-tag-start]').filter({ hasText: 'smoke-generated' }).locator('[data-tag-jump]').click();
  assert.equal(await page.locator('#markdown-editor').evaluate(node => node.value.slice(node.selectionStart).startsWith('<!-- ai:task id=smoke-generated')), true, 'selecting a document tag jumps to its Markdown comment');
  const wrappedPrefix = '折り返しのある長い文章です。'.repeat(500);
  await page.locator('#markdown-editor').fill(`${wrappedPrefix}\n${generatedExample}\n${wrappedPrefix}`);
  await page.locator('#document-tag-list [data-tag-jump]').click();
  const wrappedJump = await page.locator('#markdown-editor').evaluate(node => ({
    top: node.scrollTop, height: node.scrollHeight, viewport: node.clientHeight,
    selected: node.value.slice(node.selectionStart, node.selectionEnd),
    focused: document.activeElement === node,
  }));
  assert.match(wrappedJump.selected, /^<!-- ai:generated id=smoke-generated/);
  assert.equal(wrappedJump.focused, true);
  assert.ok(wrappedJump.top > wrappedJump.height * 0.3 && wrappedJump.top < wrappedJump.height * 0.65,
    'jump measures wrapped text and reveals the tag near the middle of the document');
  await page.locator('#markdown-editor').fill(generatedExample);
  await page.locator('#markdown-editor').evaluate(node => node.setSelectionRange(0, 0));
  assert.equal(await page.locator('#confirm-generated').count(), 0, 'generated controls have moved out of the editor toolbar');
  let delayedSaveSeen = false;
  await page.route('**/__manual/rpc', async route => {
    const request = route.request().postDataJSON();
    if (!delayedSaveSeen && request.action === 'editor-save' && request.root === project) {
      delayedSaveSeen = true;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await route.continue();
  });
  await page.locator('#save-page').click();
  await page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'true');
  assert.equal(await page.locator('#document-tag-list [data-tag-confirm]').isDisabled(), true, 'tag controls are disabled while saving');
  await idle();
  assert.equal(delayedSaveSeen, true);
  assert.equal(await page.locator('#document-tag-list [data-tag-confirm]').isEnabled(), true, 'tag controls are enabled again after saving');
  assert.equal(await page.locator('#undo-edit').isEnabled(), true, 'saving must preserve undo history');
  await page.unroute('**/__manual/rpc');

  await page.locator('[data-tab="tasks"]').click();
  const generatedOnlyCard = page.locator('[data-task="smoke-generated"]');
  await generatedOnlyCard.waitFor();
  assert.equal(await generatedOnlyCard.locator('[data-prompt]').inputValue(), generatedPrompt);
  const revisedGeneratedPrompt = '設定画面を開き、保存を押す';
  await generatedOnlyCard.locator('[data-prompt]').fill(revisedGeneratedPrompt);
  await generatedOnlyCard.locator('[data-save-prompt]').click();
  await idle();
  let generatedOnlyMarkdown = await readFile(path.join(project, 'docs/new.md'), 'utf8');
  assert.doesNotMatch(generatedOnlyMarkdown, /ai:task/);
  const savedPromptB64 = generatedOnlyMarkdown.match(/prompt-b64=([A-Za-z0-9+/=]+)/)?.[1];
  assert.equal(Buffer.from(savedPromptB64, 'base64').toString('utf8'), revisedGeneratedPrompt);
  await generatedOnlyCard.locator('[data-toggle-approved]').click();
  await idle();
  generatedOnlyMarkdown = await readFile(path.join(project, 'docs/new.md'), 'utf8');
  assert.match(generatedOnlyMarkdown, /approved-at=\d{4}-\d\d-\d\dT/);
  await generatedOnlyCard.locator('[data-toggle-approved]').click();
  await idle();
  generatedOnlyMarkdown = await readFile(path.join(project, 'docs/new.md'), 'utf8');
  assert.doesNotMatch(generatedOnlyMarkdown, /approved-at=/);
  await page.locator('[data-tab="editor"]').click();

  const otherGenerated = '<!-- ai:generated id=other-generated kind=text -->\nOther generated text\n<!-- /ai:generated -->\n';
  await page.locator('#markdown-editor').fill(`${generatedExample}\n${otherGenerated}`);
  await page.locator('#markdown-editor').evaluate(node => node.setSelectionRange(0, 0));
  const otherTag = page.locator('#document-tag-list .document-tag-row').filter({ hasText: 'other-generated' });
  await otherTag.locator('[data-tag-confirm]').click();
  let editedTags = await page.locator('#markdown-editor').inputValue();
  assert.match(editedTags, /id=other-generated[^>]*approved-at=/, 'confirmation targets the clicked tag even with the caret elsewhere');
  assert.doesNotMatch(editedTags.match(/<!-- ai:generated id=smoke-generated[^>]*-->/)?.[0] || '', /approved-at=/, 'confirmation leaves the other generated tag untouched');
  await page.locator('#document-tag-list .document-tag-row').filter({ hasText: 'other-generated' }).locator('[data-tag-confirm]').click();
  editedTags = await page.locator('#markdown-editor').inputValue();
  assert.doesNotMatch(editedTags.match(/<!-- ai:generated id=other-generated[^>]*-->/)?.[0] || '', /approved-at=/, 'local confirmation can be removed from the same tag');
  await page.locator('#markdown-editor').press('Control+z');
  assert.match((await page.locator('#markdown-editor').inputValue()).match(/<!-- ai:generated id=other-generated[^>]*-->/)?.[0] || '', /approved-at=/, 'Undo restores local confirmation removal');
  await page.locator('#markdown-editor').press('Control+z');
  editedTags = await page.locator('#markdown-editor').inputValue();
  assert.doesNotMatch(editedTags.match(/<!-- ai:generated id=other-generated[^>]*-->/)?.[0] || '', /approved-at=/, 'Undo removes the confirmation');
  await page.locator('#document-tag-list .document-tag-row').filter({ hasText: 'other-generated' }).locator('[data-tag-delete]').click();
  editedTags = await page.locator('#markdown-editor').inputValue();
  assert.doesNotMatch(editedTags, /id=other-generated/, 'deletion targets only the clicked generated tag');
  assert.match(editedTags, /id=smoke-generated/, 'deletion keeps the other generated tag');
  await page.locator('#markdown-editor').press('Control+z');
  assert.match(await page.locator('#markdown-editor').inputValue(), /id=other-generated/, 'Undo restores the deleted result');

  await page.locator('#markdown-editor').fill('# New guide\n\n');

  const imageChooserPromise = page.waitForEvent('filechooser');
  await page.locator('#insert-image').click();
  const imageChooser = await imageChooserPromise;
  await imageChooser.setFiles({
    name: 'toolbar-shot.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
  });
  await page.locator('#image-save-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#image-save-filename').inputValue(), 'toolbar-shot.png');
  await page.locator('#image-save-alt').fill('Toolbar image');
  await page.locator('#confirm-image-save').click();
  await idle();
  assert.match(await page.locator('#markdown-editor').inputValue(), /!\[Toolbar image\]\(assets\/toolbar-shot\.png\)/);
  const toolbarFile = await readFile(path.join(project, 'docs/assets/toolbar-shot.png'));
  assert.equal(toolbarFile.subarray(1, 4).toString(), 'PNG');
  await page.frameLocator('#markdown-preview').locator('img[alt="Toolbar image"]').waitFor();

  // Test clipboard image paste with auto-naming and direct insertion (no dialog)
  await page.locator('#markdown-editor').evaluate(node => {
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const binary = atob(pngBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], 'pasted-shot.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    node.dispatchEvent(evt);
  });
  await page.waitForFunction(() => /!\[image-\d{8}-\d{6}/.test(document.querySelector('#markdown-editor').value));
  await idle();
  assert.equal(await page.locator('#image-save-dialog').isVisible(), false);
  const editorVal = await page.locator('#markdown-editor').inputValue();
  const pastedMatch = editorVal.match(/!\[(image-\d{8}-\d{6}[^\]]*)\]\((assets\/(image-\d{8}-\d{6}[^)]*\.png))\)/);
  assert.ok(pastedMatch, `pasted image markdown must match auto-generated pattern: ${editorVal}`);
  const pastedRelPath = pastedMatch[2];
  const pastedFile = await readFile(path.join(project, 'docs', pastedRelPath));
  assert.equal(pastedFile.subarray(1, 4).toString(), 'PNG');
  await page.frameLocator('#markdown-preview').locator(`img[alt="${pastedMatch[1]}"]`).waitFor();

  // Test image drag & drop
  await page.locator('.editor-column').evaluate(node => {
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const binary = atob(pngBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], 'dropped-shot.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const evt = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    node.dispatchEvent(evt);
  });
  await page.locator('#image-save-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#image-save-filename').inputValue(), 'dropped-shot.png');
  await page.locator('#confirm-image-save').click();
  await idle();
  assert.match(await page.locator('#markdown-editor').inputValue(), /!\[dropped-shot\]\(assets\/dropped-shot\.png\)/);
  const droppedFile = await readFile(path.join(project, 'docs/assets/dropped-shot.png'));
  assert.equal(droppedFile.subarray(1, 4).toString(), 'PNG');
  await page.frameLocator('#markdown-preview').locator('img[alt="dropped-shot"]').waitFor();

  await page.locator('.instruction-toolbar summary').click();
  await page.locator('[data-insert="screenshot"]').click();
  await page.locator('#screenshot-task-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#start-operation-recording').isVisible(), true);
  await page.locator('#cancel-screenshot-task').click();
  await page.locator('#screenshot-task-dialog').waitFor({ state: 'hidden' });
  await page.locator('#save-page').click();
  await idle();
  await page.locator('[data-tab="publish"]').click();
  await page.locator('#build-draft').click();
  await idle();
  assert.equal(await page.locator('#status').evaluate(node => node.classList.contains('error')), false, await page.locator('#status').innerText());
  const buildResult = await page.locator('#publish-result').innerText();
  if (process.env.MANUAL_STUDIO_REQUIRE_HTML === '1') assert.match(buildResult, /Site:/);
  if (buildResult.includes('Site:')) {
    assert.match(await readFile(path.join(project, 'manual/new.html'), 'utf8'), /New guide/);
  } else {
    assert.match(buildResult, /MkDocs site build skipped/);
  }
  await writeFile(path.join(project, 'docs/ai-page.md'), '# AI page\n\n<!-- ai:task id=smoke-text kind=text\nExplain the guide\n-->\n');
  await page.locator('#open-existing-workspace').click();
  await page.locator('#project-root').fill(project);
  await page.locator('#project-form button[type=submit]').click();
  await idle();
  let generatedPageTask = false;
  await page.route('**/__manual/rpc', async route => {
    const request = route.request().postDataJSON();
    if (request.action === 'generate-review' && request.options.page === 'docs/ai-page.md') {
      generatedPageTask = true;
      await new Promise(resolve => setTimeout(resolve, 1200));
      const content = await readFile(path.join(project, request.options.page), 'utf8');
      const next = `${content}\n<!-- ai:generated id=smoke-text kind=text -->\n${request.options.feedback ? 'Revised guide' : 'Generated guide'}\n<!-- /ai:generated -->\n`;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ output: JSON.stringify({ before: { page: request.options.page, content, revision: createHash('sha256').update(content).digest('hex') }, content: next, updated: ['smoke-text'] }) }) });
    } else if (request.action === 'agent-progress') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ output: JSON.stringify({ total: 1, logs: [{ time: '12:00:00', message: 'タスク smoke-text の文章を生成しています' }] }) }) });
    } else await route.continue();
  });
  await page.locator('[data-generate-page="docs/ai-page.md"]').click();
  await page.locator('#operation-progress').waitFor({ state: 'visible' });
  assert.match(await page.locator('#progress-log').innerText(), /ai-page\.md のAI指示 1 件/);
  await page.locator('#generation-review-dialog').waitFor({ state: 'visible' });
  assert.ok(!(await readFile(path.join(project, 'docs/ai-page.md'), 'utf8')).includes('Generated guide'), 'candidate does not overwrite the original');
  assert.match(await page.locator('#generation-diff-after').innerText(), /Generated guide/);
  await page.locator('#generation-review-feedback').fill('Make the guide shorter');
  await page.locator('[data-review-action=retry]').click();
  await page.locator('#generation-review-dialog').waitFor({ state: 'visible' });
  assert.match(await page.locator('#generation-diff-after').innerText(), /Revised guide/);
  await page.locator('[data-review-action=adopt]').click();
  await idle();
  assert.match(await readFile(path.join(project, 'docs/ai-page.md'), 'utf8'), /Revised guide/);
  await page.locator('#review-ai-update').click();
  await page.locator('[data-review-action=restore]').click();
  await idle();
  assert.ok(!(await readFile(path.join(project, 'docs/ai-page.md'), 'utf8')).includes('Revised guide'), 'restore returns to the previous saved document');
  await page.locator('#generate-page').click();
  await page.locator('#generation-review-dialog').waitFor({ state: 'visible' });
  await page.locator('[data-review-action=restore]').click();
  await idle();
  const unchangedOriginal = await readFile(path.join(project, 'docs/ai-page.md'), 'utf8');
  assert.ok(!unchangedOriginal.includes('Generated guide'), 'rejecting a candidate keeps the original file');
  await page.locator('#generate-page').click();
  await page.locator('#generation-review-dialog').waitFor({ state: 'visible' });
  await writeFile(path.join(project, 'docs/ai-page.md'), `${unchangedOriginal}\nExternal edit during review\n`);
  await page.locator('[data-review-action=adopt]').click();
  await idle();
  assert.match(await page.locator('#status').innerText(), /原稿が更新/);
  assert.match(await readFile(path.join(project, 'docs/ai-page.md'), 'utf8'), /External edit during review/);
  assert.equal(generatedPageTask, true);
  await page.locator('#progress-open').click();
  assert.match(await page.locator('#progress-log').innerText(), /タスク smoke-text の文章を生成しています/);
  assert.match(await page.locator('#progress-label').innerText(), /完了/);
  await page.locator('#progress-dismiss').click();
  assert.equal(await page.locator('#operation-progress').isVisible(), false);
  await page.locator('#progress-open').click();
  assert.equal(await page.locator('#operation-progress').isVisible(), true);
  await page.unroute('**/__manual/rpc');
  await page.locator('[data-tab="appearance"]').click();
  assert.equal(await page.locator('#panel-appearance').isVisible(), true);
  assert.equal(await page.locator('#panel-publish #ui-theme').count(), 0);
  const themePicker = page.locator('#ui-theme');
  await themePicker.selectOption('midnight');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'midnight');
  assert.equal(await page.locator('html').evaluate(node => getComputedStyle(node).getPropertyValue('--app-bg').trim()), '#171d29');
  assert.equal(await page.evaluate(() => localStorage.getItem('manual-studio-theme')), 'midnight');
  const assertPreviewTheme = async () => {
    await page.waitForFunction(() => {
      const preview = document.querySelector('#markdown-preview').contentDocument;
      if (!preview?.body) return false;
      const normalize = (value, property) => {
        const probe = document.createElement('span');
        probe.style[property] = value;
        document.body.append(probe);
        const color = getComputedStyle(probe)[property];
        probe.remove();
        return color;
      };
      const root = getComputedStyle(document.documentElement);
      const body = getComputedStyle(preview.body);
      return body.backgroundColor === normalize(root.getPropertyValue('--surface-bg'), 'backgroundColor')
        && body.color === normalize(root.getPropertyValue('--text-primary'), 'color');
    });
  };
  await assertPreviewTheme();
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'midnight' && document.querySelector('#ui-theme')?.value === 'midnight');
  assert.equal(await page.locator('html').evaluate(node => getComputedStyle(node).colorScheme), 'dark');
  await assertPreviewTheme();
  await page.locator('[data-tab="appearance"]').click();
  await page.locator('#ui-theme').selectOption('blue');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'blue');
  assert.equal(await page.locator('html').evaluate(node => getComputedStyle(node).getPropertyValue('--app-bg').trim()), '#f5f8fc');
  assert.equal(await page.evaluate(() => localStorage.getItem('manual-studio-theme')), 'blue');
  await page.locator('#new-workspace').click();
  await page.locator('#wizard-parent').fill(root);
  await page.locator('#wizard-name').fill('tutorial-workspace');
  await page.locator('#wizard-next').click();
  await page.locator('#wizard-title').fill('Tutorial guide');
  await page.locator('#wizard-output').fill('docs/html');
  await page.locator('#wizard-next').click();
  await page.waitForFunction(() => document.querySelector('#wizard-error').textContent.includes('重ならない'));
  assert.match(await page.locator('#workspace-step').innerText(), /2 \/ 5/);
  await page.locator('#wizard-output').fill('manual');
  await page.locator('#wizard-docs').fill('pages');
  await page.locator('#wizard-assets').fill('pages/images');
  await page.locator('#wizard-next').click();
  await page.locator('#wizard-connection').selectOption('local_llm');
  await page.locator('#wizard-endpoint').fill('http://localhost:11434/v1');
  await page.locator('#wizard-next').click();
  await page.locator('#wizard-brief').fill('初めて使う人向け');
  await page.locator('#wizard-next').click();
  assert.match(await page.locator('#wizard-review').innerText(), /Tutorial guide/);
  await page.locator('#wizard-back').click();
  assert.equal(await page.locator('#wizard-brief').inputValue(), '初めて使う人向け');
  await page.locator('#wizard-next').click();
  await page.locator('#wizard-next').click();
  await page.locator('#new-workspace-dialog').waitFor({ state: 'hidden' });
  await idle();
  assert.match(await page.locator('#markdown-editor').inputValue(), /Tutorial guide/);
  const tutorialRoot = path.join(root, 'tutorial-workspace');
  const tutorialConfig = JSON.parse(await readFile(path.join(tutorialRoot, 'manual_setting.json'), 'utf8'));
  assert.equal(tutorialConfig.docs, 'pages');
  assert.equal(tutorialConfig.connection_type, 'local_llm');
  await page.locator('#new-workspace').click();
  await page.locator('#wizard-next').click();
  await page.waitForFunction(() => document.querySelector('#wizard-error').textContent.includes('既に存在'));
  assert.match(await page.locator('#workspace-step').innerText(), /1 \/ 5/);
  await page.locator('#wizard-cancel').click();
  await page.locator('#open-existing-workspace').click();
  await page.locator('#project-root').fill(root);
  await page.locator('#project-form button[type=submit]').click();
  await idle();
  await page.locator('#open-workspace-settings').click();
  assert.equal(await page.locator('#workspace-settings-dialog #project-root').count(), 0);
  await page.locator('#cancel-workspace-settings').click();
  await page.locator('#new-workspace').click();
  await page.locator('#wizard-name').fill('deferred-ai-workspace');
  await page.locator('#wizard-next').click();
  await page.locator('#wizard-next').click();
  await page.locator('#wizard-connection').selectOption('none');
  assert.equal(await page.locator('#wizard-agent').isVisible(), false);
  await page.locator('#wizard-next').click();
  await page.locator('#wizard-next').click();
  assert.match(await page.locator('#wizard-review').innerText(), /後で設定する/);
  await page.locator('#wizard-next').click();
  await page.locator('#new-workspace-dialog').waitFor({ state: 'hidden' });
  await idle();
  const deferredConfig = JSON.parse(await readFile(path.join(root, 'deferred-ai-workspace/manual_setting.json'), 'utf8'));
  assert.equal(deferredConfig.connection_type, 'none');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('Tutorial guide'));
  assert.equal(await page.locator('#ai-connection-type').inputValue(), 'none');
  await page.locator('[data-tab="publish"]').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#generate-draft').click();
  await idle();
  assert.match(await page.locator('#status').innerText(), /未設定/);
  assert.deepEqual(errors, []);
  console.log(`Manual Studio smoke passed: edit, bidirectional scroll sync, workspace popup, preview, save, detached conflict, project switch, screenshot dialog, new page, ${buildResult.includes('Site:') ? 'HTML build' : 'missing MkDocs message'}.`);
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill();
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}
