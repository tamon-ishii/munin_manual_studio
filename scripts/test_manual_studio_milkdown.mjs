import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
let server;
try { await fetch('http://127.0.0.1:5174/'); } catch {
  server = spawn('npm', ['run', 'manual:dev'], { stdio: 'ignore', detached: true });
  let connected = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fetch('http://127.0.0.1:5174/'); connected = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  if (!connected) { process.kill(-server.pid, 'SIGTERM'); throw new Error('Development server did not start'); }
}
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/milkdown-test', route => route.fulfill({ contentType: 'text/html', body: `<meta charset="UTF-8"><div><div class="column-label"></div><textarea id="source"></textarea></div><script type="module">
    import { setupMilkdownEditor } from '/src/milkdownEditor.ts';
    window.source = document.querySelector('textarea');
    source.value = '# Title\\n\\n<!-- ai:example -->\\n\\nText\\n\\n![Preview](assets/preview.png)\\n\\n<img src="assets/preview.png" alt="HTML preview">\\n\\n\`\`\`mermaid\\ngraph TD\\n A --> B\\n\`\`\`\\n';
    window.aiTagNumber = 0;
    window.bridge = setupMilkdownEditor(source, message => { throw new Error(message); }, async source => source, async file => { window.uploadedImage = file.name; return 'assets/uploaded.png'; }, kind => {
      window.requestedTask = kind;
      if (kind !== 'screenshot') bridge.insertAiTag('<!-- ai:task id=plugin-' + (++window.aiTagNumber) + ' kind=' + kind + ' prompt="指示の本文" -->\\n\\n<!-- /ai:task -->');
    });
  </script>` }));
  await page.goto('http://127.0.0.1:5174/milkdown-test');
  await page.waitForSelector('.ProseMirror');
  await page.waitForSelector('.mermaid-preview svg');
  assert.equal(await page.locator('#source').isVisible(), false);
  await page.locator('.milkdown-top-bar').waitFor();
  await page.locator('.cm-editor').waitFor();
  assert.equal(await page.locator('.milkdown-top-bar').getByRole('button', { name: /AIタグ/ }).count(), 0);
  assert.equal(await page.locator('.milkdown-top-bar').getByRole('button', { name: '撮影の指示', exact: true }).count(), 0);
  await page.locator('.ProseMirror p').filter({ hasText: 'Text' }).click();
  await page.keyboard.press('End'); await page.keyboard.type(' changed');
  assert.match(await page.locator('#source').inputValue(), /Text changed/);
  assert.match(await page.locator('#source').inputValue(), /!\[Preview\]/);
  assert.match(await page.locator('#source').inputValue(), /<!-- ai:example -->/);
  assert.match(await page.locator('#source').inputValue(), /<img src="assets\/preview.png"/);
  await page.locator('.milkdown-top-bar').getByRole('button', { name: '元に戻す', exact: true }).click();
  assert.doesNotMatch(await page.locator('#source').inputValue(), /changed/);
  assert.match(await page.locator('#source').inputValue(), /!\[Preview\]/);
  await page.locator('.ProseMirror p').filter({ hasText: 'Text' }).click();
  await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
  await page.locator('.milkdown-toolbar').getByRole('button', { name: '太字', exact: true }).click();
  assert.match(await page.locator('#source').inputValue(), /\*\*Text\*\*/);
  assert.equal(await page.locator('#source').isVisible(), false);
  await page.locator('.milkdown-top-bar').getByRole('button', { name: '表', exact: true }).click();
  await page.locator('.ProseMirror table.children').waitFor();
  assert.match(await page.locator('#source').inputValue(), /\|/);
  assert.equal(await page.locator('#source').isVisible(), false);
  await page.locator('.milkdown-top-bar').getByRole('button', { name: '元に戻す', exact: true }).click();
  await page.locator('.milkdown-top-bar').getByRole('button', { name: '画像', exact: true }).click();
  await page.locator('.milkdown-image-block input[type="file"]').setInputFiles({ name: 'uploaded.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') });
  await page.waitForFunction(() => document.querySelector('textarea').value.includes('assets/uploaded.png'));
  assert.equal(await page.evaluate(() => window.uploadedImage), 'uploaded.png');
  assert.equal(await page.locator('#source').isVisible(), false);
  await page.locator('.column-label button').click();
  await page.locator('#source').fill('# Next\n\n```mermaid\ninvalid diagram\n```');
  await page.locator('.column-label button').click();
  await page.waitForSelector('.diagram-error');
  assert.equal(await page.locator('.ProseMirror h1').textContent(), 'Next');
  await page.evaluate(() => { source.value = '# Reloaded\n\n```mermaid\ngraph LR\n C --> D\n```'; });
  await page.waitForSelector('.mermaid-preview svg');
  assert.equal(await page.locator('.ProseMirror h1').textContent(), 'Reloaded');
  await page.locator('.language-button').click();
  await page.getByPlaceholder('コードの言語を検索').fill('JavaScript');
  await page.locator('.language-list-item[data-language="JavaScript"]').click();
  assert.match(await page.locator('#source').inputValue(), /```JavaScript/);
  await page.locator('.language-button').click();
  await page.getByPlaceholder('コードの言語を検索').fill('mermaid');
  await page.locator('.language-list-item[data-language="mermaid"]').click();
  await page.waitForSelector('.mermaid-preview svg');
  await page.locator('.milkdown-top-bar .top-bar-heading-button').filter({ hasText: '挿入・その他' }).click();
  await page.locator('.milkdown-top-bar').getByRole('button', { name: 'Mermaidの図を挿入', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.mermaid-preview svg').length === 2);
  assert.match(await page.locator('#source').inputValue(), /開始/);
  await page.evaluate(() => { source.readOnly = true; });
  await page.waitForFunction(() => document.querySelector('.ProseMirror').contentEditable === 'false');
  await page.evaluate(() => { source.readOnly = false; });
  await page.locator('.milkdown-top-bar').getByRole('button', { name: '太字', exact: true }).waitFor();
  await page.locator('.milkdown-top-bar').getByRole('button', { name: '元に戻す', exact: true }).click();
  assert.doesNotMatch(await page.locator('#source').inputValue(), /開始/);
  await page.evaluate(() => { source.value = '# Slash\n\n<br />\n'; });
  await page.locator('.ProseMirror p').last().click();
  await page.keyboard.type('/');
  const slashMenu = page.locator('.milkdown-slash-menu');
  await slashMenu.waitFor();
  assert.equal(await slashMenu.getByText('文章の指示', { exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { source.value = '# Plain Markdown\n\nLegacy prose is editable without an AI task card.\n'; });
  await page.locator('.ProseMirror p').filter({ hasText: 'Legacy prose' }).click();
  await page.keyboard.press('End'); await page.keyboard.type(' updated');
  assert.match(await page.locator('#source').inputValue(), /Legacy prose is editable without an AI task card\. updated/);
  assert.doesNotMatch(await page.locator('#source').inputValue(), /ai:task/);

  assert.deepEqual(errors, []);
  console.log('Milkdown editing, retired AI tag removal, selection toolbar, table, code editor, Undo, images/comments, source switching, Mermaid and read-only checks passed.');
} finally { await browser?.close(); if (server) process.kill(-server.pid, 'SIGTERM'); }
