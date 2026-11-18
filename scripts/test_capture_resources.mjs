import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {createHash} from 'node:crypto';
const root=await mkdtemp(path.join(os.tmpdir(),'munin-capture-resources-'));
const native=process.argv.includes('--native'),keep=process.argv.includes('--keep-open');
const run=promisify(execFile);
const base='http://127.0.0.1:5174';let server,browser,app;
try{
 await mkdir(path.join(root,'docs/assets'),{recursive:true});
 await writeFile(path.join(root,'manual_setting.json'),JSON.stringify({docs:'docs',assets:'docs/assets',targets:['docs'],connection_type:'none'}));
 await writeFile(path.join(root,'docs/index.md'),'# Capture resources\n\nOriginal text.\n');
 if(!native){server=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--config','apps/manual-studio/vite.config.ts'],{stdio:'ignore'});
 for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}}
 const rpc=async(action,json={})=>{if(native){const result=await run(path.resolve('target/debug/manualctl.exe'),['--request',JSON.stringify({root,action,options:{json}})],{windowsHide:true});return JSON.parse(result.stdout);}const response=await fetch(base+'/__manual/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({root,action,options:{json}})});const result=await response.json();if(result.error)throw Error(result.error);return JSON.parse(result.output);};
 const png=await readFile('apps/manual-studio/src-tauri/icons/icon.png');
 const resource=await rpc('capture-resources-register',{source:png.toString('base64'),name:'Capture resource example'});
 assert.equal((await rpc('capture-resources-register',{source:png.toString('base64')})).id,resource.id);
 let page;
 if(native){
  const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  app=spawn(path.resolve('target/debug/manual-studio.exe'),['--manual-studio-webview2-test',String(port),path.join(root,'webview-profile')],{cwd:root,env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:path.join(root,'webview-profile'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`},stdio:'ignore',windowsHide:true});
  let endpoint;for(let i=0;i<150;i++){try{endpoint=(await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;if(endpoint)break;}catch{}await new Promise(r=>setTimeout(r,200));}assert(endpoint,'native debugger must start');
  browser=await chromium.connectOverCDP(endpoint);
  for(let i=0;i<100;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>!p.url().startsWith('about:')&&!p.url().includes('dialog.html'));if(page)break;await new Promise(r=>setTimeout(r,100));}
  assert(page,'Native main WebView must load');
  await page.goto(new URL(`/index.html?root=${encodeURIComponent(root)}&page=index.md`,page.url()).href);
 }else{browser=await chromium.launch({channel:process.env.MUNIN_TEST_BROWSER||(process.platform==='win32'?'msedge':'chrome'),headless:true});page=await browser.newPage({viewport:{width:1440,height:900}});await page.goto(base+'/?root='+encodeURIComponent(root)+'&page=index.md');}
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
 if(!native){
  // Replace only the OS capture boundary; generation and editor insertion are real.
  await page.evaluate(resource=>{window.captureFixture=resource;window.captureCancelled=false;window.originalInvoke=window.__TAURI_INTERNALS__?.invoke.bind(window.__TAURI_INTERNALS__);if(!window.__TAURI_INTERNALS__)window.__TAURI_INTERNALS__={};window.__TAURI_INTERNALS__.invoke=async(command,args)=>{if(command==='capture_markits_image')return window.captureCancelled?null:window.captureFixture;if(window.originalInvoke)return window.originalInvoke(command,args);throw Error(command);};},resource);
  const original=await page.locator('#markdown-editor').inputValue();
  await page.evaluate(()=>window.captureCancelled=true);
  await page.locator('#editor-screenshot-ai').click();
  await page.waitForFunction(()=>!document.querySelector('#editor-screenshot-ai').disabled);
  assert.equal(await page.locator('#markdown-editor').inputValue(),original,'Cancelled capture preserves the manuscript');
  await page.evaluate(()=>window.captureCancelled=false);
  await page.locator('#editor-screenshot-ai').click();
  await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('assets/captures/'));
  await page.waitForFunction(()=>!document.querySelector('#editor-screenshot-ai').disabled);
  assert.equal(await page.locator('.ProseMirror img').count(),1,'Capture inserts into the rich editor');
  await page.locator('#editor-mode-toggle').click();
  const captured=await page.locator('#markdown-editor').inputValue();
  await page.locator('#markdown-editor').evaluate(e=>e.setSelectionRange(e.value.length,e.value.length));
  await page.locator('#editor-screenshot-ai').click();
  await page.waitForFunction(before=>document.querySelector('#markdown-editor').value!==before,captured);
  await page.waitForFunction(()=>!document.querySelector('#editor-screenshot-ai').disabled);
  assert.equal((await page.locator('#markdown-editor').inputValue()).match(/assets\/captures\//g).length,2);
  await page.evaluate(()=>{if(window.originalInvoke)window.__TAURI_INTERNALS__.invoke=window.originalInvoke;else delete window.__TAURI_INTERNALS__;});
  await page.locator('#markdown-editor').fill(original);
  await page.locator('#save-page').click();await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  await page.locator('#editor-mode-toggle').click();
 }
 await page.locator('#view-menu-button').click();
 const dockToggle=page.locator('#view-menu-dropdown label').filter({hasText:'撮影リソース一覧'}).locator('input');
 if(!await dockToggle.isChecked())await dockToggle.check();
 await page.locator('#view-menu-button').click();
 await page.locator('.flexlayout__tab_button').filter({hasText:'撮影リソース一覧'}).first().click();
 const card=page.locator(`[data-capture-resource="${resource.id}"]`);await card.waitFor({state:'visible'});
 for(const name of ['MarkItsで編集','再撮影']){
  const button=card.getByRole('button',{name,exact:true});
  assert.equal(await button.textContent(),'');assert.equal(await button.getAttribute('title'),name);assert.equal(await button.locator('svg').count(),1);
 }
 assert.equal(await card.getByRole('button',{name:'画像を生成',exact:true}).count(),0);
 assert.equal(await card.getByRole('button',{name:'文書に挿入',exact:true}).count(),0);
 assert.equal(await card.getByRole('button',{name:'再撮影',exact:true}).isDisabled(),true);
 await rpc('capture-resources-generate',{id:resource.id});
 const d=(await rpc('capture-resources-list')).items[0].derived[0];
 const output=await readFile(path.join(root,d.path));assert(output.includes(Buffer.from('munin:resource-id')));assert(!output.includes(Buffer.from('markits:')));
 assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),'# Capture resources\n\nOriginal text.\n','generation must not change Markdown');
 assert.equal(await page.locator('#capture-resource-new,#capture-resource-search,#capture-resource-migrate,#capture-resource-refresh').count(),0);
 await page.waitForFunction(()=>document.querySelector('[data-capture-resource] img')?.naturalWidth>0);
 await page.screenshot({path:native?'reviews/capture-resources-webview2.png':'reviews/capture-resources-browser.png'});
 const findDialog=async(selector='dialog[data-screenshot-destination]')=>{
  if(!native)return page;
  for(let i=0;i<100;i++){for(const p of browser.contexts().flatMap(c=>c.pages()).filter(p=>!p.isClosed()&&p.url().includes('/dialog.html'))){try{if(await p.locator(selector).count())return p;}catch{}}await new Promise(r=>setTimeout(r,100));}
  throw Error('Native insertion window did not open: '+JSON.stringify(await Promise.all(browser.contexts().flatMap(c=>c.pages()).filter(p=>!p.isClosed()).map(async p=>({url:p.url(),body:(await p.locator('body').innerText()).slice(0,180),dialogs:await p.locator('[data-screenshot-destination]').count()})))));
 };
 // Exercise the same resource drop through both real editor modes and history.
 const source=page.locator('#markdown-editor');
 await page.locator('#editor-mode-toggle').click();await source.waitFor({state:'visible'});
 const beforeSourceDrop=await source.inputValue();await source.focus();
 await source.evaluate(e=>e.setSelectionRange(e.value.length,e.value.length));
 const payload={root,path:`capture-resource:${resource.id}`,resource_id:resource.id};
 await card.locator('img').dragTo(source);
 await page.waitForFunction(before=>document.querySelector('#markdown-editor').value!==before,beforeSourceDrop);
 const afterSourceDrop=await source.inputValue();assert(afterSourceDrop.includes('assets/captures/'));
 await source.press('Control+z');await page.waitForFunction(before=>document.querySelector('#markdown-editor').value===before,beforeSourceDrop);
 await source.press('Control+Shift+z');await page.waitForFunction(after=>document.querySelector('#markdown-editor').value===after,afterSourceDrop);
 const configured=afterSourceDrop+'\n\n<figure data-munin-image="true" data-width="50" data-align="right"><img src="assets/ordinary.png" alt="Keep alt"><figcaption>Keep caption</figcaption></figure>\n';
 await writeFile(path.join(root,'docs/assets/ordinary.png'),png);await source.fill(configured);
 await source.evaluate(e=>{const at=e.value.indexOf('Keep alt');e.setSelectionRange(at,at);});
 await source.evaluate((e,payload)=>{const dataTransfer=new DataTransfer();dataTransfer.setData('application/x-munin-image',JSON.stringify(payload));e.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));},payload);
 await page.waitForFunction(()=>!document.querySelector('#markdown-editor').value.includes('assets/ordinary.png'));
 const replaced=await source.inputValue();for(const text of ['data-width="50"','data-align="right"','alt="Keep alt"','<figcaption>Keep caption</figcaption>'])assert(replaced.includes(text));
 await source.press('Control+z');await page.waitForFunction(before=>document.querySelector('#markdown-editor').value===before,configured);
 await source.press('Control+Shift+z');await page.waitForFunction(after=>document.querySelector('#markdown-editor').value===after,replaced);
 await page.locator('#editor-mode-toggle').click();
 const rich=page.locator('.ProseMirror[contenteditable=true]');await rich.waitFor({state:'visible'});await rich.focus();await rich.press('Control+End');await rich.press('Enter');
 await page.waitForTimeout(650);const beforeRichDrop=await source.inputValue();
 const showResourceDropIndicator=async()=>{
  await rich.locator('p').last().evaluate((e,payload)=>{const rect=e.getBoundingClientRect();const transfer=new DataTransfer();transfer.setData('application/x-munin-image',JSON.stringify(payload));for(const offset of [12,15])e.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:rect.left+offset,clientY:rect.top+rect.height/2}));},payload);
  await page.locator('.milkdown-drop-indicator').waitFor({state:'visible',timeout:1000});
 };
 await showResourceDropIndicator();
 await rich.locator('p').last().evaluate((e,payload)=>{const rect=e.getBoundingClientRect();const dataTransfer=new DataTransfer();dataTransfer.setData('application/x-munin-image',JSON.stringify(payload));e.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer,clientX:rect.left+15,clientY:rect.top+rect.height/2}));},payload);
 await page.waitForFunction(before=>document.querySelector('#markdown-editor').value!==before,beforeRichDrop);
 await page.locator('.milkdown-drop-indicator').waitFor({state:'hidden',timeout:1000});
 for(const finish of ['dragend','escape','leave']){
  await showResourceDropIndicator();
  if(finish==='dragend')await card.locator('img').dispatchEvent('dragend');
  else if(finish==='escape')await page.keyboard.press('Escape');
  else await rich.evaluate(e=>e.dispatchEvent(new DragEvent('dragleave',{bubbles:true,cancelable:true,relatedTarget:document.body})));
  await page.locator('.milkdown-drop-indicator').waitFor({state:'hidden',timeout:1000});
 }
 const afterRichDrop=await source.inputValue();
 await rich.press('Control+z');await page.waitForFunction(before=>document.querySelector('#markdown-editor').value===before,beforeRichDrop);
 await rich.press('Control+Shift+z');await page.waitForFunction(after=>document.querySelector('#markdown-editor').value===after,afterRichDrop);
 await page.locator('#save-page').click();await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
 assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),afterRichDrop);
 // Verify independent docking on every side of the editor.
 const beforeCancelledDock=await page.evaluate(()=>localStorage.getItem('manual-studio-flexlayout-model-v7'));
 const cancelFrom=await page.locator('#flexlayout-tabbutton-capture-resources').boundingBox();
 const cancelTarget=await page.locator('#panel-editor').boundingBox();assert(cancelFrom&&cancelTarget);
 await page.mouse.move(cancelFrom.x+cancelFrom.width/2,cancelFrom.y+cancelFrom.height/2);await page.mouse.down();
 await page.mouse.move(cancelTarget.x+cancelTarget.width-25,cancelTarget.y+80,{steps:15});
 await page.locator('.dock-pointer-outline').waitFor({state:'visible'});
 await page.keyboard.press('Escape');await page.mouse.up();
 assert.equal(await page.locator('.dock-pointer-outline').count(),0,'Escape removes the placement preview');
 assert.equal(await page.evaluate(()=>localStorage.getItem('manual-studio-flexlayout-model-v7')),beforeCancelledDock,'Cancelled docking preserves placement');
 for(const side of ['right','bottom','left','top']){
  const from=await page.locator('#flexlayout-tabbutton-capture-resources').boundingBox();
  const target=await page.locator('#panel-editor').boundingBox();assert(from&&target);
  const x=side==='left'?target.x+25:side==='right'?target.x+target.width-25:target.x+target.width/2;
  const y=side==='top'?target.y+25:side==='bottom'?target.y+target.height-25:target.y+target.height/2;
  await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();await page.mouse.move(from.x+from.width/2+15,from.y+from.height/2,{steps:4});await page.mouse.move(x,y,{steps:20});await page.mouse.up();await page.waitForTimeout(400);
  const dock=await page.locator('#panel-capture-resources').boundingBox(),editor=await page.locator('#panel-editor').boundingBox();assert(dock&&editor);
  assert(side==='right'?dock.x>editor.x:side==='left'?dock.x<editor.x:side==='bottom'?dock.y>editor.y:dock.y<editor.y,'Dock must split to '+side+': '+JSON.stringify({dock,editor}));
 }
 // Move the Dock using FlexLayout's drag interaction, then preserve that placement.
 const dockTab=page.locator('#flexlayout-tabbutton-capture-resources');const editorTab=page.locator('#flexlayout-tabbutton-editor');
 const from=await dockTab.boundingBox(),to=await editorTab.boundingBox();assert(from&&to);
 await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();await page.mouse.move(from.x+from.width/2+15,from.y+from.height/2,{steps:4});await page.mouse.move(to.x+to.width-10,to.y+to.height/2,{steps:15});await page.mouse.up();
 await page.waitForTimeout(400);
 const layout=await page.evaluate(()=>JSON.parse(localStorage.getItem('manual-studio-flexlayout-model-v7')));
 const contains=(node,id)=>node.id===id||(node.children||[]).some(n=>contains(n,id));
 const group=(node,id)=>node.type==='tabset'&&contains(node,id)?node:(node.children||[]).map(n=>group(n,id)).find(Boolean);
 assert.equal(group(layout.layout,'capture-resources').id,group(layout.layout,'editor').id,'Dock must move into the editor tabset');
 // Closing/reopening must preserve resources and not duplicate Dock hosts.
 await page.locator('#view-menu-button').click();await dockToggle.uncheck();await dockToggle.check();await page.locator('#view-menu-button').click();
 await page.locator('.flexlayout__tab_button').filter({hasText:'撮影リソース一覧'}).first().click();assert.equal(await page.locator('#panel-capture-resources').count(),1);await card.waitFor({state:'visible'});
 await page.reload();await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');await page.locator('#flexlayout-tabbutton-capture-resources').click();await card.waitFor({state:'visible'});
 assert.equal(await page.locator('#panel-capture-resources').count(),1);
 const restored=await page.evaluate(()=>JSON.parse(localStorage.getItem('manual-studio-flexlayout-model-v7')));assert.equal(group(restored.layout,'capture-resources').id,group(restored.layout,'editor').id);
 // A resource and editor may share one tabset: hover must expose the drop target.
 await page.locator('#flexlayout-tabbutton-editor').dispatchEvent('dragover',{dataTransfer:await page.evaluateHandle(payload=>{const transfer=new DataTransfer();transfer.setData('application/x-munin-image',JSON.stringify(payload));return transfer;},payload)});
 await page.locator('.ProseMirror[contenteditable=true]').waitFor({state:'visible'});
 await page.locator('.ProseMirror[contenteditable=true]').focus();
 await page.locator('.ProseMirror[contenteditable=true]').press('Control+End');
 await page.locator('.ProseMirror[contenteditable=true]').press('Enter');
 const beforeHoverDrop=await source.inputValue();
 await page.locator('.ProseMirror p').last().evaluate((e,payload)=>{const rect=e.getBoundingClientRect();const transfer=new DataTransfer();transfer.setData('application/x-munin-image',JSON.stringify(payload));e.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:rect.left+15,clientY:rect.top+rect.height/2}));},payload);
 await page.waitForFunction(before=>document.querySelector('#markdown-editor').value!==before,beforeHoverDrop);
 await page.locator('#save-page').click();await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
 await page.locator('#flexlayout-tabbutton-capture-resources').click();
 const sharedFrom=await page.locator('#flexlayout-tabbutton-capture-resources').boundingBox();
 const sharedTarget=await page.locator('#flexlayout-tabbutton-editor').boundingBox();
 assert(sharedFrom&&sharedTarget);
 await page.mouse.move(sharedFrom.x+sharedFrom.width/2,sharedFrom.y+sharedFrom.height/2);await page.mouse.down();
 await page.mouse.move(sharedFrom.x+sharedFrom.width/2+15,sharedFrom.y+sharedFrom.height/2,{steps:4});
 const area=await page.locator('#app-layout').boundingBox();
 await page.mouse.move(area.x+area.width-15,area.y+area.height/2,{steps:20});await page.mouse.up();await page.waitForTimeout(400);
 const afterHoverLayout=await page.evaluate(()=>JSON.parse(localStorage.getItem('manual-studio-flexlayout-model-v7')));
 assert.notEqual(group(afterHoverLayout.layout,'capture-resources').id,group(afterHoverLayout.layout,'editor').id,'Dock movement must still work after hovering a hidden editor and dropping an image');
 if(native){
  // A deterministic candidate fixture exercises the actual native comparison UI.
  const candidate=await readFile('crates/markits/apps/desktop/src-tauri/icons/32x32.png');
  const revision=createHash('sha256').update(candidate).digest('hex');
  const home=path.join(root,'.munin/capture-resources',resource.id),manifestPath=path.join(home,'manifest.json');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));manifest.pending=revision;
  await writeFile(path.join(home,'revisions',revision+'.png'),candidate);await writeFile(manifestPath,JSON.stringify(manifest));
  const manuscript=await readFile(path.join(root,'docs/index.md'),'utf8');
  await page.reload();await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');await page.locator('#flexlayout-tabbutton-capture-resources').click();await card.getByRole('button',{name:'候補を比較',exact:true}).click();
  let comparison=await findDialog('dialog.capture-comparison');await comparison.locator('.capture-comparison-images img').last().waitFor();
  const size=await comparison.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|inner_size',{label:window.__TAURI_INTERNALS__.metadata.currentWindow.label}));assert(size.width>=800,'Native image comparison must use a wide window');
  assert.equal(await comparison.getByRole('button',{name:'閉じる',exact:true}).count(),0,'OS title bar owns close');
  await comparison.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('dialog.capture-comparison'));
  assert.equal((await rpc('capture-resources-list')).items[0].pending,revision,'Closing comparison keeps the pending candidate');
  await card.getByRole('button',{name:'候補を比較',exact:true}).click();comparison=await findDialog('dialog.capture-comparison');
  await comparison.getByRole('button',{name:'候補を採用して画像を更新',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('dialog.capture-comparison'));
  assert.equal((await rpc('capture-resources-list')).items[0].pending,null);assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),manuscript);
 }
 await page.locator('#flexlayout-tabbutton-editor').click();
 if(!await source.isVisible())await page.locator('#editor-mode-toggle').click();
 const savedBefore=await readFile(path.join(root,'docs/index.md'),'utf8');const unsaved=(await source.inputValue())+'\nUnsaved capture resource regression.\n';
 await source.fill(unsaved);
 await rpc('capture-resources-generate',{id:resource.id});
 assert.equal(await source.inputValue(),unsaved);assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),savedBefore);
 await page.locator('#flexlayout-tabbutton-capture-resources').click();
 const deleteButton=card.getByRole('button',{name:'撮影リソースを削除',exact:true});
 const confirmSelector='dialog[data-confirm-action]';
 const confirmation=page.locator(confirmSelector);
 const assets=await rpc('capture-resources-list');
 const publicImages=await Promise.all(assets.items[0].derived.map(async ({path:asset})=>[asset,await readFile(path.join(root,asset))]));
 await deleteButton.click();
 let confirmPage=await findDialog(confirmSelector);
 if(native){
  const size=await confirmPage.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|inner_size',{label:window.__TAURI_INTERNALS__.metadata.currentWindow.label}));
  assert(size.width<800,'Delete confirmation must use a compact window');
  assert.equal(await confirmPage.getByRole('button',{name:'閉じる',exact:true}).count(),0);
 }
 await confirmPage.getByRole('button',{name:'キャンセル',exact:true}).click();
 await confirmation.waitFor({state:'detached'});
 assert.equal((await rpc('capture-resources-list')).items.length,1);
 await deleteButton.click();confirmPage=await findDialog(confirmSelector);
 await confirmPage.keyboard.press('Escape');
 await confirmation.waitFor({state:'detached'});
 assert.equal((await rpc('capture-resources-list')).items.length,1);
 await deleteButton.click();confirmPage=await findDialog(confirmSelector);
 await confirmPage.getByRole('button',{name:'削除する',exact:true}).click();
 await card.waitFor({state:'detached'});
 assert.equal((await rpc('capture-resources-list')).items.length,0);
 await assert.rejects(readFile(path.join(root,'.munin/capture-resources',resource.id,'manifest.json')),{code:'ENOENT'});
 for(const [asset,bytes] of publicImages){
  assert.deepEqual(await readFile(path.join(root,asset)),bytes);
  assert.equal((await rpc('capture-resources-resolve',{path:asset})).path,asset);
 }
 assert.equal(await source.inputValue(),unsaved);
 assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),savedBefore);
 assert.deepEqual(errors,[]);
 if(native)await writeFile('reviews/native-capture-session.json',JSON.stringify({root,pid:app.pid,url:page.url()}));
 console.log((native?'Windows WebView2: ':'Browser capture auto-insertion/cancel: ')+'metadata, drag insertion in both editors, save, and Dock placement on all sides/restore passed.');
}finally{if(!keep){await browser?.close();server?.kill();if(app&&app.exitCode===null)await run('taskkill',['/PID',String(app.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:300});}else{app?.unref();}}
if(!native)await import('./test_manual_studio_markits_bridge.mjs');
