import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
import path from 'node:path';
const base='http://127.0.0.1:5186', root='/tmp/shortcut-fixture';
let server,browser;
const errors=[];
try {
 server=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--config','apps/manual-studio/vite.config.ts','--port','5186','--strictPort'],{stdio:'ignore'});
 for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 let saved='';
 await page.route('**/__manual/rpc',async route=>{
  const {action,options}=route.request().postDataJSON();let value={};
  if(action==='state')value={has_config:true,config:{docs:'docs',output:'manual',agent:'codex',connection_type:'none',mkdocs:{site_name:'Guide'}},brief:'',pages:['docs/index.md'],project_entries:[{path:'docs/index.md',directory:false}],tasks:[],capture_sources:{},image_assets:{},agents:[]};
  if(action==='editor-read')value={page:'docs/index.md',content:'alpha\nbeta\ngamma',revision:'r1'};
  if(action==='editor-preview')value='<html><body>Guide</body></html>';
  if(action==='editor-save'){saved=options.json.content;value={page:options.page,content:saved,revision:'r2'};}
  if(action==='page-tasks')value=[];
  if(action==='agent-progress')value={logs:[]};
  await route.fulfill({json:{output:typeof value==='string'?value:JSON.stringify(value)}});
 });
 await page.addInitScript(root=>{if(!localStorage.getItem('manual-studio-ai-logs:'+root))localStorage.setItem('manual-studio-ai-logs:'+root,JSON.stringify({logs:['old run completed'],running:false}));},root);
 await page.goto(base+'/?root='+encodeURIComponent(root));
 await page.waitForFunction(()=>document.querySelector('#editor-title')?.textContent==='docs/index.md');
 await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
 await page.locator('#application-settings').click();
 await page.locator('#panel-settings').waitFor({state:'visible'});
 assert.equal(await page.locator('#panel-settings [role=tab]').count(),5);
 const settingsSize=await page.locator('#panel-settings').boundingBox();
 for(const category of ['capture','text-ai','image-ai','appearance','keyboard']){
   await page.locator('#settings-tab-'+category).click();
   const size=await page.locator('#panel-settings').boundingBox();
   assert.ok(Math.abs(size.width-settingsSize.width)<1&&Math.abs(size.height-settingsSize.height)<1,'Settings size stays fixed across '+category);
 }
 const headerLayout=await page.evaluate(()=>{
   const dialog=document.querySelector('#panel-settings'),panel=document.querySelector('#settings-category-keyboard');
   panel.scrollTop=400;
   return {top:dialog.getBoundingClientRect().top,headerTop:dialog.querySelector('.panel-header').getBoundingClientRect().top,scroll:panel.scrollTop,outerScroll:dialog.scrollTop};
 });
 assert.ok(headerLayout.scroll>0,'Settings contents scroll separately');
 assert.ok(Math.abs(headerLayout.headerTop-headerLayout.top-1)<2,'Title bar touches the dialog top border');
 assert.equal(headerLayout.outerScroll,0);
 await page.evaluate(()=>document.querySelector('#settings-category-keyboard').scrollTop=0);
 await page.locator('#settings-tab-capture').click();
 assert.equal(await page.locator('#markits-shortcut-settings').isVisible(),true);
 assert.equal(await page.locator('#keyboard-shortcut-settings').isVisible(),false);
 // Dialog titles drag; positions stay inside the viewport after resizing.
 const dialog=page.locator('#panel-settings');
 const beforeDrag=await dialog.boundingBox();
 const title=await dialog.locator('.panel-header h1').boundingBox();
 await page.mouse.move(title.x+title.width/2,title.y+title.height/2);await page.mouse.down();
 await page.mouse.move(title.x+title.width/2+50,title.y+title.height/2+35,{steps:5});await page.mouse.up();
 const afterDrag=await dialog.boundingBox();
 assert.ok(afterDrag.x>beforeDrag.x+30);assert.ok(afterDrag.y>=beforeDrag.y && afterDrag.y+afterDrag.height<=page.viewportSize().height-7);
 await page.setViewportSize({width:900,height:600});
 await page.waitForTimeout(100);
 const resized=await dialog.boundingBox();assert.ok(resized.x>=0&&resized.y>=0&&resized.x+resized.width<=901&&resized.y+resized.height<=601);
 await page.setViewportSize({width:1280,height:720});
 await page.locator('[data-close-dialog=panel-settings]').click();await page.waitForFunction(()=>!document.querySelector('#panel-settings').classList.contains('dialog-dragged'));
 await page.locator('#application-settings').click();
 // Dynamically created modal dialogs share the same title-bar behavior.
 await page.evaluate(()=>{const d=document.createElement('dialog');d.id='drag-modal-fixture';d.innerHTML='<h2>Test dialog</h2><button>Close</button>';document.body.append(d);d.showModal();});
 const modal=page.locator('#drag-modal-fixture');const modalBefore=await modal.boundingBox();const modalTitle=await modal.locator('h2').boundingBox();
 await page.mouse.move(modalTitle.x+20,modalTitle.y+10);await page.mouse.down();await page.mouse.move(modalTitle.x+60,modalTitle.y+40,{steps:5});await page.mouse.up();
 assert.ok((await modal.boundingBox()).x>modalBefore.x+20);
 await page.evaluate(()=>{const d=document.querySelector('#drag-modal-fixture');d.close();d.remove();});
 await page.locator('#settings-tab-capture').press('End');
 assert.equal(await page.locator('#settings-tab-appearance').getAttribute('aria-selected'),'true');
 assert.equal(await page.locator('#ui-theme').isVisible(),true);
 await page.locator('#settings-tab-appearance').press('Home');
 assert.equal(await page.locator('#settings-tab-keyboard').getAttribute('aria-selected'),'true');
 const settingsBox=await page.locator('#application-settings').boundingBox();
 const viewBox=await page.locator('#view-menu-button').boundingBox();
 assert.ok(settingsBox.x>viewBox.x,'Settings is to the right of the toolbar controls');
 const save=page.locator('[data-command=save] input');assert.equal(await save.inputValue(),'Ctrl+S');
 await save.focus();await page.keyboard.press('Control+Alt+S');
 await page.locator('#keyboard-shortcut-settings [data-save]').click();
 assert.match(await page.locator('#keyboard-shortcut-settings [role=status]').innerText(),/保存しました/);
 // Conflicting assignments must leave the saved mapping intact.
 await save.focus();await page.keyboard.press('Control+Z');
 await page.locator('#keyboard-shortcut-settings [data-save]').click();
 assert.match(await page.locator('#keyboard-shortcut-settings [role=status]').innerText(),/重複/);
 await save.focus();await page.keyboard.press('Control+Alt+S');await page.locator('#keyboard-shortcut-settings [data-save]').click();
 await page.locator('[data-close-dialog=panel-settings]').click();
 // Real editor actions use the customized binding and preserve undo history.
 await page.locator('#editor-mode-toggle').click();
 const editor=page.locator('#markdown-editor');await editor.waitFor({state:'visible'});
 await editor.fill('  alpha\nbeta\ngamma');await editor.evaluate(e=>e.setSelectionRange(2,2));
 await page.keyboard.press('Shift+Tab');assert.equal(await editor.inputValue(),'alpha\nbeta\ngamma');
 await editor.evaluate(e=>e.setSelectionRange(7,7));await page.keyboard.press('Control+x');
 await page.waitForFunction(()=>document.querySelector('#markdown-editor').value==='alpha\ngamma');
 assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).replaceAll('\r\n','\n'),'beta\n');
 await page.keyboard.press('Control+Alt+s');await page.waitForTimeout(300);assert.equal(saved,'alpha\ngamma');
 // Rich editor uses the same command registry, including safe line cutting.
 await editor.fill('first\n\nlast');await page.locator('#editor-mode-toggle').click();
 const rich=page.locator('#milkdown-editor .ProseMirror');await rich.waitFor({state:'visible'});
 await rich.locator('p').first().click();await page.keyboard.press('Home');await page.keyboard.press('Shift+Tab');
 assert.match(await rich.innerText(),/first/);
 await page.keyboard.press('Control+x');await page.waitForFunction(()=>!document.querySelector('#milkdown-editor .ProseMirror').textContent.includes('first'));
 assert.match(await rich.innerText(),/last/);
 await page.keyboard.press('Control+Alt+s');await page.waitForTimeout(200);
 // The VS Code chord opens settings without applying Milkdown's old link key.
 await rich.focus();await page.keyboard.press('Control+k');await page.keyboard.press('Control+s');
 await page.locator('#panel-settings').waitFor({state:'visible'});await page.locator('[data-close-dialog=panel-settings]').click();
 // Reload restores bindings and displays historical logs without a running bar.
 await page.reload();await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
 await page.locator('#application-settings').click();assert.equal(await page.locator('[data-command=save] input').inputValue(),'Ctrl+Alt+S');
 await page.locator('[data-close-dialog=panel-settings]').click();
 await page.locator('#progress-open').click();assert.equal(await page.locator('#progress-track').isVisible(),false);
 assert.match(await page.locator('#progress-note').innerText(),/実行していません/);
 assert.equal(await page.locator('#progress-cancel').isVisible(),false);
 assert.deepEqual(errors,[]);
 console.log('Shortcuts passed: settings entry, rebinding, conflicts, persistence, outdent, line cut, customized save, idle AI logs.');
} finally {await browser?.close();server?.kill();}
