import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { beginVerification, finishVerification } from './lib/manual_ui_report.mjs';
import { fingerprint } from './lib/manual_ui_inventory.mjs';

const start = await beginVerification();
const resultDirectory = 'ui-coverage-results/managed-insertion';
await rm(`${resultDirectory}/result.json`, { force: true });
const root = await mkdtemp(path.join(os.tmpdir(), 'munin-managed-insertion-'));
const base = 'http://127.0.0.1:5174';
const initial = '# Insertion\n\nBefore text.\n\nAfter text.\n';
const other = '# Other\n\nOther body.\n';
const cursor = initial.indexOf('After');
const routes = [
  { id: 'P03.imported-card', record: 'imported resource card', kind: 'imported' },
  { id: 'P11.generated-card', record: 'generated resource card', kind: 'generated' },
  { id: 'P04.screenshot-card', record: 'screenshot resource card', kind: 'screenshot' },
  { id: 'P11.editor-dialog', record: 'editor image generation dialog', kind: 'drawing', opener: 'generate-ai-image' },
  { id: 'P11.resource-dialog', record: 'resource image generation dialog', kind: 'drawing', opener: 'resource-generate-image' },
];
let failGeneration = false;
let server, browser, api, failRead = '', failReference = false, holdReference = false, referenceStarted, releaseReference, holdExistingList = false, existingListStarted, releaseExistingList;
const records = [], pageErrors = [];
try {
  await mkdir(path.join(root, 'docs/assets'), { recursive: true });
  await writeFile(path.join(root, 'docs/index.md'), initial);
  for (const route of routes) await writeFile(path.join(root, `docs/${route.id}.md`), other);
  await writeFile(path.join(root, 'manual_setting.json'), JSON.stringify({ docs: 'docs', assets: 'docs/assets', targets: ['docs'], connection_type: 'none' }));
  const png = await readFile('apps/manual-studio/src-tauri/icons/icon.png');
  await writeFile(path.join(root, 'docs/assets/imported.png'), png);
  api = createServer(async (request, response) => {
    for await (const ignored of request) { /* Consume the fixture request. */ }
    assert.equal(request.headers.authorization, 'Bearer fixture-key');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  server = spawn(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), '--config', 'apps/manual-studio/vite.config.ts', '--strictPort'], { stdio: 'ignore' });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch { /* Wait for Vite. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'fixture server must start');
  async function rpc(action, options = {}) {
    const response = await fetch(`${base}/__manual/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root, action, options }) });
    const result = await response.json();
    if (result.error) throw Error(result.error);
    return result.output;
  }
  await rpc('screenshots-register', { json: { name: 'Insertion fixture', source: `data:image/png;base64,${png.toString('base64')}`, recipe: { steps: [] } } });
  const screenshots = JSON.parse(await rpc('screenshots-list')).items;
  const screenshot = screenshots[0];
  assert.ok(screenshot.adopted);
  await rpc('image-generation-settings', { json: { save: true, provider: 'api', model: 'fixture', endpoint: `http://127.0.0.1:${api.address().port}/images/generations` } });
  const generated = JSON.parse(await rpc('image-generate', { json: { prompt: 'Insertion fixture drawing', provider: 'api', api_key: 'fixture-key' } }));
  const assetPaths = ['docs/assets/imported.png', generated.path, screenshot.output];
  const assetHashes = new Map(await Promise.all(assetPaths.map(async asset => [asset, fingerprint(await readFile(path.join(root, asset)))])));
  const originalScreenshot = JSON.parse(await rpc('screenshots-image', { id: screenshot.id, json: { original: true } })).data;
  let generationHistory = await rpc('image-generation-history');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/__manual/rpc', async route => {
    const request = route.request().postDataJSON();
    if (request.action === 'image-generate' && failGeneration) {
      await route.fulfill({ json: { error: 'Fixture generation unavailable' } });
    } else if (request.action === 'screenshots-list' && holdExistingList) {
      holdExistingList = false; existingListStarted(); await new Promise(resolve => releaseExistingList = resolve); await route.continue();
    } else if (request.action === 'editor-read' && request.options.page === failRead) {
      await route.fulfill({ json: { error: 'Fixture destination unavailable' } });
    } else if (request.action === 'screenshots-reference' && holdReference) {
      referenceStarted(); await new Promise(resolve => releaseReference = resolve); await route.continue();
    } else if (request.action === 'screenshots-reference' && failReference) {
      await route.fulfill({ json: { error: 'Fixture reference unavailable' } });
    } else if (request.action === 'image-generation-capabilities') {
      await route.fulfill({ json: { output: JSON.stringify({ items: [{ provider: 'api', installed: true, login: 'configured', image: 'available', message: 'Local fixture provider' }] }) } });
    } else await route.continue();
  });
  await page.goto(`${base}/?root=${encodeURIComponent(root)}&page=index.md`);
  const editor = page.locator('#markdown-editor');
  const destination = page.locator('[data-screenshot-destination]');
  const drawing = page.locator('[data-ai-image]');
  const idle = () => page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('Before text.'));
  await idle();
  await page.getByRole('button', { name: 'Markdownソース', exact: true }).click();
  function assertReference(content, asset) {
    const match = content.match(/!\[[^\]]*\]\((?:<([^>]+)>|([^\)\s]+))/);
    assert.ok(match, 'inserted manuscript must contain an image reference');
    assert.equal(path.posix.normalize(`docs/${match[1] || match[2]}`), asset, 'saved reference must identify the selected asset');
  }
  const routeAsset = route => route.kind === 'imported' ? 'docs/assets/imported.png' : route.kind === 'screenshot' ? screenshot.output : generated.path;
  async function saveContent(expected) {
    await editor.press('Control+s');
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await readFile(path.join(root, 'docs', await page.locator('#editor-title').textContent()), 'utf8') === expected) { await idle(); return; }
      await page.waitForTimeout(50);
    }
    assert.fail('visible manuscript must reach the actual file');
  }
  async function openDocument(name) {
    await page.locator('[data-tab=editor]').click();
    const tab = page.locator(`[data-document-page="${name}"]`);
    if (await tab.count()) await tab.click();
    else { await page.locator('.flexlayout__tab_button').filter({ hasText: 'ファイルツリー' }).click(); await page.locator('#tree-search').fill(name); await page.locator(`[data-page="docs/${name}"]`).click(); await page.locator('#tree-search').fill(''); }
    await page.waitForFunction(name => document.querySelector('#editor-title').textContent === name, name);
    await idle();
  }
  async function reset() {
    await openDocument('index.md');
    assert.equal(await editor.inputValue(), initial);
    await editor.evaluate((node, cursor) => { node.focus(); node.setSelectionRange(cursor, cursor); }, cursor);
  }
  async function openRoute(route) {
    if (route.kind === 'drawing') {
      if (route.opener === 'resource-generate-image') await page.locator('[data-tab=screenshots]').click();
      else await page.locator('[data-tab=editor]').click();
      await page.locator(`#${route.opener}`).click(); await idle();
      await drawing.getByRole('button', { name: '作画履歴: Insertion fixture drawing', exact: true }).click();
      await drawing.getByRole('button', { name: '原稿に挿入', exact: true }).waitFor();
      await drawing.getByRole('button', { name: '原稿に挿入', exact: true }).click();
    } else {
      await page.locator('[data-tab=screenshots]').click();
      const asset = route.kind === 'imported' ? 'docs/assets/imported.png' : route.kind === 'generated' ? generated.path : screenshot.output;
      const card = page.locator(`[data-resource-path="${asset}"]`);
      if (!await card.locator('.resource-item-menu').evaluate(node => node.open)) await card.locator('.resource-item-menu>summary').click();
      await card.getByRole('button', { name: '文書に挿入', exact: true }).click();
    }
    await destination.waitFor();
  }
  async function reopenRoute(route) {
    if (route.kind === 'drawing' && await drawing.count()) await drawing.getByRole('button', { name: '原稿に挿入', exact: true }).click();
    else await openRoute(route);
    await destination.waitFor();
  }
  async function closeDrawing() {
    if (await drawing.count()) await drawing.locator('.panel-header').getByRole('button', { name: '閉じる', exact: true }).click();
  }
  const generationFormSteps = new Map();
  for (const route of routes.filter(route => route.kind === 'drawing')) {
    await reset();
    await page.locator(`[data-tab=${route.opener === 'resource-generate-image' ? 'screenshots' : 'editor'}]`).click();
    await page.locator(`#${route.opener}`).click(); await idle();
    const promptText = `Form fixture ${route.id}`;
    await drawing.getByRole('textbox', { name: '画像の指示', exact: true }).fill(promptText);
    await drawing.locator('details summary').click();
    await drawing.getByLabel('外部画像APIキー（保存しません）', { exact: true }).fill('fixture-key');
    failGeneration = true;
    await drawing.getByRole('button', { name: '画像を生成', exact: true }).click();
    await drawing.getByRole('status').filter({ hasText: 'Fixture generation unavailable' }).waitFor(); await idle();
    assert.equal(await editor.inputValue(), initial);
    assert.equal(await drawing.getByRole('textbox', { name: '画像の指示', exact: true }).inputValue(), promptText);
    failGeneration = false;
    await drawing.getByRole('button', { name: '再試行', exact: true }).click();
    await drawing.getByRole('button', { name: '原稿に挿入', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-ai-image] .actions button:nth-child(4)').disabled); await idle();
    await drawing.getByRole('button', { name: '原稿に挿入', exact: true }).click(); await destination.waitFor();
    await destination.getByRole('button', { name: '閉じる', exact: true }).click(); await idle();
    assert.equal(await drawing.getByRole('textbox', { name: '画像の指示', exact: true }).inputValue(), promptText);
    assert.equal(await editor.inputValue(), initial); assert.equal(await editor.evaluate(node => node.selectionStart), cursor);
    await drawing.getByRole('button', { name: '原稿に挿入', exact: true }).click(); await destination.waitFor();
    await destination.getByRole('button', { name: 'ここに挿入', exact: true }).click(); await idle();
    const content = await editor.inputValue();
    assert.equal((content.match(/!\[/g) || []).length, 1);
    assert.ok(content.startsWith(initial.slice(0, cursor))); assert.ok(content.endsWith(initial.slice(cursor)));
    const history = JSON.parse(await rpc('image-generation-history')).items;
    const formImage = history.find(entry => entry.prompt === promptText && entry.path); assert.ok(formImage);
    assertReference(content, formImage.path);
    const savedPng = await readFile(path.join(root, formImage.path));
    assert.deepEqual(savedPng.subarray(0, 8), png.subarray(0, 8));
    assert.equal(await page.evaluate(async sources => {
      const pixels = await Promise.all(sources.map(async source => {
        const image = new Image(); image.src = `data:image/png;base64,${source}`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); return canvas.toDataURL();
      })); return pixels[0] === pixels[1];
    }, [savedPng.toString('base64'), png.toString('base64')]), true, 'backend PNG reencoding preserves fixture pixels');
    assetHashes.set(formImage.path, fingerprint(savedPng));
    await saveContent(content); await editor.press('Control+z'); assert.equal(await editor.inputValue(), initial); await saveContent(initial);
    generationFormSteps.set(route.id, ['open independent generation form', 'enter prompt once', 'inject generation failure and retain prompt/manuscript', 'visible retry generates actual PNG', 'cancel insertion and retain generated preview/prompt/cursor', 'reopen selected generated image without regeneration', 'insert exactly once at original cursor', 'verify actual PNG and saved manuscript', 'Undo and save restored manuscript']);
    await closeDrawing();
  }
  generationHistory = await rpc('image-generation-history');
  for (const route of routes) {
    await reset(); await openRoute(route);
    await destination.getByRole('button', { name: '閉じる', exact: true }).click(); await idle();
    assert.equal(await editor.inputValue(), initial);
    assert.equal(await editor.evaluate(node => node.selectionStart), cursor);
    assert.equal(await readFile(path.join(root, 'docs/index.md'), 'utf8'), initial);
    if (route.kind === 'drawing') {
      assert.equal(await drawing.isVisible(), true, 'cancel returns to the drawing dialog');
      assert.equal(await drawing.getByRole('textbox', { name: '画像の指示', exact: true }).inputValue(), generated.prompt);
      assert.equal(await drawing.getByRole('button', { name: '原稿に挿入', exact: true }).isEnabled(), true);
    }
    if (route.kind !== 'drawing') assert.equal(await page.locator('#screenshot-library-list').isVisible(), true, 'cancel returns to the resource list');
    await reopenRoute(route); await page.keyboard.press('Escape'); await idle();
    assert.equal(await editor.inputValue(), initial);
    await reopenRoute(route);
    failRead = `${route.id}.md`;
    await destination.getByRole('combobox', { name: '挿入先の原稿', exact: true }).selectOption(failRead);
    await destination.getByRole('status').filter({ hasText: 'Fixture destination unavailable' }).waitFor();
    assert.equal(await destination.getByRole('button', { name: 'ここに挿入', exact: true }).isDisabled(), true);
    assert.equal(await editor.inputValue(), initial);
    failRead = '';
    await destination.getByRole('combobox', { name: '挿入先の原稿', exact: true }).selectOption('index.md');
    await destination.getByRole('button', { name: 'ここに挿入', exact: true }).click(); await idle();
    const inserted = await editor.inputValue();
    assertReference(inserted, routeAsset(route));
    assert.ok(inserted.startsWith(initial.slice(0, cursor)));
    assert.ok(inserted.endsWith(initial.slice(cursor)));
    assert.equal((inserted.match(/!\[/g) || []).length, 1, 'one insertion after cancel and retry');
    await saveContent(inserted);
    await editor.press('Control+z'); assert.equal(await editor.inputValue(), initial); await saveContent(initial);
    if (route.kind === 'screenshot') {
      failReference = true;
      await reopenRoute(route); await destination.getByRole('button', { name: 'ここに挿入', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Fixture reference unavailable') && document.body.getAttribute('aria-busy') === 'false');
      assert.equal(await editor.inputValue(), initial);
      failReference = false;
      await reopenRoute(route); await destination.getByRole('button', { name: 'ここに挿入', exact: true }).click(); await idle();
      assert.equal((await editor.inputValue()).match(/<!-- screenshot:ref id=/g).length, 1);
      await editor.press('Control+z'); assert.equal(await editor.inputValue(), initial); await saveContent(initial);
    }
    await closeDrawing(); await reset(); await openRoute(route);
    await destination.getByRole('combobox', { name: '挿入先の原稿', exact: true }).selectOption(`${route.id}.md`);
    await page.waitForFunction(() => !document.querySelector('[data-screenshot-destination] button.primary').disabled);
    await destination.getByRole('combobox', { name: '挿入先の位置', exact: true }).selectOption('0');
    await destination.getByRole('button', { name: 'ここに挿入', exact: true }).click(); await idle();
    assert.equal(await page.locator('#editor-title').textContent(), `${route.id}.md`);
    const otherInserted = await editor.inputValue();
    assertReference(otherInserted, routeAsset(route));
    assert.ok(otherInserted.startsWith('# Other\n')); assert.ok(otherInserted.endsWith('\nOther body.\n'), JSON.stringify(otherInserted));
    assert.equal((otherInserted.match(/!\[/g) || []).length, 1);
    assert.equal(await readFile(path.join(root, 'docs/index.md'), 'utf8'), initial);
    await saveContent(otherInserted); await editor.press('Control+z'); assert.equal(await editor.inputValue(), other); await saveContent(other);
    await closeDrawing(); await openDocument('index.md');
    assert.equal(await editor.evaluate(node => node.selectionStart), cursor, 'returning from another manuscript restores the original cursor');
    await reset();
    for (const [asset, hash] of assetHashes) assert.equal(fingerprint(await readFile(path.join(root, asset))), hash);
    assert.equal(JSON.parse(await rpc('screenshots-image', { id: screenshot.id, json: { original: true } })).data, originalScreenshot);
    assert.equal(await rpc('image-generation-history'), generationHistory);
    records.push({ entry: route.record, caseId: route.id, steps: [...(generationFormSteps.get(route.id) || []), 'open at same source cursor', 'close destination and preserve manuscript/cursor', 'reopen and Escape', 'inject destination read failure', 'retain parent image selection and prompt', 'select original manuscript and retry without regeneration', 'insert once at original cursor', 'verify saved reference identifies the selected asset', 'save and read actual manuscript', 'Undo and save original content', 'choose another manuscript and heading', 'save separate manuscript without changing original', 'Undo and return to original manuscript/cursor', ...(route.kind === 'screenshot' ? ['inject reference failure and preserve manuscript', 'reopen same screenshot and retry without duplicate reference', 'Undo retry'] : []), 'verify immutable asset bytes, original screenshot, and generation history'], assertions: { visible: true, stored: true, preserved: true, returnTarget: true }, workflow: { destinationOpenings: route.kind === 'screenshot' ? 6 : 4, destinationCancellations: 2, failedLoads: 1, generatedAgain: 0, repeatedPromptInputs: 0, insertions: route.kind === 'screenshot' ? 3 : 2, undo: route.kind === 'screenshot' ? 3 : 2, ...(route.kind === 'drawing' ? { generationForm: { promptInputs: 1, failedGenerationAttempts: 1, visibleRetries: 1, successfulGenerationAttempts: 1, generationsAfterInsertionCancel: 0 } } : {}) } });
    console.log(`PASS ${route.record}: cancel, failed destination retry, original cursor, alternate manuscript, save, Undo, asset/history retention`);
  }
  const payloads = new Map();
  for (const kind of ['imported', 'generated', 'screenshot']) {
    await reset(); await page.locator('[data-tab=screenshots]').click();
    const asset = kind === 'imported' ? 'docs/assets/imported.png' : kind === 'generated' ? generated.path : screenshot.output;
    const image = page.locator(`[data-resource-path="${asset}"]`).locator('img').first();
    const payload = await image.evaluate(image => { const data = new DataTransfer(); image.dispatchEvent(new DragEvent('dragstart', { dataTransfer: data, bubbles: true })); image.dispatchEvent(new DragEvent('dragend', { dataTransfer: data, bubbles: true })); return data.getData('application/x-munin-image'); });
    payloads.set(kind, payload); assert.equal(JSON.parse(payload).path, asset);
    assert.equal(await editor.inputValue(), initial, 'ending a drag without dropping preserves the manuscript');
    await page.locator('[data-tab=editor]').click();
    await editor.evaluate((node, { payload, cursor }) => { node.focus(); node.setSelectionRange(cursor, cursor); const data = new DataTransfer(); data.setData('application/x-munin-image', payload); node.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true })); }, { payload, cursor });
    await page.waitForFunction(() => document.querySelector('#status').textContent === '画像の参照を挿入しました。' && document.body.getAttribute('aria-busy') === 'false');
    const value = await editor.inputValue(); assertReference(value, asset); assert.ok(value.startsWith(initial.slice(0, cursor))); assert.ok(value.endsWith(initial.slice(cursor)));
    assert.equal((value.match(/!\[/g) || []).length, 1); await saveContent(value);
    await editor.press('Control+z'); assert.equal(await editor.inputValue(), initial); await saveContent(initial);
  }
  const dropScreenshot = () => editor.evaluate((node, { payload, cursor }) => { node.focus(); node.setSelectionRange(cursor, cursor); const data = new DataTransfer(); data.setData('application/x-munin-image', payload); node.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true })); }, { payload: payloads.get('screenshot'), cursor });
  await reset(); failReference = true; await dropScreenshot();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Fixture reference unavailable') && document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await editor.inputValue(), initial); failReference = false; await dropScreenshot();
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('screenshot:ref') && document.body.getAttribute('aria-busy') === 'false');
  assert.equal((await editor.inputValue()).match(/<!-- screenshot:ref id=/g).length, 1);
  await editor.press('Control+z'); assert.equal(await editor.inputValue(), initial); await saveContent(initial);
  await reset(); holdReference = true; const pendingReference = new Promise(resolve => referenceStarted = resolve); await dropScreenshot();
  await Promise.race([pendingReference, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Reference request did not start')), 10000); timer.unref(); })]);
  assert.equal(await editor.evaluate(node => node.readOnly), true, 'reference loading prevents manuscript edits');
  assert.equal(await page.locator('[data-document-page="index.md"]').isDisabled(), true, 'reference loading prevents manuscript navigation');
  await editor.evaluate(node => node.setSelectionRange(0, 0));
  const response = page.waitForResponse(response => response.url().includes('/__manual/rpc') && response.request().postDataJSON()?.action === 'screenshots-reference');
  releaseReference(); await response; await idle(); holdReference = false;
  const lateDrop = await editor.inputValue(); assertReference(lateDrop, screenshot.output);
  assert.ok(lateDrop.startsWith(initial.slice(0, cursor))); assert.ok(lateDrop.endsWith(initial.slice(cursor)));
  await saveContent(lateDrop); await editor.press('Control+z'); assert.equal(await editor.inputValue(), initial); await saveContent(initial);
  for (const [asset, hash] of assetHashes) assert.equal(fingerprint(await readFile(path.join(root, asset))), hash);
  records.push({ entry: 'source resource drag insertion', caseId: 'P03.resource-drop-source', steps: ['collect actual card drag payload for imported/generated/screenshot assets', 'end drag without drop and retain manuscript', 'drop each kind at the shared source cursor', 'verify selected asset path in each actual reference', 'save actual references and Undo each insertion', 'fail screenshot reference and retain manuscript', 'retry same payload without duplicate reference', 'hold real reference response', 'verify source readonly and navigation disabled while waiting', 'move readonly source selection and insert at original drop cursor', 'save and Undo delayed insertion', 'verify all original asset bytes'], assertions: { visible: true, stored: true, preserved: true, returnTarget: true } });
  await reset(); await page.getByRole('button', { name: 'Milkdown編集', exact: true }).click();
  async function dropRich(payload) {
    const paragraph = page.locator('.ProseMirror p').filter({ hasText: 'After text.' });
    await paragraph.click(); await page.keyboard.press('Home');
    await paragraph.evaluate((node, payload) => { const rect = node.getBoundingClientRect(); const data = new DataTransfer(); data.setData('application/x-munin-image', payload); node.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true, clientX: rect.x + 2, clientY: rect.y + rect.height / 2 })); }, payload);
  }
  const richInitial = await editor.inputValue();
  for (const kind of ['imported', 'generated', 'screenshot']) {
    await page.locator('[data-tab=screenshots]').click();
    await page.locator(`[data-resource-path="${JSON.parse(payloads.get(kind)).path}"] img`).first().evaluate(image => {
      const data = new DataTransfer(); image.dispatchEvent(new DragEvent('dragstart', { dataTransfer: data, bubbles: true }));
      image.dispatchEvent(new DragEvent('dragend', { dataTransfer: data, bubbles: true }));
    });
    assert.equal((await editor.inputValue()).trim(), richInitial.trim(), 'rich resource drag cancelled without dropping preserves manuscript');
    await page.locator('[data-tab=editor]').click();
    await dropRich(payloads.get(kind));
    await page.waitForFunction(() => document.querySelector('#status').textContent === '画像の参照を挿入しました。' && document.body.getAttribute('aria-busy') === 'false');
    const value = await editor.inputValue(); assertReference(value, JSON.parse(payloads.get(kind)).path); const imageAt = value.indexOf('![');
    assert.ok(value.indexOf('Before text.') < imageAt && imageAt < value.indexOf('After text.'), `${kind}: rich drop uses the same semantic cursor as source routes: ${JSON.stringify(value)}`);
    assert.equal((value.match(/!\[/g) || []).length, 1); await saveContent(value);
    await page.locator('.milkdown-top-bar').getByRole('button', { name: '元に戻す', exact: true }).click();
    assert.equal((await editor.inputValue()).trim(), richInitial.trim()); await saveContent(await editor.inputValue());
  }
  failReference = true; await dropRich(payloads.get('screenshot'));
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Fixture reference unavailable') && document.body.getAttribute('aria-busy') === 'false');
  assert.equal((await editor.inputValue()).trim(), richInitial.trim()); failReference = false;
  await dropRich(payloads.get('screenshot')); await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('screenshot:ref') && document.body.getAttribute('aria-busy') === 'false');
  assert.equal((await editor.inputValue()).match(/<!-- screenshot:ref id=/g).length, 1);
  await saveContent(await editor.inputValue());
  await page.locator('.milkdown-top-bar').getByRole('button', { name: '元に戻す', exact: true }).click();
  assert.equal((await editor.inputValue()).trim(), richInitial.trim()); await saveContent(await editor.inputValue());
  for (const [asset, hash] of assetHashes) assert.equal(fingerprint(await readFile(path.join(root, asset))), hash);
  records.push({ entry: 'rich resource drag insertion', caseId: 'P03.resource-drop-rich', steps: ['use actual imported/generated/screenshot resource payloads', 'drop each kind at rich paragraph before After text', 'verify same semantic cursor, selected asset path, and one image', 'save actual manuscript for each image kind', 'native ProseMirror Undo restores original prose', 'fail reference and preserve rich document', 'retry same screenshot payload without duplicate reference', 'save retry, Undo and save restored manuscript', 'preserve all asset bytes'], assertions: { visible: true, stored: true, preserved: true, returnTarget: true } });
  // The workspace tree has its own dragstart handler and carries no screenshot id.
  await page.getByRole('button', { name: 'Markdownソース', exact: true }).click();
  for (const mode of ['source', 'rich']) {
    await reset();
    if (mode === 'rich') await page.getByRole('button', { name: 'Milkdown編集', exact: true }).click();
    await page.locator('.flexlayout__tab_button').filter({ hasText: 'ファイルツリー' }).click();
    await page.locator('#tree-search').fill('imported.png');
    const treeImage = page.locator('[data-image="docs/assets/imported.png"]');
    await treeImage.waitFor({ state: 'visible' });
    const payload = await treeImage.evaluate(node => {
      const data = new DataTransfer(); node.dispatchEvent(new DragEvent('dragstart', { dataTransfer: data, bubbles: true }));
      node.dispatchEvent(new DragEvent('dragend', { dataTransfer: data, bubbles: true }));
      return data.getData('application/x-munin-image');
    });
    assert.equal(JSON.parse(payload).path, 'docs/assets/imported.png'); assert.equal(JSON.parse(payload).screenshot_id, undefined);
    assert.equal((await editor.inputValue()).trim(), initial.trim()); await page.locator('#tree-search').fill('');
    await page.locator('[data-tab=editor]').click();
    async function treeDrop(data, alternate = false) {
      if (mode === 'source') await editor.evaluate((node, { data, at }) => {
        node.focus(); node.setSelectionRange(at, at); const transfer = new DataTransfer(); transfer.setData('application/x-munin-image', data);
        node.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      }, { data, at: alternate ? 0 : cursor });
      else {
        const paragraph = alternate ? page.locator('.ProseMirror h1').first() : page.locator('.ProseMirror p').filter({ hasText: 'After text.' });
        await paragraph.click(); await page.keyboard.press('Home');
        await paragraph.evaluate((node, data) => {
          const rect = node.getBoundingClientRect(); const transfer = new DataTransfer(); transfer.setData('application/x-munin-image', data);
          node.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: rect.x + 2, clientY: rect.y + rect.height / 2 }));
        }, data);
      }
    }
    await treeDrop('{invalid'); await page.waitForFunction(() => document.querySelector('#status').textContent.includes('ドラッグ情報を読み込めません'));
    assert.equal((await editor.inputValue()).trim(), initial.trim());
    await treeDrop(JSON.stringify({ ...JSON.parse(payload), root: `${root}-different` }));
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('同じプロジェクト'));
    assert.equal((await editor.inputValue()).trim(), initial.trim());
    for (const alternate of [false, true]) {
      if (alternate) { await openDocument('P03.imported-card.md'); if (mode === 'rich' && await page.getByRole('button', { name: 'Milkdown編集', exact: true }).count()) await page.getByRole('button', { name: 'Milkdown編集', exact: true }).click(); }
      const before = await editor.inputValue(); await treeDrop(payload, alternate); await idle();
      const value = await editor.inputValue(); assertReference(value, 'docs/assets/imported.png'); assert.equal((value.match(/!\[/g) || []).length, 1);
      if (!alternate) assert.ok(value.indexOf('Before text.') < value.indexOf('![') && value.indexOf('![') < value.indexOf('After text.'));
      else assert.ok(value.includes('Other body.'));
      await saveContent(value);
      if (mode === 'rich') await page.locator('.milkdown-top-bar').getByRole('button', { name: '元に戻す', exact: true }).click(); else await editor.press('Control+z');
      assert.equal((await editor.inputValue()).trim(), before.trim()); await saveContent(await editor.inputValue());
    }
    if (mode === 'rich') await page.getByRole('button', { name: 'Markdownソース', exact: true }).click();
    await openDocument('index.md'); assert.equal((await editor.inputValue()).trim(), initial.trim());
    assert.equal(fingerprint(await readFile(path.join(root, 'docs/assets/imported.png'))), assetHashes.get('docs/assets/imported.png'));
    records.push({ entry: `${mode} tree image drag insertion`, caseId: `P03.tree-drop-${mode}`, steps: ['collect payload through independent visible workspace tree dragstart', 'dragend without drop preserves manuscript', 'reject malformed and cross-project payloads without manuscript change', 'retry valid same tree payload at original semantic cursor', 'insert once and save actual manuscript', 'Undo and save restored content', 'drop into a separate actual manuscript', 'save separate manuscript and Undo without changing original', 'preserve immutable imported PNG'], assertions: { visible: true, stored: true, preserved: true, returnTarget: true } });
  }
  // Scrolling while a reference is in flight must not re-interpret the old
  // viewport coordinates against a new part of the rich document.
  const longManuscript = initial + '\n' + Array.from({ length: 40 }, (_, index) => `Later paragraph ${index}: Preserve this text.`).join('\n\n') + '\n';
  await editor.fill(longManuscript); await saveContent(longManuscript);
  await page.getByRole('button', { name: 'Milkdown編集', exact: true }).click();
  holdReference = true;
  const richPendingReference = new Promise(resolve => referenceStarted = resolve);
  await dropRich(payloads.get('screenshot'));
  await Promise.race([richPendingReference, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Rich reference did not start')), 10000); timer.unref(); })]);
  assert.equal(await editor.evaluate(node => node.readOnly), true);
  assert.equal(await page.locator('[data-document-page="index.md"]').isDisabled(), true, 'pending rich reference prevents switching manuscripts');
  assert.equal(await page.locator('.ProseMirror').getAttribute('contenteditable'), 'false', 'pending rich reference prevents editing');
  const pendingRichBody = await editor.inputValue();
  await page.locator('.ProseMirror').press('x');
  assert.equal(await editor.inputValue(), pendingRichBody, 'typing while a rich reference is pending does not change the manuscript');
  await page.locator('#milkdown-editor').hover(); await page.mouse.wheel(0, 300);
  await page.waitForFunction(() => document.querySelector('#milkdown-editor').scrollTop >= 200);
  const richResponse = page.waitForResponse(response => response.url().includes('/__manual/rpc') && response.request().postDataJSON()?.action === 'screenshots-reference');
  releaseReference(); await richResponse; await idle(); holdReference = false;
  const afterRichScroll = await editor.inputValue(); assertReference(afterRichScroll, screenshot.output);
  assert.ok(afterRichScroll.indexOf('Before text.') < afterRichScroll.indexOf('![') && afterRichScroll.indexOf('![') < afterRichScroll.indexOf('After text.'), 'a delayed rich drop must retain its document position across actual viewport scrolling');
  await saveContent(afterRichScroll);
  await page.locator('.milkdown-top-bar').getByRole('button', { name: '元に戻す', exact: true }).click();
  assert.equal((await editor.inputValue()).trim(), longManuscript.trim());
  await saveContent(await editor.inputValue());
  records.find(record => record.caseId === 'P03.resource-drop-rich').steps.push('hold actual screenshot reference in a long rich manuscript', 'verify rich contenteditable is false and typing cannot change manuscript while pending', 'verify document tab is disabled while pending', 'scroll the readonly editor with mouse wheel while waiting', 'retain original document position instead of reusing viewport coordinates', 'save inserted reference and Undo, then save restored trailing paragraphs');
  await page.getByRole('button', { name: 'Markdownソース', exact: true }).click();
  await editor.fill(initial); await saveContent(initial); await reset();
  async function insertExistingScreenshot() {
    if(!await page.locator('#editor-screenshot-options').isVisible())await page.locator('#editor-more > summary').click();await page.locator('#editor-screenshot-options').click();
    await page.locator('#editor-screenshot-method').getByRole('button', { name: '撮影済み画像を選ぶ', exact: true }).click();
    await page.locator('#editor-screenshot-existing').locator(`[data-screenshot-id="${screenshot.id}"]`).click();
  }
  if(!await page.locator('#editor-screenshot-options').isVisible())await page.locator('#editor-more > summary').click();await page.locator('#editor-screenshot-options').click();
  await page.locator('#editor-screenshot-method').getByRole('button', { name: '撮影済み画像を選ぶ', exact: true }).click();
  await page.locator('#editor-screenshot-existing').getByRole('button', { name: '閉じる', exact: true }).click();
  assert.equal(await editor.inputValue(), initial); assert.equal(await editor.evaluate(node => node.selectionStart), cursor);
  failReference = true; await insertExistingScreenshot();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Fixture reference unavailable') && document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await editor.inputValue(), initial); failReference = false;
  await insertExistingScreenshot();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('指定位置にスクショを挿入しました。') && document.body.getAttribute('aria-busy') === 'false');
  const existingInserted = await editor.inputValue(); assertReference(existingInserted, screenshot.output); assert.ok(existingInserted.startsWith(initial.slice(0, cursor))); assert.ok(existingInserted.endsWith(initial.slice(cursor)));
  assert.equal((existingInserted.match(/<!-- screenshot:ref id=/g) || []).length, 1); await saveContent(existingInserted);
  await editor.press('Control+z'); assert.equal(await editor.inputValue(), initial); await saveContent(initial);
  assert.equal(JSON.parse(await rpc('screenshots-list')).items.find(shot => shot.id === screenshot.id).adopted, screenshot.adopted);
  assert.equal(JSON.parse(await rpc('screenshots-image', { id: screenshot.id, json: { original: true } })).data, originalScreenshot);
  records.push({ entry: 'editor existing screenshot insertion', caseId: 'P04.editor-existing', steps: ['start from same source cursor', 'choose actual adopted screenshot', 'close image selection and preserve manuscript/cursor', 'reopen and inject reference failure', 'retain adopted revision and manuscript', 'select same screenshot and insert immediately without confirmation or recapture', 'verify selected screenshot asset path and save one reference in actual manuscript', 'Undo and save original manuscript', 'preserve adopted revision and immutable original PNG'], assertions: { visible: true, stored: true, preserved: true, returnTarget: true } });
  await reset(); holdExistingList = true;
  const pendingList = new Promise(resolve => existingListStarted = resolve);
  if(!await page.locator('#editor-screenshot-options').isVisible())await page.locator('#editor-more > summary').click();await page.locator('#editor-screenshot-options').click();
  await page.locator('#editor-screenshot-method').getByRole('button', { name: '撮影済み画像を選ぶ', exact: true }).click();
  await Promise.race([pendingList, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Existing screenshot list did not start')), 10000); timer.unref(); })]);
  await openDocument('P03.imported-card.md'); assert.equal(await editor.inputValue(), other);
  await openDocument('index.md'); assert.equal(await editor.inputValue(), initial);
  await editor.evaluate(node => { node.focus(); node.setSelectionRange(0, 0); });
  const listResponse = page.waitForResponse(response => response.url().includes('/__manual/rpc') && response.request().postDataJSON()?.action === 'screenshots-list');
  releaseExistingList(); await listResponse;
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('原稿が変更されたため挿入していません') || document.querySelector('#editor-screenshot-existing'));
  assert.equal(await page.locator('#editor-screenshot-existing').count(), 0, 'an old screenshot chooser must not reappear after leaving and reopening the same manuscript');
  assert.equal(await editor.inputValue(), initial); assert.equal(await editor.evaluate(node => node.selectionStart), 0);
  records.find(record => record.caseId === 'P04.editor-existing').steps.push('hold actual existing-image list response', 'navigate to another actual document tab and reopen original identical manuscript', 'move cursor in the new opening session', 'reject stale chooser before preview or insertion and preserve new session/cursor');
  assert.deepEqual(pageErrors, []);
  await mkdir(resultDirectory, { recursive: true });
  await page.screenshot({ path: `${resultDirectory}/final.png` });
  const registry = JSON.parse(await readFile('scripts/fixtures/manual-studio-ui-inventory.json', 'utf8'));
  const artifacts = [{ path: 'final.png', sha256: fingerprint(await readFile(`${resultDirectory}/final.png`)) }];
  const results = records.flatMap(record => {
    const testCase = registry.cases.find(testCase => testCase.id === record.caseId);
    assert.ok(testCase, `explicit case missing: ${record.caseId}`);
    assert.equal(testCase.evidenceRecord, record.entry);
    return testCase.entryPoints.map(entryPoint => ({ caseId: record.caseId, entryPoint, type: 'real-backend', status: 'passed', steps: record.steps, assertions: record.assertions, artifacts }));
  });
  assert.equal(records.length, 10, 'all ten explicit routes must execute');
  await writeFile(`${resultDirectory}/result.json`, JSON.stringify({ ...await finishVerification(start), type: 'real-backend', scope: 'explicit source-editor resource/drawing/library and card drag insertion routes; local deterministic image API fixture, injected destination transport failures; no real provider or OS capture/drag/clipboard proof', records, results }, null, 2));
  console.log(`Managed insertion contracts passed ${records.length} explicit routes; real files and immutable assets verified.`);
} finally {
  await browser?.close(); server?.kill();
  if (api) await new Promise(resolve => api.close(resolve));
  await rm(root, { recursive: true, force: true });
}
