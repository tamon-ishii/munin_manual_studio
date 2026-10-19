import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {chromium} from 'playwright-core';
const root=await mkdtemp(path.join(os.tmpdir(),'munin-priority-'));const base='http://127.0.0.1:5183';
let server,browser;
try{
 await writeFile(path.join(root,'README.md'),'# Guide\n\nOriginal manuscript.\n');
 server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','apps/manual-studio/vite.config.ts','--port','5183'],{stdio:'ignore'});
 for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-sandbox']});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 // Vite's development bridge restricts origins to its default loopback address.
 await page.route('**/__manual/rpc',async route=>{const response=await route.fetch({headers:{...route.request().headers(),origin:'http://127.0.0.1:5174'}});await route.fulfill({response});});
 const rpc=async(action,options={})=>{const response=await fetch(base+'/__manual/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({root,action,options})});const result=await response.json();assert.equal(response.ok,true,result.error);return JSON.parse(result.output);};
 await page.goto(`${base}/?root=${encodeURIComponent(root)}`);await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
 const menu=async label=>{await page.locator('#workspace-name').click();await page.getByRole('button',{name:label,exact:true}).click();};
 await menu('原稿・画像の保存先');
 const dialog=page.locator('#workspace-paths-dialog');await dialog.waitFor();
 assert.equal(await dialog.getByRole('textbox',{name:'原稿フォルダー'}).inputValue(),'.');
 assert.equal(await dialog.getByRole('textbox',{name:'画像保存先'}).inputValue(),'assets');
 await dialog.getByRole('textbox',{name:'画像保存先'}).fill('../outside');await dialog.getByRole('button',{name:'保存先を変更'}).click();await dialog.getByRole('alert').getByText(/project|相対|内/).waitFor();
 await dialog.getByRole('textbox',{name:'画像保存先'}).fill('media/shots');await dialog.getByRole('button',{name:'保存先を変更'}).click();await dialog.waitFor({state:'detached'});await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
 assert.equal((await rpc('workspace-paths-read')).assets,'media/shots');
 assert.equal(await readFile(path.join(root,'README.md'),'utf8'),'# Guide\n\nOriginal manuscript.\n');
 await menu('原稿・画像の保存先');await dialog.waitFor();
 const cfg=JSON.parse(await readFile(path.join(root,'manual_setting.json'),'utf8'));cfg.assets='external-update';await writeFile(path.join(root,'manual_setting.json'),JSON.stringify(cfg));
 await dialog.getByRole('textbox',{name:'画像保存先'}).fill('stale');await dialog.getByRole('button',{name:'保存先を変更'}).click();await dialog.getByRole('alert').getByText(/別の操作/).waitFor();assert.equal((await rpc('workspace-paths-read')).assets,'external-update');await dialog.getByRole('button',{name:'キャンセル'}).click();
 await rpc('operation-timings-record',{json:{operation:'screenshot-insert',outcome:'success',stages:[{stage:'markits',duration_ms:2000},{stage:'import',duration_ms:125},{stage:'save',duration_ms:75}]}});
 await menu('撮影・挿入の処理時間');const timings=page.locator('#operation-timings-dialog');await timings.waitFor();assert.match(await timings.textContent(),/処理 0.20秒 \/ 操作待ち 2.00秒/);await timings.locator('summary').click();assert.equal(await timings.getByRole('cell',{name:'編集結果を保存中',exact:true}).count(),1);
 assert.deepEqual(errors,[]);console.log('Workspace menu, path validation/save/stale protection and timing history display passed.');
}finally{await browser?.close();server?.kill();await rm(root,{recursive:true,force:true});}
