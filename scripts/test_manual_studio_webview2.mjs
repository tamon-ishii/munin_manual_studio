// Runs against the actual Windows Studio/WebView2 process, with its own project.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access,mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

if(process.platform!=='win32')throw new Error('This check requires Windows and the actual Studio WebView2.');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run=promisify(execFile),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const root=await mkdtemp(path.join(tmpdir(),'munin-webview2-'));
const output=path.resolve(process.env.MANUAL_WEBVIEW2_RESULTS||'webview2-results');
let app,browser;let diagnostics='';
try{
  await mkdir(output,{recursive:true});await mkdir(path.join(root,'docs'));
  const content='# WebView2 hover fixture\n\n<!-- ai:task id=hover-fixture kind=text approved-at="2026-10-10T00:00:00Z"\n'+Array.from({length:90},(_,i)=>`Long instruction ${i+1}: preserve the visible document.`).join('\n')+'\n-->\nVisible fixture body.\n<!-- /ai:task -->\n';
  await writeFile(path.join(root,'docs/index.md'),content);
  await writeFile(path.join(root,'manual_setting.json'),JSON.stringify({docs:'docs',assets:'docs/assets',targets:['docs'],connection_type:'none'}));
  const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const executable=path.join(repo,'target/debug/manual-studio.exe');await access(executable);
  let launchError;
  app=spawn(executable,['--manual-studio-webview2-test',String(port),path.join(root,'webview-profile')],{cwd:root,env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:path.join(root,'webview-profile')},stdio:['ignore','ignore','pipe']});
  app.on('error',error=>{launchError=error;});
  app.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-4000);});
  let endpoint,lastProbeFailure='';
  for(let i=0;i<150;i++){
    if(launchError)throw launchError;
    if(app.exitCode!==null)throw new Error(`Studio exited (${app.exitCode}): ${diagnostics}`);
    try{const response=await fetch(`http://127.0.0.1:${port}/json/version`);if(response.ok){endpoint=(await response.json()).webSocketDebuggerUrl;if(endpoint)break;lastProbeFailure='Debugger response had no browser endpoint';}else lastProbeFailure=`HTTP ${response.status}`;}catch(error){lastProbeFailure=String(error.cause||error);}
    await pause(200);
  }
  assert.ok(endpoint,`The owned WebView2 debugging endpoint must start. Last probe: ${lastProbeFailure}. Studio diagnostics: ${diagnostics}`);
  browser=await chromium.connectOverCDP(endpoint);
  const context=browser.contexts()[0];assert.ok(context,'WebView2 must expose its native context');
  context.setDefaultTimeout(15000);
  let page;
  for(let i=0;i<100;i++){page=context.pages().find(candidate=>/tauri\.localhost|tauri:\/\//.test(candidate.url()));if(page)break;await pause(100);}
  assert.ok(page,'The native Tauri page must be present');
  // CDP exposes the document before the async frontend has installed handlers.
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false',undefined,{timeout:30000});
  // A fresh WebView profile starts without a selected project. Use Studio's
  // own project picker rather than assuming its working directory is opened.
  await page.locator('#open-existing-workspace').click();
  await page.locator('#workspace-dialog[open]').waitFor();
  await page.locator('#project-root').fill(root);
  await page.locator('#project-form button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#markdown-editor')?.value.includes('WebView2 hover fixture'),undefined,{timeout:30000});
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  const card=page.locator('[data-ai-task-id="hover-fixture"]');await card.waitFor();
  const before=await page.locator('#markdown-editor').inputValue();
  await card.getByRole('button',{name:'▶ 指示を展開',exact:true}).click();
  assert.ok((await card.locator('textarea').boundingBox()).height<=216,'A long instruction must stay bounded in the actual WebView2');
  await card.getByRole('button',{name:'▼ 指示を折りたたむ',exact:true}).click();
  assert.equal(await page.locator('#markdown-editor').inputValue(),before,'Disclosure must preserve Markdown');
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.evaluate(await readFile(path.join(repo,'scripts/diagnose_manual_studio_display.js'),'utf8'));
  const windowAction=async(action,extra=[])=>JSON.parse((await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(repo,'scripts/native_webview2_window.ps1'),'-OwnerPid',String(app.pid),'-Action',action,...extra],{timeout:15000,windowsHide:true})).stdout.trim());
  const checks=[];
  for(const [width,height] of [[1440,940],[1000,700]]){
    const native=await windowAction('resize',['-Width',String(width),'-Height',String(height)]);
    const modes=page.locator('button[data-editor-view]');
    for(let mode=0;mode<await modes.count();mode++){
      await modes.nth(mode).click();
      assert.equal(await page.locator('#panel-editor').getAttribute('title'),null,'The editor panel must never inherit its full text as a native tooltip');
      const label=await modes.nth(mode).getAttribute('title');assert.ok(label&&label.length<100,'View controls need short explanations');
      for(const selector of ['#panel-editor','button[data-editor-view]']){
        const node=page.locator(selector).first();const box=await node.boundingBox();assert.ok(box);
        await windowAction('hover',['-X',String(box.x+Math.min(box.width/2,100)),'-Y',String(box.y+Math.min(box.height/2,40))]);
        await windowAction('capture',['-OutputPath',path.join(output,`hover-${width}-${mode}-${selector==='#panel-editor'?'panel':'button'}.png`)]);
      }
      checks.push({native,viewport:await page.evaluate(()=>({width:innerWidth,height:innerHeight,devicePixelRatio})),mode});
    }
  }
  const probe=await page.evaluate(()=>{const report=window.muninDisplayProbe.report();window.muninDisplayProbe.stop();return report;});
  await writeFile(path.join(output,'report.json'),JSON.stringify({checks,probe,errors,scope:'Actual Windows Studio/WebView2, OS DPI reported per window; no DPI emulation and no untested DPI claimed.'},null,2));
  assert.deepEqual(errors,[]);
  console.log(`Actual WebView2 hover checks passed at OS DPI ${[...new Set(checks.map(check=>check.native.dpi))].join(', ')}; screenshots and report: ${output}`);
}finally{
  // Disconnect CDP and stop only the process tree launched by this fixture.
  if(browser)await browser.close().catch(()=>{});
  if(app&&app.exitCode===null)await run('taskkill',['/PID',String(app.pid),'/T','/F']).catch(()=>{});
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:300});
}
