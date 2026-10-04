import assert from 'node:assert/strict';
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
  assert.match(await page.locator('#markdown-editor').inputValue(), /\| 項目 \| 内容 \|\n\| --- \| --- \|/);
  await page.frameLocator('#markdown-preview').locator('table').waitFor();
  await page.locator('#markdown-editor').fill(originalMarkdown);
  assert.equal(await page.locator('#page-list [data-page="docs/index.md"]').count(), 1);
  assert.equal(await page.locator('#page-list .tree-static[title="project.txt"]').count(), 1);
  assert.equal(await page.locator('#page-list [data-page="docs/z-guide/intro.md"]').count(), 1);
  await page.locator('#page-list details[data-folder="notes"] summary').click();
  await page.locator('#page-list [data-page="notes/extra.md"]').click();
  await idle();
  assert.match(await page.locator('#markdown-editor').inputValue(), /Project note/);
  assert.equal(await page.locator('#undo-edit').isEnabled(), false);
  await page.locator('#page-list [data-page="docs/index.md"]').click();
  await idle();
  await page.locator('#page-list details[data-folder="docs/z-guide"] summary').click();
  assert.equal(await page.locator('#page-list .tree-static[title="docs/z-guide/diagram.svg"]').count(), 1);
  await page.locator('#page-list [data-page="docs/z-guide/intro.md"]').click();
  await idle();
  assert.match(await page.locator('#markdown-editor').inputValue(), /Nested guide/);
  await page.locator('#page-list [data-page="docs/index.md"]').click();
  await idle();
  await page.locator('#open-workspace-settings').click();
  await page.locator('#project-root').fill(path.join(root, 'docs'));
  await page.locator('#project-form button[type="submit"]').click();
  await idle();
  assert.equal(await page.locator('#project-root').inputValue(), path.join(root, 'docs'));
  assert.equal(await page.locator('#page-list [data-page="index.md"]').count(), 1);
  await page.locator('#open-workspace-settings').click();
  await page.locator('#project-root').fill(root);
  await page.locator('#project-form button[type="submit"]').click();
  await idle();
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
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#reload-page').click();
  await idle();
  assert.equal(await page.locator('#markdown-editor').inputValue(), '# Updated in another window\n');
  await popup.close();

  await page.locator('#open-workspace-settings').click();
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

  const generatedExample = '# New guide\n\n<!-- ai:generated id=smoke-generated -->\nGenerated text\n<!-- /ai:generated -->\n';
  await page.locator('#markdown-editor').fill(generatedExample);
  await page.locator('#markdown-editor').evaluate(node => node.setSelectionRange(0, 0));
  assert.equal(await page.locator('#delete-generated').isDisabled(), true, 'delete stays disabled when the cursor is outside a generated block');
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
  assert.equal(await page.locator('#delete-generated').isDisabled(), true, 'busy state must preserve the disabled selection-sensitive action');
  await idle();
  assert.equal(delayedSaveSeen, true);
  assert.equal(await page.locator('#delete-generated').isDisabled(), true, 'saving must not enable deletion outside a generated block');
  assert.equal(await page.locator('#undo-edit').isEnabled(), true, 'saving must preserve undo history');
  await page.unroute('**/__manual/rpc');

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

  // Test clipboard image paste with custom destination
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
  await page.locator('#image-save-dialog').waitFor({ state: 'visible' });
  await page.locator('#image-save-filename').fill('pasted-guide-image.png');
  await page.locator('#image-save-alt').fill('Pasted guide screenshot');
  await page.locator('#confirm-image-save').click();
  await idle();
  assert.equal(await page.locator('#image-save-dialog').isVisible(), false);
  assert.match(await page.locator('#markdown-editor').inputValue(), /!\[Pasted guide screenshot\]\(assets\/pasted-guide-image\.png\)/);
  const pastedFile = await readFile(path.join(project, 'docs/assets/pasted-guide-image.png'));
  assert.equal(pastedFile.subarray(1, 4).toString(), 'PNG');
  await page.frameLocator('#markdown-preview').locator('img[alt="Pasted guide screenshot"]').waitFor();

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
  await page.locator('#open-workspace-settings').click();
  await page.locator('#project-root').fill(project);
  await page.locator('#project-form button[type=submit]').click();
  await idle();
  let generatedPageTask = false;
  await page.route('**/__manual/rpc', async route => {
    const request = route.request().postDataJSON();
    if (request.action === 'generate-page' && request.options.page === 'docs/ai-page.md') {
      generatedPageTask = true;
      await new Promise(resolve => setTimeout(resolve, 1200));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ output: JSON.stringify({ updated: ['smoke-text'] }) }) });
    } else if (request.action === 'agent-progress') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ output: JSON.stringify({ total: 1, logs: [{ time: '12:00:00', message: 'タスク smoke-text の文章を生成しています' }] }) }) });
    } else await route.continue();
  });
  await page.locator('[data-generate-page="docs/ai-page.md"]').click();
  await page.locator('#operation-progress').waitFor({ state: 'visible' });
  assert.match(await page.locator('#progress-log').innerText(), /ai-page\.md のAI指示 1 件/);
  await idle();
  assert.equal(generatedPageTask, true);
  await page.locator('#progress-open').click();
  assert.match(await page.locator('#progress-log').innerText(), /タスク smoke-text の文章を生成しています/);
  assert.match(await page.locator('#progress-label').innerText(), /完了/);
  await page.locator('#progress-dismiss').click();
  assert.equal(await page.locator('#operation-progress').isVisible(), false);
  await page.locator('#progress-open').click();
  assert.equal(await page.locator('#operation-progress').isVisible(), true);
  await page.unroute('**/__manual/rpc');
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
