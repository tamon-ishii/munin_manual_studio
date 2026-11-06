import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';

// Requires the Vite development server and manualctl backend.
const base = process.env.MANUAL_STUDIO_TEST_URL || 'http://127.0.0.1:5174';
const root = await mkdtemp(path.join(os.tmpdir(), 'munin-shared-toolbar-'));
let browser;
try {
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs/index.md'), '# Test\n\nSample paragraph.\n');
  await writeFile(path.join(root, 'manual_setting.json'), JSON.stringify({docs:'docs', assets:'docs/assets', output:'manual', targets:['docs'], connection_type:'none'}));
  browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:1440, height:960}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__manual/rpc', async route => {
    const response = await route.fetch({headers:{...route.request().headers(), origin:'http://127.0.0.1:5174'}});
    await route.fulfill({response});
  });
  await page.goto(`${base}/?root=${encodeURIComponent(root)}&page=index.md`);
  await page.waitForFunction(() => document.querySelector('#markdown-editor')?.value.includes('Sample paragraph'));
  await page.locator('#milkdown-editor .ProseMirror').waitFor();
  await page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  const toolbar = page.locator('.milkdown-top-bar');
  assert.ok(await toolbar.isVisible(), 'original Milkdown toolbar remains visible');
  assert.equal(await page.locator('.formatting-toolbar').isVisible(), false);
  const labels = () => toolbar.locator('button').evaluateAll(items => items.map(item => item.getAttribute('aria-label') || item.textContent.trim()));
  const original = await labels();
  const rich = page.locator('#milkdown-editor .ProseMirror');
  await rich.locator('p').click();
  await toolbar.getByRole('button', {name:'太字', exact:true}).click();
  await page.keyboard.type('Bold');
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('**Bold**'));
  await toolbar.getByRole('button', {name:'元に戻す', exact:true}).click();
  await page.waitForFunction(() => !document.querySelector('#markdown-editor').value.includes('Bold'));
  await page.locator('#editor-mode-toggle').click();
  assert.ok(await toolbar.isVisible());
  assert.equal(await rich.isVisible(), false, 'rich content is hidden while editing source');
  assert.ok(await page.locator('#markdown-editor').isVisible());
  assert.equal(await page.locator('.formatting-toolbar').isVisible(), false);
  assert.deepEqual((await labels()).slice(1), original.slice(1), 'source uses Milkdown controls and ordering');
  await page.locator('#markdown-editor').evaluate(element => {
    const start = element.value.indexOf('Sample');element.focus();element.setSelectionRange(start, start + 6);element.dispatchEvent(new Event('select'));
  });
  await toolbar.getByRole('button', {name:'太字', exact:true}).click();
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('**Sample**'));
  await toolbar.getByRole('button', {name:'元に戻す', exact:true}).click();
  await page.waitForFunction(() => !document.querySelector('#markdown-editor').value.includes('**Sample**'));
  await toolbar.getByRole('button', {name:'やり直す', exact:true}).click();
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('**Sample**'));
  await toolbar.locator('.top-bar-heading-selector').first().locator('.top-bar-heading-button').click();
  await toolbar.getByRole('button', {name:'見出し2', exact:true}).click();
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('## **Sample**'));
  await toolbar.getByRole('button', {name:'挿入・その他', exact:true}).click();
  await toolbar.getByRole('button', {name:'タスクリスト', exact:true}).click();
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('- [ ]'));
  assert.ok(await page.locator('#markdown-editor').isVisible());
  for (const [name, expected] of [['取り消し線','~~'], ['インラインコード','`'], ['引用','> '], ['コードブロック','```'], ['数式','```LaTeX'], ['区切り線','---'], ['Mermaidの図を挿入','```mermaid']]) {
    await page.locator('#markdown-editor').fill('Sample');
    await toolbar.getByRole('button', {name:'挿入・その他', exact:true}).click();
    await toolbar.getByRole('button', {name, exact:true}).click();
    assert.ok((await page.locator('#markdown-editor').inputValue()).includes(expected), `${name} writes Markdown source`);
  }
  await toolbar.getByRole('button', {name:'注釈', exact:true}).click();
  await toolbar.getByRole('button', {name:'ヒント (TIP)', exact:true}).click();
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('[!TIP]'));
  await page.locator('#editor-mode-toggle').click();
  assert.ok(await rich.isVisible());
  assert.ok(await toolbar.isVisible());
  assert.equal(await page.locator('#markdown-editor').isVisible(), false);
  await page.locator('#editor-mode-toggle').click();
  await page.locator('#markdown-editor').fill(Array.from({length:150}, (_, index) => `Paragraph ${index}.\n`).join('\n'));
  const sourceBounds = await page.locator('#markdown-editor').boundingBox();
  await page.locator('#editor-mode-toggle').click();
  const richBounds = await rich.boundingBox();
  assert.ok(Math.abs(sourceBounds.y - richBounds.y) < 1, 'both scroll areas begin below the toolbar');
  assert.ok(Math.abs(sourceBounds.x + sourceBounds.width - richBounds.x - richBounds.width) < 1, 'both scrollbar right edges match');
  assert.ok(Math.abs(sourceBounds.height - richBounds.height) < 1, 'both scroll areas end at the same bottom edge');
  const toolbarBefore = await toolbar.boundingBox();
  await rich.evaluate(element => {element.scrollTop = element.scrollHeight / 2;});
  await page.waitForFunction(() => document.querySelector('#milkdown-editor .ProseMirror').scrollTop > 0);
  const toolbarAfter = await toolbar.boundingBox();
  assert.equal(toolbarBefore.y, toolbarAfter.y, 'scrolling rich text keeps the toolbar fixed');
  assert.equal(await page.locator('#milkdown-editor').evaluate(element => element.scrollTop), 0, 'the outer editor does not scroll');
  assert.deepEqual(errors, []);
  console.log('Milkdown toolbar preserved: rich/source formatting, source history, headings, tasks and mode switching passed.');
} finally {
  await browser?.close();
  await rm(root, {recursive:true, force:true});
}
