import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {chromium} from 'playwright-core';

const base = 'http://127.0.0.1:5178';
let server, browser;
try {
  server = spawn(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), '--config', 'apps/manual-studio/vite.config.ts', '--port', '5178'], {stdio:'ignore'});
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Vite test server started');
  browser = await chromium.launch({channel:process.env.MUNIN_TEST_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless:true});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const modulePath = path.resolve('crates/markits/apps/desktop/src').split(path.sep).join('/');
  await page.route('**/record-test', route => route.fulfill({contentType:'text/html', body:`<html><body><div class="action-bar"></div>
    <meta charset="utf-8"><script type="module">
      import {addRecordingButton, showRecordingControls} from '/@fs/${modulePath}/recording.ts';
      window.calls=[];window.paused=false;window.cancelled=false;
      window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
        if(command==='plugin:dialog|save') { window.saveAttempts=(window.saveAttempts||0)+1; return window.saveAttempts===1 ? null : 'C:/test/operations.json'; }
        if(command==='plugin:fs|write_file') { window.saved=JSON.parse(new TextDecoder().decode(args)); return; }
        throw new Error('Unexpected native command: '+command);
      }};
      window.invoke=async (command,args)=>{
        calls.push({command,args});
        if(command==='cmd_recording_windows') return [{id:'window-1',title:'Example application'}];
        if(command==='cmd_recording_status') return {running:true,paused:window.paused,events:[{kind:'text',value:'日本語入力',elapsed_ms:1500}]};
        if(command==='cmd_recording_pause') window.paused=args.paused;
        if(command==='cmd_recording_finish') return {version:1,window:'Example application',events:[{kind:'text',value:'日本語入力',elapsed_ms:1500}]};
        if(command==='cmd_recording_cancel') window.cancelled=true;
      };
      addRecordingButton(window.invoke);
      window.showControls=()=>showRecordingControls(window.invoke);
    </script></body></html>`}));
  await page.goto(`${base}/record-test`);
  await page.getByRole('button', {name:'ウインドウ操作を記録', exact:true}).click();
  await page.waitForFunction(() => document.querySelector('#record-window')?.options.length === 1);
  await page.getByRole('button', {name:'記録を開始', exact:true}).click();
  await page.waitForFunction(() => !document.querySelector('dialog'));
  assert.deepEqual(await page.evaluate(() => calls.find(call => call.command === 'cmd_recording_start').args), {windowId:'window-1'});
  await page.evaluate(() => showControls());
  await page.waitForFunction(() => document.querySelector('#record-status').textContent.includes('1 件'));
  assert.match(await page.locator('#record-events').innerText(), /日本語入力/);
  await page.locator('#record-pause').click();
  await page.waitForFunction(() => document.querySelector('#record-status').textContent.includes('一時停止中'));
  await page.locator('#record-pause').click();
  await page.waitForFunction(() => !window.paused);
  await page.locator('#record-finish').click();
  await page.waitForFunction(() => document.querySelector('#record-status').textContent.includes('保存先を選び直せます'));
  assert.equal(await page.evaluate(() => window.cancelled), false, 'cancel save retains completed recording');
  await page.locator('#record-finish').click();
  await page.waitForFunction(() => window.cancelled);
  assert.equal(await page.evaluate(() => saved.events[0].value), '日本語入力');
  assert.equal(await page.evaluate(() => calls.filter(call=>call.command==='cmd_recording_finish').length), 1, 'save retry does not finish twice');
  await page.evaluate(() => { window.cancelled=false; showControls(); });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.cancelled);
  assert.deepEqual(errors, []);

  const ids = ['viewport','canvas-container','svg-layer','snap-guide-layer','inspector-content','layer-list','layer-count','empty-state'];
  await page.route('**/selection-test', route => route.fulfill({contentType:'text/html', body:`<html><body>
    ${ids.map(id=>'<div id="'+id+'"></div>').join('')}<img id="bg-image"><svg id="handles-layer" width="800" height="600"></svg>
    <meta charset="utf-8"><script type="module">
      import {AnnotationEditor} from '/@fs/${modulePath}/editor.ts';
      window.editor=new AnnotationEditor(async()=>'<svg></svg>');
      editor.scene={canvas:{width:800,height:600},annotations:[{type:'rect',target:[10,10,20,20],style:'primary'},{type:'rect',target:[50,50,20,20],style:'danger'},{type:'arrow',start:[100,100],end:[150,150],style:'info'}]};
      editor.undoStack=[JSON.stringify(editor.scene)];editor.selectMany([0,1]);
    </script></body></html>`}));
  await page.goto(`${base}/selection-test`);
  await page.waitForSelector('#bulk-style');
  assert.match(await page.locator('#inspector-content').innerText(), /2 個のマークを選択中/);
  assert.equal(await page.locator('#bulk-style').inputValue(), '');
  await page.locator('#bulk-style').selectOption('warning');
  assert.deepEqual(await page.evaluate(() => editor.scene.annotations.map(a=>a.style)), ['warning','warning','info']);
  await page.locator('#bulk-stroke_width').fill('7');
  await page.locator('#bulk-stroke_width').dispatchEvent('change');
  assert.deepEqual(await page.evaluate(() => editor.scene.annotations.slice(0,2).map(a=>a.stroke_width)), [7,7]);
  await page.evaluate(() => editor.undo());
  assert.deepEqual(await page.evaluate(() => editor.scene.annotations.slice(0,2).map(a=>a.stroke_width ?? null)), [null,null]);
  await page.evaluate(() => editor.redo());
  assert.deepEqual(await page.evaluate(() => editor.scene.annotations.slice(0,2).map(a=>a.stroke_width)), [7,7]);
  await page.evaluate(() => editor.selectMany([0,1,2]));
  await page.getByRole('button', {name:'rect のみ選択'}).click();
  assert.deepEqual(await page.evaluate(() => [...editor.selection]), [0,1]);
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Delete');
  assert.deepEqual(await page.evaluate(() => editor.scene.annotations.map(a=>a.type)), ['arrow']);
  await page.evaluate(() => {
    editor.undo(); editor.selectMany([]);
  });
  const box = await page.locator('#handles-layer').boundingBox();
  await page.mouse.move(box.x + 1, box.y + 1);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 80, {steps:5});
  await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => [...editor.selection]), [0,1], 'mouse drag selects marks in a range');
  await page.locator('[data-handle-type="select-anno"][data-annotation-index="2"]').last().click({modifiers:['Shift']});
  assert.deepEqual(await page.evaluate(() => [...editor.selection]), [0,1,2], 'Shift-click adds a mark');
  assert.deepEqual(errors, []);
  console.log('Markits recording controls and bulk editing browser tests passed.');
} finally {
  await browser?.close();
  server?.kill();
}
