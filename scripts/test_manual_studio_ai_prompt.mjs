import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:5174';
const root = await mkdtemp(path.join(os.tmpdir(), 'manual-ai-prompt-'));
let browser;
let server;
try {
  try { await fetch(base); } catch {
    server = spawn('npm', ['run', 'manual:dev'], { stdio: 'ignore', detached: true });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await fetch(base); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(ready, 'Development server did not start');
  }
  await mkdir(path.join(root, 'docs'));
  const filename = path.join(root, 'docs/index.md');
  await writeFile(filename, '# Guide\n\n<!-- ai:task id=guide kind=text prompt="初心者向けに説明" -->\n\n既存の本文 **太字**\n\n<!-- /ai:task -->\n\nタグ外の文章\n');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/?root=${encodeURIComponent(root)}`);
  const prompt = page.getByRole('textbox', { name: 'AIへの指示 guide', exact: true });
  await prompt.waitFor();
  await page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await prompt.inputValue(), '初心者向けに説明');
  await prompt.fill('"保存"を説明してください\nA --> B の順で操作');
  assert.equal(await page.locator('#markdown-editor').isVisible(), false);
  assert.match(await page.locator('#markdown-editor').inputValue(), /prompt="&quot;保存&quot;を説明してください&#10;A --&gt; B の順で操作"/);
  const saved = page.waitForResponse(response => response.url().endsWith('/__manual/rpc') && response.request().postDataJSON()?.action === 'editor-save');
  await prompt.press('Control+s');
  assert.equal((await saved).status(), 200);
  await page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  const markdown = await readFile(filename, 'utf8');
  assert.match(markdown, /prompt="&quot;保存&quot;を説明してください&#10;A --&gt; B の順で操作"/);
  assert.match(markdown, /既存の本文 \*\*太字\*\*/);
  assert.match(markdown, /タグ外の文章/);
  assert.equal((markdown.match(/<!-- ai:task /g) || []).length, 1);
  await page.reload();
  await prompt.waitFor();
  assert.equal(await prompt.inputValue(), '"保存"を説明してください\nA --> B の順で操作');
  assert.equal(await page.locator('.milkdown-ai-task-body strong').innerText(), '太字');
  await page.screenshot({ path: path.join(os.tmpdir(), 'manual-ai-prompt.png') });
  assert.deepEqual(errors, []);
  console.log('Milkdown AI prompt editing, source synchronization, document save and reload checks passed.');
} finally {
  await browser?.close();
  if (server) process.kill(-server.pid, 'SIGTERM');
  await rm(root, { recursive: true, force: true });
}
