import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {sourceInventory,validateRegistry} from './lib/manual_ui_inventory.mjs';
import {runtimeDeclarations,collectRuntime,runtimeErrors,reachabilityErrors} from './lib/manual_ui_runtime.mjs';

const base='http://127.0.0.1:5188';
const declarations=await runtimeDeclarations(process.cwd());
const registry=JSON.parse(await readFile('scripts/fixtures/manual-studio-ui-inventory.json','utf8'));
const source=await sourceInventory(process.cwd());
assert.deepEqual(validateRegistry(registry,source),[]);
const png='data:image/png;base64,'+(await readFile('apps/manual-studio/src-tauri/icons/icon.png')).toString('base64');
let shots=[],resources=[],releaseGeneration,generationStarted=false,releasePaste,pasteStarted=false;
let content='# Fixture\n\nBody text.\n';
const state={has_config:true,config:{docs:'docs',assets:'docs/assets',output:'manual',agent:'codex',model:'test',connection_type:'none',mkdocs:{site_name:'Fixture',theme:'material',language:'ja',use_directory_urls:true}},brief:'',pages:['docs/index.md'],project_entries:[{path:'docs/index.md',directory:false}],tasks:[],capture_sources:{},image_assets:{},agents:[]};
let server,browser;
const snapshots=[];
const requirements=[
 ...['editor-screenshot-ai','selection-ai','reader-review','generate-ai-image'].map(id=>({state:'document',selector:`button[id=${JSON.stringify(id)}]`})),
 ...['settings','appearance','publish','applications'].map(name=>({state:name,selector:`button[data-close-dialog=${JSON.stringify(`panel-${name}`)}]`})),
 ...['source-no-selection','source-selection'].map(state=>({state,selector:'textarea[id="markdown-editor"]'})),
 ...['image-kinds-and-candidate','expanded-image-operations','protected-image'].map(state=>({state,selector:'select[id="resource-kind"]'})),
 {state:'expanded-image-operations',label:'画像の編集版'},
 {state:'AI-processing',selector:'button[id="progress-cancel"]'},
 {state:'clipboard-saving',selector:'button[id="cancel-image-paste"]'},
 {state:'AI-failure-retry',label:'候補を作成'},
];
try {
 server=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--config','apps/manual-studio/vite.config.ts','--port','5188','--strictPort'],{stdio:'ignore'});
 for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:960}});
 await page.route('**/__manual/rpc',async route=>{
  const {action,options}=route.request().postDataJSON();
  if(action==='save-asset'){pasteStarted=true;await new Promise(resolve=>releasePaste=resolve);await route.fulfill({json:{output:'{}'}});return;}
  if(action==='selection-generate'){generationStarted=true;await new Promise(resolve=>releaseGeneration=resolve);await route.fulfill({json:{error:'Fixture generation failed; retry is available'}});return;}
  if(action==='save')Object.assign(state.config,options);
  if(action==='editor-save')content=options.json.content;
  const result=action==='state'||action==='save'?state:action==='editor-read'||action==='editor-save'?{page:'docs/index.md',content,revision:'r1'}:action==='editor-preview'?'<html><body><h1>Fixture</h1></body></html>':action==='screenshots-list'?{items:shots}:action==='resources-list'?{items:resources}:action==='resources-thumbnail'||action==='resources-image'?png:action==='agent-progress'?{logs:[],total:0}:action==='page-tasks'?[]:{};
  await route.fulfill({json:{output:typeof result==='string'?result:JSON.stringify(result)}});
 });
 await page.goto(base);await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');await snapshot('no-project');
 await page.goto(`${base}/?root=${encodeURIComponent('/tmp/munin-runtime-fixture')}`);
 await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false'&&document.querySelector('#editor-title').textContent==='docs/index.md');
 async function snapshot(name){const controls=await collectRuntime(page,declarations);snapshots.push({name,controls});if(runtimeErrors(controls).length)console.log(controls.filter(c=>!c.registered));assert.deepEqual(runtimeErrors(controls),[],name);}
 await snapshot('document');
 await page.getByRole('button',{name:'Markdownソース',exact:true}).click();await snapshot('source-no-selection');
 await page.locator('#markdown-editor').evaluate(node=>{node.focus();node.setSelectionRange(12,16);});await snapshot('source-selection');
 await page.locator('#markdown-editor').evaluate((node,png)=>{const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(png.split(',')[1]),c=>c.charCodeAt(0))],'fixture.png',{type:'image/png'}));node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));},png);
 for(let attempt=0;attempt<100&&!pasteStarted;attempt++)await new Promise(resolve=>setTimeout(resolve,50));assert.ok(pasteStarted);
 await snapshot('clipboard-saving');await page.locator('#cancel-image-paste').click();releasePaste();
 await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
 for(const name of ['settings','appearance','publish','brief','applications']) {
  if(name==='applications')await page.locator('[data-tab=screenshots]').click();
  if(name==='brief')await page.locator('#editor-more>summary').click();
  await page.locator(`[data-tab=${name}]`).click();await snapshot(name);
  await page.locator(`[data-close-dialog=panel-${name}]`).click();
 }
 await page.locator('[data-tab=screenshots]').click();await snapshot('empty-resources');
 shots=[{id:'fixture-shot',name:'Fixture shot',output:'docs/assets/shot.png',adopted:'r1',protected:false,edits:[{id:'r1',created_at:'old',flattened:false},{id:'r2',created_at:'new',flattened:false,requires_review:true}],usage:['docs/index.md'],thumbnail:png,recipe:{steps:[]}}];
 resources=[{path:'docs/assets/shot.png',name:'Fixture shot',kind:'screenshot',screenshot_id:'fixture-shot',usages:[]},{path:'docs/assets/ordinary.png',name:'ordinary.png',kind:'imported',usages:[]},{path:'docs/assets/generated.png',name:'Generated',kind:'generated',generation:{id:'gen',path:'docs/assets/generated.png',prompt:'Fixture drawing',created_at:'now'},usages:[]}];
 if(!await page.locator('#screenshot-library-refresh').isVisible())await page.locator('#resource-management-menu>summary').click();await page.locator('#screenshot-library-refresh').click();await page.waitForFunction(()=>document.querySelectorAll('.resource-list-item').length===3);await snapshot('image-kinds-and-candidate');
 for(const menu of await page.locator('.resource-item-menu>summary').all())await menu.click();
 for(const menu of await page.locator('.screenshot-management>summary').all())await menu.click();
 await snapshot('expanded-image-operations');
 shots[0].protected=true;if(!await page.locator('#screenshot-library-refresh').isVisible())await page.locator('#resource-management-menu>summary').click();await page.locator('#screenshot-library-refresh').click();await page.waitForFunction(()=>document.querySelector('.screenshot-library-card').textContent.includes('保護中'));await snapshot('protected-image');
  await page.locator('[data-tab=editor]').click();
 if(!await page.locator('#editor-screenshot-options').isVisible())await page.locator('#editor-more>summary').click();
 await page.locator('#editor-screenshot-options').click();await snapshot('screenshot-methods');
 await page.locator('dialog[open]').getByRole('button',{name:'閉じる',exact:true}).click();
 await page.locator('#selection-ai').click();await snapshot('AI-not-configured');
 const open=page.locator('dialog[open]');if(await open.count())await open.getByRole('button',{name:'閉じる',exact:true}).click();
 await page.locator('[data-tab=settings]').click();await page.locator('#ai-connection-type').selectOption('api');await page.locator('#ai-endpoint-url').fill('http://127.0.0.1:1/v1');await page.waitForFunction(()=>document.querySelector('#ai-save-state').textContent==='保存済み');await page.locator('[data-close-dialog=panel-settings]').click();
 await page.locator('#selection-ai').click();await page.getByRole('textbox',{name:'AIへの指示',exact:true}).fill('Fixture instruction');await snapshot('AI-instruction');await page.getByRole('button',{name:'候補を作成',exact:true}).click();
 for(let attempt=0;attempt<100&&!generationStarted;attempt++)await new Promise(resolve=>setTimeout(resolve,50));assert.ok(generationStarted);await snapshot('AI-processing');releaseGeneration();await page.waitForFunction(()=>document.querySelector('dialog[open] [role=alert]')?.textContent.includes('Fixture generation failed'));await snapshot('AI-failure-retry');
 await page.locator('dialog[open]').getByRole('button',{name:'閉じる',exact:true}).click();if(await page.locator('#progress-dismiss').isVisible())await page.locator('#progress-dismiss').click();
  assert.deepEqual(reachabilityErrors(snapshots,requirements),[],'required entries must be visible and enabled in their scheduled state');
 // Keep the declaration in place but make a real entry unreachable. Unknown
 // control detection alone would accept this broken screen.
 await page.locator('#editor-screenshot-ai').evaluate(node=>node.hidden=true);
 const hiddenSnapshot={name:'document',controls:await collectRuntime(page,declarations)};
 assert.deepEqual(runtimeErrors(hiddenSnapshot.controls),[]);
 assert.ok(reachabilityErrors([hiddenSnapshot],[requirements[0]]).some(error=>error.includes('unreachable required control')),'a declared but hidden entry must fail');
 await page.locator('#editor-screenshot-ai').evaluate(node=>{node.hidden=false;node.disabled=true;});
 assert.ok(reachabilityErrors([{name:'document',controls:await collectRuntime(page,declarations)}],[requirements[0]]).some(error=>error.includes('disabled required control')),'a visible but disabled entry must fail');
 await page.locator('#editor-screenshot-ai').evaluate(node=>node.disabled=false);
 assert.ok(reachabilityErrors([],requirements).some(error=>error.includes('unexplored required state')),'omitting a scheduled state must fail');
 await page.evaluate(()=>{const button=document.createElement('button');button.textContent='UNREGISTERED_UI_FAULT_FIXTURE';button.dataset.uiIcon='camera';document.body.append(button);});
 assert.ok(runtimeErrors(await collectRuntime(page,declarations)).some(error=>error.includes('UNREGISTERED_UI_FAULT_FIXTURE')),'unregistered visible button must fail');
 await mkdir('ui-coverage-results',{recursive:true});
 await writeFile('ui-coverage-results/runtime-inventory.json',JSON.stringify({type:'browser-mock',scope:'source/rich, selection, settings, resource kinds/candidate/protection, AI instruction/processing/failure; discovery only, no native or provider proof',sourceHash:source.sourceHash,sourceBindings:source.operations.filter(operation=>/event:(keydown|keyup|paste|drop|drag)|keyboard-map/.test(operation.kind)),requirements,faults:['unknown-control','hidden-required-entry','disabled-required-entry','missing-required-state'],snapshots},null,2));
 console.log(`Runtime discovery passed ${snapshots.length} states and ${requirements.length} required entries; unknown, hidden, disabled and unexplored fixtures are rejected. This is discovery evidence, not behavioral coverage.`);
} finally {await browser?.close();server?.kill();}
