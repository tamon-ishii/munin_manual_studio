import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, stat, rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
// Run after building manualctl; this test starts its own development server.
const serverUrl=process.env.MANUAL_STUDIO_URL || 'http://127.0.0.1:5187';
const roots=[];
let browser, server;
const results=[];
try {
 if(!process.env.MANUAL_STUDIO_URL){
  server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','apps/manual-studio/vite.config.ts','--port','5187','--strictPort'],{stdio:'ignore'});
  let ready=false;
  for(let i=0;i<100;i++){
   if(server.exitCode!==null)throw new Error('Folder test server exited');
   try{ready=(await fetch(serverUrl)).ok;}catch{}
   if(ready)break;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(ready,'Folder test server did not start');
 }
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const layout of ['root','docs']) {
  const root=await mkdtemp(path.join(os.tmpdir(),'manual-folder-ui-'));
  roots.push(root);
  if(layout==='docs')await mkdir(`${root}/docs`);
  await writeFile(`${root}/${layout==='docs'?'docs/index.md':'README.md'}`,'# Folder test\n');
  const page=await browser.newPage();
  await page.route('**/__manual/rpc',async route=>{
   const response=await route.fetch({headers:{...route.request().headers(),origin:'http://127.0.0.1:5174'}});
   await route.fulfill({response});
  });
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${serverUrl}/?root=${encodeURIComponent(root)}`);
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false' && document.querySelector('#page-list [data-page]'));
  const base=layout==='docs'?'docs/':'';
  async function create(name, expected, context) {
   if(context==='root') { const box=await page.locator('#page-list').boundingBox(); await page.locator('#page-list').click({button:'right',position:{x:5,y:box.height-5}}); }
   else if(context) await page.locator(`#page-list [data-folder="${context}"] > summary`).click({button:'right'});
   if(context) await page.locator('#tree-context-menu').getByRole('menuitem',{name:'フォルダーを作成',exact:true}).click();
   else {
    await page.locator('#tree-create-menu > summary').click();
    await page.locator('#new-folder').click();
   }
   const field=page.locator('#new-folder-path');
   const prefix=await field.inputValue();
   await field.fill(prefix+name);
   const response=page.waitForResponse(async r=>r.url().endsWith('/__manual/rpc') && r.request().postDataJSON()?.action==='create-folder');
   await page.locator('#new-folder-form button[type=submit]').click();
   const r=await response;assert.equal(r.status(),200,await r.text());
   await page.waitForFunction(()=>!document.querySelector('#new-folder-dialog').open && document.body.getAttribute('aria-busy')==='false');
   assert.ok((await stat(`${root}/${expected}`)).isDirectory());
   assert.equal(await page.locator(`#page-list [data-folder="${expected}"]`).count(),1);
   results.push(`${layout}: ${context||'作成メニュー'} -> ${expected}`);
  }
  await create('通常作成',base+'通常作成');
  await create('右クリック作成',base+'右クリック作成','root');
  await create('子フォルダ/孫',base+'通常作成/子フォルダ/孫',base+'通常作成');
  await page.reload();
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false' && document.querySelector('#page-list [data-page]'));
  assert.equal(await page.locator(`#page-list [data-folder="${base}右クリック作成"]`).count(),1);
  assert.deepEqual(errors,[]);
  await page.unrouteAll({behavior:'wait'});
  await page.close();
 }
 console.log(JSON.stringify({passed:results,reload:true,consoleErrors:0},null,2));
} finally {
 await browser?.close();
 server?.kill();
 await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));
}
