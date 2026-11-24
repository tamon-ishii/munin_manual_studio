import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = await mkdtemp(path.join(os.tmpdir(), 'munin-preview-tab-switch-'));
const base = 'http://127.0.0.1:5174';
let server, browser;

try {
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(
    path.join(root, 'manual_setting.json'),
    JSON.stringify({ docs: 'docs', assets: 'docs/assets', targets: ['docs'], connection_type: 'none' }),
  );
  await writeFile(
    path.join(root, 'docs/index.md'),
    '# Home Page\n\n## Shared Heading\n\n[Jump to Guide Target](guide.md#target)\n',
  );
  await writeFile(
    path.join(root, 'docs/guide.md'),
    '# Guide Page\n\n## Shared Heading\n\n' + 'Paragraph line.\n\n'.repeat(80) + '## Target\n\nReached target.\n',
  );
  await writeFile(
    path.join(root, 'docs/deep.md'),
    '# Deep Page\n\n# Shared Heading\n\n## Shared Heading\n\nDeep body content.\n',
  );

  server = spawn(
    process.execPath,
    [path.resolve('node_modules/vite/bin/vite.js'), '--config', 'apps/manual-studio/vite.config.ts'],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }

  browser = await chromium.launch({
    channel: process.env.MUNIN_TEST_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'),
    headless: true,
  });
  const context = await browser.newContext();
  const page = await context.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  await page.addInitScript(() => {
    localStorage.setItem('manual-studio-editor-view', 'split');
    localStorage.setItem('manual-studio-theme', 'charcoal');
  });

  const idle = () => page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  const openFromTree = async (file) => {
    const closed = page.locator('details[data-folder="docs"]:not([open]) > summary');
    if (await closed.count()) await closed.click();
    await page.locator(`[data-page="docs/${file}"]`).click();
    await idle();
  };

  await page.goto(`${base}/?root=${encodeURIComponent(root)}&page=index.md`);
  await idle();
  await page.frameLocator('#markdown-preview').getByRole('heading', { name: 'Home Page', exact: true }).waitFor();

  // Verify initial dark theme styling is injected into srcdoc and iframe background is not white.
  const initialState = await page.evaluate(() => {
    const frame = document.querySelector('#markdown-preview');
    const doc = frame.contentDocument;
    return {
      srcdocHasTheme: frame.getAttribute('srcdoc')?.includes('id="manual-studio-preview-theme"') || false,
      iframeBg: getComputedStyle(frame).backgroundColor,
      htmlBg: getComputedStyle(doc.documentElement).backgroundColor,
      bodyBg: getComputedStyle(doc.body).backgroundColor,
      csp: Boolean(doc.head.querySelector('meta[http-equiv="Content-Security-Policy"]')),
    };
  });
  assert.equal(initialState.srcdocHasTheme, true, 'initial srcdoc includes preview theme style');
  assert.equal(initialState.csp, true, 'initial preview document keeps CSP meta');
  assert.notEqual(initialState.iframeBg, 'rgb(255, 255, 255)', 'iframe background is not hardcoded white');
  assert.notEqual(initialState.htmlBg, 'rgb(255, 255, 255)', 'preview html background matches dark theme');
  assert.notEqual(initialState.bodyBg, 'rgb(255, 255, 255)', 'preview body background matches dark theme');

  // Open guide.md and deep.md so we have 3 open tabs.
  await openFromTree('guide.md');
  await page.frameLocator('#markdown-preview').getByRole('heading', { name: 'Guide Page', exact: true }).waitFor();
  await openFromTree('deep.md');
  await page.frameLocator('#markdown-preview').getByRole('heading', { name: 'Deep Page', exact: true }).waitFor();

  // Install rAF monitor to detect any iframe reload, blank frame, or white background flash across tab switches.
  await page.evaluate(() => {
    const frame = document.querySelector('#markdown-preview');
    const initialDoc = frame.contentDocument;
    window.__tabFlashMonitor = {
      initialDoc,
      loads: 0,
      emptyFrames: 0,
      whiteFrames: 0,
      docChanges: 0,
      active: true,
    };
    frame.addEventListener('load', () => {
      window.__tabFlashMonitor.loads += 1;
    });
    const sample = () => {
      const state = window.__tabFlashMonitor;
      if (!state.active) return;
      const doc = frame.contentDocument;
      if (doc !== state.initialDoc) state.docChanges += 1;
      if (!doc?.body?.textContent?.trim()) state.emptyFrames += 1;
      const iframeBg = getComputedStyle(frame).backgroundColor;
      const htmlBg = doc?.documentElement ? getComputedStyle(doc.documentElement).backgroundColor : 'rgb(255, 255, 255)';
      const bodyBg = doc?.body ? getComputedStyle(doc.body).backgroundColor : 'rgb(255, 255, 255)';
      if (iframeBg === 'rgb(255, 255, 255)' || htmlBg === 'rgb(255, 255, 255)' || bodyBg === 'rgb(255, 255, 255)') {
        state.whiteFrames += 1;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  // Switch tabs back and forth multiple times.
  for (const [tab, heading] of [
    ['index.md', 'Home Page'],
    ['guide.md', 'Guide Page'],
    ['deep.md', 'Deep Page'],
    ['index.md', 'Home Page'],
  ]) {
    await page.locator(`[data-document-page="${tab}"]`).click();
    await idle();
    await page.frameLocator('#markdown-preview').getByRole('heading', { name: heading, exact: true }).waitFor();
  }

  // Verify shared heading IDs are cleanly recomputed on index.md (not stuck on a suffixed ID from deep.md).
  const sharedHeadingId = await page.evaluate(() => {
    const doc = document.querySelector('#markdown-preview').contentDocument;
    return doc.querySelector('h2')?.id || '';
  });
  assert.equal(sharedHeadingId, 'shared-heading', 'auto heading IDs reset cleanly across tab switches');

  // Verify cross-page fragment link still scrolls to #target when preview updates in-place (no iframe load).
  await page.frameLocator('#markdown-preview').getByRole('link', { name: 'Jump to Guide Target', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#editor-title')?.textContent === 'guide.md');
  await idle();
  await page.waitForFunction(() => {
    const doc = document.querySelector('#markdown-preview').contentDocument;
    const target = doc?.getElementById('target');
    return Boolean(target && target.getBoundingClientRect().top < 500 && doc.scrollingElement.scrollTop > 0);
  });

  const monitorResult = await page.evaluate(() => {
    const state = window.__tabFlashMonitor;
    state.active = false;
    const doc = document.querySelector('#markdown-preview').contentDocument;
    return {
      sameDocument: doc === state.initialDoc,
      loads: state.loads,
      emptyFrames: state.emptyFrames,
      whiteFrames: state.whiteFrames,
      docChanges: state.docChanges,
      csp: Boolean(doc?.head?.querySelector('meta[http-equiv="Content-Security-Policy"]')),
    };
  });
  assert.deepEqual(monitorResult, {
    sameDocument: true,
    loads: 0,
    emptyFrames: 0,
    whiteFrames: 0,
    docChanges: 0,
    csp: true,
  });

  // Closing all tabs clears srcdoc, and reopening a page still loads cleanly with dark theme.
  for (const tab of ['index.md', 'guide.md', 'deep.md']) {
    await page.getByRole('button', { name: `${tab}を閉じる`, exact: true }).click();
    await idle();
  }
  assert.equal(await page.locator('#markdown-preview').getAttribute('srcdoc'), '');
  await openFromTree('index.md');
  await page.frameLocator('#markdown-preview').getByRole('heading', { name: 'Home Page', exact: true }).waitFor();
  const reopenedBg = await page.evaluate(() => {
    const doc = document.querySelector('#markdown-preview').contentDocument;
    return getComputedStyle(doc.body).backgroundColor;
  });
  assert.notEqual(reopenedBg, 'rgb(255, 255, 255)', 'reopened preview keeps dark theme');

  assert.deepEqual(errors, []);
  console.log('Preview tab-switch no-flash test passed: zero reloads, zero white/empty frames, clean heading IDs, cross-page fragment scroll works.');
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill();
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}
