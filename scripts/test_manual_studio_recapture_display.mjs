import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
const base='http://127.0.0.1:5174';const root=await mkdtemp(path.join(os.tmpdir(),'munin-recapture-display-'));let server,browser;
try {
 server=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--config','apps/manual-studio/vite.config.ts'],{stdio:'ignore'});
 for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
 await mkdir(path.join(root,'docs'));await writeFile(path.join(root,'docs/index.md'),'# Capture\n');
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
 const colors=await page.evaluate(()=>['red','blue'].map(color=>{const canvas=document.createElement('canvas');canvas.width=80;canvas.height=60;const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,80,60);return canvas.toDataURL();}));
 const rpc=async(action,options={})=>{const response=await fetch(`${base}/__manual/rpc`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({root,action,options})});const value=await response.json();if(value.error)throw new Error(value.error);return value.output;};
 const initial=JSON.parse(await rpc('screenshots-register',{json:{source:colors[0],name:'Screen'}}));const id=initial.screenshot.id;
 const reference=await rpc('screenshots-reference',{id,page:'docs/index.md'});await writeFile(path.join(root,'docs/index.md'),`# Capture\n\n${reference}\n`);await writeFile(path.join(root,'docs/other.md'),reference);
 await page.goto(`${base}/?root=${encodeURIComponent(root)}`);await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
 const original=await readFile(path.join(root,'docs/index.md'),'utf8');
 const candidate=JSON.parse(await rpc('screenshots-register',{json:{id,source:colors[1],adopt:false}}));
 const published=path.join(root,initial.screenshot.output);const old=await readFile(published);
 assert.deepEqual(await readFile(published),old,'candidate does not replace adopted pixels');
 await page.locator('[data-tab=screenshots]').click();await page.locator('#screenshot-library-refresh').click();
 const card=page.locator('.screenshot-library-card');await card.locator('select').selectOption(candidate.revision);page.once('dialog',dialog=>dialog.accept());await card.getByRole('button',{name:'選択版を採用',exact:true}).click();
 await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');assert.notDeepEqual(await readFile(published),old);
 assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),original,'adoption does not rewrite prose');assert.equal(JSON.parse(await rpc('screenshots-list')).items[0].usage.length,2);
 await card.locator('select').selectOption(initial.revision);page.once('dialog',dialog=>dialog.accept());await card.getByRole('button',{name:'選択版を採用',exact:true}).click();await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');assert.deepEqual(await readFile(published),old,'previous adopted version can be restored');
 console.log('Screenshot candidate adoption, two-document usage, prose preservation and previous-version restoration checks passed.');
}finally{await browser?.close();server?.kill();await rm(root,{recursive:true,force:true});}
