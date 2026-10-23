import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';

const base='http://127.0.0.1:5174';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','apps/manual-studio/vite.config.ts'],{stdio:'ignore'});
let browser;
try {
  for(let attempt=0;attempt<100;attempt++){
    try { if((await fetch(base)).ok)break; } catch {}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:380,height:350}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    window.historyFixture={total:0,items:[]};window.historyFailure=false;window.commands=[];
    window.__TAURI_INTERNALS__={invoke:async command=>{
      window.commands.push(command);
      if(command==='operation_recording_history'){
        if(window.historyFailure)throw Error('temporary read failure');
        return window.historyFixture;
      }
    }};
  });
  await page.goto(`${base}/recording-control.html`);
  await page.waitForFunction(()=>window.commands.includes('operation_recording_history'));
  assert.equal(await page.locator('#capture-history-empty').isVisible(),true);
  assert.equal(await page.locator('#capture-history').isVisible(),false);
  await page.evaluate(()=>{window.historyFixture={total:4,items:[
    {sequence:1,elapsedMs:1000,label:'「保存」（button）をクリック'},
    {sequence:2,elapsedMs:2100,label:'テキスト入力: <img src=x onerror=alert(1)>'},
    {sequence:3,elapsedMs:3000,label:'キー入力: Enter'},
    {sequence:4,elapsedMs:64000,label:'スクロール: 横 0・縦 -3'},
  ]};});
  await page.waitForFunction(()=>document.querySelectorAll('#capture-history li').length===4);
  assert.equal(await page.locator('#capture-history-heading').textContent(),'操作履歴（4件）');
  assert.equal(await page.locator('#capture-history li').last().locator('time').textContent(),'1:04');
  assert.equal(await page.locator('#capture-history img').count(),0,'recorded text must remain literal text');
  assert.equal(await page.locator('#capture-history-empty').isVisible(),false);
  const bounds=await page.locator('#capture-history-panel').boundingBox();
  const button=await page.locator('#capture-now').boundingBox();
  assert.ok(bounds.y>=button.y+button.height,'history is below the capture controls');
  assert.ok(bounds.y+bounds.height<=350,'history fits the native popup');
  await page.evaluate(()=>{window.historyFixture={total:120,items:Array.from({length:100},(_,i)=>({sequence:i+21,elapsedMs:i*1000,label:`操作 ${i+21}`}))};});
  await page.waitForFunction(()=>document.querySelectorAll('#capture-history li').length===100);
  assert.equal(await page.locator('#capture-history-note').isVisible(),true);
  assert.equal(await page.locator('#capture-history li').first().locator('.history-number').textContent(),'21');
  await page.locator('#capture-history').evaluate(node=>{node.scrollTop=80;});
  await page.evaluate(()=>{window.historyFixture.items[99].label='スクロール: 横 0・縦 -8';});
  await page.waitForFunction(()=>document.querySelector('#capture-history li:last-child').textContent.includes('縦 -8'));
  assert.equal(await page.locator('#capture-history').evaluate(node=>node.scrollTop),80,'reading earlier operations does not jump to the bottom');
  await page.evaluate(()=>{window.historyFailure=true;});
  await page.waitForFunction(()=>document.querySelector('#capture-history-status').textContent.includes('再試行'));
  assert.equal(await page.locator('#capture-history li').count(),100,'read failure retains the visible history');
  await page.evaluate(()=>{window.historyFailure=false;});
  await page.waitForFunction(()=>document.querySelector('#capture-history-status').textContent==='');
  await page.screenshot({path:'/tmp/munin-recording-history.png'});
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>window.commands.includes('cancel_operation_recording'));
  await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
  const requests=await page.evaluate(()=>window.commands.length);
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(()=>window.commands.length),requests,'closing stops history polling');
  assert.deepEqual(errors,[]);
  console.log('Recording control: ordered operations, live updates, safe text, scroll retention, failure recovery and cancellation passed.');
} finally { await browser?.close();server.kill(); }
