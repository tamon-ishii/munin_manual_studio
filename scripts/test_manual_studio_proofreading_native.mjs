// Real Tauri/WebView2 regression: the comparison must outgrow its native opener.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,mkdir,writeFile,readdir,readFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';

const repo=process.cwd(),root=await mkdtemp(path.join(tmpdir(),'munin-proofreading-native-'));
const run=promisify(execFile),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const assets=path.join(repo,'apps/manual-studio/dist/assets');
const entry=(await readdir(assets)).find(name=>/^proofreading-.*\.js$/.test(name));
const entrySource=await readFile(path.join(assets,entry),'utf8');
const shared=(entrySource.match(/from"\.\/(proofreadingReview[^"\n]+)"/)??entrySource.match(/from"\.\/([^"\n]+)"/))[1];
let app,browser;
try{
  const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  app=spawn(path.join(repo,'target/debug/manual-studio.exe'),['--manual-studio-webview2-test',String(port),path.join(root,'profile')],{cwd:root,env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:path.join(root,'profile'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`},stdio:'ignore',windowsHide:true});
  let endpoint;
  for(let i=0;i<150;i++){
    assert.equal(app.exitCode,null,'Native app must remain running');
    try{endpoint=(await(await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;if(endpoint)break;}catch{}
    await pause(100);
  }
  assert.ok(endpoint,'Native WebView2 endpoint must start');
  browser=await chromium.connectOverCDP(endpoint);const context=browser.contexts()[0];context.setDefaultTimeout(20000);
  let page;
  for(let i=0;i<100;i++){page=context.pages().find(p=>!p.url().startsWith('about:'));if(page)break;await pause(100);}
  assert.ok(page,'Main native page must exist');
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.locator('#ui-theme').selectOption('midnight',{force:true});
  await page.evaluate(async shared=>{
    await window.__TAURI_INTERNALS__.invoke('plugin:window|set_size',{label:'main',value:{Logical:{width:1000,height:700}}});
    const {r:reviewProofreading}=await import(`/assets/${shared}`);
    window.comparisonResult='pending';
    reviewProofreading('old A\nkeep\nold B',[{id:'yomiyasu',content:'new A\nkeep\nold B'},{id:'natural-japanese',content:'old A\nkeep\nnew B'}]).then(value=>window.comparisonResult=value).catch(error=>window.comparisonResult={error:String(error)});
  },shared);
  let label;
  for(let i=0;i<100;i++){
    label=await page.evaluate(async()=>{return (await window.__TAURI_INTERNALS__.invoke('plugin:window|get_all_windows')).find(label=>label.startsWith('proofreading-'));});
    if(label)break;await pause(100);
  }
  assert.ok(label,`Native comparison window must open: ${JSON.stringify(await page.evaluate(()=>window.comparisonResult))}`);
  const dimensions=await page.evaluate(async label=>{
    const invoke=window.__TAURI_INTERNALS__.invoke;
    return {parent:await invoke('plugin:window|inner_size',{label:'main'}),child:await invoke('plugin:window|inner_size',{label}),maximized:await invoke('plugin:window|is_maximized',{label})};
  },label);
  assert.equal(dimensions.maximized,false,'Comparison must open at its calculated size, not maximized');
  assert.ok(dimensions.child.width>dimensions.parent.width,JSON.stringify(dimensions));
  assert.ok(dimensions.child.height>=480,JSON.stringify(dimensions));
  assert.equal(await page.locator('#proofreading-dialog').count(),0,'Main window must not contain the comparison dialog');
  // The event transport must work even though this test uses an isolated parent profile.
  let childPage;
  for(let i=0;i<100;i++){
    childPage=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('proofreading.html'));
    if(childPage)break;await pause(100);
  }
  assert.ok(childPage,'Native comparison webview must be inspectable');
  await childPage.locator('#proofreading-dialog').waitFor();
  await childPage.waitForFunction(()=>document.documentElement.dataset.theme==='midnight');
  const palette=await page.evaluate(()=>({surface:getComputedStyle(document.documentElement).getPropertyValue('--surface-bg').trim(),text:getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim()}));
  assert.deepEqual(await childPage.evaluate(()=>({surface:getComputedStyle(document.documentElement).getPropertyValue('--surface-bg').trim(),text:getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim()})),palette);
  const initialStyle=await childPage.locator('#proofreading-dialog').evaluate(el=>({background:getComputedStyle(el).backgroundColor,text:getComputedStyle(el).color}));
  assert.deepEqual(initialStyle,{background:'rgb(32, 40, 56)',text:'rgb(237, 242, 251)'});
  // Changing the parent's theme while the comparison is open must update it too.
  await page.locator('#ui-theme').selectOption('warm',{force:true});
  await childPage.waitForFunction(()=>document.documentElement.dataset.theme==='warm');
  assert.equal(await childPage.locator('#proofreading-dialog').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 253, 250)');
  await page.locator('#ui-theme').selectOption('charcoal',{force:true});
  await childPage.waitForFunction(()=>document.documentElement.dataset.theme==='charcoal');
  await childPage.getByRole('radio',{name:'差分1：yomiyasuを採用',exact:true}).check();
  await childPage.getByRole('radio',{name:'差分2：natural-japaneseを採用',exact:true}).check();
  await mkdir('ui-coverage-results',{recursive:true});await childPage.screenshot({path:'ui-coverage-results/proofreading-native.png'});
  await childPage.getByRole('button',{name:'最終結果を確定',exact:true}).click();
  await page.waitForFunction(()=>window.comparisonResult==='new A\nkeep\nnew B');
  await writeFile('ui-coverage-results/proofreading-native.json',JSON.stringify({dimensions,result:await page.evaluate(()=>window.comparisonResult),errors},null,2));
  assert.deepEqual(errors,[]);
  console.log(`Native comparison passed: parent ${dimensions.parent.width}x${dimensions.parent.height}, comparison ${dimensions.child.width}x${dimensions.child.height}, adoption returned.`);
}finally{
  if(browser)await browser.close().catch(()=>{});
  if(app&&app.exitCode===null)await run('taskkill',['/PID',String(app.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:300});
}
