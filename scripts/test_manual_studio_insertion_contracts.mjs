import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {beginVerification, finishVerification} from './lib/manual_ui_report.mjs';
import {fingerprint} from './lib/manual_ui_inventory.mjs';
const verificationStart = await beginVerification();
await rm('ui-coverage-results/insertion/result.json', { force: true });
const root=await mkdtemp(path.join(os.tmpdir(),'munin-insert-contract-')),base='http://127.0.0.1:5174';
const initial='# Insertion\n\nBefore text.\n\nAfter text.\n',caret=initial.indexOf('After');
let browser,server,failSave=false,releaseSave,startedSave,holdNextSaves=0;
const heldSaves=[];
const records=[],assetRequests=[];
const waitStarted=promise=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Asset save request did not start')),10000);timer.unref();})]);
try{
 await mkdir(path.join(root,'docs/assets'),{recursive:true});await writeFile(path.join(root,'docs/index.md'),initial);await writeFile(path.join(root,'docs/other.md'),'# Other\n\nOther body.\n');await writeFile(path.join(root,'manual_setting.json'),JSON.stringify({docs:'docs',assets:'docs/assets',targets:['docs'],connection_type:'none'}));
 const png=await readFile('apps/manual-studio/src-tauri/icons/icon.png');const file={name:'fixture.png',mimeType:'image/png',buffer:png};
 server=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--config','apps/manual-studio/vite.config.ts'],{stdio:'ignore'});for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/__manual/rpc',async route=>{const request=route.request().postDataJSON();if(request.action==='save-asset'){assetRequests.push(request.options.path);
  if(failSave){await route.fulfill({json:{error:'Fixture asset save unavailable'}});return;}
  if(holdNextSaves>0){holdNextSaves--;await new Promise(resolve=>heldSaves.push({path:request.options.path,release:resolve}));}
  if(startedSave){startedSave();await new Promise(resolve=>releaseSave=resolve);startedSave=undefined;}
 }await route.continue();});
 await page.goto(`${base}/?root=${encodeURIComponent(root)}&page=index.md`);await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('Before text.'));const idle=()=>page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');await idle();await page.getByRole('button',{name:'Markdownソース',exact:true}).click();const editor=page.locator('#markdown-editor');
 async function verifySaved(expected){
  await editor.press('Control+s');
  for(let attempt=0;attempt<100;attempt++){if(await readFile(path.join(root,'docs/index.md'),'utf8')===expected){await idle();return;}await page.waitForTimeout(50);}
  assert.fail('visible insertion must reach the actual manuscript file');
 }
 const select=()=>editor.evaluate((node,caret)=>{node.focus();node.setSelectionRange(caret,caret);},caret);
 const chooseToolbarFile=async selectedFile=>{const chooser=page.waitForEvent('filechooser');await page.locator('#insert-image').click();await (await chooser).setFiles(selectedFile);};
 await select();await chooseToolbarFile(file);await page.locator('#image-save-dialog').waitFor();await page.locator('#image-save-alt').fill('Retained description');await page.locator('#cancel-image-save').click();assert.equal(await editor.inputValue(),initial);assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),initial);
 await select();await chooseToolbarFile(file);await page.locator('#image-save-dialog').waitFor();await page.locator('#image-save-alt').fill('Retained description');failSave=true;await page.locator('#image-save-form button[type=submit]').click();await idle();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Fixture asset save unavailable'));assert.equal(await page.locator('#image-save-dialog').isVisible(),true);assert.equal(await page.locator('#image-save-alt').inputValue(),'Retained description');assert.equal(await editor.inputValue(),initial);failSave=false;await page.locator('#image-save-form button[type=submit]').click();await idle();assert.equal(await editor.inputValue(),initial.slice(0,caret)+'![Retained description](assets/fixture.png)'+initial.slice(caret));assert.deepEqual(await readFile(path.join(root,'docs/assets/fixture.png')),png);assert.equal(((await editor.inputValue()).match(/!\[/g)||[]).length,1,'exactly one image before Undo');await verifySaved(await editor.inputValue());await editor.press('Control+z');assert.equal(await editor.inputValue(),initial);await verifySaved(initial);
await select();await page.evaluate(data=>{const f=new File([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],'guard.png',{type:'image/png'});const inp=document.querySelector('#toolbar-image-input');const dt=new DataTransfer();dt.items.add(f);inp.files=dt.files;inp.dispatchEvent(new Event('change'));const ed=document.querySelector('#markdown-editor');ed.value+='\nChanged before file read.';ed.dispatchEvent(new InputEvent('input',{bubbles:true}));},png.toString('base64'));await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('編集中の原稿が切り替わりました'));assert.equal(await page.locator('#image-save-dialog').isVisible(),false);await editor.fill(initial);await editor.press('Control+s');await idle();
 async function openDocument(name){
  const tab=page.locator(`[data-document-page="${name}"]`);
  if(await tab.count())await tab.click();
  else {await page.locator('#tree-search').fill(name);await page.locator(`[data-page="docs/${name}"]`).click();await page.locator('#tree-search').fill('');}
  await page.waitForFunction(name=>document.querySelector('#editor-title').textContent===name,name);await idle();
 }
 async function resetSource(){
  await openDocument('index.md');const toSource=page.getByRole('button',{name:'Markdownソース',exact:true});if(await toSource.count())await toSource.click();
  await editor.fill(initial);const saved=page.waitForResponse(response=>response.url().includes('/__manual/rpc')&&response.request().postDataJSON()?.action==='editor-save'&&response.request().postDataJSON()?.options?.json?.content===initial);
  await editor.press('Control+s');await saved;await idle();await select();
 }
 let pasteFromDocument=false;
 const paste=()=>editor.evaluate((node,{data,fromDocument})=>{const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],'pasted.png',{type:'image/png'}));if(fromDocument){document.querySelector('#editor-screenshot-ai').focus();document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));}else node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));},{data:png.toString('base64'),fromDocument:pasteFromDocument});
 const drop=name=>editor.evaluate((node,{data,name})=>{const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],name,{type:'image/png'}));node.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));},{data:png.toString('base64'),name});
 await openDocument('other.md');await resetSource();
 records.push({entry:'source file upload',steps:['choose same cursor','activate visible editor image insertion button','select fixture image through browser file chooser','cancel save dialog','repeat through visible button and chooser','fail save','retain image/description','retry','insert at captured cursor','Undo','guard against change during file read'],assertions:{visible:true,stored:true,preserved:true,returnTarget:true}});
 for(const clipboardEntry of ['source clipboard image','document clipboard image']){
 pasteFromDocument=clipboardEntry==='document clipboard image';
 await resetSource();
 // A clipboard image save is asynchronous. Moving the caret while it saves
 // must not change the insertion destination.
 await select();const started=new Promise(resolve=>startedSave=resolve);
 await paste();
 await waitStarted(started);await editor.evaluate(node=>node.setSelectionRange(0,0));releaseSave();await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('![image-'));await idle();let inserted=await editor.inputValue();assert.ok(inserted.startsWith(initial.slice(0,caret)));assert.ok(inserted.endsWith(initial.slice(caret)));const clipboardPath=inserted.match(/\]\((assets\/[^)]+)\)/)[1];assert.deepEqual(await readFile(path.join(root,'docs',clipboardPath)),png);assert.equal(((await editor.inputValue()).match(/!\[/g)||[]).length,1,'exactly one image before Undo');await verifySaved(await editor.inputValue());await editor.press('Control+z');assert.equal(await editor.inputValue(),initial);await verifySaved(initial);
 records.push({entry:clipboardEntry,steps:['paste at same cursor','hold actual asset save','move caret','complete save','verify original destination','Undo'],assertions:{visible:true,stored:true,preserved:true,returnTarget:true}});
 // Failed paste can be retried by pasting again.
 await resetSource();failSave=true;await paste();
 await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Fixture asset save unavailable'));await idle();
 const failedPaste=assetRequests.at(-1);assert.equal(await editor.inputValue(),initial);await assert.rejects(readFile(path.join(root,failedPaste)),{code:'ENOENT'});
 failSave=false;await paste();await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('![image-'));await idle();
 const retryPaste=assetRequests.at(-1);assert.deepEqual(await readFile(path.join(root,retryPaste)),png);await assert.rejects(readFile(path.join(root,failedPaste)),{code:'ENOENT'});
 assert.equal(((await editor.inputValue()).match(/!\[/g)||[]).length,1,'exactly one image before Undo');await verifySaved(await editor.inputValue());await editor.press('Control+z');assert.equal(await editor.inputValue(),initial);await verifySaved(initial);
 // A real tab switch and return must reject even an identical page/body.
 await resetSource();const switchingPaste=new Promise(resolve=>startedSave=resolve);await paste();await waitStarted(switchingPaste);
 await openDocument('other.md');assert.equal(await editor.inputValue(),'# Other\n\nOther body.\n');await openDocument('index.md');
 releaseSave();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('保存した画像はリソース一覧に残しています'));await idle();
 assert.equal(await editor.inputValue(),initial);assert.deepEqual(await readFile(path.join(root,assetRequests.at(-1))),png);
 records.find(r=>r.entry===clipboardEntry).steps.push('inject failed save and preserve manuscript','paste same data again and save one PNG','Undo','switch to other manuscript and back while saving','reject old opening session even with identical text');
 // Cancel a clipboard save through its visible control, then retry normally.
 await resetSource();const cancelledPasteStarted=new Promise(resolve=>startedSave=resolve);await paste();await waitStarted(cancelledPasteStarted);
 const cancelledPastePath=assetRequests.at(-1);await page.locator('#cancel-image-paste').click();
 assert.equal(await editor.inputValue(),initial);assert.equal(await editor.evaluate(node=>node.selectionStart),caret);
 const pendingRequests=assetRequests.length;await paste();assert.equal(assetRequests.length,pendingRequests,'another paste cannot overlap a cancelled save awaiting completion');
 releaseSave();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('画像の挿入はキャンセルされました'));await idle();
 assert.equal(await editor.inputValue(),initial);assert.deepEqual(await readFile(path.join(root,cancelledPastePath)),png);
 assert.equal(await page.locator('#cancel-image-paste').isVisible(),false);
 await paste();await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('![image-'));await idle();
 const afterCancelRetry=await editor.inputValue();assert.ok(afterCancelRetry.startsWith(initial.slice(0,caret)));assert.ok(afterCancelRetry.endsWith(initial.slice(caret)));
 assert.equal(((await editor.inputValue()).match(/!\[/g)||[]).length,1,'exactly one image before Undo');await verifySaved(await editor.inputValue());await editor.press('Control+z');assert.equal(await editor.inputValue(),initial);await verifySaved(initial);
 // Hold FileReader delivery to verify that the opening cursor is captured
 // before reading, and that cancelling before saving creates no asset.
 for(const cancelBeforeRead of [false,true]){
  await resetSource();const requestCount=assetRequests.length;
  await page.evaluate(()=>{window.__originalReader=window.FileReader;window.FileReader=class extends window.__originalReader{readAsDataURL(file){const deliver=this.onload;this.onload=event=>{window.__releaseRead=()=>deliver.call(this,event);};super.readAsDataURL(file);}};});
  await paste();await page.waitForFunction(()=>typeof window.__releaseRead==='function');
  if(cancelBeforeRead)await page.locator('#cancel-image-paste').click();else await editor.evaluate(node=>node.setSelectionRange(0,0));
  await page.evaluate(()=>{window.FileReader=window.__originalReader;const release=window.__releaseRead;delete window.__releaseRead;release();});
  if(cancelBeforeRead){await idle();assert.equal(assetRequests.length,requestCount);assert.equal(await editor.inputValue(),initial);}
  else{await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('![image-'));await idle();const value=await editor.inputValue();assert.ok(value.startsWith(initial.slice(0,caret)));assert.ok(value.endsWith(initial.slice(caret)));assert.equal(((await editor.inputValue()).match(/!\[/g)||[]).length,1,'exactly one image before Undo');await verifySaved(await editor.inputValue());await editor.press('Control+z');assert.equal(await editor.inputValue(),initial);await verifySaved(initial);}
 }
 records.find(r=>r.entry===clipboardEntry).steps.push('cancel held save through visible control','reject overlapping paste until save finishes','preserve saved PNG without insertion','paste again at captured cursor and Undo','capture cursor before FileReader delivery','cancel before FileReader delivery without saving an asset');
 }
 pasteFromDocument=false;
 // A manuscript edit while a save is pending makes the insertion stale.
 await resetSource();const staleStarted=new Promise(resolve=>startedSave=resolve);await editor.evaluate((node,data)=>{const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(data),char=>char.charCodeAt(0))],'drop.png',{type:'image/png'}));node.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));},png.toString('base64'));await page.locator('#image-save-dialog').waitFor();await page.locator('#image-save-form button[type=submit]').click();await waitStarted(staleStarted);await editor.evaluate((node,value)=>{node.value=value;node.dispatchEvent(new InputEvent('input',{bubbles:true}));},initial+'Changed while saving.\n');releaseSave();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('保存した画像はリソース一覧に残しています'));assert.equal(await editor.inputValue(),initial+'Changed while saving.\n');assert.deepEqual(await readFile(path.join(root,'docs/assets/drop.png')),png);await page.locator('#cancel-image-save').click();await page.waitForFunction(()=>!document.querySelector('#image-save-dialog')?.open);
 records.push({entry:'source file drop',steps:['drop image and confirm save','hold asset save','fault: change live manuscript','complete save','reject stale insertion and preserve saved asset'],assertions:{visible:true,stored:true,preserved:true,returnTarget:true}});
 // Drop uses the same visible save dialog for cancellation and retry.
 await resetSource();await drop('retry-drop.png');await page.locator('#image-save-dialog').waitFor();await page.locator('#cancel-image-save').click();
 assert.equal(await editor.inputValue(),initial);assert.equal(await editor.evaluate(node=>node.selectionStart),caret,'cancel returns to the captured cursor');await assert.rejects(readFile(path.join(root,'docs/assets/retry-drop.png')),{code:'ENOENT'});
 await drop('retry-drop.png');await page.locator('#image-save-dialog').waitFor();await page.locator('#image-save-alt').fill('Drop description');failSave=true;
 await page.locator('#image-save-form button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Fixture asset save unavailable'));await idle();
 assert.equal(await page.locator('#image-save-alt').inputValue(),'Drop description');assert.equal(await editor.inputValue(),initial);failSave=false;
 await page.locator('#image-save-form button[type=submit]').click();await page.waitForFunction(()=>!document.querySelector('#image-save-dialog').open);await idle();
 assert.equal(await editor.inputValue(),initial.slice(0,caret)+'![Drop description](assets/retry-drop.png)'+initial.slice(caret));assert.deepEqual(await readFile(path.join(root,'docs/assets/retry-drop.png')),png);
 assert.equal(((await editor.inputValue()).match(/!\[/g)||[]).length,1,'exactly one image before Undo');await verifySaved(await editor.inputValue());await editor.press('Control+z');assert.equal(await editor.inputValue(),initial);await verifySaved(initial);
 // Escape withdraws insertion even after the actual asset save has started.
 for(const entry of ['source file upload','source file drop']){
  await resetSource();const name=entry==='source file upload'?'escape-file.png':'escape-drop.png';
  if(entry==='source file upload')await chooseToolbarFile({...file,name});else await drop(name);
  await page.locator('#image-save-dialog').waitFor();const cancelSaving=new Promise(resolve=>startedSave=resolve);
  await page.locator('#image-save-form button[type=submit]').click();await waitStarted(cancelSaving);await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.querySelector('#image-save-dialog').open);assert.equal(await editor.inputValue(),initial);
  releaseSave();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('挿入はキャンセルされました'));await idle();
  assert.equal(await editor.inputValue(),initial);assert.equal(await editor.evaluate(node=>node.selectionStart),caret);assert.deepEqual(await readFile(path.join(root,'docs/assets',name)),png);
  records.find(r=>r.entry===entry).steps.push('confirm and hold actual asset save','cancel open save dialog with Escape','complete save while preserving PNG and original manuscript/cursor');
 }
 // Deliver an actual FileReader result after a real tab switch, deterministically.
 for(const entry of ['source file upload','source file drop']){
  await resetSource();const count=assetRequests.length;
  await page.evaluate(()=>{window.__originalReader=window.FileReader;window.FileReader=class extends window.__originalReader{readAsDataURL(file){const deliver=this.onload;this.onload=event=>{window.__releaseRead=()=>deliver.call(this,event);};super.readAsDataURL(file);}};});
  if(entry==='source file upload')await chooseToolbarFile(file);else await drop('switch-drop.png');
  await page.waitForFunction(()=>typeof window.__releaseRead==='function');await openDocument('other.md');
  await page.evaluate(()=>{window.FileReader=window.__originalReader;const release=window.__releaseRead;delete window.__releaseRead;release();});
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('編集中の原稿が切り替わりました'));
  assert.equal(await editor.inputValue(),'# Other\n\nOther body.\n');assert.equal(await page.locator('#image-save-dialog').isVisible(),false);assert.equal(assetRequests.length,count);
  records.find(r=>r.entry===entry).steps.push('timing fault: defer actual FileReader load delivery','switch through real manuscript tab','deliver original image result','reject before save and preserve other manuscript');
 }
 await resetSource();records.find(r=>r.entry==='source file drop').steps.push('cancel save dialog without creating file','inject failed save and retain description','retry same file and cursor','Undo');
 // Rich editor's actual upload entry shares document identity
 // protection, with native ProseMirror Undo.
 await editor.fill(initial);await editor.press('Control+s');await idle();await page.getByRole('button',{name:'Milkdown編集',exact:true}).click();await page.locator('.ProseMirror p').filter({hasText:'After text.'}).click();await page.keyboard.press('Home');const richBefore=await editor.inputValue();await page.locator('.milkdown-top-bar').getByRole('button',{name:'画像',exact:true}).click();await page.locator('.milkdown-image-block input[type=file]').setInputFiles(file);await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('assets/image-'));const richPath=(await editor.inputValue()).match(/(?:\.\.\/)*assets\/image-[A-Za-z0-9._-]+/)?.[0];assert.ok(richPath,'uploaded asset reference must be serialized');assert.deepEqual(await readFile(path.join(root,'docs',richPath)),png);await verifySaved(await editor.inputValue());await page.locator('.milkdown-top-bar').getByRole('button',{name:'元に戻す',exact:true}).click();assert.ok((await editor.inputValue()).includes('![]()'));await page.locator('.milkdown-top-bar').getByRole('button',{name:'元に戻す',exact:true}).click();assert.equal((await editor.inputValue()).trim(),richBefore.trim());await verifySaved(await editor.inputValue());
 // Slow upload must survive an explicit manuscript save.
 await page.getByRole('button',{name:'Markdownソース',exact:true}).click();
 await editor.fill(initial);await editor.press('Control+s');await idle();
 await page.getByRole('button',{name:'Milkdown編集',exact:true}).click();
 await page.locator('.ProseMirror p').filter({hasText:'After text.'}).click();await page.keyboard.press('Home');
 const autosaved=page.waitForResponse(response=>response.url().includes('/__manual/rpc')&&response.request().postDataJSON()?.action==='editor-save'&&response.request().postDataJSON()?.options?.json?.content?.includes('![]()'));
 await page.locator('.milkdown-top-bar').getByRole('button',{name:'画像',exact:true}).click();
 const slowStarted=new Promise(resolve=>startedSave=resolve);
 await page.locator('.milkdown-image-block input[type=file]').setInputFiles(file);await waitStarted(slowStarted);
 await page.keyboard.press('Control+s');await autosaved;await page.waitForFunction(()=>document.querySelector('#save-state').dataset.state==='saved');
 releaseSave();await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('assets/image-'),{},{timeout:15000});
 await page.locator('.milkdown-top-bar').getByRole('button',{name:'元に戻す',exact:true}).click();
 await page.locator('.milkdown-top-bar').getByRole('button',{name:'元に戻す',exact:true}).click();
 assert.equal((await editor.inputValue()).trim(),initial.trim());
 async function richPlaceholder(){
  await resetSource();await page.getByRole('button',{name:'Milkdown編集',exact:true}).click();
  await page.locator('.ProseMirror p').filter({hasText:'After text.'}).click();await page.keyboard.press('Home');
  await page.locator('.milkdown-top-bar').getByRole('button',{name:'画像',exact:true}).click();
  return page.locator('.milkdown-image-block input[type=file]');
 }
 const richInput=await richPlaceholder();failSave=true;await richInput.setInputFiles(file);
 await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Fixture asset save unavailable'));
 assert.equal(await richInput.inputValue(),'','failed upload must allow choosing the same file again');
 const failedRich=assetRequests.at(-1);await assert.rejects(readFile(path.join(root,failedRich)),{code:'ENOENT'});
 assert.ok((await editor.inputValue()).includes('Before text.'));assert.ok((await editor.inputValue()).includes('After text.'));failSave=false;
 await richInput.setInputFiles(file);await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('assets/image-'));
 const richMarkup=await editor.inputValue();assert.ok(richMarkup.indexOf('Before text.')<richMarkup.indexOf('assets/image-')&&richMarkup.indexOf('assets/image-')<richMarkup.indexOf('After text.'),'rich insertion uses the same semantic cursor as source entries');
 assert.deepEqual(await readFile(path.join(root,assetRequests.at(-1))),png);await assert.rejects(readFile(path.join(root,failedRich)),{code:'ENOENT'});
 await page.locator('.milkdown-top-bar').getByRole('button',{name:'元に戻す',exact:true}).click();await page.locator('.milkdown-top-bar').getByRole('button',{name:'元に戻す',exact:true}).click();assert.equal((await editor.inputValue()).trim(),initial.trim());
 // Undo withdraws the image block while its actual save is pending.
 const cancelInput=await richPlaceholder();const cancellingUpload=new Promise(resolve=>startedSave=resolve);await cancelInput.setInputFiles(file);await waitStarted(cancellingUpload);
 const cancelledPath=assetRequests.at(-1);await page.locator('.milkdown-top-bar').getByRole('button',{name:'元に戻す',exact:true}).click();assert.equal((await editor.inputValue()).trim(),initial.trim());
 releaseSave();await page.waitForFunction(()=>document.querySelector('#status').textContent==='画像を保存しました。');
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal((await editor.inputValue()).trim(),initial.trim());assert.deepEqual(await readFile(path.join(root,cancelledPath)),png);
 // Late upload is rejected after a real manuscript switch.
 const switchInput=await richPlaceholder();const switchingUpload=new Promise(resolve=>startedSave=resolve);await switchInput.setInputFiles(file);await waitStarted(switchingUpload);
 const switchedPath=assetRequests.at(-1);await openDocument('other.md');releaseSave();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('編集中の原稿が切り替わりました'));
 assert.equal(await editor.inputValue(),'# Other\n\nOther body.\n');assert.equal(await readFile(path.join(root,'docs/other.md'),'utf8'),'# Other\n\nOther body.\n');assert.deepEqual(await readFile(path.join(root,switchedPath)),png);
 await resetSource();
 records.push({entry:'rich image upload',steps:['choose insertion context','upload real PNG through Milkdown','check Markdown reference','native editor Undo','hold upload through explicit manuscript save','retry same file after visible error','cancel image block with Undo during save','switch through actual manuscript tab and reject late upload'],assertions:{visible:true,stored:true,preserved:true,returnTarget:true}});
 // Crepe's file gestures use an upload placeholder, rather than the image-input block.
 for(const gesture of ['paste','drop']){
  const entry=`rich image ${gesture}`;
  async function richGesture(){
   await resetSource();await page.getByRole('button',{name:'Milkdown編集',exact:true}).click();
   const paragraph=page.locator('.ProseMirror p').filter({hasText:'After text.'});
   return async()=>{
    // Every new user gesture selects the same semantic insertion point. Upload
    // failure can move the browser caret and relayout the placeholder, so do not
    // reuse a cursor or screen coordinates captured before that failure.
    await paragraph.click();await page.keyboard.press('Home');
    assert.ok(await paragraph.evaluate(node=>{
     const selection=window.getSelection();
     if(!selection?.isCollapsed||!selection.anchorNode||!node.contains(selection.anchorNode))return false;
     const before=document.createRange();before.selectNodeContents(node);before.setEnd(selection.anchorNode,selection.anchorOffset);
     return before.toString()==='';
    }),'rich image gesture starts at the beginning of the After paragraph');
    // Home updates the browser selection first. Wait for the public source
    // selection synchronized by ProseMirror before dispatching a synthetic
    // paste/drop; a physical paste includes an intervening keyboard event.
    await page.waitForFunction(()=>{
     const source=document.querySelector('#markdown-editor');
     return source.selectionStart===source.selectionEnd&&source.selectionStart===source.value.indexOf('After text.');
    });
    const bounds=await paragraph.boundingBox();
    await page.locator('.ProseMirror').evaluate((node,{data,gesture,x,y})=>{
     const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],'gesture.png',{type:'image/png'}));
     node.dispatchEvent(gesture==='paste'?new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}):new DragEvent('drop',{dataTransfer:transfer,clientX:x,clientY:y,bubbles:true,cancelable:true}));
    },{data:png.toString('base64'),gesture,x:bounds.x+1,y:bounds.y+bounds.height/2});
   };
  }
  let fire=await richGesture();failSave=true;await fire();
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Fixture asset save unavailable'));
  await page.waitForFunction(()=>!document.querySelector('.ProseMirror').textContent.includes('Upload in progress...'),{},{timeout:3000});
  assert.equal((await editor.inputValue()).trim(),initial.trim());const failedPath=assetRequests.at(-1);await assert.rejects(readFile(path.join(root,failedPath)),{code:'ENOENT'});
  failSave=false;await fire();await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('assets/image-'));
  const value=await editor.inputValue();assert.equal((value.match(/assets\/image-/g)||[]).length,1);assert.ok(value.indexOf('Before text.')<value.indexOf('assets/image-')&&value.indexOf('assets/image-')<value.indexOf('After text.'),`rich ${gesture} retry must insert between the original paragraphs: ${value}`);
  assert.deepEqual(await readFile(path.join(root,assetRequests.at(-1))),png);
  const savedGesture=page.waitForResponse(response=>response.url().includes('/__manual/rpc')&&response.request().postDataJSON()?.action==='editor-save'&&response.request().postDataJSON()?.options?.json?.content===value);
  await page.locator('.ProseMirror').press('Control+s');await savedGesture;await idle();assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),value);
  await page.locator('.milkdown-top-bar').getByRole('button',{name:'元に戻す',exact:true}).click();assert.equal((await editor.inputValue()).trim(),initial.trim());
  fire=await richGesture();const cancelled=new Promise(resolve=>startedSave=resolve);await fire();await waitStarted(cancelled);const cancelledAsset=assetRequests.at(-1);
  await page.locator('.milkdown-top-bar').getByRole('button',{name:'元に戻す',exact:true}).click();releaseSave();
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='画像を保存しました。');await idle();
  assert.equal((await editor.inputValue()).trim(),initial.trim());assert.deepEqual(await readFile(path.join(root,cancelledAsset)),png);
  await verifySaved(await editor.inputValue());
  fire=await richGesture();const pending=new Promise(resolve=>startedSave=resolve);await fire();await waitStarted(pending);const retained=assetRequests.at(-1);
  await openDocument('other.md');releaseSave();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('編集中の原稿が切り替わりました'));
  assert.equal(await editor.inputValue(),'# Other\n\nOther body.\n');assert.deepEqual(await readFile(path.join(root,retained)),png);
  await openDocument('index.md');
  assert.equal((await editor.inputValue()).trim(),initial.trim());
  assert.equal(await page.locator('.ProseMirror').textContent().then(text=>text.includes('Upload in progress...')),false,'returning to a cached document must not revive a rejected upload placeholder');
  await resetSource();
  records.push({entry,steps:['same manuscript and semantic cursor','dispatch actual rich file gesture to Crepe plugin','fail real save via transport fault','visible error and cleared upload placeholder','retry same file once','verify PNG bytes and actual saved Markdown','rich Undo restores body','cancel pending upload using visible rich Undo and retain saved asset without insertion','switch actual document while save waits','preserve saved PNG and other manuscript, reject late insertion'],assertions:{visible:true,stored:true,preserved:true,returnTarget:true}});
 }
 // Physical Ctrl+Z must cancel pending rich file gestures, while Undo of a
 // separate image block must leave an independent pending paste intact.
 async function pendingRichGesture(gesture){
  const paragraph=page.locator('.ProseMirror p').filter({hasText:'After text.'});await paragraph.click();await page.keyboard.press('Home');
  const bounds=await paragraph.boundingBox();assert.ok(bounds);
  await page.locator('.ProseMirror').evaluate((node,{data,gesture,x,y})=>{const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],'pending.png',{type:'image/png'}));node.dispatchEvent(gesture==='paste'?new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}):new DragEvent('drop',{dataTransfer:transfer,clientX:x,clientY:y,bubbles:true,cancelable:true}));},{data:png.toString('base64'),gesture,x:bounds.x+1,y:bounds.y+bounds.height/2});
 }
 const waitForHeldSaves = async count => {
  for (let i = 0; i < 100; i++) {
   if (heldSaves.length >= count) return;
   await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(heldSaves.length, count, `timed out waiting for heldSaves to reach ${count}`);
 };
 for(const gesture of ['paste','drop']){
  await resetSource();await page.getByRole('button',{name:'Milkdown編集',exact:true}).click();holdNextSaves=1;
  await pendingRichGesture(gesture);await page.waitForFunction(()=>document.querySelector('.ProseMirror')?.textContent.includes('Upload in progress...'));
  await waitForHeldSaves(1);
  assert.equal(heldSaves.length,1);const cancelled=heldSaves.shift();await page.locator('.ProseMirror').press('Control+z');
  assert.equal((await editor.inputValue()).trim(),initial.trim());cancelled.release();
  await page.waitForFunction(()=>!document.querySelector('.ProseMirror')?.textContent.includes('Upload in progress...'));await idle();
  assert.equal((await editor.inputValue()).trim(),initial.trim(),`physical rich Ctrl+Z rejects the late ${gesture} image`);
  assert.deepEqual(await readFile(path.join(root,cancelled.path)),png,`cancelled ${gesture} retains its saved PNG`);
  records.find(r=>r.entry===`rich image ${gesture}`).steps.push(`physical Ctrl+Z cancels pending rich ${gesture} after real file gesture and preserves saved PNG`);
 }
 await resetSource();await page.getByRole('button',{name:'Milkdown編集',exact:true}).click();
 holdNextSaves=2;await page.locator('.milkdown-top-bar').getByRole('button',{name:'画像',exact:true}).click();
 await page.locator('.milkdown-image-block input[type=file]').setInputFiles(file);
 await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('![]()'));
 await pendingRichGesture('paste');await page.waitForFunction(()=>document.querySelector('.ProseMirror')?.textContent.includes('Upload in progress...'));
 await waitForHeldSaves(2);
 assert.equal(heldSaves.length,2);const independentPath=heldSaves[1].path;
 await page.locator('.milkdown-top-bar').getByRole('button',{name:'元に戻す',exact:true}).click();
 assert.equal((await editor.inputValue()).trim(),initial.trim(),'Undo removes only the image block');
 for(const held of heldSaves.splice(0))held.release();
 await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('assets/image-'));await idle();
 const independentMarkup=await editor.inputValue();
 assert.equal((independentMarkup.match(/assets\/image-/g)||[]).length,1,'independent pending paste survives another upload Undo');
 assert.deepEqual(await readFile(path.join(root,independentPath)),png);
 await page.locator('.milkdown-top-bar').getByRole('button',{name:'元に戻す',exact:true}).click();
 assert.equal((await editor.inputValue()).trim(),initial.trim());
 records.find(r=>r.entry==='rich image paste').steps.push('Undo one image block while another rich paste waits','independent pending paste inserts once after release');
 assert.deepEqual(errors,[]);assert.equal(await readFile(path.join(root,'docs/other.md'),'utf8'),'# Other\n\nOther body.\n');assert.equal(await page.locator('#editor-title').textContent(),'index.md');
 await mkdir('ui-coverage-results/insertion',{recursive:true});await page.screenshot({path:'ui-coverage-results/insertion/final.png'});
 const registry=JSON.parse(await readFile('scripts/fixtures/manual-studio-ui-inventory.json','utf8'));
 const artifacts=[{path:'final.png',sha256:fingerprint(await readFile('ui-coverage-results/insertion/final.png'))}];
 const cases=registry.cases.filter(c=>c.existingChecks?.includes('scripts/test_manual_studio_insertion_contracts.mjs'));
 assert.equal(cases.length,7,'the seven tested insertion routes must be registered explicitly');
 const results=cases.flatMap(c=>{const record=records.find(r=>r.entry===c.evidenceRecord);assert.ok(record,`Missing actual record for ${c.id}`);return c.entryPoints.map(entryPoint=>({caseId:c.id,entryPoint,type:'real-backend',status:'passed',steps:record.steps,assertions:record.assertions,artifacts}));});
 await writeFile('ui-coverage-results/insertion/result.json',JSON.stringify({...await finishVerification(verificationStart),type:'real-backend',scope:'explicit file/clipboard/drop/rich upload entries only; managed and AI insertion are separate tests; save failures use injected transport errors; FileReader delivery timing is controlled for switch cases; clipboard insertion cancellation preserves completed asset saves',records,results},null,2));console.log(`Insertion contracts passed ${records.length} entries: cancel/retry/captured cursor/stale source/rich Undo.`);
}finally{await browser?.close();server?.kill();await rm(root,{recursive:true,force:true});}
