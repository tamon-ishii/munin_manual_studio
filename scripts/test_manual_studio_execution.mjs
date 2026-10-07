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
 await runText();await page.locator('#execution-failure-dialog [data-rollback]').click();await idle();
 assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),original,'rollback restores the entire document');assert.deepEqual(await readFile(path.join(root,'docs/assets/shot.png')),png,'rollback preserves the old image');
 const first=(await rpc('execution-history')).runs[0];assert.equal(first.status,'rolled_back');
 await runText();await page.locator('#execution-failure-dialog [data-keep]').click();await idle();
 assert.match(await readFile(path.join(root,'docs/index.md'),'utf8'),/New text/);
 const partial=(await rpc('execution-history')).runs[0];assert.equal(partial.status,'partial');assert.equal(partial.entries.find(e=>e.task.id==='write').status,'succeeded');assert.equal(partial.entries.find(e=>e.task.id==='shot').status,'failed');
 assert.match(await page.locator('#execution-result').textContent(),/成功1件・失敗1件・未完了0件/);
 assert.equal(await page.locator('#ai-workflow-status').getAttribute('data-phase'),'partial');
 assert.deepEqual((await rpc('execution-resume',{id:partial.id})).ids,['shot']);
 const quality=await rpc('quality-check');assert.equal(quality.passed,false);assert.ok(quality.issues.some(issue=>issue.kind==='execution_failure'));
 await page.reload();await idle();await page.locator('[data-tab=tasks]').click();await page.locator('#task-status-filter').selectOption('failed');assert.equal(await page.locator('#task-list article').count(),1,'failed status persists after reload');
 await page.locator('[data-tab=editor]').click();await page.locator('#editor-more summary').click();await page.locator('#execution-history-open').click();
 const current=page.locator('.execution-history-list article').first();await current.getByRole('button',{name:'入力・画像を確認'}).click();await current.locator('img').first().waitFor();assert.ok(await current.locator('img').count()>=2,'history shows old/new images');
 await current.getByRole('button',{name:'撮影前後を比較・拡大'}).first().click();
 const comparison=page.locator('.image-comparison-dialog');assert.equal(await comparison.locator('img').count(),2);
 await comparison.locator('input[type=range]').fill('150');await comparison.locator('input[type=range]').dispatchEvent('input');
 assert.equal(await comparison.locator('.image-comparison-grid').getAttribute('data-fitted'),'false');
 assert.equal(await comparison.locator('output').textContent(),'150%');
 await comparison.locator('[data-close]').click();
 allowCapture=true;const previousRequests=requests;
 await page.locator('#execution-history-dialog [data-close]').click();
 await page.locator('#execution-result summary').click();
 await page.locator('#execution-result').getByRole('button',{name:'未完了分を確認して再実行'}).click();await page.locator('#generation-input-dialog').waitFor();
 assert.equal(await page.locator('#generation-input-tasks input[value=write]').count(),0,'successful text is excluded from resume');assert.equal(await page.locator('#generation-input-tasks input[value=shot]').count(),1);
 await page.locator('#generation-input-run').click();await idle();assert.equal(requests,previousRequests,'resume does not call text generation');
 assert.equal((await rpc('quality-check')).passed,true);
 const final=await readFile(path.join(root,'docs/index.md'),'utf8');assert.match(final,/Protected content/);assert.match(final,/approved-at=2026-10-08T00:00:00Z/);
 const completed=(await rpc('execution-history')).runs[0];assert.equal(completed.status,'completed');
 assert.equal(await page.locator('#ai-workflow-status').getAttribute('data-phase'),'completed');
 assert.match(await page.locator('#execution-result').textContent(),/成功1件・失敗0件・未完了0件/);
 await writeFile(path.join(root,'docs/index.md'),final+'\nExternal edit\n');
 await assert.rejects(()=>rpc('execution-finish',{id:completed.id,rollback:true}),/変更されています/);
 assert.match(await readFile(path.join(root,'docs/index.md'),'utf8'),/External edit/);
 // Retry only the failed capture; a successful text section stays untouched.
 await page.reload();await idle();allowCapture=false;succeedAt=captures+2;
 const beforeRetry=requests;
 await page.locator('#generate-page').click();await page.locator('#generation-input-tasks input[value=write]').uncheck();
 await page.locator('#execution-retries').fill('1');await page.locator('#generation-input-run').click();await idle();
 const retried=(await rpc('execution-history')).runs[0];assert.equal(retried.entries[0].attempts,2);assert.equal(retried.status,'completed');assert.equal(requests,beforeRetry);
 // A real API deadline fails the first attempt and succeeds on the next one.
 slowResponses=1;
 await page.locator('#generate-page').click();await page.locator('#generation-input-tasks input[value=shot]').uncheck();
 await page.locator('#execution-timeout').fill('5');await page.locator('#execution-retries').fill('1');
 await page.locator('#generation-input-run').click();await page.locator('[data-review-action=adopt]').click();await idle();
 const timed=(await rpc('execution-history')).runs[0];assert.equal(timed.entries[0].attempts,2);assert.equal(timed.limits.timeout_seconds,5);assert.equal(timed.status,'completed');
 assert.deepEqual(errors,[]);console.log(`Execution checks passed: atomic rollback, partial adoption, durable failure, image history, resume skips successes, quality gate, approval protection and conflict-safe restoration, failed-only retries and API deadlines (${captures} captures).`);
}finally{await browser?.close();vite?.kill();await new Promise(resolve=>ai.close(resolve));await rm(root,{recursive:true,force:true});}
