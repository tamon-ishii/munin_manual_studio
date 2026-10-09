import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
const base='http://127.0.0.1:5174';
const root=await mkdtemp(path.join(os.tmpdir(),'munin-execution-'));
let browser,vite,captures=0,requests=0,allowCapture=false,succeedAt=Infinity,slowResponses=0;
const ai=createServer(async(req,res)=>{
 for await(const chunk of req){}requests++;
 if(slowResponses>0){slowResponses--;await new Promise(resolve=>setTimeout(resolve,6500));}
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({answers:[{id:'write',markdown:'New text'}]})}}]}));
});
const png=await readFile('apps/manual-studio/src-tauri/icons/icon.png');
const original='# Guide\n\n<!-- ai:task id=write kind=text prompt="Write" -->\nOld text\n<!-- /ai:task -->\n\n<!-- ai:task id=shot kind=screenshot prompt="Capture" -->\n![shot](assets/shot.png)\n<!-- /ai:task -->\n\n<!-- ai:task id=locked kind=text prompt="Keep" approved-at=2026-10-08T00:00:00Z -->\nProtected content\n<!-- /ai:task -->\n';
const rpc=async(action,options={})=>{
 const response=await fetch(`${base}/__manual/rpc`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({root,action,options})});const value=await response.json();if(value.error)throw new Error(value.error);return value.output?JSON.parse(value.output):null;
};
try{
 await new Promise(resolve=>ai.listen(0,'127.0.0.1',resolve));
 await mkdir(path.join(root,'docs/assets'),{recursive:true});await writeFile(path.join(root,'docs/index.md'),original);await writeFile(path.join(root,'docs/assets/shot.png'),png);
 await writeFile(path.join(root,'manual_setting.json'),JSON.stringify({docs:'docs',targets:['docs'],connection_type:'local_llm',endpoint_url:`http://127.0.0.1:${ai.address().port}/v1`,agent:'codex',model:'test'}));
 vite=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--config','apps/manual-studio/vite.config.ts'],{stdio:'ignore'});
 for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();page.setDefaultTimeout(30000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/__manual/rpc',async route=>{
  const request=route.request().postDataJSON();if(request.action!=='generate-page-captures'){await route.continue();return;}
  captures++;
  const success=allowCapture||captures>=succeedAt;
  if(success){await writeFile(path.join(root,'shot.png'),png);await rpc('record-screenshot',{id:'shot',image:path.join(root,'shot.png'),json:request.options.json});}
  await route.fulfill({json:{output:JSON.stringify({updated:[],captured:success?['shot']:[],capture_errors:success?[]:[{id:'shot',reason:'Expected target is missing'}]})}});
 });
 await page.goto(`${base}/?root=${encodeURIComponent(root)}&page=docs%2Findex.md`);
 const idle=()=>page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');await idle();
 const runText=async()=>{await page.locator('#generate-page').click();await page.locator('#generation-input-run').click();await page.locator('[data-review-action=adopt]').click();};
 await runText();await idle();
 assert.equal(captures,0,'AI execution does not capture screenshots');
 assert.deepEqual(await readFile(path.join(root,'docs/assets/shot.png')),png,'AI execution preserves image');
 const final=await readFile(path.join(root,'docs/index.md'),'utf8');assert.match(final,/Protected content/);assert.match(final,/New text/);
 const completed=(await rpc('execution-history')).runs[0];assert.equal(completed.status,'completed');assert.deepEqual(completed.entries.map(entry=>entry.task.id),['write']);
 await writeFile(path.join(root,'docs/index.md'),final+'\nExternal edit\n');
 await assert.rejects(()=>rpc('execution-finish',{id:completed.id,rollback:true}),/変更されています/);
 await page.reload();await idle();
 // A real API deadline fails the first attempt and succeeds on the next one.
 slowResponses=1;
 await page.locator('#generate-page').click();assert.equal(await page.locator('#generation-input-tasks input[value=shot]').count(),0);
 await page.locator('#execution-timeout').fill('5');await page.locator('#execution-retries').fill('1');
 await page.locator('#generation-input-run').click();
 try { await page.locator('[data-review-action=adopt]').click(); }
 catch(error) { throw new Error(`${error.message}\nStudio status: ${await page.locator('#status').textContent()}\nAI requests: ${requests}\nPage errors: ${JSON.stringify(errors)}`, {cause:error}); }
 await idle();
 const timed=(await rpc('execution-history')).runs[0];assert.equal(timed.entries[0].attempts,2);assert.equal(timed.limits.timeout_seconds,5);assert.equal(timed.status,'completed');
 assert.deepEqual(errors,[]);console.log(`Execution checks passed: AI/image independence, approval protection, durable history, conflict-safe restoration, retries and API deadlines (${captures} captures).`);
}finally{await browser?.close();vite?.kill();await new Promise(resolve=>ai.close(resolve));await rm(root,{recursive:true,force:true});}
