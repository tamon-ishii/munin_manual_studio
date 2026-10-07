import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:5174';
const root = await mkdtemp(path.join(os.tmpdir(), 'munin-recapture-display-'));
let server, browser;
try {
  try { await fetch(base); } catch {
    server = spawn(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), '--config', 'apps/manual-studio/vite.config.ts'], { stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base)).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  const colors = await page.evaluate(() => ['red', 'blue'].map(color => {
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 60;
    const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 80, 60);
    return canvas.toDataURL();
  }));
  await mkdir(path.join(root, 'docs/assets'), { recursive: true });
  await mkdir(path.join(root, 'manual'));
  const original = '# Capture\n\n<!-- ai:task id=shot kind=screenshot prompt="Capture fixture" -->\n\n![shot](assets/screen.png)\n\n<!-- /ai:task -->\n';
  await writeFile(path.join(root, 'docs/index.md'), original);
  await writeFile(path.join(root, 'docs/assets/screen.png'), Buffer.from(colors[0].split(',')[1], 'base64'));
  await writeFile(path.join(root, 'manual_setting.json'), JSON.stringify({ docs: 'docs', targets: ['docs'] }));
  await writeFile(path.join(root, 'manual/capture_sources.json'), JSON.stringify({ shot: { kind: 'window', title: 'Fixture', inset: 0 } }));
  let captures = 0;
  await page.route('**/__manual/rpc', async route => {
    const request = route.request().postDataJSON();
    if (request.action !== 'recapture') return route.continue();
    captures++;
    await writeFile(path.join(root, 'docs/assets/screen.png'), Buffer.from(colors[captures % 2].split(',')[1], 'base64'));
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ output: '{"captured":["shot"]}' }) });
  });
  await page.goto(`${base}/?root=${encodeURIComponent(root)}`);
  const displayed = page.locator('.milkdown-ai-task-body img');
  await displayed.waitFor();
  await page.waitForFunction(expected => document.querySelector('.milkdown-ai-task-body img')?.src === expected, colors[0]);
  for (const color of [colors[1], colors[0]]) {
    await page.locator('.milkdown-ai-task-regenerate').click();
    await page.waitForFunction(expected => document.body.getAttribute('aria-busy') === 'false' && document.querySelector('.milkdown-ai-task-body img')?.src === expected, color);
    assert.equal(await page.locator('#markdown-editor').inputValue(), original, 'display refresh must not turn the saved path into a data URL');
    assert.equal(await readFile(path.join(root, 'docs/index.md'), 'utf8'), original, 'refresh must preserve the image path and manuscript');
    await page.waitForFunction(expected => document.querySelector('[data-thumb="shot"]')?.src === expected, color);
    await page.waitForFunction(expected => document.querySelector('#markdown-preview').contentDocument?.querySelector('img')?.src === expected, color);
  }
  assert.equal(captures, 2);
  console.log('Recapture display checks passed: same-path image refresh in AI tag, task thumbnail and preview, manuscript preservation.');
} finally {
  await browser?.close();
  if (server && server.exitCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exited; }
  await rm(root, { recursive: true, force: true });
}
