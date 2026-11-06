import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';

// Requires a Vite development server and the manualctl backend.
const base = process.env.MANUAL_STUDIO_TEST_URL || 'http://127.0.0.1:5174';
const root = await mkdtemp(path.join(os.tmpdir(), 'munin-refactoring-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
let browser;
try {
  await mkdir(path.join(root, 'docs/assets'), {recursive:true});
  const manuscript = path.join(root, 'docs/index.md');
  await writeFile(manuscript, '# Test\n\nSample paragraph.\n');
  await writeFile(path.join(root, 'manual_setting.json'), JSON.stringify({docs:'docs', assets:'docs/assets', output:'manual', targets:['docs'], connection_type:'none'}));
  browser = await chromium.launch({headless:true});
  const context = await browser.newContext({viewport:{width:1440,height:960}});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/__manual/rpc', async route => {
    const response = await route.fetch({headers:{...route.request().headers(), origin:'http://127.0.0.1:5174'}});
    await route.fulfill({response});
  });
  const open = async target => {
    await target.goto(`${base}/?root=${encodeURIComponent(root)}&page=index.md`);
    await target.waitForFunction(() => document.querySelector('#markdown-editor')?.value.includes('Sample paragraph'));
    await target.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
    await target.locator('#milkdown-editor .ProseMirror').waitFor();
  };
  await open(page);
  const changeSize = async (id, value) => page.locator(`#${id}`).evaluate((control, size) => {
    control.value = String(size);control.dispatchEvent(new Event('input'));control.dispatchEvent(new Event('change'));
  }, value);
  await changeSize('editor-font-size', 22);
  await changeSize('preview-font-size', 26);
  await changeSize('editor-font-size', 29);
  await changeSize('preview-font-size', 11);
  assert.equal(await page.locator('#editor-font-size').inputValue(), '22');
  assert.equal(await page.locator('#preview-font-size').inputValue(), '26');
  const peer = await context.newPage();await open(peer);
  assert.equal(await peer.locator('#editor-font-size').inputValue(), '22');
  assert.equal(await peer.locator('#preview-font-size').inputValue(), '26');
  await changeSize('editor-font-size', 24);
  await peer.waitForFunction(() => document.querySelector('#editor-font-size').value === '24');
  assert.equal(await peer.locator('#preview-font-size').inputValue(), '26', 'font preferences stay independent');
  await page.locator('button[data-editor-view=split]').click();
  await page.waitForFunction(() => document.querySelector('#markdown-preview').contentDocument?.body?.textContent.includes('Sample paragraph'));
  await page.waitForFunction(() => {
    const frame = document.querySelector('#markdown-preview');
    return frame.contentWindow.getComputedStyle(frame.contentDocument.body).fontSize === '26px';
  });
  await page.locator('#editor-mode-toggle').click();
  const source = page.locator('#markdown-editor');
  assert.equal(await source.evaluate(element => getComputedStyle(element).fontSize), '24px');
  const end = () => source.evaluate(element => {element.focus();element.setSelectionRange(element.value.length, element.value.length);});
  const submitImage = async name => {
    await page.locator('#image-save-dialog').waitFor();
    await page.locator('#image-save-filename').fill(name);
    await page.locator('#image-save-form').evaluate(form => form.requestSubmit());
    await page.waitForFunction(() => !document.querySelector('#image-save-dialog').open && document.body.getAttribute('aria-busy') === 'false');
    await page.waitForFunction(name => document.querySelector('#markdown-editor').value.includes(name), name);
    assert.deepEqual(await readFile(path.join(root, 'docs/assets', name)), png);
  };
  // File selection and drag/drop share reading and stale-owner checks.
  await end();
  await page.locator('#toolbar-image-input').setInputFiles({name:'selected.png',mimeType:'image/png',buffer:png});
  await submitImage('selected.png');
  await end();
  await source.evaluate((element, bytes) => {
    const transfer = new DataTransfer();transfer.items.add(new File([new Uint8Array(bytes)], 'dropped.png', {type:'image/png'}));
    element.dispatchEvent(new DragEvent('drop', {bubbles:true,cancelable:true,dataTransfer:transfer}));
  }, [...png]);
  await submitImage('dropped.png');
  await end();
  await source.evaluate((element, bytes) => {
    const transfer = new DataTransfer();transfer.items.add(new File([new Uint8Array(bytes)], 'pasted.png', {type:'image/png'}));
    element.dispatchEvent(new ClipboardEvent('paste', {bubbles:true,cancelable:true,clipboardData:transfer}));
  }, [...png]);
  await page.waitForFunction(() => /assets\/image-\d/.test(document.querySelector('#markdown-editor').value));
  await page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  const text = await source.inputValue();
  assert.ok(text.includes('Sample paragraph.') && text.includes('selected.png') && text.includes('dropped.png'));
  assert.equal(await readFile(manuscript, 'utf8'), '# Test\n\nSample paragraph.\n', 'image insertion keeps manuscript changes unsaved');
  // Both file entry points must reject an insertion after the manuscript changes.
  await page.evaluate(() => {
    const original = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function(file) {setTimeout(() => original.call(this, file), 150);};
  });
  await page.locator('#toolbar-image-input').setInputFiles({name:'stale.png',mimeType:'image/png',buffer:png});
  await source.fill('Changed while the image was being read.');
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('画像を挿入し直してください'));
  assert.equal(await page.locator('#image-save-dialog').isVisible(), false, 'stale image cannot open the save dialog');
  assert.deepEqual(errors, []);
  console.log('Refactoring browser checks passed: independent fonts, validation, persistence, window sync, preview styling, file/drop/paste image insertion.');
} finally {
  await browser?.close();
  await rm(root, {recursive:true,force:true});
}
