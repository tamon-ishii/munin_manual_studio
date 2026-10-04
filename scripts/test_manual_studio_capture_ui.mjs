import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => {
    const callbacks = new Map();
    let nextCallback = 1;
    const calls = [];
    let starts = 0;
    let finishes = 0;
    let resolveAnnotation;
    window.__captureMock = {
      calls,
      resolveAnnotation(value) { resolveAnnotation?.(value); resolveAnnotation = undefined; },
      get starts() { return starts; },
      get finishes() { return finishes; },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback(callback) { const id = nextCallback++; callbacks.set(id, callback); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      convertFileSrc(path) { return path; },
      invoke(command, args = {}) {
        calls.push({ command, args });
        if (command === 'plugin:event|listen') return Promise.resolve(nextCallback++);
        if (command === 'load_launch_commands') return Promise.resolve([{ name: 'Shared test app', program: '/usr/bin/shared-app', args: ['--shared', 'value'] }]);
        if (command === 'manual_request') {
          const request = args.request;
          if (request.action === 'state') return Promise.resolve(JSON.stringify({
            has_config: false,
            config: { docs: 'docs', output: 'manual', agent: 'agy', model: '', mkdocs: { site_name: 'Test', theme: 'readthedocs', language: 'ja', use_directory_urls: true } },
            brief: '', pages: ['docs/guide.md', 'docs/other.md'],
            project_entries: [{ path: 'docs', directory: true }, { path: 'docs/guide.md', directory: false }, { path: 'docs/other.md', directory: false }],
            tasks: [], image_assets: {}, capture_sources: {}, ui_map: null,
            agents: [{ id: 'agy', label: 'Agy', available: true }],
          }));
          if (request.action === 'editor-read') return Promise.resolve(JSON.stringify({ page: request.options.page, content: `# ${request.options.page}\n`, revision: 'rev-1' }));
          if (request.action === 'editor-save') return Promise.resolve(JSON.stringify({ page: request.options.page, content: request.options.json.content, revision: 'rev-2' }));
          if (request.action === 'editor-preview') return Promise.resolve('<html><body>preview</body></html>');
          if (request.action === 'agent-progress') return Promise.resolve(JSON.stringify({ logs: [], total: 0 }));
          return Promise.resolve('{}');
        }
        if (command === 'start_operation_recording') {
          starts++;
          if (starts === 1) return Promise.reject(new Error('simulated first start failure'));
          return Promise.resolve('recording started');
        }
        if (command === 'operation_recording_running') return Promise.resolve(true);
        if (command === 'finish_operation_recording') {
          finishes++;
          return Promise.resolve({
            scenarioFile: `/tmp/scenario-${finishes}.json`, events: 1, operationText: 'clicked', sourceFile: `/tmp/source-${finishes}.png`,
            annotationFile: `/tmp/annotated-${finishes}.png`, completionFile: `/tmp/done-${finishes}.json`, markitsStarted: true, message: 'MarkIts started',
          });
        }
        if (command === 'markits_annotation_ready') return new Promise(resolve => { resolveAnnotation = resolve; });
        if (command === 'preserve_markits_capture') return Promise.resolve(`<!-- ai:generated id=${args.taskId} -->\n![capture](assets/${args.taskId}.png)\n<!-- /ai:generated -->`);
        return Promise.resolve(null);
      },
    };
  });

  const app = pathToFileURL(path.resolve('apps/manual-studio/dist/index.html')).href;
  await page.goto(`${app}?root=${encodeURIComponent('/tmp/mock-workspace')}`);
  await page.waitForFunction(() => document.querySelector('#markdown-editor')?.value.includes('docs/guide.md'));
  await page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');

  await page.locator('[data-insert="text"]').click();
  assert.match(await page.locator('#markdown-editor').inputValue(), /ai:task id=task-docs-guide-text-1 kind=text/, 'ordinary AI task insertion still works');
  await page.locator('[data-insert="screenshot"]').click();
  await page.locator('#screenshot-launch-command').selectOption('__custom__');
  await page.locator('#screenshot-task-form button[type="submit"]').click();
  assert.match(await page.locator('#screenshot-submit-feedback').textContent(), /起動アプリまたは補足/, 'empty screenshot task submission explains what is missing in the dialog');
  assert.equal(await page.locator('#screenshot-submit-feedback').evaluate(node => node.nextElementSibling?.matches('#screenshot-task-form > .actions')), true, 'submission feedback sits directly above the add button');
  assert.equal(await page.locator('#screenshot-task-dialog').evaluate(node => node.open), true, 'rejected screenshot submission keeps the dialog open');
  await page.locator('#screenshot-launch-command').selectOption('Shared test app');
  await page.locator('#screenshot-task-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#markdown-editor')?.value.includes('起動アプリ: /usr/bin/shared-app'));
  const directScreenshotTask = await page.locator('#markdown-editor').inputValue();
  assert.match(directScreenshotTask, /起動引数:\n- --shared\n- value/, 'unrecorded screenshot tag retains the selected shared app and arguments');
  assert.equal(await page.locator('#screenshot-task-dialog').evaluate(node => node.open), false, 'valid screenshot tag submission closes the dialog');
  assert.match(await page.locator('#status').textContent(), /保存すると実行対象になります/, 'successful screenshot tag insertion tells the user to save');
  await page.locator('#save-page').click();
  await page.waitForFunction(() => window.__captureMock.calls.some(call => call.command === 'manual_request' && call.args.request.action === 'editor-save' && call.args.request.options.page === 'docs/guide.md'));
  await page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');

  await page.locator('[data-insert="screenshot"]').click();
  await page.locator('#screenshot-launch-command').selectOption('__custom__');
  await page.locator('#screenshot-launch-program').fill('/usr/bin/mock-app');
  await page.locator('#start-operation-recording').click();
  await page.waitForFunction(() => document.querySelector('#operation-recording-status')?.textContent.includes('simulated first start failure'));
  await page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('#start-operation-recording').isEnabled(), true, 'a failed startup unlocks the retry button');
  assert.equal(await page.locator('#cancel-screenshot-task').isEnabled(), true, 'a failed startup can be cancelled');

  await page.locator('#start-operation-recording').click();
  await page.waitForFunction(() => window.__captureMock.starts === 2);
  await page.waitForFunction(() => document.querySelector('#stop-operation-recording')?.disabled === false);
  assert.equal(await page.locator('#start-operation-recording').isEnabled(), false, 'a live recorder cannot be started twice');
  assert.equal(await page.locator('#cancel-screenshot-task').isEnabled(), false, 'a live recorder cannot be cancelled without finishing');

  await page.locator('#stop-operation-recording').click();
  await page.waitForFunction(() => window.__captureMock.calls.some(call => call.command === 'markits_annotation_ready'));
  assert.equal(await page.locator('#cancel-screenshot-task').isEnabled(), true, 'MarkIts annotation wait can be cancelled');
  await page.locator('#cancel-screenshot-task').click();
  await page.locator('[data-page="docs/other.md"]').click();
  await page.waitForFunction(() => document.querySelector('#markdown-editor')?.value.includes('docs/other.md'));
  await page.locator('[data-insert="screenshot"]').click();

  await page.evaluate(() => window.__captureMock.resolveAnnotation(JSON.stringify({ annotations: [{ id: 'late' }] })));
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#screenshot-task-dialog').evaluate(node => node.open), true, 'late completion must not close or submit the newer capture dialog');
  assert.equal(await page.locator('#markdown-editor').inputValue(), '# docs/other.md\n', 'late completion must not mutate the newly selected page');
  assert.equal(await page.evaluate(() => window.__captureMock.calls.filter(call => call.command === 'preserve_markits_capture').length), 0);

  await page.locator('#screenshot-launch-command').selectOption('__custom__');
  await page.locator('#screenshot-launch-program').fill('/usr/bin/mock-app');
  await page.locator('#start-operation-recording').click();
  await page.waitForFunction(() => window.__captureMock.starts === 3);
  await page.waitForFunction(() => document.querySelector('#stop-operation-recording')?.disabled === false);
  await page.locator('#stop-operation-recording').click();
  await page.waitForFunction(() => window.__captureMock.finishes === 2);
  await page.waitForFunction(() => window.__captureMock.calls.filter(call => call.command === 'markits_annotation_ready').length === 2);
  await page.evaluate(() => window.__captureMock.resolveAnnotation(JSON.stringify({ canvas: { width: 100, height: 100 }, annotations: [] })));
  await page.waitForFunction(() => window.__captureMock.calls.some(call => call.command === 'preserve_markits_capture'));
  const preserveRequest = await page.evaluate(() => window.__captureMock.calls.find(call => call.command === 'preserve_markits_capture'));
  assert.equal(preserveRequest.args.root, '/tmp/mock-workspace', 'the image import uses the root captured at session start');
  assert.equal(preserveRequest.args.page, 'docs/other.md', 'the image import uses the page captured at session start');
  await page.waitForFunction(() => window.__captureMock.calls.some(call => call.command === 'manual_request' && call.args.request.action === 'editor-save' && call.args.request.options.page === 'docs/other.md'));
  const saveRequest = await page.evaluate(() => window.__captureMock.calls.find(call => call.command === 'manual_request' && call.args.request.action === 'editor-save' && call.args.request.options.page === 'docs/other.md'));
  assert.equal(saveRequest.args.request.root, '/tmp/mock-workspace');
  assert.equal(saveRequest.args.request.options.page, 'docs/other.md');
  await page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.match(await page.locator('#markdown-editor').inputValue(), /ai:generated id=task-docs-other-screenshot-1/);
  assert.deepEqual(errors, [], `browser errors: ${errors.join('; ')}`);
  console.log('Manual Studio native-mock capture UI checks passed.');
} finally {
  await browser?.close();
}
