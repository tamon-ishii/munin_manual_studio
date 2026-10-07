import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium, webkit} from 'playwright-core';
const base = 'http://127.0.0.1:5174';
const root = await mkdtemp(path.join(os.tmpdir(), 'munin-preview-links-'));
let browser, server;
try {
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs/index.md'), '# Home\n\n[Next](%E6%97%A5%E6%9C%AC%E8%AA%9E.md#target)\n\n[Missing](missing.md)\n\n[Heading](#home)\n\n[Malformed](#%ZZ)');
  await writeFile(path.join(root, 'docs/日本語.md'), '# Next\n\n' + 'Paragraph\n\n'.repeat(90) + '## Target\n\nEnd\n');
  await writeFile(path.join(root, 'manual_setting.json'), JSON.stringify({docs:'docs',targets:['docs']}));
  server = spawn(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), '--config','apps/manual-studio/vite.config.ts'], {stdio:'ignore'});
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve,100));
  }
  browser = process.env.MUNIN_TEST_BROWSER === 'webkit'
    ? await webkit.launch({headless:true})
    : await chromium.launch({channel:'chrome',headless:true});
  const page = await browser.newPage(); page.setDefaultTimeout(30_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const idle = () => page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  await page.goto(`${base}/?root=${encodeURIComponent(root)}&page=docs%2Findex.md`);
  await page.waitForFunction(() => document.querySelector('#editor-title').textContent === 'docs/index.md');
  await idle();
  // Verify that a link cannot load the app even before interception is attached.
  const response = await fetch(`${base}/__manual/rpc`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({root,action:'editor-preview',options:{page:'docs/index.md',body:'# Safe\n\n[Jump](#safe)\n\n<script>parent.__previewScriptRan = true;</script>\n<a onclick="parent.__previewScriptRan = true">Inline</a>'}})});
  const rendered = await response.json();
  assert.ok(rendered.output);
  const inert = await page.evaluate(async html => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox',document.querySelector('#markdown-preview').getAttribute('sandbox'));
    window.__previewScriptRan = false;
    iframe.style.display = 'none';
    const loaded = new Promise(resolve => iframe.addEventListener('load', resolve, {once:true}));
    iframe.srcdoc = html; document.body.appendChild(iframe); await loaded;
    const anchor = iframe.contentDocument.querySelector('a');
    const href = anchor.getAttribute('href'); anchor.click();
    iframe.contentDocument.querySelector('a[onclick]')?.click();
    await new Promise(resolve => setTimeout(resolve,100));
    const result = {href, url:iframe.contentWindow.location.href, heading:iframe.contentDocument.querySelector('h1')?.textContent, scriptRan:window.__previewScriptRan};
    iframe.remove(); return result;
  }, rendered.output);
  assert.deepEqual(inert, {href:null,url:'about:srcdoc',heading:'Safe',scriptRan:false});
  const preview = page.frameLocator('#markdown-preview');
  await preview.getByRole('link',{name:'Malformed',exact:true}).click();
  await preview.getByRole('link',{name:'Heading',exact:true}).click();
  await preview.getByRole('link',{name:'Next',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('#editor-title').textContent === 'docs/日本語.md');
  await idle();
  await page.waitForFunction(() => {
    const doc = document.querySelector('#markdown-preview').contentDocument;
    return doc.getElementById('target')?.getBoundingClientRect().top < 500 && doc.scrollingElement.scrollTop > 0;
  });
  // Cancel backwards navigation without moving the history cursor or losing edits.
  await page.locator('#markdown-editor').evaluate(node => {
    node.value += '\nUnsaved'; node.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await page.locator('#preview-nav-back').click();
  await page.locator('[data-unsaved-action=cancel]').click(); await idle();
  assert.equal(await page.locator('#editor-title').textContent(), 'docs/日本語.md');
  assert.equal(await page.locator('#preview-nav-back').isEnabled(), true);
  assert.equal(await page.locator('#preview-nav-forward').isEnabled(), false);
  await page.locator('#preview-nav-back').click();
  await page.locator('[data-unsaved-action=discard]').click(); await idle();
  assert.equal(await page.locator('#editor-title').textContent(), 'docs/index.md');
  await preview.getByRole('link',{name:'Missing',exact:true}).click(); await idle();
  assert.match(await page.locator('#status').textContent(), /原稿を開けません/);
  assert.equal(await page.locator('#editor-title').textContent(), 'docs/index.md');
  await page.locator('#preview-nav-forward').click(); await idle();
  assert.equal(await page.locator('#editor-title').textContent(), 'docs/日本語.md');
  assert.deepEqual(errors, []);
  console.log('Preview link checks passed: encoded paths, heading fragments, cancelled history, missing-page errors, forward navigation.');
} finally {
  await browser?.close();
  if (server && server.exitCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exited; }
  await rm(root,{recursive:true,force:true});
}
