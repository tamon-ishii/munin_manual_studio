import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {beginVerification, finishVerification} from './lib/manual_ui_report.mjs';
const verificationStart = await beginVerification();
await rm('ui-coverage-results/integrity/result.json', { force: true });
const root=await mkdtemp(path.join(os.tmpdir(),'munin-integrity-')),other=await mkdtemp(path.join(os.tmpdir(),'munin-integrity-other-'));
const base='http://127.0.0.1:5174';let browser,server,releaseSave,saveStarted,failSettings=false,mockRecapture=false,shotAId,shotBId,recaptureCalls=[];
const records=[],requests=[],results=[];
const registry=JSON.parse(await readFile('scripts/fixtures/manual-studio-ui-inventory.json','utf8'));
const integrityCases={"dirty-external-conflict-and-project-cancel": "P02.integrity-conflict-project-cancel", "settings-save-failure-retry": "P13.integrity-settings-retry", "legacy-open-stale-migration-backup-repeat": "P15.integrity-legacy-open", "protected-shared-original": "P06.integrity-protected-sharing", "recapture-partial-failure-retry-original-preservation": "P08.integrity-recapture-partial-retry"};
async function storedFiles(directory=root,prefix=''){
 const entries=await readdir(directory,{withFileTypes:true}),files={};
 for(const entry of entries){const relative=path.posix.join(prefix,entry.name),absolute=path.join(directory,entry.name);if(entry.isDirectory())Object.assign(files,await storedFiles(absolute,relative));else if(entry.isFile())files[relative]=hash(await readFile(absolute));}
 return files;
}
async function record(page,item){
 const caseId=integrityCases[item.case],testCase=registry.cases.find(candidate=>candidate.id===caseId);
 assert.ok(testCase,`Explicit integrity case missing: ${caseId}`);
 const directory='ui-coverage-results/integrity';await mkdir(directory,{recursive:true});
 const screenshot=`${caseId}.png`,state=`${caseId}.state.json`;
 await page.screenshot({path:path.join(directory,screenshot)});
 await writeFile(path.join(directory,state),JSON.stringify({caseId,steps:item.steps,assertions:item.assertions,storedHashes:await storedFiles(),otherProjectHash:hash(await readFile(path.join(other,'docs/index.md'))),editor:await page.locator('#markdown-editor').inputValue(),saveState:await page.locator('#save-state').getAttribute('data-state'),requests:[...requests],recaptureCalls:[...recaptureCalls]},null,2));
 const artifacts=await Promise.all([screenshot,state].map(async file=>({path:file,sha256:hash(await readFile(path.join(directory,file)))})));
 records.push({...item,caseId});
 for(const entryPoint of testCase.entryPoints)results.push({caseId,entryPoint,type:item.type,status:item.status,steps:item.steps,assertions:item.assertions,artifacts});
}
const original='# Integrity\n\nOriginal manuscript.\n';
const legacyDisplay='\n![old](assets/old.png)\n\n';
const legacy='<!-- ai:task id=legacy kind=screenshot prompt="Capture" -->\n![old](assets/old.png)\n<!-- /ai:task -->\n';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
 for(const project of [root,other]){await mkdir(path.join(project,'docs/assets'),{recursive:true});await writeFile(path.join(project,'manual_setting.json'),JSON.stringify({docs:'docs',assets:'docs/assets',targets:['docs'],connection_type:'none'}));await writeFile(path.join(project,'docs/index.md'),original);}
 await writeFile(path.join(root,'docs/legacy.md'),legacy);const png=await readFile('apps/manual-studio/src-tauri/icons/icon.png');await writeFile(path.join(root,'docs/assets/old.png'),png);
 server=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--config','apps/manual-studio/vite.config.ts','--port','5174','--strictPort'],{stdio:'ignore'});
 for(let attempt=0;attempt<100;attempt++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
 const rpc=async(action,options={})=>{const response=await fetch(`${base}/__manual/rpc`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({root,action,options})});const result=await response.json();if(result.error)throw Error(result.error);try{return JSON.parse(result.output);}catch{return result.output;}};
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:960}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/__manual/rpc',async route=>{const request=route.request().postDataJSON();requests.push({action:request.action,root:request.root,page:request.options?.page});
  if(request.action==='editor-save'&&releaseSave){saveStarted?.();await new Promise(resolve=>releaseSave=resolve);releaseSave=undefined;}
  if(request.action==='save'&&failSettings){await route.fulfill({json:{error:'Fixture settings storage unavailable'}});return;}
  if(request.action==='screenshots-recapture'&&mockRecapture){
    recaptureCalls.push(request.options?.json);
    if(recaptureCalls.length===1){
      await route.fulfill({json:{output:JSON.stringify({id:'run-partial',items:[{id:shotAId,status:'succeeded'},{id:shotBId,status:'failed',reason:'window not found'}]})}});
      return;
    }else{
      await route.fulfill({json:{output:JSON.stringify({id:'run-retry',items:[{id:shotBId,status:'succeeded'}]})}});
      return;
    }
  }
  await route.continue();
 });
 const idle=()=>page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
 await page.goto(`${base}/?root=${encodeURIComponent(root)}&page=index.md`);await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('Original manuscript'));await idle();await page.getByRole('button',{name:'Markdownソース',exact:true}).click();const editor=page.locator('#markdown-editor');
 let started;const pending=new Promise(resolve=>started=resolve);saveStarted=started;releaseSave=()=>{};
 const draft=original+'Unsaved local changes.\n';await editor.fill(draft);await page.locator('#save-page').click();await pending;
 const external=original+'External changes.\n';await writeFile(path.join(root,'docs/index.md'),external);releaseSave();
 await page.waitForFunction(()=>document.querySelector('#save-state').dataset.state==='error');assert.equal(await editor.inputValue(),draft);assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),external);
 await page.locator('#open-existing-workspace').click();await page.locator('#project-root').fill(other);await page.locator('#project-form button[type=submit]').click();await page.locator('#unsaved-changes-dialog [data-unsaved-action=cancel]').click();await page.locator('#cancel-open-workspace').click();await idle();assert.equal(await editor.inputValue(),draft);assert.equal(await readFile(path.join(other,'docs/index.md'),'utf8'),original);
 await record(page,{feature:'P01/P02',case:'dirty-external-conflict-and-project-cancel',status:'passed',type:'real-backend',steps:['edit source','hold actual save request','external file write','release and reject stale save','open another project','cancel unsaved prompt'],assertions:{visible:true,stored:true,preserved:true,returnTarget:true},externalHash:hash(external),draftHash:hash(draft)});
 const configBefore=await readFile(path.join(root,'manual_setting.json'));failSettings=true;await page.locator('[data-tab=settings]').click();await page.locator('#ai-connection-type').selectOption('api');await page.locator('#ai-model').fill('Retained model');await page.waitForFunction(()=>document.querySelector('#ai-save-state').textContent.includes('保存失敗'));assert.equal(await page.locator('#ai-model').inputValue(),'Retained model');assert.deepEqual(await readFile(path.join(root,'manual_setting.json')),configBefore);failSettings=false;await page.locator('#ai-save-retry').click();await page.waitForFunction(()=>document.querySelector('#ai-save-state').textContent==='保存済み');assert.equal(JSON.parse(await readFile(path.join(root,'manual_setting.json'),'utf8')).model,'Retained model');assert.equal(await editor.inputValue(),draft);await page.locator('[data-close-dialog=panel-settings]').click();
 await record(page,{feature:'P13',case:'settings-save-failure-retry',status:'passed',type:'browser-mock',steps:['edit model','reject configuration save','retain field and original file','retry actual backend save'],assertions:{visible:true,stored:true,preserved:true,returnTarget:true},limitation:'The settings failure is an injected transport error; successful save uses the actual backend.'});
 // Discard the conflicting local draft explicitly, then verify read-only legacy load.
 await page.getByRole('button',{name:'index.mdを閉じる',exact:true}).click();await page.locator('#unsaved-changes-dialog [data-unsaved-action=discard]').click();await idle();await page.locator('#tree-search').fill('legacy.md');await page.locator('[data-page="docs/legacy.md"]').click();await idle();assert.equal(await editor.inputValue(),legacyDisplay,'read-only compatibility removes AI wrappers while preserving the image reference');assert.equal(await page.locator('#save-state').getAttribute('data-state'),'saved','display normalization must not create an unsaved edit');await new Promise(resolve=>setTimeout(resolve,1000));assert.deepEqual(await readFile(path.join(root,'docs/legacy.md')),Buffer.from(legacy),'opening normalized legacy source must not rewrite original file bytes');assert.deepEqual(await readFile(path.join(root,'docs/assets/old.png')),png);assert.equal(requests.some(request=>request.action==='editor-save'&&/(^|\/)legacy\.md$/.test(request.page||'')),false,'opening legacy source must not issue an automatic save');const legacyRead=await rpc('editor-read',{page:'docs/legacy.md'});assert.equal(legacyRead.content,legacyDisplay);assert.equal(legacyRead.revision,hash(Buffer.from(legacy)),'normalized reads retain the raw on-disk revision');
 const plan=await rpc('screenshots-migration-plan');const candidate=plan.pages.find(item=>item.page==='legacy.md'||item.page==='docs/legacy.md');assert.ok(candidate,'legacy fixture is discoverable');await assert.rejects(()=>rpc('screenshots-migrate',{page:candidate.page,json:{...candidate,revision:'stale'}}),/更新|変更/);assert.equal(await readFile(path.join(root,'docs/legacy.md'),'utf8'),legacy);
 const migrated=await rpc('screenshots-migrate',{page:candidate.page,json:candidate});assert.equal(migrated.migrated,1);assert.equal(await readFile(path.join(root,migrated.backup),'utf8'),legacy);assert.deepEqual(await readFile(path.join(root,'docs/assets/old.png')),png);const after=await readFile(path.join(root,'docs/legacy.md'),'utf8');assert.match(after,/screenshot:ref/);const repeat=await rpc('screenshots-migrate',{page:candidate.page,json:{revision:(await rpc('editor-read',{page:candidate.page})).revision}});assert.equal(repeat.migrated,0);assert.equal(await readFile(path.join(root,'docs/legacy.md'),'utf8'),after);
 await record(page,{feature:'P15',case:'legacy-open-stale-migration-backup-repeat',status:'passed',type:'real-backend',normalizedDisplay:legacyDisplay,originalSourceHash:hash(Buffer.from(legacy)),steps:['open legacy manuscript with read-only normalized AI wrappers','verify no automatic save and raw revision','compare unchanged file and image','reject stale migration','explicit backend migration','verify backup','repeat without duplicate'],assertions:{visible:true,stored:true,preserved:true,returnTarget:true},limitation:'Migration has no current UI entry by user decision; compatibility backend is exercised explicitly.'});
 const registered=await rpc('screenshots-register',{json:{source:`data:image/png;base64,${png.toString('base64')}`,name:'Protected fixture'}});const id=registered.screenshot.id;const copy=await rpc('screenshots-change',{id,json:{copy:true}});const originalImage=(await rpc('screenshots-image',{id,json:{original:true}})).data;
 await page.locator('[data-tab=screenshots]').click();if(!await page.locator('#screenshot-library-refresh').isVisible())await page.locator('#resource-management-menu>summary').click();await page.locator('#screenshot-library-refresh').click();await idle();const card=page.locator(`[data-screenshot-id="${id}"]`);await card.locator('.resource-item-menu>summary').click();await card.locator('.screenshot-management>summary').click();await card.getByRole('button',{name:'画像を保護',exact:true}).click();await idle();assert.equal((await rpc('screenshots-list')).items.find(item=>item.id===id).protected,true);assert.equal(await card.getByRole('button',{name:'選択版を採用',exact:true}).isDisabled(),true);await assert.rejects(()=>rpc('screenshots-change',{id,json:{delete:true}}),/保護/);await card.getByRole('button',{name:'共有関係',exact:true}).click();assert.match(await page.locator('dialog[open]').textContent(),/派生画像2枚/);await page.locator('dialog[open]').getByRole('button',{name:'閉じる',exact:true}).click();assert.equal((await rpc('screenshots-image',{id:copy.screenshot.id,json:{original:true}})).data,originalImage);
 await record(page,{feature:'P06',case:'protected-shared-original',status:'passed',type:'real-backend',steps:['copy managed asset','protect through resource menu','verify adoption disabled and deletion rejected','open shared relationships','return and compare original'],assertions:{visible:true,stored:true,preserved:true,returnTarget:true}});

 // P08: Recapture partial failure, retry failed items, and verify original image preservation
 const recipeA={version:1,platform:'desktop',window:'App',steps:[{launch:{program:'/usr/bin/true',args:[]}},{window:'App'},{screenshot:{task:'recapture-A'}}]};
 const recipeB={version:1,platform:'desktop',window:'App',steps:[{launch:{program:'/usr/bin/true',args:[]}},{window:'App'},{screenshot:{task:'recapture-B'}}]};
 const shotA=await rpc('screenshots-register',{json:{source:`data:image/png;base64,${png.toString('base64')}`,recipe:recipeA,name:'Recapture A'}});
 const shotB=await rpc('screenshots-register',{json:{source:`data:image/png;base64,${png.toString('base64')}`,recipe:recipeB,name:'Recapture B'}});
 shotAId=shotA.screenshot.id;shotBId=shotB.screenshot.id;
 const origDataA=(await rpc('screenshots-image',{id:shotAId,json:{original:true}})).data;
 const origDataB=(await rpc('screenshots-image',{id:shotBId,json:{original:true}})).data;

 mockRecapture=true;
 if(!await page.locator('#screenshot-library-refresh').isVisible())await page.locator('#resource-management-menu>summary').click();await page.locator('#screenshot-library-refresh').click();await idle();
 if(!await page.locator('#screenshot-library-recapture-all').isVisible())await page.locator('#resource-management-menu>summary').click();await page.locator('#screenshot-library-recapture-all').click();
 await page.locator('[data-confirm-accept]').click();
 await page.waitForFunction(()=>document.querySelector('#screenshot-recapture-status')?.textContent.includes('失敗 1件'));
 assert.match(await page.locator('#screenshot-recapture-status').textContent(),/成功 1件・失敗 1件/);
 assert.equal((await rpc('screenshots-image',{id:shotAId,json:{original:true}})).data,origDataA,'partial failure preserves shot A original');
 assert.equal((await rpc('screenshots-image',{id:shotBId,json:{original:true}})).data,origDataB,'partial failure preserves shot B original');

 await page.locator('[data-confirm-accept]').click();
 await page.waitForFunction(()=>document.querySelector('#screenshot-recapture-status')?.textContent.includes('成功 1件・失敗 0件'));
 assert.equal((await rpc('screenshots-image',{id:shotAId,json:{original:true}})).data,origDataA,'retried recapture preserves shot A original');
 assert.equal((await rpc('screenshots-image',{id:shotBId,json:{original:true}})).data,origDataB,'retried recapture preserves shot B original');
 assert.equal(recaptureCalls.length,2);assert.deepEqual(recaptureCalls[1],{run:'run-partial',retry_failed:true},'retry must request failed items from the original partial run');
 mockRecapture=false;

 await record(page,{feature:'P08',case:'recapture-partial-failure-retry-original-preservation',status:'passed',type:'browser-mock',steps:['register 2 screenshots with recipes','inject partial failure on recapture','verify partial failure status and original image hashes','retry failed items','verify completion and original hashes preserved'],assertions:{visible:true,stored:true,preserved:true,returnTarget:true},limitation:'Recapture execution is mocked to simulate partial desktop capture failure; original preservation is verified via backend.'});

 assert.deepEqual(errors,[]);await mkdir('ui-coverage-results/integrity',{recursive:true});await page.screenshot({path:'ui-coverage-results/integrity/final.png'});await writeFile('ui-coverage-results/integrity/result.json',JSON.stringify({...await finishVerification(verificationStart),scope:'explicit integrity scenarios only; injected settings/recapture failures, real storage checks; no native recapture or all-entry proof',records,results,requests},null,2));console.log(`Integrity workflows passed ${records.length} scenarios: project cancel/conflict, settings retry, legacy migration, protected shared images, and recapture partial failure retry.`);
}finally{await browser?.close();server?.kill();await rm(root,{recursive:true,force:true});await rm(other,{recursive:true,force:true});}
