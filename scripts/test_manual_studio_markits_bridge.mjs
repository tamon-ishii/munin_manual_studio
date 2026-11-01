import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {chromium} from 'playwright-core';

const base='http://127.0.0.1:5187';
let server,browser;
try{
  server=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--config','apps/manual-studio/vite.config.ts','--port','5187'],{stdio:'ignore'});
  let ready=false;
  for(let i=0;i<100;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(ready,'Vite started');
  browser=await chromium.launch({channel:process.env.MUNIN_TEST_BROWSER||(process.platform==='win32'?'msedge':'chrome'),headless:true});
  const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.route('**/bridge-test',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><meta charset="utf-8"><body>
    <input id="resource-search"><select id="resource-kind"><option value="all">all</option></select><select id="resource-usage"><option value="all">all</option></select><span id="resource-count"></span>
    <div id="screenshot-library-list"></div><p id="screenshot-library-status"></p>
    ${['record','refresh','stop','retry','cancel','recapture-all','import-button'].map(id=>`<button id="screenshot-library-${id}">${id}</button>`).join('')}
    <button id="screenshot-ui-settings"></button><input type="file" id="screenshot-library-import">
    <script type="module">
    import {setupScreenshotLibrary} from '/src/screenshotLibrary.ts';
    window.root='project-one';window.calls=[];window.mode='success';
    window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
      calls.push({command,args});
      if(command==='edit_markits_image')return 'assets/markits/edited.png';
      if(command==='capture_markits_image'){
        if(window.mode==='failure')throw new Error('Capture failed');
        if(window.mode==='cancel')return null;
        if(window.mode==='defer')await new Promise(resolve=>window.finishCapture=resolve);
        return 'assets/markits/completed.png';
      }
      throw new Error('Unexpected command: '+command);
    }};
    window.library=setupScreenshotLibrary({root:()=>window.root,refreshAssets:async()=>{},request:async()=>JSON.stringify({items:[]}),work:async operation=>operation(),insert:()=>{},page:()=> 'index.md',chooseDestination:async()=>true,openPage:async()=>{},applications:()=>[],insertAsset:async()=>true,openImage:async()=>{},editImage:async()=>{},openUsage:async()=>{},generateImage:async()=>{},annotateScreenshot:async()=>{}});
    </script></body></html>`}));
  await page.goto(base+'/bridge-test');await page.waitForFunction(()=>Boolean(window.library));
  await page.locator('#screenshot-library-record').click();
  await page.waitForFunction(()=>window.calls.length===1);
  assert.deepEqual(await page.evaluate(()=>window.calls),[{command:'capture_markits_image',args:{root:'project-one'}}]);
  assert.equal(await page.locator('dialog').count(),0,'library capture must not open a history dialog');
  const inserted=await page.evaluate(()=>window.library.recordForInsertion());
  assert.deepEqual(inserted,{path:'assets/markits/completed.png'});
  assert.equal(await page.locator('dialog').count(),0,'editor capture must not open a history dialog');
  await page.evaluate(()=>window.mode='cancel');
  assert.equal(await page.evaluate(async()=>Boolean(await window.library.recordForInsertion())),false);
  await page.evaluate(()=>window.mode='failure');
  assert.equal(await page.evaluate(async()=>{try{await window.library.recordForInsertion();}catch(e){return String(e);}}),'Error: Capture failed');
  await page.evaluate(()=>{window.mode='defer';window.result='pending';void window.library.recordForInsertion().then(value=>window.result=value||null);});
  await page.waitForFunction(()=>Boolean(window.finishCapture));
  await page.evaluate(()=>{window.root='project-two';window.finishCapture();});
  await page.waitForFunction(()=>window.result===null);
  const edited=await page.evaluate(()=>window.library.editImage('assets/selected.png','index.md'));
  assert.deepEqual(edited,{path:'assets/markits/edited.png'});
  assert.deepEqual(await page.evaluate(()=>[...new Set(window.calls.map(call=>call.command))]),['capture_markits_image','edit_markits_image']);
  await page.goto(base);await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  assert.equal(await page.locator('#screenshot-library-record').textContent(),'撮影');
  assert.deepEqual(errors,[]);
  console.log('Direct capture: no history dialogs from either entry, cancel, failure, project isolation and direct editing passed.');
}finally{await browser?.close();server?.kill();}
