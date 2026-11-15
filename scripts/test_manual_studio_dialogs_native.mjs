import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';

const repo=process.cwd(),root=await mkdtemp(path.join(tmpdir(),'munin-dialog-native-'));
const run=promisify(execFile),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let app,browser;
try{
  await mkdir(path.join(root,'docs'));await writeFile(path.join(root,'docs/index.md'),'# Dialog fixture\n\nUnchanged manuscript.\n');
  await writeFile(path.join(root,'manual_setting.json'),JSON.stringify({docs:'docs',output:'published',assets:'docs/assets',targets:['docs'],connection_type:'none',agent:'codex'}));
  const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  app=spawn(path.join(repo,'target/debug/manual-studio.exe'),['--manual-studio-webview2-test',String(port),path.join(root,'profile')],{cwd:root,env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:path.join(root,'profile'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`},stdio:'ignore',windowsHide:true});
  let endpoint;
  for(let i=0;i<150;i++){assert.equal(app.exitCode,null);try{endpoint=(await(await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;if(endpoint)break;}catch{}await pause(100);}
  assert.ok(endpoint);browser=await chromium.connectOverCDP(endpoint);const context=browser.contexts()[0];context.setDefaultTimeout(15000);
  let page;
  for(let i=0;i<100;i++){page=context.pages().find(p=>!p.url().startsWith('about:'));if(page)break;await pause(100);}
  assert.ok(page);await page.goto(new URL(`/index.html?root=${encodeURIComponent(root)}`,page.url()).href);
  await page.waitForFunction(()=>document.querySelector('#markdown-editor')?.value.includes('Unchanged manuscript.'));
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.locator('#ui-theme').selectOption('midnight',{force:true});
  await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|set_size',{label:'main',value:{Logical:{width:1000,height:700}}}));
  const findChild=async id=>{
    for(let i=0;i<100;i++){
      for(const child of browser.contexts().flatMap(c=>c.pages()).filter(candidate=>!candidate.isClosed()&&candidate.url().includes('/dialog.html'))){
        try{if(await child.locator(`#${id}`).count()){child.on('pageerror',error=>errors.push(error.message));return child;}}catch(error){if(!child.isClosed())throw error;}
      }
      await pause(100);
    }
    throw Error(`Independent window did not render ${id}: ${await page.locator('[role=alert]').allTextContents()}`);
  };
  await page.locator('#application-settings').click();
  const settings=await findChild('panel-settings');
  const label=await settings.evaluate(()=>window.__TAURI_INTERNALS__.metadata.currentWindow.label);
  const before=await page.evaluate(async label=>({main:await window.__TAURI_INTERNALS__.invoke('plugin:window|inner_size',{label:'main'}),settings:await window.__TAURI_INTERNALS__.invoke('plugin:window|inner_size',{label}),maximized:await window.__TAURI_INTERNALS__.invoke('plugin:window|is_maximized',{label})}),label);
  assert.ok(before.settings.width>before.main.width,JSON.stringify(before));assert.equal(before.maximized,false);
  assert.equal(await page.locator('#panel-settings').isVisible(),false,'Original settings must not remain inside the app');
  await settings.waitForFunction(()=>document.documentElement.dataset.theme==='midnight');
  await settings.getByRole('tab',{name:'外観',exact:true}).click();
  await settings.locator('#ui-theme').selectOption('charcoal');
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='charcoal');
  await settings.waitForFunction(()=>document.documentElement.dataset.theme==='charcoal');
  await settings.getByRole('tab',{name:'外観',exact:true}).focus();await settings.keyboard.press('Home');
  await settings.locator('#settings-tab-keyboard[aria-selected=true]').waitFor();
  const shortcut=settings.locator('#shortcut-key-save-0');
  await shortcut.focus();await shortcut.press('Control+Alt+7');
  await settings.waitForFunction(()=>document.querySelector('#shortcut-key-save-0').value.includes('7'));
  assert.equal(await shortcut.inputValue(),await page.locator('#shortcut-key-save-0').inputValue(),'Recorded keys update the focused field');
  await shortcut.press('Escape');assert.equal(await page.locator('#panel-settings').evaluate(dialog=>dialog.open),true,'Esc ends key recording without closing settings');
  await settings.locator('[data-command=save]').getByRole('button',{name:'記録',exact:true}).first().click();
  await shortcut.press('Tab');await settings.waitForFunction(()=>document.querySelector('#shortcut-key-save-0').value==='Tab');
  await shortcut.press('Escape');
  await settings.getByRole('tab',{name:'外観',exact:true}).click();
  await settings.locator('#editor-font-size').fill('18');await settings.locator('#editor-font-size').dispatchEvent('change');
  await page.waitForFunction(()=>document.querySelector('#editor-font-size').value==='18');
  await settings.locator('#editor-font-size').fill('100');await settings.locator('#editor-font-size').dispatchEvent('change');
  await settings.waitForFunction(()=>document.querySelector('#editor-font-size').value==='18');
  await settings.locator('#toolbar-customization summary').click();
  const toolbarKey=await settings.locator('.toolbar-setting-row').nth(1).getAttribute('data-toolbar-setting');
  await settings.locator('.toolbar-setting-row').nth(1).locator('.toolbar-setting-moves button').first().click();
  await page.waitForFunction(key=>document.querySelector('.toolbar-setting-row')?.dataset.toolbarSetting===key,toolbarKey);
  await settings.waitForFunction(key=>document.querySelector('.toolbar-setting-row')?.dataset.toolbarSetting===key,toolbarKey);
  await settings.waitForFunction(()=>document.querySelector('#toolbar-customization').open);
  const draggedKey=await settings.locator('.toolbar-setting-row').first().getAttribute('data-toolbar-setting');
  await settings.locator('.toolbar-setting-row').nth(2).scrollIntoViewIfNeeded();
  const dragStart=await settings.locator('.toolbar-setting-grip').first().boundingBox(),dragEnd=await settings.locator('.toolbar-setting-row').nth(2).boundingBox();
  await settings.mouse.move(dragStart.x+dragStart.width/2,dragStart.y+dragStart.height/2);await settings.mouse.down();
  await settings.mouse.move(dragEnd.x+120,dragEnd.y+dragEnd.height-4,{steps:12});await settings.mouse.up();
  await page.waitForFunction(key=>document.querySelector('.toolbar-setting-row')?.dataset.toolbarSetting!==key,draggedKey);
  assert.equal(await settings.locator('[data-dialog-expand]').count(),0);
  assert.equal(await settings.getByRole('button',{name:'閉じる',exact:true}).count(),0);
  await settings.getByRole('tab',{name:'文章・図のAI',exact:true}).click();
  await settings.locator('#ai-connection-type').selectOption('local_llm');
  await settings.locator('#ai-endpoint-url').fill('http://127.0.0.1:11434/v1');
  await settings.locator('#ai-model').fill('native-dialog-fixture');
  await settings.locator('#ai-save-state').getByText('保存済み',{exact:true}).waitFor();
  const config=JSON.parse(await readFile(path.join(root,'manual_setting.json'),'utf8'));
  assert.equal(config.model,'native-dialog-fixture');assert.equal(config.connection_type,'local_llm');
  // Resizing the real OS window can exceed its opener in both dimensions.
  await page.evaluate(label=>window.__TAURI_INTERNALS__.invoke('plugin:window|set_size',{label,value:{Logical:{width:1600,height:1000}}}),label);
  const after=await page.evaluate(label=>window.__TAURI_INTERNALS__.invoke('plugin:window|inner_size',{label}),label);
  assert.ok(after.width>before.main.width&&after.height>before.main.height);
  await mkdir('ui-coverage-results',{recursive:true});await settings.screenshot({path:'ui-coverage-results/settings-native.png'});
  await page.evaluate(label=>window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label}),label);
  await page.waitForFunction(()=>!document.querySelector('#panel-settings').open);
  // Unsaved confirmation appears only in its child, once, and cancellation keeps the draft.
  await page.getByRole('button',{name:'Markdownソース',exact:true}).click();
  const draft='# Dialog fixture\n\nUnchanged manuscript.\nUnsaved draft.\n';
  await page.locator('#markdown-editor').fill(draft);
  await page.getByRole('button',{name:'index.mdを閉じる',exact:true}).click();
  const unsaved=await findChild('unsaved-changes-dialog');
  assert.equal(await page.evaluate(async()=> (await window.__TAURI_INTERNALS__.invoke('plugin:window|get_all_windows')).filter(label=>label.startsWith('dialog-')).length),1);
  assert.equal(await page.locator('#unsaved-changes-dialog').isVisible(),false);
  assert.equal(await unsaved.locator('[data-dialog-expand]').count(),0);
  assert.equal(await unsaved.getByRole('button',{name:'閉じる',exact:true}).count(),0);
  const confirmationBox=await unsaved.locator('#unsaved-changes-dialog').boundingBox();
  assert.ok(confirmationBox.width<=480&&confirmationBox.height<=300,JSON.stringify(confirmationBox));
  await unsaved.screenshot({path:'ui-coverage-results/unsaved-native.png'});
  await unsaved.getByRole('button',{name:'キャンセル',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#unsaved-changes-dialog'));
  assert.equal(await page.locator('#markdown-editor').inputValue(),draft);
  await page.getByRole('button',{name:'index.mdを閉じる',exact:true}).click();
  const discarded=await findChild('unsaved-changes-dialog');
  await discarded.getByRole('button',{name:'変更を破棄する',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#unsaved-changes-dialog'));
  assert.equal(await page.locator('#unsaved-changes-dialog').count(),0);
  assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),'# Dialog fixture\n\nUnchanged manuscript.\n');
  await page.locator('[data-page="docs/index.md"]').click();
  await page.waitForFunction(()=>document.querySelector('#markdown-editor')?.value.includes('Unchanged manuscript.'));
  const savedDraft='# Dialog fixture\n\nSaved from the confirmation.\n';
  await page.locator('#markdown-editor').fill(savedDraft);
  await page.getByRole('button',{name:'index.mdを閉じる',exact:true}).click();
  const saved=await findChild('unsaved-changes-dialog');
  await saved.getByRole('button',{name:'保存する',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#unsaved-changes-dialog')&&!document.querySelector('[data-document-page="index.md"]'));
  assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),savedDraft);
  // Removing a dialog or its containing panel must not leave an orphan OS window.
  for(const ancestor of [false,true]){
    await page.evaluate(()=>{
      const container=document.createElement('div');container.id='native-removal-container';
      const dialog=document.createElement('dialog');dialog.id='native-removal-test';dialog.innerHTML='<h2>Removal fixture</h2><p>Close through owner cleanup.</p>';
      window.removalClosed=0;dialog.onclose=()=>{window.removalClosed++;};container.append(dialog);document.body.append(container);dialog.showModal();
    });
    const removable=await findChild('native-removal-test'),removeLabel=await removable.evaluate(()=>window.__TAURI_INTERNALS__.metadata.currentWindow.label);
    await page.evaluate(ancestor=>document.getElementById(ancestor?'native-removal-container':'native-removal-test').remove(),ancestor);
    await page.waitForFunction(async label=>!(await window.__TAURI_INTERNALS__.invoke('plugin:window|get_all_windows')).includes(label),removeLabel);
    await page.waitForFunction(()=>window.removalClosed===1);
    await page.evaluate(()=>document.getElementById('native-removal-container')?.remove());
  }
  // Closing is prevented while the original dialog's cancel handler rejects it.
  await page.evaluate(()=>{
    const dialog=document.createElement('dialog');dialog.id='native-cancel-guard';dialog.innerHTML='<h2>Cancel guard</h2><button type="button">閉じられるようにする</button>';
    let allowed=false;dialog.oncancel=event=>{if(!allowed)event.preventDefault();};dialog.querySelector('button').onclick=()=>{allowed=true;};document.body.append(dialog);dialog.showModal();
  });
  const guarded=await findChild('native-cancel-guard');await guarded.keyboard.press('Escape');
  assert.equal(await page.locator('#native-cancel-guard').evaluate(dialog=>dialog.open),true);
  await guarded.getByRole('button',{name:'閉じられるようにする',exact:true}).click();await guarded.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.getElementById('native-cancel-guard').open);
  // A raw, dynamically created dialog must use the same host and preserve form validation/submit.
  await page.evaluate(()=>{
    const dialog=document.createElement('dialog');dialog.id='native-raw-form';dialog.innerHTML='<form><h2>Raw form</h2><label>名前<input id="raw-name" required></label><label>ファイル<input id="raw-file" type="file"></label><button type="submit">確定</button></form>';
    dialog.querySelector('#raw-file').onchange=async()=>{window.fileResult=await dialog.querySelector('#raw-file').files[0].text();};
    dialog.querySelector('form').onsubmit=event=>{event.preventDefault();window.rawResult=dialog.querySelector('input').value;dialog.close();dialog.remove();};document.body.append(dialog);dialog.showModal();
  });
  const raw=await findChild('native-raw-form');
  await raw.getByRole('button',{name:'確定',exact:true}).click();assert.equal(await page.evaluate(()=>window.rawResult),undefined);
  await raw.locator('#raw-name').dispatchEvent('compositionstart');await raw.locator('#raw-name').fill('日本語の入力');
  assert.equal(await page.locator('#raw-name').inputValue(),'');await raw.locator('#raw-name').dispatchEvent('compositionend');
  await raw.locator('#raw-file').setInputFiles({name:'fixture.txt',mimeType:'text/plain',buffer:Buffer.from('file transfer fixture')});
  await page.waitForFunction(()=>window.fileResult==='file transfer fixture');
  await raw.getByRole('button',{name:'確定',exact:true}).click();
  await page.waitForFunction(()=>window.rawResult==='日本語の入力');
  // Native title-bar close must run the original cancellation path.
  await page.locator('#application-settings').click();const again=await findChild('panel-settings');
  await again.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#panel-settings').open);
  await page.locator('#application-settings').click();const titleClose=await findChild('panel-settings');
  const closeLabel=await titleClose.evaluate(()=>window.__TAURI_INTERNALS__.metadata.currentWindow.label);
  await page.evaluate(label=>window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label}),closeLabel);
  await page.waitForFunction(()=>!document.querySelector('#panel-settings').open);
  assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),savedDraft);
  assert.deepEqual(errors,[]);
  await writeFile('ui-coverage-results/settings-native.json',JSON.stringify({before,after,savedModel:config.model,errors},null,2));
  await page.locator('#application-settings').click();const owned=await findChild('panel-settings');
  const ownedClosed=owned.waitForEvent('close');
  await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'})).catch(error=>{if(!page.isClosed())throw error;});
  await ownedClosed;
  for(let i=0;i<100&&app.exitCode===null;i++)await pause(100);
  assert.equal(app.exitCode,0,'Closing the owner must also close auxiliary windows and exit normally');
  console.log('Native dialogs passed: settings, focused validation, shortcut recording, IME, files, drag, save, cancellation guards and orphan-window cleanup.');
}finally{
  if(browser)await browser.close().catch(()=>{});
  if(app&&app.exitCode===null)await run('taskkill',['/PID',String(app.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:300});
}
