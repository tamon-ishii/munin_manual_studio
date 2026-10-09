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
  const insertAiTag = async label => {
    await page.locator('.milkdown-top-bar .top-bar-heading-button').filter({ hasText: 'AIタグを追加' }).click();
    await page.locator('.milkdown-top-bar').getByRole('button', { name: label, exact: true }).click();
  };
  await insertAiTag('文章の指示');
  assert.match(await page.locator('#source').inputValue(), /ai:task id=plugin-1 kind=text prompt="指示の本文" -->/);
  assert.match(await page.locator('#source').inputValue(), /<!-- \/ai:task -->/);
  assert.equal(await page.locator('#source').isVisible(), false);
  const promptField = page.locator('[data-ai-task-id=\"plugin-1\"] textarea.milkdown-ai-task-prompt');
  assert.equal(await promptField.inputValue(), '指示の本文');
  await promptField.locator('..').locator('..').locator('summary').click();
  await promptField.fill('初心者向け "保存"\nA --> B の順に説明');
  assert.match(await page.locator('#source').inputValue(), /prompt="初心者向け &quot;保存&quot;&#10;A --&gt; B の順に説明"/);
  await promptField.press('Control+z');
  assert.equal(await promptField.inputValue(), '指示の本文');
  await promptField.press('Control+Shift+z');
  assert.match(await promptField.inputValue(), /初心者向け/);
  await promptField.press('Control+z');
  await page.locator('.milkdown-top-bar').getByRole('button', { name: '元に戻す', exact: true }).click();
  assert.doesNotMatch(await page.locator('#source').inputValue(), /id=plugin-1/);
  await insertAiTag('図の指示');
  assert.match(await page.locator('#source').inputValue(), /ai:task id=plugin-2 kind=diagram/);
  await page.locator('.milkdown-top-bar').getByRole('button', { name: '元に戻す', exact: true }).click();
  assert.equal(await page.locator('.milkdown-top-bar').getByRole('button', { name: '撮影の指示', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.requestedTask), 'diagram');
  assert.equal(await page.locator('#source').isVisible(), false);
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
  await page.locator('.milkdown-slash-menu').getByText('文章の指示', { exact: true }).click();
  assert.match(await page.locator('#source').inputValue(), /ai:task id=plugin-3 kind=text/);
  assert.doesNotMatch(await page.locator('#source').inputValue(), /^\/$/m);
  assert.equal(await page.locator('#source').isVisible(), false);
  await page.evaluate(() => { source.value = '# AI card\n\n<!-- ai:task id=editable-guide kind=text prompt="元の指示" source-sha256=' + '0'.repeat(64) + ' -->\n\n本文 **太字**\n\n- 一つ目\n- 二つ目\n\n<!-- /ai:task -->\n\n外側の文章\n'; });
  const card = page.locator('.milkdown-ai-task');
  await card.waitFor();
  assert.equal(await card.locator('.milkdown-ai-task-body strong').innerText(), '太字');
  assert.equal(await card.locator('.milkdown-ai-task-body li').count(), 2);
  const body = card.locator('.milkdown-ai-task-body p').filter({ hasText: '本文' });
  await body.click(); await page.keyboard.press('End'); await page.keyboard.type(' edited');
  const cardPrompt = page.locator('[data-ai-task-id=\"editable-guide\"] textarea.milkdown-ai-task-prompt');
  await cardPrompt.locator('..').locator('..').locator('summary').click();
  await cardPrompt.fill('更新した指示 "引用"\n二行目');
  const savedCard = await page.locator('#source').inputValue();
  assert.match(savedCard, /prompt="更新した指示 &quot;引用&quot;&#10;二行目"/);
  assert.match(savedCard, /本文 \*\*太字 edited\*\*/);
  assert.match(savedCard, /外側の文章/);
  assert.match(savedCard, /source-sha256=0{64}/);
  assert.equal((savedCard.match(/<!-- ai:task /g) || []).length, 1);
  assert.equal((savedCard.match(/<!-- \/ai:task -->/g) || []).length, 1);
  await page.evaluate(() => { source.value = source.value; });
  // Test regenerate button and confirm button in unapproved state
  const regenBtn = card.locator('.milkdown-ai-task-regenerate');
  assert.equal(await regenBtn.innerText(), '再生成');
  assert.equal(await regenBtn.isEnabled(), true, 'enabled when unapproved');

  const confirmBtn = card.locator('.milkdown-ai-task-confirm');
  assert.equal(await confirmBtn.innerText(), '確定');
  assert.equal(await card.locator('.milkdown-ai-task-status').innerText(), '生成済み');

  // Confirm
  await confirmBtn.click();
  await page.waitForFunction(() => document.querySelector('#source').value.includes('approved-at='));
  assert.match(await page.locator('#source').inputValue(), /approved-at="\d{4}-\d{2}-\d{2}T/);
  assert.equal(await confirmBtn.innerText(), '確定解除');
  assert.equal(await card.locator('.milkdown-ai-task-status').innerText(), '確定済み');
  assert.equal(await card.getAttribute('class'), 'milkdown-ai-task is-approved');
  assert.equal(await regenBtn.isEnabled(), false, 'disabled while approved');

  // Unconfirm
  await confirmBtn.click();
  await page.waitForFunction(() => !document.querySelector('#source').value.includes('approved-at='));
  assert.doesNotMatch(await page.locator('#source').inputValue(), /approved-at=/);
  assert.equal(await confirmBtn.innerText(), '確定');
  assert.equal(await card.locator('.milkdown-ai-task-status').innerText(), '生成済み');
  assert.equal(await regenBtn.isEnabled(), true, 'enabled when unapproved');

  // Clicking regenerate dispatches custom event
  await page.evaluate(() => {
    window.lastRegenerateEvent = null;
    window.addEventListener('manual-studio-regenerate-task', e => { window.lastRegenerateEvent = e.detail; });
  });
  await regenBtn.click();
  assert.deepEqual(await page.evaluate(() => window.lastRegenerateEvent), { id: 'editable-guide', kind: 'text' });

  // Test delete button
  const deleteBtn = card.locator('.milkdown-ai-task-delete');
  assert.equal(await deleteBtn.innerText(), '削除');
  await deleteBtn.click();
  await page.waitForFunction(() => !document.querySelector('#source').value.includes('id=editable-guide'));
  assert.doesNotMatch(await page.locator('#source').inputValue(), /id=editable-guide/);

  // Undo restores the deleted card
  await page.locator('.milkdown-top-bar').getByRole('button', { name: '元に戻す', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#source').value.includes('id=editable-guide'));
  assert.match(await page.locator('#source').inputValue(), /id=editable-guide/);

  // Empty task has '生成' regenerate button and disabled confirm button
  await page.evaluate(() => { source.value = '# Empty Task\n\n<!-- ai:task id=empty-task kind=text prompt="未生成の指示" -->\n\n<!-- /ai:task -->\n'; });
  const emptyCard = page.locator('.milkdown-ai-task');
  await emptyCard.waitFor();
  const emptyConfirmBtn = emptyCard.locator('.milkdown-ai-task-confirm');
  assert.equal(await emptyConfirmBtn.innerText(), '確定');
  assert.equal(await emptyCard.locator('.milkdown-ai-task-status').innerText(), '未生成');
  assert.equal(await emptyConfirmBtn.isDisabled(), true);
  const emptyRegenBtn = emptyCard.locator('.milkdown-ai-task-regenerate');
  assert.equal(await emptyRegenBtn.innerText(), '生成');
  assert.equal(await emptyRegenBtn.isEnabled(), true);

  // Legacy format is converted to editable task box
  await page.evaluate(() => {
    source.value = '# Legacy\n\n<!-- ai:task id=legacy-task kind=text\nレガシーな指示文\n-->\n\n<!-- ai:generated id=legacy-task kind=text created-at=2026-10-04T12:00:00Z source-sha256=123 -->\nレガシーな本文\n<!-- /ai:generated -->\n';
  });
  const legacyCard = page.locator('.milkdown-ai-task');
  await legacyCard.waitFor();
  assert.equal(await legacyCard.locator('.milkdown-ai-task-body p').innerText(), 'レガシーな本文');
  const legacyPrompt = page.locator('[data-ai-task-id=\"legacy-task\"] textarea.milkdown-ai-task-prompt');
  assert.equal(await legacyPrompt.inputValue(), 'レガシーな指示文');
  await legacyCard.locator('.milkdown-ai-task-confirm').click();
  await page.waitForFunction(() => document.querySelector('#source').value.includes('approved-at='));
  assert.match(await page.locator('#source').inputValue(), /<!-- ai:task id="legacy-task" kind="text" prompt="レガシーな指示文"[^>]*approved-at=/);

  assert.deepEqual(errors, []);
  console.log('Milkdown editable AI prompt/body cards, confirm/unconfirm button, legacy format support, Crepe standard top bar, AI tag plugin/menu, selection toolbar, table, code editor, Undo, images/comments, source switching, Mermaid and read-only checks passed.');
} finally { await browser?.close(); if (server) process.kill(-server.pid, 'SIGTERM'); }
