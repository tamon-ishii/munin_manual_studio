import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {chromium} from 'playwright-core';
const base='http://127.0.0.1:5174';let server,browser;
try {
  server=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--config','apps/manual-studio/vite.config.ts'],{stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
  await page.route('**/progress-fixture', route=>route.fulfill({contentType:'text/html',body:'<html><body></body></html>'}));
  await page.goto(`${base}/progress-fixture`);
  await page.evaluate(async()=>{
    const {setupScreenshotLibrary}=await import('/src/screenshotLibrary.ts');
    const ids=['list','status','recapture-all','migrate','cancel','history','retry','record','stop','refresh','import','import-button','diagnose'];
    document.body.innerHTML=ids.map(id=>`<${id==='import'?'input':'div'} id="screenshot-library-${id}"></${id==='import'?'input':'div'}>`).join('')+'<p id="screenshot-recapture-status"></p>';
    window.confirm=()=>true;
    const state=window.progressFixture={root:'first',message:'操作 2/4：記録された待機（120秒）',cancel:false};
    setupScreenshotLibrary({root:()=>state.root,work:op=>op().catch(error=>{state.error=String(error);}),applications:()=>[],page:()=>undefined,insert(){},chooseDestination:async()=>false,openPage:async()=>{},async request(action){
      if(action==='screenshots-list')return '{"items":[]}';
      if(action==='screenshots-recapture-plan')return '{"items":[{"status":"pending"}]}';
      if(action==='agent-progress')return JSON.stringify({logs:[{message:'再撮影 1/1：設定画面 — 操作を再生しています'},{message:state.message}]});
      if(action==='agent-cancel'){state.cancel=true;return '{}';}
      if(action==='screenshots-recapture')return await new Promise((resolve,reject)=>{state.finish=items=>resolve(JSON.stringify({id:'run-test',items}));state.fail=()=>reject(new Error('capture failed'));});
      return '{}';
    }});
  });
  const status=page.locator('#screenshot-recapture-status');
  await page.locator('#screenshot-library-recapture-all').dispatchEvent('click');
  await page.waitForFunction(()=>document.querySelector('#screenshot-recapture-status').textContent.includes('120秒'));
  assert.match(await status.textContent(),/設定画面/);
  await page.evaluate(()=>window.progressFixture.message='操作 4/4：画面を撮影');
  await page.waitForFunction(()=>document.querySelector('#screenshot-recapture-status').textContent.includes('画面を撮影'));
  await page.evaluate(()=>window.progressFixture.finish([{status:'succeeded'}]));
  await page.waitForFunction(()=>document.querySelector('#screenshot-recapture-status').textContent.includes('が完了しました'));
  await page.waitForTimeout(900);assert.match(await status.textContent(),/成功 1件/,'completion persists after polling stops');
  await page.locator('#screenshot-library-recapture-all').dispatchEvent('click');
  await page.waitForFunction(()=>document.querySelector('#screenshot-recapture-status').textContent.includes('再撮影中'));
  await page.locator('#screenshot-library-cancel').dispatchEvent('click');
  assert.equal(await page.evaluate(()=>window.progressFixture.cancel),true);
  await page.evaluate(()=>window.progressFixture.finish([{status:'cancelled'},{status:'pending'}]));
  await page.waitForFunction(()=>document.querySelector('#screenshot-recapture-status').textContent.includes('を中断しました'));
  assert.match(await status.textContent(),/未完了 2件/);
  await page.locator('#screenshot-library-recapture-all').dispatchEvent('click');
  await page.waitForFunction(()=>document.querySelector('#screenshot-recapture-status').textContent.includes('再撮影中'));
  await page.evaluate(()=>{window.progressFixture.root='second';document.querySelector('#screenshot-recapture-status').textContent='別プロジェクト';window.progressFixture.finish([{status:'succeeded'}]);});
  await page.waitForTimeout(900);assert.equal(await status.textContent(),'別プロジェクト');
  await page.locator('#screenshot-library-recapture-all').dispatchEvent('click');
  await page.waitForFunction(()=>document.querySelector('#screenshot-recapture-status').textContent.includes('再撮影中'));
  await page.evaluate(()=>window.progressFixture.fail());
  await page.waitForFunction(()=>document.querySelector('#screenshot-recapture-status').textContent.includes('再撮影に失敗しました'));
  await page.waitForTimeout(900);assert.match(await status.textContent(),/capture failed/);
  console.log('Screenshot recapture progress, completion, cancellation and project isolation passed.');
} finally {await browser?.close();server?.kill();}
