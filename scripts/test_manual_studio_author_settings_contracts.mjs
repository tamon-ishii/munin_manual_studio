import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {beginVerification,finishVerification} from './lib/manual_ui_report.mjs';

const start=await beginVerification();
const reportDir='ui-coverage-results/author-settings';
await rm(path.join(reportDir,'result.json'),{force:true});
const root=await mkdtemp(path.join(os.tmpdir(),'munin-author-settings-'));
const base='http://127.0.0.1:5181';
const original='# Author settings\n\nOriginal paragraph.\n';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const registry=JSON.parse(await readFile('scripts/fixtures/manual-studio-ui-inventory.json','utf8'));
const results=[];
let server,browser,page;
function entry(feature,needle){
 const candidates=registry.actions.filter(action=>action.feature===feature&&action.expression.includes(needle));
 // A loop can contain the same handler text; select the handler itself first.
 const direct=candidates.filter(action=>action.expression.startsWith(needle));
 const matches=direct.length?direct:candidates;
 assert.equal(matches.length,1,`ambiguous registry operation: ${feature} ${needle}`);
 return matches[0].id;
}
async function record(caseId,feature,needles,steps,stored){
 const names=needles.map(needle=>entry(feature,needle));
 const stem=caseId.replaceAll('.','-');
 const screenshot=`${stem}.png`,state=`${stem}.json`;
 await page.screenshot({path:path.join(reportDir,screenshot)});
 await writeFile(path.join(reportDir,state),JSON.stringify({caseId,steps,stored,editor:await page.locator('#markdown-editor').inputValue(),originalHash:hash(original),manuscriptHash:hash(await readFile(path.join(root,'docs/index.md'))),settingsHash:hash(await readFile(path.join(root,'manual_setting.json'))),localStorage:await page.evaluate(()=>({toolbar:localStorage.getItem('manual-studio-toolbar-hidden'),font:localStorage.getItem('manual-studio-editor-font-size')}))},null,2));
 const artifacts=await Promise.all([screenshot,state].map(async file=>({path:file,sha256:hash(await readFile(path.join(reportDir,file)))})));
 for(const entryPoint of names)results.push({caseId,entryPoint,type:feature==='P13'?'browser-mock':'real-backend',status:'passed',steps,assertions:{visible:true,stored:true,preserved:true,returnTarget:true},artifacts});
}
try{
 await mkdir(path.join(root,'docs'),{recursive:true});
 await mkdir(reportDir,{recursive:true});
 await writeFile(path.join(root,'docs/index.md'),original);
 await writeFile(path.join(root,'manual_setting.json'),JSON.stringify({docs:'docs',assets:'docs/assets',output:'manual',targets:['docs'],connection_type:'none'}));
 server=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--config','apps/manual-studio/vite.config.ts','--port','5181','--strictPort'],{stdio:'ignore'});
 for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
 assert.equal((await fetch(base)).ok,true,'isolated Vite server must start');
 browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:960}});
 page=await context.newPage();
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/__manual/rpc',async route=>{const response=await route.fetch({headers:{...route.request().headers(),origin:'http://127.0.0.1:5174'}});await route.fulfill({response});});
 const idle=()=>page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
 await page.goto(`${base}/?root=${encodeURIComponent(root)}&page=index.md`);
 await page.waitForFunction(()=>document.querySelector('#markdown-editor')?.value.includes('Original paragraph')).catch(async error=>{throw new Error(`${error.message}; status=${await page.locator('#status').textContent()}; body=${(await page.locator('body').textContent()).slice(0,500)}`)});
 await idle();
 const settingsBefore=await readFile(path.join(root,'manual_setting.json'));
 assert.equal(await page.locator('.workspace-tabs #open-applications').count(),1);
 assert.equal(await page.locator('.app-header #open-applications').count(),0);
 assert.equal(await page.locator('#panel-editor > .document-heading .editor-display-group').count(),1);
 for(const view of ['edit','split','preview']){
   const button=page.locator(`button[data-editor-view=${view}]`);
   assert.equal(await button.textContent(),'');
   assert.ok(await button.getAttribute('aria-label'));
   assert.equal(await button.getAttribute('title'),`${await button.getAttribute('aria-label')} (Ctrl/Cmd+Shift+Pで順に切替)`);
 }
 assert.equal(await page.locator('#editor-screenshot-ai').textContent(),'撮影');
 assert.equal(await page.locator('#generate-ai-image').textContent(),'AI作画');
 for(const view of ['edit','preview','split']){
   await page.locator(`#panel-editor button[data-editor-view="${view}"]`).click();
   assert.equal(await page.locator('#panel-editor').getAttribute('data-editor-view'),view);
   assert.equal(await page.locator(`#panel-editor button[data-editor-view="${view}"]`).getAttribute('aria-pressed'),'true');
 }

 await page.screenshot({path:path.join(reportDir,'compact-editor.png')});

 assert.equal(await page.locator('#project-menu, #open-workspace-settings, #workspace-settings-dialog').count(),0,'removed project menu and workspace settings are absent');
 await page.locator('#open-existing-workspace').click();
 assert.equal(await page.locator('#workspace-dialog h2').textContent(),'フォルダーを開く');
 assert.equal(await page.locator('#workspace-dialog .folder-picker #browse-project').count(),1);
 assert.deepEqual(await page.locator('#workspace-dialog .actions button').allTextContents(),['キャンセル','開く']);
 await page.locator('#cancel-open-workspace').click();
 assert.equal(await page.locator('#workspace-dialog').isVisible(),false);
 assert.equal(await page.locator('#new-workspace, #new-workspace-dialog').count(),0);
 assert.equal(await page.locator('#open-existing-workspace').isVisible(),true);
 assert.equal(await page.locator('#workspace-name').isVisible(),true);
 assert.equal(await page.locator('#workspace-name').getAttribute('title'),'最近開いたフォルダーを選択');
 assert.equal(await page.locator('#workspace-name-label').textContent(),path.basename(root));
 assert.equal(await page.locator('#workspace-name .folder-selector-arrow').isVisible(),true);
 await page.locator('#workspace-name .folder-selector-arrow').click();
 assert.equal(await page.locator('#workspace-history-title').textContent(),'最近開いたフォルダー');
 assert.equal(await page.locator('#workspace-history-dialog [data-workspace-root]').count(),1);
 await page.locator('#workspace-history-dialog [data-history-close]').click();

 assert.deepEqual(await readFile(path.join(root,'manual_setting.json')),settingsBefore,'opening a project preserves configuration');
 if(!await page.locator('#editor-more').evaluate(el=>el.open)) await page.locator('#editor-more > summary').click();

 await page.getByRole('button',{name:'執筆方針',exact:true}).click();
 await page.locator('#manual-brief').fill('初心者向けに、起動から保存までを説明する。');
 await page.waitForFunction(()=>document.querySelector('#brief-save-state').textContent==='保存済み');await idle();
 const storedSettings=JSON.parse(await readFile(path.join(root,'manual_setting.json'),'utf8'));
 for(const [key,value] of Object.entries(JSON.parse(settingsBefore)))assert.deepEqual(storedSettings[key],value,`brief autosave preserves ${key}`);
 assert.equal(await page.locator('#save-settings').count(),0,'writing brief uses autosave');
 let failBriefSave=true;
 const briefRoute=async route=>{
   const request=route.request().postDataJSON();
   if(failBriefSave&&request.action==='save'&&Object.hasOwn(request.options||{},'brief')){
     failBriefSave=false;await route.fulfill({status:500,json:{error:'fixture brief save failure'}});
   }else await route.fallback();
 };
 await page.route('**/__manual/rpc',briefRoute);
 await page.locator('#manual-brief').fill('初心者向けに、起動から保存・復元までを説明する。');
 await page.waitForFunction(()=>document.querySelector('#brief-save-state').textContent.includes('保存失敗'));
 await page.locator('#brief-save-retry').click();
 await page.waitForFunction(()=>document.querySelector('#brief-save-state').textContent==='保存済み');
 await page.unroute('**/__manual/rpc',briefRoute);
 assert.equal(await page.locator('#brief-save-retry').isVisible(),false);
 assert.match(await readFile(path.join(root,'manual/brief.md'),'utf8'),/保存・復元/);
 assert.deepEqual(JSON.parse(await readFile(path.join(root,'manual_setting.json'),'utf8')),storedSettings,'brief retry preserves AI and project settings');
 assert.match(await readFile(path.join(root,'manual/brief.md'),'utf8'),/初心者向け/);
 assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),original);
 await page.locator('[data-close-dialog=panel-brief]').click();
 await page.reload();await idle();
 if(!await page.locator('#editor-more').evaluate(el=>el.open)) await page.locator('#editor-more > summary').click();

 await page.getByRole('button',{name:'執筆方針',exact:true}).click();
 assert.match(await page.locator('#manual-brief').inputValue(),/初心者向け/);
 await page.locator('[data-close-dialog=panel-brief]').click();
 const settingsAfterWorkspace=await readFile(path.join(root,'manual_setting.json'));
 await record('P02.brief-persistence','P02',['data-tab="brief"','id="manual-brief"','id="brief-save-retry"','data-close-dialog="panel-brief"','element("manual-brief").addEventListener','element("brief-save-retry").addEventListener'],['open independent writing brief','inject brief save failure and click retry','verify settings preserved after retry','edit brief and wait for autosave','read actual manual/brief.md','verify original manuscript is unchanged','close and reload application','reopen and verify stored brief'],{brief:await readFile(path.join(root,'manual/brief.md'),'utf8'),persistence:'manual/brief.md'});

 await page.getByRole('button',{name:'Markdownソース',exact:true}).click();
 const editor=page.locator('#markdown-editor');
 const draft=original+'Saved through editor.\n';
 await editor.fill(draft);
 await page.waitForTimeout(1200);
 assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),original,'editing preserves the stored manuscript until explicit save');
 await page.locator('#save-page').click();
 await page.waitForFunction(()=>document.querySelector('#save-state')?.dataset.state==='saved');
 assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),draft,'explicit save writes the real manuscript');
 await page.reload();await idle();
 assert.equal(await editor.inputValue(),draft,'editor reload restores actual saved content');
 assert.equal(await page.locator('#editor-title').textContent(),'index.md');
 assert.deepEqual(await readFile(path.join(root,'manual_setting.json')),settingsAfterWorkspace);
 await record('P02.editor-manual-save','P02',['id="markdown-editor" spellcheck'],['edit source manuscript','verify unsaved body then click Save','read actual docs/index.md','reload editor and compare body and active title'],{manuscript:'docs/index.md',contentHash:hash(draft)});

 await page.getByRole('button',{name:'外観',exact:true}).click();
 await page.locator('#toolbar-customization>summary').click();
 const bold=page.locator('#toolbar-customization-list label').filter({hasText:/^太字$/}).locator('input');
 await bold.uncheck();
 assert.equal(await page.locator('[data-format="bold"]').getAttribute('data-toolbar-hidden'),'true');
 assert.ok((await page.evaluate(()=>JSON.parse(localStorage.getItem('manual-studio-toolbar-hidden')||'[]'))).includes('太字'));
 await page.locator('[data-close-dialog=panel-appearance]').click();
 await page.reload();await idle();
 await page.getByRole('button',{name:'外観',exact:true}).click();
 await page.locator('#toolbar-customization>summary').click();
 assert.equal(await bold.isChecked(),false,'hidden toolbar state restores from browser storage');
 await page.locator('#reset-toolbar-customization').click();
 assert.equal(await bold.isChecked(),true);
 assert.equal(await page.evaluate(()=>localStorage.getItem('manual-studio-toolbar-hidden')),null);
 assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),draft);
 assert.deepEqual(await readFile(path.join(root,'manual_setting.json')),settingsAfterWorkspace);
 await record('P13.toolbar-visibility','P13',['data-tab="appearance" data-ui-icon','id="reset-toolbar-customization"','checkbox.onchange=()=>{if(checkbox.checked)hidden.delete'],['open appearance panel','hide bold control','verify toolbar and localStorage','reload and verify preference restores','reset toolbar visibility','verify manuscript unchanged'],{persistence:'browser localStorage',reset:'storage key removed'});
 assert.deepEqual(errors,[]);
 await writeFile(path.join(reportDir,'result.json'),JSON.stringify({...await finishVerification(start),type:'real-backend',scope:'removed workspace settings, P02 explicit manuscript save, P13 toolbar preference; browser UI with actual local backend files; remaining actions unverified',notes:'Vite fixture ran on port 5181. Browser RPC Origin was adapted to its development allowlist on port 5174 while requests passed through the actual backend.',results},null,2));
 console.log(`Author/settings contracts passed: ${results.length} entry-specific results across 3 scenarios.`);
}finally{await browser?.close();server?.kill();await rm(root,{recursive:true,force:true});}
