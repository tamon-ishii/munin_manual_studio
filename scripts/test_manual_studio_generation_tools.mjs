import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:5174';
const root = await mkdtemp(path.join(os.tmpdir(), 'munin-generation-tools-'));
const requests = [];
const authorizations = [];
let text = 'First candidate';
const ai = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  requests.push(JSON.parse(body));
  authorizations.push(request.headers.authorization);
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ choices:[{ message:{ content:JSON.stringify({answers:[{id:'first', markdown:text}]}) } }] }));
});
let browser, vite;
try {
  await new Promise(resolve => ai.listen(0, '127.0.0.1', resolve));
  await mkdir(path.join(root, 'docs'));
  const original = '# Guide\n\n<!-- ai:task id=first kind=text prompt="First instruction" -->\n\nOld first\n\n<!-- /ai:task -->\n\n<!-- ai:task id=second kind=text prompt="Second instruction" -->\n\nKeep second\n\n<!-- /ai:task -->\n';
  await writeFile(path.join(root, 'docs/index.md'), original);
  await writeFile(path.join(root, 'manual_setting.json'), JSON.stringify({ docs:'docs', targets:['docs'], agent:'codex', model:'test-model', connection_type:'local_llm', endpoint_url:`http://127.0.0.1:${ai.address().port}/v1` }));
  vite = spawn(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), '--config', 'apps/manual-studio/vite.config.ts'], { stdio:'ignore' });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(base)).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'dev server ready');
  browser = await chromium.launch({ channel:'chrome', headless:true });
  const context = await browser.newContext(); context.setDefaultTimeout(30_000);
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const idle = () => page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  await page.goto(`${base}/?root=${encodeURIComponent(root)}`);
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('First instruction'));
  await idle();
  for (const candidate of ['First candidate', 'Second candidate']) {
    text = candidate;
    const count = requests.length;
    await page.locator('#generate-page').click();
    await page.locator('#generation-input-dialog').waitFor();
    assert.equal(requests.length, count, 'preview does not call AI');
    assert.match(await page.locator('#generation-input-content').textContent(), /Keep second/);
    await page.locator('#generation-input-tasks input[value=second]').uncheck();
    await page.locator('#generation-input-run').click();
    await page.locator('#generation-review-dialog').waitFor();
    assert.match(await page.locator('#generation-diff-after').textContent(), new RegExp(candidate));
    await page.locator('[data-review-action=restore]').click();
    await idle();
    assert.equal(await readFile(path.join(root, 'docs/index.md'), 'utf8'), original);
  }
  await page.locator('#editor-more summary').click();
  await page.locator('#generation-history-open').click();
  await page.locator('#generation-history-dialog').waitFor();
  assert.equal(await page.locator('.generation-history-row').count(), 2);
  const rows = page.locator('.generation-history-row');
  await rows.nth(0).locator('input').check(); await rows.nth(1).locator('input').check();
  await page.locator('#generation-history-compare').click();
  await page.locator('#generation-review-dialog').waitFor();
  const compared = await page.locator('#generation-review-dialog').textContent();
  assert.match(compared, /First candidate/); assert.match(compared, /Second candidate/);
  await page.locator('[data-review-action=adopt]').click();
  await rows.nth(0).getByRole('button', { name:'候補として再利用' }).click();
  await page.locator('#generation-review-dialog').waitFor();
  await page.locator('[data-review-action=adopt]').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('生成履歴の候補を採用'));
  assert.match(await readFile(path.join(root, 'docs/index.md'), 'utf8'), /Second candidate/);
  assert.match(await readFile(path.join(root, 'docs/index.md'), 'utf8'), /Keep second/);
  await page.locator('#generation-history-close').click(); await idle();

  const ordinaryRequests = [];
  page.on('request', request => {
    if (!request.url().includes('/__manual/rpc')) return;
    const body = request.postDataJSON();
    if (['state','editor-read','editor-preview','save'].includes(body.action)) ordinaryRequests.push(body);
  });
  await page.locator('#settings-menu summary').click();
  await page.locator('[data-tab=settings]').click();
  await page.locator('#ai-connection-type').selectOption('api');
  const originalEndpoint = `http://127.0.0.1:${ai.address().port}/v1`;
  await page.locator('#ai-api-key').fill('endpoint-test-key');
  await page.waitForFunction(() => document.querySelector('#ai-save-state').textContent === '保存済み');
  await page.locator('#ai-endpoint-url').fill('http://127.0.0.1:1/v1');
  assert.equal(await page.locator('#ai-api-key').inputValue(), '');
  await page.locator('#ai-endpoint-url').fill(originalEndpoint);
  assert.equal(await page.locator('#ai-api-key').inputValue(), 'endpoint-test-key');
  await page.waitForFunction(() => document.querySelector('#ai-save-state').textContent === '保存済み');
  await page.locator('[data-tab=editor]').click();
  await page.locator('#generate-page').click();
  await page.locator('#generation-input-tasks input[value=second]').uncheck();
  await page.locator('#generation-input-run').click();
  await page.locator('#generation-review-dialog').waitFor();
  assert.equal(authorizations.at(-1), 'Bearer endpoint-test-key');
  await page.locator('[data-review-action=restore]').click(); await idle();
  assert.ok(ordinaryRequests.length > 0);
  assert.ok(ordinaryRequests.every(request => !('api_key' in request.options)), 'non-AI requests never receive a credential');

  // Render real ANSI data, keep connection manual, and close only this owner.
  let spawns = 0, closes = 0, dataSent = false, realSession;
  await context.route('**/__manual/rpc', async route => {
    const request = route.request().postDataJSON();
    const output = value => route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify({output:JSON.stringify(value)}) });
    if (request.action === 'pty-spawn') {
      spawns++;
      if (spawns === 1) await output({session_id:'terminal-test'});
      else {
        request.options.command = 'sh'; request.options.args = [];
        const response = await route.fetch({postData:JSON.stringify(request)});
        const result = await response.json(); realSession = JSON.parse(result.output).session_id;
        await route.fulfill({response});
      }
    }
    else if (request.action === 'pty-read') { const data = dataSent ? '' : '\x1b[38;2;255;0;0mCOLOR_RED\x1b[0m\r\n'; dataSent = true; await output({data, alive:true}); }
    else if (request.action === 'pty-close-owner') { closes++; await output({ok:true}); }
    else if (request.action === 'pty-resize') await output({ok:true});
    else await route.continue();
  });
  await page.locator('#view-menu-button').click();
  await page.locator('#view-menu-dropdown label').filter({hasText:'AIターミナル'}).locator('input').check();
  await page.locator('#view-menu-button').click();
  assert.equal(spawns, 0, 'opening terminal does not connect');
  assert.match(await page.locator('#terminal-badge').innerText(), /未接続/);
  await page.locator('#terminal-connect-btn').click();
  await page.waitForFunction(() => document.querySelector('#terminal-badge').textContent.includes('接続中'));
  const red = page.locator('.xterm-rows span').filter({hasText:'COLOR_RED'}).first();
  await red.waitFor();
  assert.equal(await red.evaluate(node => getComputedStyle(node).color), 'rgb(255, 0, 0)');
  await page.locator('#terminal-disconnect-btn').click();
  await page.waitForFunction(() => document.querySelector('#terminal-badge').textContent.includes('未接続'));
  assert.equal(closes, 1);
  await page.locator('#terminal-connect-btn').click();
  await page.waitForFunction(() => document.querySelector('#terminal-badge').textContent.includes('接続中'));
  assert.ok(realSession);
  await context.unroute('**/__manual/rpc');
  await page.reload();
  let cleaned = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await fetch(`${base}/__manual/rpc`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({root,action:'pty-read',options:{session_id:realSession}})});
    const result = await response.json();
    if (result.error) { cleaned = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(cleaned, 'unload removes the real PTY session');
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('First instruction'));
  assert.equal(spawns, 2, 'reload does not reconnect');
  assert.deepEqual(errors, []);
  console.log('Generation tools checks passed: preview, selected generation, persistent history, comparison, reuse, manual terminal connection, ANSI truecolor, unload cleanup.');
} finally {
  await browser?.close();
  if (vite && vite.exitCode === null) { const exited = new Promise(resolve => vite.once('exit', resolve)); vite.kill(); await exited; }
  await new Promise(resolve => ai.close(resolve));
  await rm(root, { recursive:true, force:true });
}
