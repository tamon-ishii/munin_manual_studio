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
 const preview=page.frameLocator('#markdown-preview').locator('img').first();
 async function color(image,expected){
   await image.waitFor();
   await image.evaluate((image,expected)=>new Promise((resolve,reject)=>{
     const deadline=Date.now()+10000;
     const check=()=>{
       if(image.complete&&image.naturalWidth){const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d');context.drawImage(image,0,0,1,1);const pixel=[...context.getImageData(0,0,1,1).data].slice(0,3);if(pixel.join(',')===expected.join(','))return resolve();}
       if(Date.now()>deadline)return reject(new Error('Displayed image did not update'));setTimeout(check,50);
     };check();
   }),expected);
 }
 await color(preview,[255,0,0]);
 const original=await readFile(path.join(root,'docs/index.md'),'utf8');
 const candidate=JSON.parse(await rpc('screenshots-register',{json:{id,source:colors[1],adopt:false}}));
 const published=path.join(root,initial.screenshot.output);const old=await readFile(published);
 assert.deepEqual(await readFile(published),old,'candidate does not replace adopted pixels');
 await page.locator('[data-tab=screenshots]').click();if(!await page.locator('#screenshot-library-refresh').isVisible())await page.locator('#resource-management-menu>summary').click();await page.locator('#screenshot-library-refresh').click();
 const card=page.locator('.screenshot-library-card');await card.locator('.resource-item-menu>summary').click();await card.locator('.screenshot-management>summary').click();await card.locator('select').selectOption(candidate.revision);await card.getByRole('button',{name:'選択版を採用',exact:true}).click();await page.locator('[data-confirm-accept]').click();
 await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');assert.notDeepEqual(await readFile(published),old);
 assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),original,'adoption does not rewrite prose');assert.equal(JSON.parse(await rpc('screenshots-list')).items[0].usage.length,2);
 await color(preview,[0,0,255]);
 await color(page.locator('#milkdown-editor img[data-type="image-block"]').first(),[0,0,255]);
 assert.equal(await card.locator('.resource-item-menu').evaluate(node=>node.open),true);
 assert.equal(await card.locator('.screenshot-management').evaluate(node=>node.open),true);
 await card.locator('select').selectOption(initial.revision);
 // Adopt straight from the comparison: decline first (nothing changes, dialog stays), then confirm.
 await card.getByRole('button',{name:'選択版を表示',exact:true}).click();
 const comparison=page.locator('.image-comparison-dialog');await comparison.waitFor();
 await comparison.getByRole('button',{name:'選択版を採用',exact:true}).click();await page.locator('dialog[data-confirm-action]').getByRole('button',{name:'キャンセル',exact:true}).click();
 assert.equal(await comparison.isVisible(),true,'declining keeps the comparison open');assert.notDeepEqual(await readFile(published),old,'declined adoption changes nothing');
 await comparison.getByRole('button',{name:'選択版を採用',exact:true}).click();await page.locator('[data-confirm-accept]').click();
 await comparison.waitFor({state:'detached'});await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');assert.deepEqual(await readFile(published),old,'previous adopted version can be restored from the comparison');
 assert.equal(await page.locator('.screenshot-library-card .screenshot-management').evaluate(node=>node.open),true,'management stays expanded after comparison adoption');
 await color(preview,[255,0,0]);
 console.log('Screenshot candidate adoption, two-document usage, prose preservation and previous-version restoration checks passed.');
}finally{await browser?.close();server?.kill();await rm(root,{recursive:true,force:true});}
