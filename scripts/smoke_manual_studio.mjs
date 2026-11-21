import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

// Run against `npm run manual:dev` after building manualctl.
const base = process.env.MANUAL_STUDIO_URL || 'http://127.0.0.1:5174';
const root = await mkdtemp(path.join(os.tmpdir(), 'manual-studio-smoke-'));
let browser;
let server;
smoke: try {
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
  browser = await chromium.launch({ channel: process.env.MUNIN_TEST_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
  const context = await browser.newContext();
  context.setDefaultTimeout(30_000);
  await context.addInitScript(() => {
    localStorage.setItem('manual-studio-flexlayout-model', '{invalid-json');
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
  const sourceEditor = async target => {
    await target.waitForSelector('#milkdown-editor .ProseMirror', { state: 'attached' });
    if (!await target.locator('#markdown-editor').isVisible()) await target.getByRole('button', { name: 'Markdownソース', exact: true }).click();
    return target.locator('#markdown-editor');
  };
  const idle = async (target = page) => {
    await target.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false', undefined, { timeout: 30_000 }).catch(async error => {
      const state = await target.evaluate(() => ({ status: document.querySelector('#status')?.textContent, dialogs: [...document.querySelectorAll('dialog[open]')].map(node => node.id) }));
      throw new Error(`Studio did not become idle: ${JSON.stringify(state)}; ${error.message}`);
    });
  };
  const awaitRpcObserved = (promise, label, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  await page.goto(`${base}/?root=${encodeURIComponent(root)}`);
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('Original text'));
  await idle();
  await page.waitForSelector("#milkdown-editor .ProseMirror");
  if (process.argv.includes('--save-conflict-only')) {
    const file = path.join(root, 'docs/index.md');
    await writeFile(file, '# Original text\n\nFirst part.\n\nLast part.\n');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('Last part.'));
    await idle();
    await page.locator('#editor-mode-toggle').click();
    const source = page.locator('#markdown-editor');
    const draft = '# Original text\n\nFirst part.\n\nLocal draft.\n';
    const external = '# Original text\n\nExternal edit.\n\nLast part.\n';
    await source.fill(draft);
    await writeFile(file, external);
    await source.press('Control+s');
    await idle();
    assert.equal(await source.inputValue(), draft);
    assert.equal(await readFile(file, 'utf8'), external);
    const openReview = async () => {
      await page.locator('#save-conflict').click();
      await page.getByRole('button', {name:'変更を選んで保存'}).click();
      const parts = page.locator('#selection-diff-dialog [data-diff-part]');
      await parts.last().waitFor();
      assert.equal(await parts.count(), 2);
      assert.equal(await parts.first().isChecked(), false);
      assert.equal(await parts.last().isChecked(), false);
      await parts.last().check();
    };
    await openReview();
    await page.locator('[data-diff-action=restore]').click();
    assert.equal(await source.inputValue(), draft);
    await openReview();
    await writeFile(file, external.replace('External edit.', 'New external edit.'));
    const failedSave = page.waitForResponse(response =>
      response.request().postDataJSON()?.action === 'editor-save');
    await page.locator('[data-diff-action=adopt]').click();
    assert.equal((await failedSave).ok(), false);
    await page.locator('#selection-diff-dialog').waitFor({state:'detached'});
    await idle();
    assert.equal(await source.inputValue(), draft);
    assert.match(await readFile(file, 'utf8'), /New external edit/);
    await openReview();
    await page.locator('[data-diff-action=adopt]').click();
    await page.waitForFunction(() => document.querySelector('#save-state').dataset.state === 'saved');
    await idle();
    const merged = '# Original text\n\nNew external edit.\n\nLocal draft.\n';
    assert.equal(await source.inputValue(), merged);
    assert.equal(await readFile(file, 'utf8'), merged);
    assert.deepEqual(errors, []);
    console.log('Save conflict review keeps external changes, preserves drafts on cancel and a second conflict, and saves selected edits.');
    break smoke;
  }
  if (process.argv.includes('--external-document-only')) {
    await page.locator('button[data-editor-view="split"]').click();
    const file = path.join(root, 'docs/index.md');
    const source = page.locator('#markdown-editor');
    const preview = page.frameLocator('#markdown-preview');
    await writeFile(file, '# External update\n\nNew body from AI.\n');
    await page.locator('.ProseMirror').getByText('New body from AI.', {exact:true}).waitFor({timeout:12000});
    await preview.getByText('New body from AI.', {exact:true}).waitFor();
    assert.equal(await source.inputValue(), '# External update\n\nNew body from AI.\n');
    await page.locator('#editor-mode-toggle').click();
    const draft = '# Local draft\n\nUnsaved text.\n';
    await source.fill(draft);
    await writeFile(file, '# Another external update\n\nExternal content.\n');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('未保存の編集は保持'), undefined, {timeout:12000});
    assert.equal(await source.inputValue(), draft);
    await preview.getByText('Unsaved text.', {exact:true}).waitFor();
    await source.press('Control+z');
    await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('External content.'), undefined, {timeout:12000});
    await preview.getByText('External content.', {exact:true}).waitFor();
    await source.fill('# Saved after reload\n');
    await source.press('Control+s');
    await idle();
    assert.equal(await readFile(file, 'utf8'), '# Saved after reload\n');
    assert.deepEqual(errors, []);
    console.log('Open manuscript and preview follow external edits, preserve a dirty draft, and save against the new revision.');
    break smoke;
  }
  if (process.argv.includes('--alert-icons-only')) {
    const markdown = '# Alert icons\n\n> [!WARNING]\n> Warning body.\n\n> [!CAUTION]\n> Caution body.\n';
    const manuscript = path.join(root, 'docs/index.md');
    await writeFile(manuscript, markdown);
    await page.reload();
    await page.locator('button[data-editor-view="split"]').click();
    const editor = page.locator('.ProseMirror [data-gfm-alert="WARNING"]');
    const preview = page.frameLocator('#markdown-preview').locator('.markdown-alert-warning');
    const previewMask = () => preview.evaluate(node => getComputedStyle(node, '::after').maskImage);
    assert.equal(await previewMask(), 'none');
    await page.locator('#application-settings').click();
    await page.locator('#settings-tab-appearance').click();
    await page.locator('#project-alert-icons').check();
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-alert-icons'));
    await page.locator('[data-close-dialog="panel-settings"]').click();
    const editorMask = await editor.evaluate(node => getComputedStyle(node, '::before').maskImage);
    assert.match(editorMask, /data:image\/svg\+xml/);
    assert.equal(await previewMask(), editorMask);
    await page.reload();
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-alert-icons'));
    assert.equal(await previewMask(), editorMask);
    await page.locator('#application-settings').click();
    await page.locator('#settings-tab-appearance').click();
    await page.locator('#project-alert-icons').uncheck();
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-alert-icons'));
    await page.locator('[data-close-dialog="panel-settings"]').click();
    assert.equal(await previewMask(), 'none');
    assert.equal(await readFile(manuscript, 'utf8'), markdown);
    assert.deepEqual(errors, []);
    console.log('Project alert icons match in editor and preview, persist, and can be switched off.');
    break smoke;
  }
  if (process.argv.includes('--image-sizing-only')) {
    await page.setViewportSize({ width: 1800, height: 1050 });
    await page.locator('button[data-editor-view="split"]').click();
    await page.locator('#editor-mode-toggle').click();
    const source = page.locator('#markdown-editor');
    await writeFile(path.join(root, 'docs/assets/wide.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="360"><rect width="1200" height="360" fill="steelblue"/></svg>');
    await source.fill('# Original text\n\n![Unspecified](assets/wide.svg)\n\nMiddle\n\n<figure data-munin-image="true" data-width="50" data-align="right"><img src="assets/wide.svg" alt="Configured"></figure>\n\nDrop here\n');
    await page.locator('#editor-mode-toggle').click();
    const rich = page.locator('#milkdown-editor .ProseMirror');
    const preview = page.frameLocator('#markdown-preview');
    const size = locator => locator.evaluate(img => {
      const {width, height} = img.getBoundingClientRect();
      return {width, height};
    });
    const compare = async (name, expected) => {
      const image = rich.getByAltText(name), rendered = preview.getByAltText(name);
      await rendered.waitFor();
      const editorSize = await size(image), previewSize = await size(rendered);
      assert.ok(editorSize.width > 100);
      assert.ok(Math.abs(editorSize.width - previewSize.width) < 2, JSON.stringify({editorSize, previewSize}));
      assert.ok(Math.abs(editorSize.height - previewSize.height) < 2, JSON.stringify({editorSize, previewSize}));
      if (expected) assert.ok(Math.abs(editorSize.width - expected.width) < 2);
      return editorSize;
    };
    await page.waitForFunction(() => [...document.querySelectorAll('.ProseMirror img')].filter(img => img.naturalWidth === 1200).length === 2);
    const unspecified = await compare('Unspecified');
    const configured = await compare('Configured');
    assert.ok(Math.abs(configured.width * 2 - unspecified.width) < 2);
    await rich.getByAltText('Configured').dragTo(rich.getByText('Middle', { exact: true }), {
      sourcePosition: { x: 10, y: 50 }, targetPosition: { x: 20, y: 2 },
    });
    const moved = await source.inputValue();
    assert.ok(moved.indexOf('data-width="50"') < moved.indexOf('Middle'), moved);
    await page.waitForFunction(() => {
      const body = document.querySelector('#markdown-preview').contentDocument?.body;
      const figure = body?.querySelector('figure[data-width="50"]');
      const middle = [...(body?.querySelectorAll('p') || [])].find(node => node.textContent === 'Middle');
      return !!(figure && middle && (figure.compareDocumentPosition(middle) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    await compare('Configured', configured);
    await rich.press('Control+s');
    await idle();
    assert.match(await readFile(path.join(root, 'docs/index.md'), 'utf8'), /data-width="50"/);
    assert.deepEqual(errors, []);
    console.log('Editor and preview use the same image size, including after drag and save.');
    break smoke;
  }
  if (process.argv.includes('--image-move-only')) {
    const rich = page.locator('#milkdown-editor .ProseMirror');
    await page.locator('button[data-editor-view="edit"]').click();
    await page.locator('#editor-mode-toggle').click();
    const source = page.locator('#markdown-editor');
    await writeFile(path.join(root, 'docs/assets/capture.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="110"><rect width="320" height="110" fill="#385b80"/></svg>');
    const original = '# Original text\n\n<!-- screenshot:ref id=test-shot -->\n![Capture](assets/capture.svg)\n<!-- /screenshot:ref -->\n\nBefore destination\n\nDrop here\n\nLast paragraph\n';
    await source.fill(original);
    await page.locator('#editor-mode-toggle').click();
    const image = rich.locator('.milkdown-image-block img');
    await page.waitForFunction(() => document.querySelector('.milkdown-image-block img')?.naturalWidth === 320);
    const destination = rich.getByText('Drop here', { exact: true });
    await image.dragTo(destination, { sourcePosition: { x: 10, y: 50 }, targetPosition: { x: 20, y: 2 } });
    const moved = await source.inputValue();
    assert.equal((moved.match(/assets\/capture\.svg/g) || []).length, 1, moved);
    assert.ok(moved.indexOf('Before destination') < moved.indexOf('assets/capture.svg'), moved);
    assert.match(moved, /<!-- screenshot:ref id=test-shot -->\s*!\[Capture\]\(assets\/capture\.svg\)\s*<!-- \/screenshot:ref -->/);
    const selectedImage = rich.locator('.milkdown-image-block.selected img');
    await selectedImage.waitFor();
    const editImageButton = page.locator('.milkdown-image-action-overlay .milkdown-image-edit-btn');
    await page.mouse.move(5, 5);
    await editImageButton.waitFor({state:'hidden'});
    const box = await selectedImage.boundingBox();
    await page.mouse.move(box.x + 20, box.y + box.height - 16);
    await editImageButton.waitFor({timeout:3000});
    await rich.locator('.milkdown-image-block.selected .operation').waitFor({state:'hidden'});
    await page.locator('.milkdown-image-action-overlay').getByRole('button',{name:'画像の表示設定'}).click();
    const presentation = page.locator('dialog[data-image-presentation]');
    await presentation.getByRole('textbox',{name:'画像のキャプション'}).waitFor();
    await presentation.press('Escape');
    await presentation.waitFor({state:'detached'});
    await rich.press('Control+s');
    await idle();
    assert.equal(await readFile(path.join(root, 'docs/index.md'), 'utf8'), moved);
    await rich.press('Control+z');
    const restored = await source.inputValue();
    assert.ok(restored.indexOf('assets/capture.svg') < restored.indexOf('Before destination'));
    assert.equal((restored.match(/assets\/capture\.svg/g) || []).length, 1);
    assert.deepEqual(errors, []);
    console.log('In-editor screenshot drag moves one image with its reference and supports Save and Undo.');
    break smoke;
  }
  if (process.argv.includes('--save-scroll-only')) {
    await page.locator('button[data-editor-view="split"]').click();
    const rich = page.locator('#milkdown-editor .ProseMirror');
    const source = page.locator('#markdown-editor');
    const body = Array.from({ length: 120 }, (_, index) => `Paragraph ${index + 1}`).join('\n\n');
    await rich.fill(body);
    for (const surface of [rich, source]) {
      if (surface === source) {
        await page.getByRole('button', { name: 'Markdownソース', exact: true }).click();
        await source.fill(body + '\n\nSource edit\n');
      }
      await surface.focus();
      await page.frameLocator('#markdown-preview').getByText(surface === rich ? 'Paragraph 120' : 'Source edit', { exact: true }).waitFor({ state: 'attached' });
      const before = await surface.evaluate(node => {
        node.scrollTop = 520;
        return node.scrollTop;
      });
      assert.ok(before > 400);
      await page.keyboard.press('Control+s');
      await page.waitForFunction(() => document.querySelector('#save-state').dataset.state === 'saved');
      await idle();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await surface.evaluate(node => node.scrollTop), before, `save preserves the ${surface === rich ? 'rich' : 'source'} editor viewport`);
      assert.match(await readFile(path.join(root, 'docs/index.md'), 'utf8'), /Paragraph 120/);
    }
    assert.deepEqual(errors, []);
    console.log('Save scroll smoke passed in rich and Markdown source modes.');
    break smoke;
  }
  if (process.argv.includes('--editor-splitter-only')) {
    await page.setViewportSize({ width: 2400, height: 850 });
    await page.locator('button[data-editor-view="split"]').click();
    const splitter = page.locator('#editor-resizer');
    assert.equal(await splitter.getAttribute('aria-valuenow'), '50', 'a new workspace starts with an even split');
    const richEditor = page.locator('#milkdown-editor .ProseMirror');
    await richEditor.fill(Array.from({ length: 100 }, (_, index) => `Line ${index + 1}`).join('\n'));
    for (const [editor, direction] of [[richEditor, 260], [page.locator('#markdown-editor'), -210]]) {
      if (direction < 0) await page.getByRole('button', { name: 'Markdownソース', exact: true }).click();
      const before = await splitter.boundingBox();
      await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
      await page.mouse.down();
      await page.mouse.move(before.x + direction, before.y + before.height / 2, { steps: 8 });
      const after = await splitter.boundingBox();
      const viewport = await editor.boundingBox();
      await page.mouse.up();
      assert.ok((after.x - before.x) * Math.sign(direction) > 100, 'splitter moved as dragged');
      if (direction > 0) assert.ok(after.x - viewport.x > 906, 'editor pane exceeds the old viewport width cap');
      assert.ok(Math.abs(viewport.x + viewport.width - after.x) <= 2, 'scroll viewport reaches the splitter');
      assert.ok(await editor.evaluate(node => {
        node.scrollTop = 120;
        return node.scrollTop > 0;
      }), 'editor viewport scrolls');
    }
    assert.deepEqual(errors, []);
    console.log('Editor splitter smoke passed in rich and Markdown source modes.');
    break smoke;
  }
  await page.locator('.ProseMirror p').filter({ hasText: 'Original text' }).click();
  await page.keyboard.press('End'); await page.keyboard.type(' rich edit');
  assert.match(await page.locator('#markdown-editor').inputValue(), /Original text rich edit/);
  const draft = await page.locator('#markdown-editor').inputValue();
  const external = path.join(root, 'generated.md');
  const renamed = path.join(root, 'renamed.md');
  await writeFile(external, '# Externally generated\n');
  await page.locator('#page-list [data-page="generated.md"]').waitFor({ state: 'attached', timeout: 12000 });
  await rename(external, renamed);
  await page.locator('#page-list [data-page="renamed.md"]').waitFor({ state: 'attached', timeout: 12000 });
  assert.equal(await page.locator('#page-list [data-page="generated.md"]').count(), 0);
  await rm(renamed);
  await page.locator('#page-list [data-page="renamed.md"]').waitFor({ state: 'detached', timeout: 12000 });
  assert.equal(await page.locator('#markdown-editor').inputValue(), draft);
  if (process.argv.includes('--file-tree-only')) {
    assert.deepEqual(errors, []);
    console.log('File tree smoke passed: external add, rename, delete, and draft preservation.');
    break smoke;
  }
  await page.locator('.milkdown-top-bar').getByRole('button', { name: '元に戻す', exact: true }).click();
  assert.doesNotMatch(await page.locator('#markdown-editor').inputValue(), /rich edit/);
  assert.match(await page.locator('#markdown-editor').inputValue(), /!\[Preview\]/, 'image survives text Undo');
  await page.locator('.milkdown-top-bar .top-bar-heading-button').filter({ hasText: '挿入・その他' }).click();
  await page.locator('.milkdown-top-bar').getByRole('button', { name: 'Mermaidの図を挿入', exact: true }).click();
  assert.match(await page.locator('#markdown-editor').inputValue(), /!\[Preview\]/, 'image survives diagram insertion');
  await page.locator('#milkdown-editor .mermaid-preview svg').waitFor();
  await page.frameLocator('#markdown-preview').locator('.mermaid-preview svg').waitFor();
  await page.locator('.milkdown-top-bar').getByRole('button', { name: '元に戻す', exact: true }).click();
  assert.match(await page.locator('#markdown-editor').inputValue(), /!\[Preview\]/, 'image survives diagram Undo');
  assert.equal(await page.locator('.milkdown-top-bar').getByRole('button', { name: /AIタグ/ }).count(), 0);
  assert.equal(await page.locator('.milkdown-top-bar').getByRole('button', { name: '撮影の指示', exact: true }).count(), 0);
  await page.getByRole("button", { name: "Markdownソース", exact: true }).click();
  const editorHeight = await page.locator('#markdown-editor').evaluate(node => node.clientHeight);
  assert.ok(editorHeight > 150, `editor must preserve vertical room: ${editorHeight}px`);

  const splitters = page.locator('.flexlayout__splitter');
  assert.ok(await splitters.count() > 0, 'FlexLayout splitters must exist');
  const firstSplitter = splitters.first();
  const bounds = await firstSplitter.boundingBox();
  if (bounds) {
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 10, bounds.y + bounds.height / 2);
    await page.mouse.up();
  }

  const editorResizer = page.locator('#editor-resizer');
  assert.ok(await editorResizer.count() > 0, '#editor-resizer must exist in unified editor pane');
  const resizerBounds = await editorResizer.boundingBox();
  if (resizerBounds) {
    await page.mouse.move(resizerBounds.x + resizerBounds.width / 2, resizerBounds.y + resizerBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizerBounds.x + resizerBounds.width / 2 + 10, resizerBounds.y + resizerBounds.height / 2);
    await page.mouse.up();
  }
  assert.equal(await page.locator('#panel-editor').isVisible(), true);
  await page.waitForFunction(() => {
    const images = [...(document.querySelector('#markdown-preview').contentDocument?.querySelectorAll('img') || [])];
    return images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0);
  });
  console.log("Smoke: editor and preview initialized");
  const sourceTool = key => page.locator(`.milkdown-top-bar [data-toolbar-key="${key}"]`);
  const originalMarkdown = await page.locator('#markdown-editor').inputValue();
  await page.locator('#markdown-editor').focus();
  await page.locator('#markdown-editor').evaluate(node => {
    const start = node.value.indexOf('Original text');
    node.setSelectionRange(start, start + 'Original text'.length);
  });
  await sourceTool('bold').click();
  assert.match(await page.locator('#markdown-editor').inputValue(), /\*\*Original text\*\*/);
  await page.frameLocator('#markdown-preview').locator('strong').filter({ hasText: 'Original text' }).waitFor();
  await sourceTool('undo').click();
  assert.equal(await page.locator('#markdown-editor').inputValue(), originalMarkdown);
  await sourceTool('redo').click();
  assert.match(await page.locator('#markdown-editor').inputValue(), /\*\*Original text\*\*/);
  await page.locator('#markdown-editor').press('Control+z');
  assert.equal(await page.locator('#markdown-editor').inputValue(), originalMarkdown);
  await page.locator('#markdown-editor').press('Control+y');
  assert.match(await page.locator('#markdown-editor').inputValue(), /\*\*Original text\*\*/);
  await sourceTool('undo').click();
  await sourceTool('italic').click();
  const afterItalic = await page.locator('#markdown-editor').inputValue();
  await sourceTool('redo').click();
  assert.equal(await page.locator('#markdown-editor').inputValue(), afterItalic);
  await (await sourceEditor(page)).fill(originalMarkdown);
  await page.locator('#markdown-editor').evaluate(node => {
    const start = node.value.indexOf('Original text');
    node.setSelectionRange(start, start + 'Original text'.length);
  });
  await sourceTool('link').click();
  assert.match(await page.locator('#markdown-editor').inputValue(), /\[Original text\]\(https:\/\/example\.com\)/);
  assert.equal(await page.locator('#markdown-editor').evaluate(node => node.value.slice(node.selectionStart, node.selectionEnd)), 'https://example.com');
  await (await sourceEditor(page)).fill(originalMarkdown);
  await page.locator('#markdown-editor').evaluate(node => node.setSelectionRange(node.value.length, node.value.length));
  await sourceTool('table').click();
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
  await sourceTool('table').click();
  assert.equal(await tableDialog.getByRole('textbox', { name: '行1・列1', exact: true }).inputValue(), '名前 | 種別');
  await tableDialog.getByRole('button', { name: '行3を削除', exact: true }).click();
  await tableDialog.getByRole('button', { name: '列3を削除', exact: true }).click();
  await tableDialog.locator('button[type="submit"]').click();
  assert.equal((await page.locator('#markdown-editor').inputValue()).includes('備考'), false);
  await sourceTool('undo').click();
  assert.equal((await page.locator('#markdown-editor').inputValue()).includes('備考'), true);
  await sourceTool('table').click();
  await tableDialog.locator('[data-table-cancel]').click();
  await (await sourceEditor(page)).fill(originalMarkdown);
  assert.equal(await page.locator('#page-list [data-page="docs/index.md"]').count(), 1);
  assert.equal(await page.locator('#page-list .tree-static[title="project.txt"]').count(), 1);
  assert.equal(await page.locator('#page-list [data-page="docs/z-guide/intro.md"]').count(), 1);
  await page.locator('#page-list details[data-folder="notes"] summary').click();
  await page.locator('#page-list [data-page="notes/extra.md"]').click();
  await page.waitForFunction(() => document.querySelector('#unsaved-changes-dialog') || document.body.getAttribute('aria-busy') === 'false');
  if (await page.locator('#unsaved-changes-dialog').count()) await page.locator('[data-unsaved-action=discard]').click();
  await idle();
  assert.match(await page.locator('#markdown-editor').inputValue(), /Project note/);
  const openedNote = await page.locator('#markdown-editor').inputValue();
  await sourceTool('undo').click();
  assert.equal(await page.locator('#markdown-editor').inputValue(), openedNote);
  const originalNote = await page.locator('#markdown-editor').inputValue();
  await (await sourceEditor(page)).fill(originalNote + '\nUnsaved dialog check\n');
  await page.locator('#page-list [data-page="docs/index.md"]').click();
  await idle();
  assert.equal(await page.locator('#unsaved-changes-dialog').count(), 0, 'tab switches retain drafts without a discard prompt');
  await page.locator('#page-list [data-page="notes/extra.md"]').click();
  await idle();
  assert.match(await page.locator('#markdown-editor').inputValue(), /Unsaved dialog check/);
  assert.equal(await readFile(path.join(root, 'notes/extra.md'), 'utf8'), originalNote, 'switching tabs retains the draft without writing to disk');
  await (await sourceEditor(page)).fill(originalNote + '\nUnsaved dialog check\nPending close edit\n');
  await page.getByRole('button', { name: 'notes/extra.mdを閉じる', exact: true }).click();
  assert.equal(await page.locator('#unsaved-changes-dialog button').count(), 3);
  await page.locator('[data-unsaved-action=cancel]').click();
  await idle();
  assert.match(await page.locator('#markdown-editor').inputValue(), /Unsaved dialog check/);
  assert.equal(await readFile(path.join(root, 'notes/extra.md'), 'utf8'), originalNote, 'cancelling close preserves the unsaved draft without saving');
  await page.getByRole('button', { name: 'notes/extra.mdを閉じる', exact: true }).click();
  await page.locator('[data-unsaved-action=save]').click();
  await idle();
  assert.match(await readFile(path.join(root, 'notes/extra.md'), 'utf8'), /Unsaved dialog check/);
  await page.locator('#page-list [data-page="notes/extra.md"]').click();
  await idle();
  await (await sourceEditor(page)).fill('This change must be discarded');
  await page.getByRole('button', { name: 'notes/extra.mdを閉じる', exact: true }).click();
  await page.locator('[data-unsaved-action=discard]').click();
  await idle();
  assert.match(await readFile(path.join(root, 'notes/extra.md'), 'utf8'), /Unsaved dialog check/);
  await page.locator('#page-list [data-page="docs/index.md"]').click();
  await idle();
  await page.locator('#page-list details[data-folder="docs/z-guide"] summary').click();
  assert.equal(await page.locator('#page-list [data-image="docs/z-guide/diagram.svg"]').count(), 1);
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
    if (holdOldDocumentRead && request.action === 'editor-read' && request.root === root && request.options.page === 'index.md') {
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
  await idle();
  await page.evaluate(() => window.__manualStudioRaceTest.openPage('docs/index.md', false));
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('Original text'));
  await idle();

  // Navigation waits for an in-flight save before changing the editor owner.
  const oldSavePage = await page.evaluate(() => window.__manualStudioRaceTest.documentState.page);
  const newerPage = await page.locator('#page-list [data-page]').evaluateAll(nodes => nodes.map(node => node.dataset.page).find(candidate => candidate?.endsWith('/intro.md')));
  assert.ok(newerPage, 'fixture project must expose its nested guide page');
  await (await sourceEditor(page)).fill('# Save response from old document\n');
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
  await page.evaluate(pagePath => { window.__navigationAfterSave = window.__manualStudioRaceTest.openPage(pagePath, false); }, newerPage);
  assert.equal(await page.evaluate(() => window.__manualStudioRaceTest.documentState.page), oldSavePage, 'navigation retains the old editor until its save completes');
  releaseOldSave();
  await page.evaluate(() => Promise.all([window.__oldSaveResponse, window.__navigationAfterSave]));
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('Nested guide'));
  assert.match(await page.locator('#markdown-editor').inputValue(), /Nested guide/);
  assert.equal(await page.locator('#editor-title').textContent(), newerPage.replace(/^docs\//, ''));
  assert.match(await readFile(path.join(root, 'docs/index.md'), 'utf8'), /Save response from old document/);
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
  await (await sourceEditor(page)).fill('# User edit during refresh\n');
  releaseRefreshRead();
  await page.evaluate(() => window.__pendingWorkspaceRefresh);
  assert.equal(await page.locator('#markdown-editor').inputValue(), '# User edit during refresh\n');
  assert.equal(await page.locator('#save-state').getAttribute('data-state'), 'dirty');
  await page.unroute('**/__manual/rpc');

  const longDraft = Array.from({ length: 120 }, (_, index) => `Paragraph ${index + 1}: scroll synchronization check.\n\n`).join('');
  await (await sourceEditor(page)).fill(`# Long draft\n\n${longDraft}`);
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
  await (await sourceEditor(page)).fill('# Edited guide\n\n**Saved content**\n');
  await page.keyboard.press('Control+s');
  await idle();
  assert.match(await readFile(path.join(root, 'docs/index.md'), 'utf8'), /Saved content/);
  await page.frameLocator('#markdown-preview').locator('strong').waitFor();
  assert.equal(await page.locator('[data-tab="tasks"]').count(), 0);
  assert.equal(await page.locator('#generate-all-pages').count(), 0);
  const openAiSettings = async () => {
    await page.locator('#application-settings').click();
    await page.locator('#settings-tab-text-ai').click();
  };
  await openAiSettings();
  assert.ok(['codex', 'claude', 'grok', 'agy'].includes(await page.locator('#ai-agent').inputValue()));
  // Saving a choice does not require running that CLI on the smoke machine.
  await page.locator('#ai-connection-type').selectOption('cli');
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
  await openAiSettings();
  assert.equal(await page.locator('#panel-settings #docs-path').count(), 0, 'workspace paths are not in AI settings');
  await page.locator('[data-close-dialog="panel-settings"]').click();
  assert.equal(await page.locator('#project-menu,#workspace-settings-dialog').count(),0);
  await openAiSettings();
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
  if(!await page.locator('#editor-more').evaluate(el=>el.open)) await page.locator('#editor-more > summary').click();

  await page.getByRole('button',{name:'執筆方針',exact:true}).click();
  await page.locator('#manual-brief').fill('初めて使う読者向けの操作説明');
  await page.waitForFunction(()=>document.querySelector('#brief-save-state').textContent==='保存済み');await idle();
  assert.match(await readFile(path.join(root,'manual/brief.md'),'utf8'),/初めて使う読者/);
  assert.equal(JSON.parse(await readFile(path.join(root,'manual_setting.json'),'utf8')).model,'retry-test-model');
  await page.locator('[data-close-dialog=panel-brief]').click();
  await page.locator('[data-tab="editor"]').click();

  const popupPromise = page.waitForEvent('popup');
  await page.locator('#editor-more summary').click();
  await page.locator('#detach-editor').click();
  const popup = await popupPromise;
  await popup.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('Saved content'));
  await idle(popup);
  await popup.waitForSelector("#milkdown-editor .ProseMirror");
  await popup.getByRole("button", { name: "Markdownソース", exact: true }).click();
  await (await sourceEditor(popup)).fill('# Updated in another window\n');
  await popup.keyboard.press('Control+s');
  await idle(popup);
  await (await sourceEditor(page)).fill('# Stale edit\n');
  await page.keyboard.press('Control+s');
  await idle();
  assert.match(await page.locator('#status').innerText(), /原稿が更新/);
  assert.equal(await readFile(path.join(root, 'docs/index.md'), 'utf8'), '# Updated in another window\n');
  await page.locator('#editor-more summary').click();
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

  await page.locator('#tree-create-menu>summary').click();
  await page.locator('#new-page').click();
  await page.locator('#new-page-path').fill('new.md');
  await page.locator('#new-page-title').fill('New guide');
  await page.locator('#new-page-form button[type=submit]').click();
  await idle();
  assert.match(await readFile(path.join(root, 'empty/new.md'), 'utf8'), /# New guide/);
  const project = path.join(root, 'empty');
  await assert.rejects(access(path.join(project,'docs')),{code:'ENOENT'});
  await assert.rejects(access(path.join(project,'manual')),{code:'ENOENT'});

  const generatedPrompt = '画面を開いてからボタンを押す';
  const generatedPromptB64 = Buffer.from(generatedPrompt, 'utf8').toString('base64');
  const generatedExample = `# New guide\n\n<!-- ai:generated id=smoke-generated kind=text prompt-b64=${generatedPromptB64} -->\nGenerated text\n<!-- /ai:generated -->\n`;
  await (await sourceEditor(page)).fill(generatedExample);
  let delayedSaveSeen = false;
  await page.route('**/__manual/rpc', async route => {
    const request = route.request().postDataJSON();
    if (!delayedSaveSeen && request.action === 'editor-save' && request.root === project) {
      delayedSaveSeen = true;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await route.continue();
  });
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'true');
  await idle();
  assert.equal(delayedSaveSeen, true);
  const savedMarkdown = await page.locator('#markdown-editor').inputValue();
  await sourceTool('undo').click();
  assert.notEqual(await page.locator('#markdown-editor').inputValue(), savedMarkdown, 'saving must preserve undo history');
  await sourceTool('redo').click();
  await page.unroute('**/__manual/rpc');

  let generatedOnlyMarkdown = await readFile(path.join(project, 'new.md'), 'utf8');
  assert.doesNotMatch(generatedOnlyMarkdown, /ai:generated/);
  assert.doesNotMatch(generatedOnlyMarkdown, /ai:task/);
  assert.match(generatedOnlyMarkdown, /Generated text/);
  assert.equal(await page.locator('[data-tab="tasks"]').count(), 0);

  if (!await page.locator('#markdown-editor').isVisible()) {
    await page.getByRole("button", { name: "Markdownソース", exact: true }).click();
  }
  const unifiedPrompt = '初心者向け &quot;保存&quot;&#10;approved-at=fake を説明';
  const unifiedBlock = `<!-- ai:task id=unified-guide kind=text prompt="${unifiedPrompt}" -->\nGenerated unified body\n<!-- /ai:task -->`;
  await (await sourceEditor(page)).fill(`# New guide\n\n${unifiedBlock}\n\nKeep manual text\n`);
  await page.locator('#editor-mode-toggle[aria-pressed=true]').click();
  await page.waitForSelector('#milkdown-editor .ProseMirror');
  assert.equal(await page.locator('.milkdown-ai-task').count(), 0, 'AI task controls are omitted');
  assert.equal(await page.locator('.ProseMirror p').filter({ hasText: 'Generated unified body' }).count(), 1);
  await page.getByRole("button", { name: "Markdownソース", exact: true }).click();
  await page.keyboard.press('Control+s');
  await idle();
  let unifiedMarkdown = await readFile(path.join(project, 'new.md'), 'utf8');
  assert.doesNotMatch(unifiedMarkdown, /ai:task/);
  assert.doesNotMatch(unifiedMarkdown, /ai:generated/);
  assert.match(unifiedMarkdown, /Generated unified body/);
  assert.match(unifiedMarkdown, /Keep manual text/);

  await (await sourceEditor(page)).fill('# New guide\n\n');

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
  const toolbarFile = await readFile(path.join(project, 'assets/toolbar-shot.png'));
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
  const pastedFile = await readFile(path.join(project, pastedRelPath));
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
  const droppedFile = await readFile(path.join(project, 'assets/dropped-shot.png'));
  assert.equal(droppedFile.subarray(1, 4).toString(), 'PNG');
  await page.frameLocator('#markdown-preview').locator('img[alt="dropped-shot"]').waitFor();

  await page.locator('[data-tab="screenshots"]').click();
  assert.equal(await page.locator('#screenshot-library-import-button').isVisible(),true);
  await page.locator('[data-tab="editor"]').click();
  await page.keyboard.press('Control+s');
  await idle();
  await page.locator('[data-tab="publish"]').click();
  assert.equal(await page.locator('#build-html,#build-mode,#open-output').count(),0);
  await page.locator('#quality-check').click();await idle();
  await writeFile(path.join(project, 'ai-page.md'), '# AI page\n\n<!-- ai:task id=smoke-text kind=text\nExplain the guide\n-->\n');
  await page.locator('#open-existing-workspace').click();
  await page.locator('#project-root').fill(project);
  await page.locator('#project-form button[type=submit]').click();
  await idle();
  // Generation itself is mocked below; choose a configured connection without
  // depending on an AI CLI being installed on the machine running this smoke.
  await page.locator('[data-tab="settings"]').dispatchEvent('click');
  await page.locator('#ai-connection-type').selectOption('local_llm');
  await page.locator('#ai-model').fill('smoke-generation-model');
  await page.locator('#ai-endpoint-url').fill('http://127.0.0.1:11434/v1');
  await page.waitForFunction(() => document.querySelector('#ai-save-state').textContent === '保存済み');
  await page.locator('[data-close-dialog="panel-settings"]').click();
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
  await idle();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'midnight' && document.querySelector('#ui-theme')?.value === 'midnight');
  assert.equal(await page.locator('html').evaluate(node => getComputedStyle(node).colorScheme), 'dark');
  await assertPreviewTheme();
  await page.locator('[data-tab="appearance"]').click();
  await page.locator('#ui-theme').selectOption('blue');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'blue');
  assert.equal(await page.locator('html').evaluate(node => getComputedStyle(node).getPropertyValue('--app-bg').trim()), '#f5f8fc');
  assert.equal(await page.evaluate(() => localStorage.getItem('manual-studio-theme')), 'blue');
  assert.equal(await page.locator('#new-workspace, #new-workspace-dialog, #project-menu, #workspace-settings-dialog').count(), 0);

  // Verify AI terminal dock and controls
  const closePublishBtn = page.locator('#panel-publish [data-close-dialog]');
  if (await closePublishBtn.isVisible()) await closePublishBtn.click();
  const closeAiSettingsBtn = page.locator('#panel-settings [data-close-dialog]');
  if (await closeAiSettingsBtn.isVisible()) await closeAiSettingsBtn.click();
  assert.equal(await page.locator('#panel-terminal').isVisible(), false, "AI terminal is hidden by default");
  await page.locator('#view-menu-button').click();
  await page.locator('#view-menu-dropdown label').filter({ hasText: "AIターミナル" }).locator('input').check();
  await page.locator('#view-menu-button').click();
  await page.locator('#panel-terminal').waitFor({ state: 'visible' });
  await page.locator('#terminal-container .xterm').waitFor({ state: 'visible' });
  const terminalBg = await page.locator('#panel-terminal').evaluate(node => node.style.backgroundColor);
  assert.ok(terminalBg && terminalBg !== 'rgb(255, 255, 255)' && terminalBg !== '#ffffff', `terminal background (${terminalBg}) must match theme and not be white`);
  assert.equal(await page.locator('#terminal-connect-btn').isVisible(), true);
  assert.equal(await page.locator('#terminal-clear-btn').isVisible(), true);
  assert.match(await page.locator('#terminal-badge').innerText(), /未接続/);
  assert.equal(await page.locator('#terminal-connect-btn').isDisabled(), false);
  await page.locator('#terminal-clear-btn').click();
  await page.locator('#terminal-connect-btn').click();
  await page.waitForTimeout(500);

  await page.locator('#terminal-connect-btn').click();
  await page.waitForFunction(() => document.querySelector('#terminal-badge').textContent.includes('未接続'));


  assert.deepEqual(errors, []);
  console.log(`Manual Studio smoke passed: edit, bidirectional scroll sync, folder dropdown, preview, save, detached conflict, project switch, screenshot library, new page, AI terminal, manuscript check.`);
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill();
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}
