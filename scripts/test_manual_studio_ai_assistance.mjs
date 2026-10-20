import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {chromium} from 'playwright-core';
import {beginVerification,finishVerification} from './lib/manual_ui_report.mjs';
import {fingerprint} from './lib/manual_ui_inventory.mjs';
const exec=promisify(execFile),root=await mkdtemp(path.join(tmpdir(),'munin-assistance-'));
const resultDirectory='ui-coverage-results/editor-ai-capture';
await mkdir(resultDirectory,{recursive:true});await rm(`${resultDirectory}/result.json`,{force:true});
const workflowDirectory='ui-coverage-results/ai-workflows';
await mkdir(workflowDirectory,{recursive:true});await rm(`${workflowDirectory}/result.json`,{force:true});
const workflowResults=[],workflowRecords=[],workflowArtifacts=new Map();
const workflowRegistry=JSON.parse(await readFile('scripts/fixtures/manual-studio-ui-inventory.json','utf8'));
const workflowSteps={"P12.compact-progress-dismiss-cancel": ["start blocked draft", "advance waiting clock", "dismiss full progress", "cancel through compact control", "assert cancelled label and preserved editor/file"], "P12.full-draft-discard": ["generate full candidate", "verify actual manuscript unchanged", "discard through draft dialog", "verify editor/file and absent new page"], "P12.full-draft-selective-page-part-adoption": ["decline all and verify apply disabled", "select all", "exclude other and new pages", "exclude last index change", "apply selected part", "read exact index and unchanged other file", "verify new page absent"], "P09.review-preflight-retry": ["inject preflight transport failure", "retain reader purpose", "verify run disabled", "retry capability check", "verify run enabled and purpose retained", "close options"], "P09.selection-review-filter-rerun-jump": ["review source selection", "verify two findings", "filter image empty and proofreading one finding", "fail two reruns", "retain report and filter", "jump twice to exact old A anchor"], "P09.review-finding-correction-chain": ["inspect replacement generated during review", "discard candidate and retain report/filter", "adopt cached correction without another AI call", "retain and reanchor next finding to old B", "save exact corrected manuscript"], "P09.report-reopen-after-reload": ["close report", "reload actual project page", "reopen persisted report", "verify remaining finding and saved correction"], "P12.progress-log-reopen-after-review": ["after reload verify log entry visible", "reopen historical review log", "assert review/process text", "dismiss log and verify saved manuscript unchanged"], "P10.selection-diff-partial-retry-undo-redo": ["generate two-part selection candidate", "expand unchanged context", "uncheck last change", "verify small viewport layout", "inject retry generation failure", "retain partial choice and feedback", "adopt old A only", "Undo then Redo", "save exact partial manuscript"], "P10.cursor-position-new-text-undo": ["generate text at empty source selection", "adopt before exact 後文 cursor", "assert entire expected manuscript", "Undo insertion", "save partial manuscript"]};
const verificationStart=await beginVerification();
async function fixtureHashes(directory=root,prefix=''){
 const hashes={};for(const item of await readdir(directory,{withFileTypes:true})){const relative=path.posix.join(prefix,item.name),absolute=path.join(directory,item.name);if(item.isDirectory())Object.assign(hashes,await fixtureHashes(absolute,relative));else if(item.isFile())hashes[relative]=fingerprint(await readFile(absolute));}return hashes;
}
async function workflowEvidence(page,caseId,details={},stage='final'){
 const testCase=workflowRegistry.cases.find(item=>item.id===caseId);assert.ok(testCase,`Explicit AI workflow case missing: ${caseId}`);
 const screenshot=`${caseId}.${stage}.png`,state=`${caseId}.${stage}.state.json`,assertions={visible:true,stored:true,preserved:true,returnTarget:true};
 const editorState=await page.locator('#markdown-editor').evaluate(element=>({value:element.value,start:element.selectionStart,end:element.selectionEnd}));
 await page.screenshot({path:path.join(workflowDirectory,screenshot)});
 await writeFile(path.join(workflowDirectory,state),JSON.stringify({caseId,stage,status:stage==='final'?'passed':'checkpoint',steps:workflowSteps[caseId],assertions:stage==='final'?assertions:undefined,editorState,storedHashes:await fixtureHashes(),visibleText:await page.locator('body').innerText(),aiRequests:calls.map(call=>({input:call.input,prompt:call.prompt})),...details},null,2));
 const artifacts=await Promise.all([screenshot,state].map(async name=>({path:name,sha256:fingerprint(await readFile(path.join(workflowDirectory,name)))})));
 const allArtifacts=[...(workflowArtifacts.get(caseId)||[]),...artifacts];workflowArtifacts.set(caseId,allArtifacts);if(stage!=='final')return;
 workflowRecords.push({caseId,status:'passed',steps:workflowSteps[caseId],assertions});
 for(const entryPoint of testCase.entryPoints)workflowResults.push({caseId,entryPoint,type:'browser-mock',status:'passed',steps:workflowSteps[caseId],assertions,artifacts:allArtifacts});
}

let browser,vite,denyImages=false,delayReview=false,reviewStarted,releaseReview,expandedCorrection=false,omitReviewReplacements=false;
const calls=[];
function chunk(type,data){const name=Buffer.from(type),payload=Buffer.concat([name,data]);let crc=0xffffffff;for(const byte of payload){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const header=Buffer.alloc(4),tail=Buffer.alloc(4);header.writeUInt32BE(data.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([header,payload,tail]);}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(100,0);ihdr.writeUInt32BE(60,4);ihdr[8]=8;ihdr[9]=6;
const pixels=Buffer.alloc(60*(1+100*4),255);for(let row=0;row<60;row++)pixels[row*(1+100*4)]=0;
const ui=[{role:'button',name:'Save',x:2,y:3,width:10,height:8}];
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('tEXt',Buffer.from('markits:ui_elements\0'+JSON.stringify(ui))),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);

const ai=createServer(async(req,res)=>{try{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),user=body.messages.at(-1).content;
  const rawPrompt=typeof user==='string'?user:user.find(p=>p.type==='text').text;const prompt=rawPrompt.replace(/^Return the requested JSON only[^\n]*\n/,'');
  const input=JSON.parse(prompt.split('Input JSON: ')[1].split('\nImage attachments')[0].split('\n\nRespond with')[0]);calls.push({prompt,input,user,key:req.headers.authorization});
  if(denyImages&&Array.isArray(user)){res.writeHead(400);res.end('image input unavailable');return;}
  let result;
  if(prompt.startsWith('Review')){
    if(delayReview){reviewStarted?.();await new Promise(resolve=>releaseReview=resolve);}
    const issues=[];if(input.document.includes('old A'))issues.push({category:'proofreading',severity:'problem',quote:'old A',occurrence:1,message:'用語を校正',suggestion:'用語と説明を統一します。',replacement:'new A with extra explanation',image:''});
    if(input.document.includes('old B'))issues.push({category:'reader',severity:'suggestion',quote:'old B',occurrence:1,message:'説明が曖昧',suggestion:'説明を明確にします。',replacement:'new B',image:''});
    const images=Array.isArray(user)?input.images.filter(i=>i.status==='submitted').map(i=>i.path):[];
    if(images.length&&input.document.includes('画面'))issues.push({category:'image',severity:'problem',quote:'画面',occurrence:1,message:'ボタン説明が画像と異なる',suggestion:'画像を確認して説明を修正',replacement:null,image:images[0]});
    if(omitReviewReplacements)for(const issue of issues)issue.replacement=null;
    result={issues,checked_images:images};
  }else if(prompt.startsWith('Write concrete Markdown replacements'))result={replacements:input.findings.map(finding=>({id:finding.id,replacement:finding.quote==='old A'?'new A with extra explanation':'new B'}))};
  else if(prompt.startsWith('Create a comprehensive'))result={pages:[{path:'index.md',content:original.replace('old A','new A').replace('old B','new B')},{path:'other.md',content:'# Other changed\n\nCandidate\n'},{path:'new.md',content:'# New candidate\n'}]};
  else if(prompt.startsWith('Create or revise'))result={content:input.mode==='insert new text'?'新しい文章です。':input.selected.replaceAll('old A',expandedCorrection?'new A with extra explanation':'new A').replaceAll('old B','new B')};
  else if(prompt.startsWith('Choose the target')){assert.ok(input.launch_context.some(file=>file.path==='README.md'&&file.content.includes('--workspace')));assert.ok(input.executable_candidates.some(candidate=>candidate.name==='fixture-app'));result={name:'Fixture app',program:input.selected_application?.program||'/usr/bin/true',args:['--workspace','demo project','--mode','docs'],workingDirectory:input.selected_application?.workingDirectory||''};}
  else if(prompt.startsWith('Select actual screenshot'))result={marks:[{element:1,type:'badge',step:1,text:''}]};
  else throw new Error(`Unexpected prompt ${prompt.slice(0,50)}`);
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));
}catch(e){res.writeHead(500);res.end(String(e));}});
await new Promise(resolve=>ai.listen(0,'127.0.0.1',resolve));const endpoint=`http://127.0.0.1:${ai.address().port}/v1`;
const cli=path.resolve(process.env.CARGO_TARGET_DIR||'target','debug/manualctl');
const rpc=async(action,options={})=>JSON.parse((await exec(cli,['--request',JSON.stringify({root,action,options:{...options,api_key:'fixture-key'}})])).stdout);
const original='# Guide\n\n前文😀\n\nold A\n\nunchanged\n\nold B\n\n後文\n\n画面 ![sample](assets/sample.png)\n\n```html\n<img src="ignored.png">\n```\n';
try{
  await mkdir(path.join(root,'bin'),{recursive:true});await writeFile(path.join(root,'bin/fixture-app'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  await writeFile(path.join(root,'README.md'),'Fixture app launch: /usr/bin/true --workspace "demo project" --mode docs\n');
  await mkdir(path.join(root,'docs/assets'),{recursive:true});await writeFile(path.join(root,'docs/index.md'),original);await writeFile(path.join(root,'docs/other.md'),'# Other\n\nOther text\n');await writeFile(path.join(root,'docs/assets/sample.png'),png);
  await writeFile(path.join(root,'manual_setting.json'),JSON.stringify({docs:'docs',output:'manual',agent:'codex',model:'fixture',connection_type:'api',endpoint_url:endpoint,assets:'docs/assets'}));
  const doc=await rpc('editor-read',{page:'docs/index.md'});
  omitReviewReplacements=true;
  const repaired=await rpc('document-review',{page:doc.page,json:{revision:doc.revision,reader:'初心者'}});
  assert.equal(repaired.issues[0].replacement,'new A with extra explanation','review completes missing concrete corrections before returning');
  assert.equal(repaired.issues[1].replacement,'new B');
  assert.equal(repaired.issues[2].replacement,null,'image findings needing verification are preserved');
  assert.equal(calls.at(-1).input.findings.length,2,'missing corrections are completed in one batch');
  omitReviewReplacements=false;
  const report=await rpc('document-review',{page:doc.page,json:{revision:doc.revision,reader:'初心者'}});
  assert.equal(report.images.length,1);assert.equal(report.images[0].status,'checked');assert.equal(report.issues.length,3);assert.ok(Array.isArray(calls.at(-1).user));assert.equal(calls.at(-1).key,'Bearer fixture-key');
  const start=original.indexOf('old B'),end=start+5;
  const selected=await rpc('document-review',{page:doc.page,json:{revision:doc.revision,range:{start,end}}});assert.equal(selected.issues.length,1);assert.equal(selected.issues[0].start,start);assert.equal(selected.images.length,0);
  denyImages=true;const fallback=await rpc('document-review',{page:doc.page,json:{revision:doc.revision}});assert.equal(fallback.images[0].status,'unverified');assert.equal(fallback.issues.filter(i=>i.category==='image').length,0);assert.equal(fallback.warnings.length,1);denyImages=false;
  await assert.rejects(rpc('document-review',{page:doc.page,json:{revision:'old'}}),/更新/);assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),original);
  const preflight=await rpc('document-review-capabilities',{page:doc.page,json:{}});assert.equal(preflight.supports_images,true);assert.equal(preflight.images,1);assert.match(preflight.note,/結果で確認/);const settings=await readFile(path.join(root,'manual_setting.json'),'utf8');await writeFile(path.join(root,'manual_setting.json'),JSON.stringify({...JSON.parse(settings),connection_type:'cli'}));const cliPreflight=await rpc('document-review-capabilities',{page:doc.page,json:{}});assert.equal(cliPreflight.supports_images,false);assert.match(cliPreflight.note,/整合チェックはできません/);await writeFile(path.join(root,'manual_setting.json'),settings);
  await writeFile(path.join(root,'AGENTS.md'),'Project instruction fixture: preserve existing manuscripts.\n');
  await writeFile(path.join(root,'bin/agy'),`#!/usr/bin/python3
import os,sys,json
assert '--mode' in sys.argv and sys.argv[sys.argv.index('--mode')+1]=='plan'
assert os.getcwd()==${JSON.stringify(root)}
assert 'Project instruction fixture' in open('AGENTS.md').read()
print(json.dumps({'status':'SUCCESS','structured_output':{'pages':[{'path':'index.md','content':'# Detached candidate'}]}}))
`,{mode:0o755});
  await writeFile(path.join(root,'manual_setting.json'),JSON.stringify({...JSON.parse(settings),connection_type:'cli',agent:'agy',model:''}));
  const detached=JSON.parse((await exec(cli,['--request',JSON.stringify({root,action:'draft-propose',options:{}})],{env:{...process.env,PATH:path.join(root,'bin')+path.delimiter+process.env.PATH}})).stdout);assert.equal(detached.pages[0].content,'# Detached candidate\n');assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),original,'CLI reads project instructions without writing manuscripts');await writeFile(path.join(root,'manual_setting.json'),settings);

  const candidate=await rpc('draft-propose');assert.equal(candidate.pages.length,3);assert.equal(candidate.pages[0].before,original);assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),original);await assert.rejects(readFile(path.join(root,'docs/new.md'),'utf8'));
  const app=await rpc('screenshot-ai-application',{json:{instruction:'Fixture appを撮影',applications:[]}});assert.equal(app.workingDirectory,'');assert.equal(app.available,true);assert.equal(app.program,"/usr/bin/true");assert.deepEqual(app.args,['--workspace','demo project','--mode','docs']);
  const recipe={version:1,platform:'desktop',window:'Fixture',steps:[{launch:{program:'/usr/bin/true',args:[]}},{window:'Fixture'},{screenshot:{task:'ai-capture'}}]};
  const shot=await rpc('screenshots-register',{json:{source:`data:image/png;base64,${png.toString('base64')}`,recipe,adopt:false}});
  const annotated=await rpc('screenshot-ai-annotate',{json:{id:shot.screenshot.id,instruction:'Saveに番号1を振って'}});
  assert.equal(annotated.screenshot.edits.length,2);assert.equal(annotated.screenshot.adopted,null);assert.deepEqual(annotated.screenshot.recipe,recipe);assert.deepEqual(annotated.screenshot.edits.at(-1).scene.annotations[0].target,[2,3,10,8]);
  await rpc('screenshots-change',{id:shot.screenshot.id,json:{adopt:annotated.revision}});
  const diagnostic=await rpc('screenshots-diagnose');assert.equal(diagnostic.items.find(item=>item.id===shot.screenshot.id).status,'ready');
  const rawShot=await rpc('screenshots-image',{id:shot.screenshot.id,json:{original:true}});assert.equal(rawShot.data,`data:image/png;base64,${png.toString('base64')}`);
  vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','apps/manual-studio/vite.config.ts'],{stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:5174')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:960}});await page.clock.install();const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack);});
  await page.goto(`http://127.0.0.1:5174/?root=${encodeURIComponent(root)}&page=docs/index.md`);try{await page.waitForFunction(()=>/^(docs\/)?index\.md$/.test(document.querySelector('#editor-title').textContent));}catch(e){console.log(await page.locator('#status').textContent());throw e;}
  const idle=()=>page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');await idle();await page.getByRole('button',{name:'Markdownソース',exact:true}).click();
  const editor=page.locator('#markdown-editor');const select=async(left,right)=>editor.evaluate((e,[a,b])=>{e.focus();e.setSelectionRange(a,b);},[left,right]);
  let progressClears=0,failCandidate=false,failReview=false,failPreflight=false,blockFailedReview=false,releaseFailedReview,releaseDraft,blockDraft=true;
  await page.route('**/__manual/rpc',async route=>{
    const {action}=route.request().postDataJSON();
    if(action==='agent-progress-clear'){progressClears++;await route.fulfill({json:{output:'{}'}});return;}
    if(action==='agent-progress'){await route.fulfill({json:{output:JSON.stringify({total:1,logs:[{time:'11:55:56',message:progressClears?'AIエージェントの応答を待っています':'Historical operation'}]})}});return;}
    if(action==='draft-propose'&&blockDraft){await new Promise(resolve=>releaseDraft=resolve);releaseDraft=undefined;await route.fulfill({json:{error:'AI生成を中断しました。'}});return;}
    if(action==='agent-cancel'&&releaseDraft){releaseDraft();await route.fulfill({json:{output:'{}'}});return;}
    if(action==='document-review'&&failReview){if(blockFailedReview)await new Promise(resolve=>releaseFailedReview=resolve);await route.fulfill({json:{error:'レビュー接続のテスト失敗'}});return;}
    if(action==='document-review-capabilities'&&failPreflight){await route.fulfill({json:{error:'画像対応のテスト失敗'}});return;}
    if(action==='selection-generate'&&failCandidate){await route.fulfill({status:500,json:{error:'agy failed: invalid structured output'}});return;}
    await route.continue();
  });
  await page.locator('#editor-more summary').click();await page.locator('#generate-draft').click();await page.locator('#progress-cancel').waitFor();assert.equal(await page.locator('#panel-publish').isVisible(),false,'draft progress is not blocked by the output dialog');await page.waitForFunction(()=>document.querySelector('#progress-note').textContent==='AIエージェントの応答を待っています');await page.clock.fastForward(16000);assert.match(await page.locator('#progress-note').textContent(),/API.*応答を待っています/);await page.locator('#progress-dismiss').click();await page.locator('#progress-compact-cancel').waitFor();assert.match(await page.locator('#progress-open').textContent(),/API.*経過/);await workflowEvidence(page,'P12.compact-progress-dismiss-cancel',{},'waiting');await page.locator('#progress-compact-cancel').click();await idle();assert.equal(await editor.inputValue(),original,'cancelled draft preserves the manuscript');assert.equal(await page.locator('#progress-label').textContent(),'AI処理を中断しました');assert.equal(await page.locator('#progress-compact-cancel').isVisible(),false);
  assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),original);await workflowEvidence(page,'P12.compact-progress-dismiss-cancel');
  blockDraft=false;
  const draft=async()=>{await page.locator('#editor-more summary').click();await page.locator('#generate-draft').click();await page.locator('#draft-diff-dialog').waitFor();};
  await draft();assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),original);await workflowEvidence(page,'P12.full-draft-discard',{},'candidate');await page.locator('#draft-diff-dialog').getByRole('button',{name:'破棄',exact:true}).click();assert.equal(await editor.inputValue(),original);
  assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),original);await assert.rejects(readFile(path.join(root,'docs/new.md'),'utf8'));await workflowEvidence(page,'P12.full-draft-discard');
  await draft();await page.locator('#draft-diff-dialog').getByRole('button',{name:'すべて見送り',exact:true}).click();assert.equal(await page.locator('#draft-diff-dialog').getByRole('button',{name:'選んだ変更を反映',exact:true}).isDisabled(),true);await page.locator('#draft-diff-dialog').getByRole('button',{name:'すべて採用',exact:true}).click();await page.locator('[data-draft-enabled="other.md"]').uncheck();await page.locator('[data-draft-enabled="new.md"]').uncheck();await page.locator('[data-draft-page="index.md"] [data-draft-part]').last().uncheck();await page.locator('#draft-diff-dialog').getByRole('button',{name:'選んだ変更を反映',exact:true}).click();await idle();await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('new A'));assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),original.replace('old A','new A'));assert.equal(await readFile(path.join(root,'docs/other.md'),'utf8'),'# Other\n\nOther text\n');await assert.rejects(readFile(path.join(root,'docs/new.md'),'utf8'));
  await workflowEvidence(page,'P12.full-draft-selective-page-part-adoption');
  expandedCorrection=false;await editor.fill(original);await editor.press('Control+s');await idle();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('保存しました'));
  await page.evaluate(({root,original})=>localStorage.setItem(`manual-studio-reader-review:${root}:docs/index.md`,JSON.stringify({expected:original,report:{issues:[{category:'proofreading',severity:'problem',quote:'old A',start:original.indexOf('old A'),end:original.indexOf('old A')+5,message:'Legacy finding',suggestion:'Revise wording',image:''}],images:[],warnings:[]}})),{root,original});
  await page.reload();await idle();await page.getByRole('button',{name:'Markdownソース',exact:true}).click();
  failPreflight=true;await select(0,0);await page.locator('#reader-review').click();await page.getByRole('button',{name:'対応状況を再確認',exact:true}).waitFor();await page.getByRole('textbox',{name:'想定する読者・目的'}).fill('Retained reader purpose');assert.equal(await page.getByRole('button',{name:'レビューを実行',exact:true}).isDisabled(),true);failPreflight=false;await page.getByRole('button',{name:'対応状況を再確認',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#reader-review-options .primary').disabled);assert.equal(await page.getByRole('textbox',{name:'想定する読者・目的'}).inputValue(),'Retained reader purpose');await workflowEvidence(page,'P09.review-preflight-retry',{},'retried');await page.locator('#reader-review-options').getByRole('button',{name:'閉じる',exact:true}).click();
  assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),original);await workflowEvidence(page,'P09.review-preflight-retry');
  await select(original.indexOf('old A'),original.indexOf('old B')+5);await page.locator('#reader-review').click();assert.equal(await page.getByRole('combobox',{name:'レビュー対象'}).inputValue(),'selection');await page.getByRole('button',{name:'レビューを実行',exact:true}).click();await page.locator('#reader-review-results').waitFor();assert.equal(await page.locator('[data-review-category]').count(),2);
  await page.getByRole('combobox',{name:'指摘の分類'}).selectOption('image');assert.equal(await page.locator('[data-review-category]:visible').count(),0);assert.equal(await page.locator('.review-empty').textContent(),'この分類の指摘はありません。');
  await page.getByRole('combobox',{name:'指摘の分類'}).selectOption('proofreading');assert.equal(await page.locator('[data-review-category]:visible').count(),1);
  for(let attempt=0;attempt<2;attempt++){failReview=true;await page.locator('#reader-review').click();await page.getByRole('button',{name:'レビューを実行',exact:true}).click();await idle();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('レビュー接続のテスト失敗'));assert.equal(await page.locator('#reader-review-results').isVisible(),true,'failed rerun preserves the original report');assert.equal(await page.getByRole('combobox',{name:'指摘の分類'}).inputValue(),'proofreading');assert.equal(await page.locator('[data-review-category]').count(),2);await page.locator('#progress-dismiss').click();}failReview=false;
  await page.locator('[data-review-category=proofreading]').getByRole('button',{name:'該当箇所へ',exact:true}).click();assert.equal(await editor.evaluate(e=>e.value.slice(e.selectionStart,e.selectionEnd)),'old A');assert.equal(await page.locator('#reader-review-results').isVisible(),true,'jump retains the review panel');assert.equal(await page.getByRole('combobox',{name:'指摘の分類'}).inputValue(),'proofreading');assert.equal(await page.locator('[data-review-category]').count(),2);await page.locator('[data-review-category=proofreading]').getByRole('button',{name:'該当箇所へ',exact:true}).click();assert.equal(await page.locator('#reader-review-results').isVisible(),true);
  assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),original);await workflowEvidence(page,'P09.selection-review-filter-rerun-jump');
  assert.equal(await page.locator('#reader-review-reopen').count(),0,'no extra review results button');
  assert.equal(await page.locator('[data-review-category=proofreading] .review-replacement').inputValue(),'new A with extra explanation','review includes the concrete replacement');
  const callsBeforeCorrection=calls.length;
  await page.locator('[data-review-category=proofreading]').getByRole('button',{name:'修正案を確認',exact:true}).click();
  await page.locator('#selection-diff-dialog').waitFor();
  assert.equal(await page.locator('#selection-diff-dialog [data-diff-action=retry]').count(),0);
  await page.locator('[data-diff-action=restore]').click();
  assert.equal(await editor.inputValue(),original);assert.equal(await page.locator('#reader-review-results').isVisible(),true,'discarding a correction retains the report');
  assert.equal(await page.getByRole('combobox',{name:'指摘の分類'}).inputValue(),'proofreading');
  await page.locator('[data-review-category=proofreading]').getByRole('button',{name:'修正案を確認',exact:true}).click();
  await page.locator('#selection-diff-dialog').waitFor();await page.locator('[data-diff-action=adopt]').click();await idle();
  assert.equal(calls.length,callsBeforeCorrection,'review correction preview and adoption never launch another AI request');
  await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('new A'));
  await page.waitForFunction(()=>document.querySelectorAll('[data-review-category]').length===1);
  await page.getByRole('combobox',{name:'指摘の分類'}).selectOption('reader');
  await page.locator('[data-review-category=reader]').getByRole('button',{name:'該当箇所へ',exact:true}).click();
  assert.equal(await editor.evaluate(e=>e.value.slice(e.selectionStart,e.selectionEnd)),'old B','accepted correction must retain and re-anchor the next finding');
  assert.equal(await page.locator('#reader-review-results [role=alert]').textContent(),'');
  const corrected=original.replace('old A','new A with extra explanation');await editor.press('Control+s');await page.waitForFunction(()=>document.querySelector('#save-state').dataset.state==='saved');assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),corrected);await workflowEvidence(page,'P09.review-finding-correction-chain');
  expandedCorrection=false;
  await page.locator('#reader-review-results').getByRole('button',{name:'閉じる',exact:true}).click();
  await page.goto(`http://127.0.0.1:5174/?root=${encodeURIComponent(root)}&page=docs/index.md`);
  await page.waitForFunction(()=>/^(docs\/)?index\.md$/.test(document.querySelector('#editor-title').textContent));
  await idle();
  await page.getByRole('button',{name:'Markdownソース',exact:true}).click();
  await idle();
  assert.equal(await page.locator('#reader-review-reopen').count(),0,'no extra results button after reload');
  const callsBeforeReopen=calls.length;
  await page.locator('#reader-review').click();
  await page.locator('#reader-review-options').waitFor();
  assert.equal(await page.getByRole('button',{name:'レビューを実行',exact:true}).isVisible(),true,'review after reload offers a fresh run');
  await page.getByRole('button',{name:'前回の結果を見る',exact:true}).click();
  assert.equal(calls.length,callsBeforeReopen,'previous results reopen only when explicitly requested');
  await page.locator('#reader-review-results').waitFor();
  assert.equal(await page.locator('[data-review-category]').count(),1,'persisted review report reopens with findings');
  assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),corrected);await workflowEvidence(page,'P09.report-reopen-after-reload');
  await page.locator('#reader-review-results').getByRole('button',{name:'閉じる',exact:true}).click();
  assert.equal(await page.locator('#progress-open').isVisible(),true,'progress logs entry preserved across reload');
  await page.locator('#progress-open').click();
  assert.match(await page.locator('#progress-log').textContent(),/レビュー|処理/);await workflowEvidence(page,'P12.progress-log-reopen-after-review',{},'opened');
  await page.locator('#progress-dismiss').click();
  assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),corrected);await workflowEvidence(page,'P12.progress-log-reopen-after-review');
  await page.locator('#reader-review').click();await page.getByRole('button',{name:'前回の結果を見る',exact:true}).click();await page.locator('#reader-review-results').waitFor();
  const callsBeforeDirect=calls.length;
  await page.locator('[data-review-category=reader]').getByRole('button',{name:'この修正案を適用',exact:true}).click();await idle();
  await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('new B'));
  assert.equal(await editor.inputValue(),corrected.replace('old B','new B'));
  assert.equal(calls.length,callsBeforeDirect,'individual application needs no AI');
  await editor.press('Control+z');await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('old B'));
  assert.equal(await editor.inputValue(),corrected,'individual application supports Undo');
  await page.locator('#reader-review-results').getByRole('button',{name:'閉じる',exact:true}).click();
  await editor.fill(original);await editor.press('Control+s');await idle();
  await select(0,0);await page.locator('#reader-review').click();await page.getByRole('button',{name:'レビューを実行',exact:true}).click();
  await page.locator('#reader-review-results').waitFor();
  assert.equal(await page.locator('[data-review-category=image]').getByRole('button',{name:'この修正案を適用',exact:true}).isDisabled(),true,'findings requiring confirmation have no applicable replacement');
  const callsBeforeBatch=calls.length;
  await page.getByRole('combobox',{name:'指摘の分類'}).selectOption('proofreading');
  await editor.fill(original+'manual change');
  await page.getByRole('button',{name:'すべて適用',exact:true}).click();
  assert.match(await page.locator('#reader-review-results [role=alert]').textContent(),/原稿が変更/);
  assert.equal(await editor.inputValue(),original+'manual change','stale batch never writes');
  await editor.press('Control+z');assert.equal(await editor.inputValue(),original);
  await page.getByRole('button',{name:'すべて適用',exact:true}).click();await idle();
  const batchCorrected=original.replace('old A','new A with extra explanation').replace('old B','new B');
  assert.equal(await editor.inputValue(),batchCorrected,'apply all includes findings outside the active category filter');
  assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),batchCorrected);
  assert.equal(calls.length,callsBeforeBatch,'batch application needs no AI');
  assert.equal(await page.getByRole('button',{name:'すべて適用',exact:true}).isDisabled(),true);
  await page.getByRole('combobox',{name:'指摘の分類'}).selectOption('image');
  assert.match(await page.locator('[data-review-category=image] .muted').textContent(),/修正文が返っていません/);
  // Editing an existing report during a failed rerun must survive busy-state restoration.
  failReview=true;blockFailedReview=true;
  await page.locator('#reader-review').click();
  await page.getByRole('button',{name:'レビューを実行',exact:true}).click();
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='true');
  await page.locator('[data-review-category=image] .review-replacement').fill('画像で確認した画面');
  assert.equal(await page.locator('[data-review-category=image]').getByRole('button',{name:'この修正案を適用',exact:true}).isDisabled(),true,'application stays blocked during processing');
  while(!releaseFailedReview)await new Promise(resolve=>setTimeout(resolve,10));
  releaseFailedReview();await idle();failReview=false;blockFailedReview=false;

  assert.equal(await page.locator('[data-review-category=image]').getByRole('button',{name:'この修正案を適用',exact:true}).isEnabled(),true);
  assert.equal(await page.getByRole('button',{name:'すべて適用',exact:true}).isEnabled(),true);
  await editor.press('Control+z');await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('old A'));
  assert.equal(await editor.inputValue(),original,'one Undo reverses the whole batch');
  await page.locator('#reader-review-results').getByRole('button',{name:'閉じる',exact:true}).click();
  await editor.fill(original);await editor.press('Control+s');await idle();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('保存しました'));
  await select(original.indexOf('old A'),original.indexOf('old B')+5);await page.locator('#selection-ai').click();await page.getByRole('textbox',{name:'AIへの指示',exact:true}).fill('校正');await page.getByRole('button',{name:'候補を作成',exact:true}).click();await page.locator('#selection-diff-dialog').waitFor();assert.equal(await page.locator('[data-diff-part]').count(),2);assert.equal(await page.locator('.diff-controls [role=status]').textContent(),'2 / 2件の変更を採用');assert.equal(await page.locator('.diff-same .selection-diff-columns').count(),0);await page.locator('.diff-context summary').first().click();assert.equal(await page.locator('.diff-context').first().getAttribute('open'),'');await page.locator('[data-diff-part]').last().uncheck();assert.equal(await page.locator('.diff-controls [role=status]').textContent(),'1 / 2件の変更を採用');await page.setViewportSize({width:540,height:760});assert.ok(await page.locator('#selection-diff-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1));await page.setViewportSize({width:1440,height:960});failCandidate=true;await page.locator('#selection-diff-dialog textarea').fill('Retry without losing partial choices');await page.locator('[data-diff-action=retry]').click();await page.waitForFunction(()=>document.querySelector('#selection-diff-dialog [role=alert]')?.textContent.includes('前の候補と採用の選択を保持'));assert.equal(await page.locator('.diff-controls [role=status]').textContent(),'1 / 2件の変更を採用');assert.equal(await page.locator('[data-diff-part]').last().isChecked(),false);assert.equal(await page.locator('#selection-diff-dialog textarea').inputValue(),'Retry without losing partial choices');await workflowEvidence(page,'P10.selection-diff-partial-retry-undo-redo',{},'retry-failed');failCandidate=false;await page.locator('[data-diff-action=adopt]').click();await idle();await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('new A'));
  const partial=original.replace('old A','new A');assert.equal(await editor.inputValue(),partial);await editor.press('Control+z');assert.equal(await editor.inputValue(),original);await editor.press('Control+Shift+z');assert.equal(await editor.inputValue(),partial);
  await editor.press('Control+s');await page.waitForFunction(()=>document.querySelector('#save-state').dataset.state==='saved');assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),partial);await workflowEvidence(page,'P10.selection-diff-partial-retry-undo-redo');
  await select(partial.indexOf('後文'),partial.indexOf('後文'));await page.locator('#selection-ai').click();await page.getByRole('textbox',{name:'AIへの指示',exact:true}).fill('新規文章');await page.getByRole('button',{name:'候補を作成',exact:true}).click();await page.locator('#selection-diff-dialog').waitFor();await page.locator('[data-diff-action=adopt]').click();await idle();await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('新しい文章です。'));assert.equal(await editor.inputValue(),partial.replace('後文','新しい文章です。後文'));await workflowEvidence(page,'P10.cursor-position-new-text-undo',{},'inserted');await editor.press('Control+z');assert.equal(await editor.inputValue(),partial);
  await editor.press('Control+s');await page.waitForFunction(()=>document.querySelector('#save-state').dataset.state==='saved');assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),partial);await workflowEvidence(page,'P10.cursor-position-new-text-undo');
  // A pending review must not navigate a different manuscript.
  await select(0,0);delayReview=true;const started=new Promise(resolve=>reviewStarted=resolve);await page.locator('#reader-review').click();await page.getByRole('button',{name:'レビューを実行',exact:true}).click();await started;
  await editor.evaluate(e=>{e.value+='changed';e.dispatchEvent(new InputEvent('input',{bubbles:true}));});releaseReview();delayReview=false;await idle();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('レビューを実行し直してください'));assert.equal(await page.locator('#reader-review-results').count(),0);
  // Cancel while the compatible API is still processing; preserve all text.
  const unchanged=await editor.inputValue();await select(0,0);delayReview=true;const cancelStarted=new Promise(resolve=>reviewStarted=resolve);
  await page.locator('#reader-review').click();await page.getByRole('button',{name:'レビューを実行',exact:true}).click();await cancelStarted;await page.locator('#progress-cancel').click();
  await page.waitForFunction(()=>document.querySelector('#status').classList.contains('error'));releaseReview();delayReview=false;await idle();assert.equal(await editor.inputValue(),unchanged);assert.equal(await page.locator('#reader-review-results').count(),0);
  assert.equal(await page.locator('#progress-label').textContent(),'AI処理を中断しました');
  await page.locator('#progress-dismiss').click();
  assert.ok(progressClears>=4,'each document AI operation clears earlier execution logs');
  assert.doesNotMatch(await page.locator('#progress-log').textContent(),/Historical operation/);
  failCandidate=true;await select(0,0);await page.locator('#selection-ai').click();await page.getByRole('textbox',{name:'AIへの指示',exact:true}).fill('Add text');await page.getByRole('button',{name:'候補を作成',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#progress-log').textContent.includes('失敗: Error: agy failed: invalid structured output'));
  assert.equal(await editor.inputValue(),unchanged,'failed generation preserves the manuscript');await page.getByRole('textbox',{name:'AIへの指示',exact:true}).waitFor();assert.equal(await page.getByRole('textbox',{name:'AIへの指示',exact:true}).inputValue(),'Add text');assert.match(await page.locator('dialog[open] [role=alert]').last().textContent(),/invalid structured output/);failCandidate=false;await page.getByRole('button',{name:'候補を作成',exact:true}).click();await page.locator('#selection-diff-dialog').waitFor();await page.locator('[data-diff-action=restore]').click();assert.equal(await editor.inputValue(),unchanged);if(await page.locator('#progress-dismiss').isVisible())await page.locator('#progress-dismiss').click();
  // Compare this entry against the same saved manuscript/caret as the P03/P04/P11 insertion routes.
  const screenshotInsertionFixture='# Insertion\n\nBefore text.\n\nAfter text.\n';
  await editor.fill(screenshotInsertionFixture);await editor.press('Control+s');await idle();
  await page.waitForFunction(()=>document.querySelector('#save-state').dataset.state==='saved');
  assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),screenshotInsertionFixture,'P04 AI begins with the actual saved shared insertion fixture');
  // Editor capture keeps the source caret and never replaces selected prose.
  let failEditorAnnotation=true,failEditorCapture=false,holdEditorCaptureRefresh=false,captureRefreshStarted,releaseCaptureRefresh;
  const editorShotRequests=[];
  await page.evaluate(()=>{window.__TAURI_INTERNALS__={invoke:async(command)=>{if(['test_launch_application','save_launch_commands','restore_manual_studio'].includes(command))return;throw Error(command);}};});
  await page.route('**/__manual/rpc',async route=>{
    const request=route.request().postDataJSON(),{action}=request;let result;
    if(action.startsWith('screenshot-ai-'))editorShotRequests.push(request);
    if(action==='screenshots-list'&&holdEditorCaptureRefresh){holdEditorCaptureRefresh=false;captureRefreshStarted();await new Promise(resolve=>releaseCaptureRefresh=resolve);await route.continue();return;}
    if(action==='screenshot-ai-capture'&&failEditorCapture){await route.fulfill({json:{error:'Fixture capture transport failure'}});return;}
    if(action==='list-accessible-windows')result=[{app:'Fixture',title:'Main',query:'Fixture'}];
    else if(action==='screenshot-ai-annotate'&&failEditorAnnotation){await route.fulfill({json:{error:'注釈する画面要素を特定できませんでした。'}});return;}
    else if(action==='screenshot-ai-plan')result={summary:'撮影して番号を振る',recipe};
    else if(action==='screenshot-ai-capture')result=await rpc('screenshots-register',{json:{source:`data:image/png;base64,${png.toString('base64')}`,recipe,adopt:false}});
    else {await route.continue();return;}
    await route.fulfill({json:{output:JSON.stringify(result)}});
  });
  const editorCapture=async(expectPreview=true)=>{try{await page.locator('#editor-screenshot-ai').click();await page.getByRole('button',{name:'AIに撮影を指示',exact:true}).click();assert.equal(await page.getByRole('button',{name:'指示から作成',exact:true}).isDisabled(),true,'empty screenshot instructions cannot start');await page.locator('#screenshot-ai-instruction textarea').fill('FixtureのSaveに番号を振って');await page.getByRole('button',{name:'指示から作成',exact:true}).click();await page.getByRole('button',{name:'登録して起動',exact:true}).click();await page.getByRole('button',{name:'このウィンドウで手順を作成',exact:true}).click();await page.getByRole('button',{name:'この手順で撮影',exact:true}).click();if(failEditorCapture){await page.locator('#screenshot-ai-retry').waitFor();assert.equal(await editor.inputValue(),beforeScreenshot);const ids=(await rpc('screenshots-list')).items.map(item=>item.id);assert.deepEqual(ids.sort(),[...priorScreenshotIds,cancelledScreenshot[0].id].sort());failEditorCapture=false;await page.getByRole('button',{name:'撮影だけ再試行',exact:true}).click();}if(failEditorAnnotation)await page.getByRole('button',{name:'注釈なしの原本を使う',exact:true}).click();if(expectPreview)await page.locator('#editor-screenshot-preview').waitFor();}catch(error){console.error('Editor capture status:',await page.locator('#status').textContent());console.error('Progress:',(await page.locator('#progress-log').textContent()).slice(-1500));throw error;}};
  const beforeScreenshot=await editor.inputValue(),caret=beforeScreenshot.indexOf('After');
  assert.equal(beforeScreenshot,screenshotInsertionFixture);assert.equal(caret,screenshotInsertionFixture.indexOf('After'));
  const priorScreenshotIds=new Set((await rpc('screenshots-list')).items.map(item=>item.id));
  await select(caret,caret+5);await editorCapture();assert.match(await page.locator('#editor-screenshot-preview [role="alert"]').textContent(),/番号・注釈なしの撮影原本/);await page.locator('#editor-screenshot-preview').getByRole('button',{name:'閉じる',exact:true}).click();assert.equal(await editor.inputValue(),beforeScreenshot);assert.equal(await editor.evaluate(node=>node.selectionStart),caret);failEditorAnnotation=false;
  const cancelledScreenshot=(await rpc('screenshots-list')).items.filter(item=>!priorScreenshotIds.has(item.id));assert.equal(cancelledScreenshot.length,1,'cancelled preview retains one captured original');
  failEditorCapture=true;const beforeRetryRequests=editorShotRequests.length;await select(caret,caret+5);await editorCapture();const retryRequests=editorShotRequests.slice(beforeRetryRequests);assert.equal(retryRequests.filter(item=>item.action==='screenshot-ai-plan').length,1);const captureRetries=retryRequests.filter(item=>item.action==='screenshot-ai-capture');assert.equal(captureRetries.length,2);assert.deepEqual(captureRetries[0].options.json,captureRetries[1].options.json);await page.screenshot({path:`${resultDirectory}/preview.png`});await page.getByRole('button',{name:'この位置に挿入',exact:true}).click();await idle();await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('screenshots/'));
  const withScreenshot=await editor.inputValue();assert.ok(withScreenshot.indexOf('screenshots/')<withScreenshot.indexOf('After'));assert.ok(withScreenshot.startsWith(beforeScreenshot.slice(0,caret)));assert.ok(withScreenshot.includes('After text.'),'AI capture insertion preserves the selected prose');assert.ok(withScreenshot.endsWith(beforeScreenshot.slice(caret)));assert.equal((withScreenshot.match(/<!-- screenshot:ref id=/g)||[]).length,1,'one captured screenshot reference inserted');await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),withScreenshot,'AI screenshot reference saved to actual manuscript');
  const insertedScreenshotId=withScreenshot.match(/<!-- screenshot:ref id=([^ >]+)/)?.[1];assert.ok(insertedScreenshotId);assert.notEqual(insertedScreenshotId,cancelledScreenshot[0].id);const insertedOriginal=await rpc('screenshots-image',{id:insertedScreenshotId,json:{original:true}});const insertedOriginalHash=fingerprint(Buffer.from(insertedOriginal.data.split(',')[1],'base64'));
  if(await page.locator('.milkdown-top-bar').isVisible())await page.locator('.milkdown-top-bar').getByRole('button',{name:'元に戻す',exact:true}).click();else await editor.press('Control+z');assert.equal(await editor.inputValue(),beforeScreenshot);await editor.press('Control+s');await idle();const savedAfterUndo=await readFile(path.join(root,'docs/index.md'),'utf8');assert.equal(savedAfterUndo,beforeScreenshot,'Undo and save restore the actual manuscript');assert.equal(fingerprint(Buffer.from((await rpc('screenshots-image',{id:insertedScreenshotId,json:{original:true}})).data.split(',')[1],'base64')),insertedOriginalHash);
  // Hold the real library refresh after capture to navigate while the nonmodal operation completes.
  const beforeStaleIds=new Set((await rpc('screenshots-list')).items.map(item=>item.id));
  const refreshWaiting=new Promise(resolve=>captureRefreshStarted=resolve);
  holdEditorCaptureRefresh=true;await select(caret,caret);const staleCapture=editorCapture(false);await refreshWaiting;
  await page.locator('#tree-search').fill('other.md');await page.locator('[data-page="docs/other.md"]').click();await page.locator('#tree-search').fill('');await idle();
  const otherBefore=await editor.inputValue();assert.equal(otherBefore,'# Other\n\nOther text\n');releaseCaptureRefresh();await staleCapture;
  // No preview may be offered after the source document's opening session changed.
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('原稿が変更されたため挿入していません'));
  assert.equal(await page.locator('#editor-screenshot-preview').count(),0);assert.equal(await editor.inputValue(),otherBefore);assert.equal(await readFile(path.join(root,'docs/other.md'),'utf8'),otherBefore);assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),beforeScreenshot);
  const staleScreenshot=(await rpc('screenshots-list')).items.filter(item=>!beforeStaleIds.has(item.id));assert.equal(staleScreenshot.length,1);
  await page.locator('[data-document-page="docs/index.md"], [data-document-page="index.md"]').click();await idle();assert.equal(await editor.inputValue(),beforeScreenshot);assert.equal(await editor.evaluate(node=>node.selectionStart),caret);
  await select(caret,caret);await editorCapture();await editor.evaluate(el=>{el.value+='edited';el.dispatchEvent(new InputEvent('input',{bubbles:true}));});await page.getByRole('button',{name:'この位置に挿入',exact:true}).click();await idle();assert.equal(await editor.inputValue(),beforeScreenshot+'edited');
  const beforeExisting=await editor.inputValue();const sourceToggle=page.locator('.column-label button');if((await sourceToggle.textContent())==='Markdownソース')await sourceToggle.click();await select(0,0);await page.locator('#editor-screenshot-ai').click();await page.getByRole('button',{name:'撮影済み画像を選ぶ',exact:true}).click();await page.locator('#editor-screenshot-existing [data-screenshot-id]').first().click();await page.getByRole('button',{name:'この位置に挿入',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('screenshots/'));await idle();assert.match(await editor.inputValue(),/screenshots\//);assert.ok((await editor.inputValue()).endsWith(beforeExisting));await editor.press('Control+z');assert.equal(await editor.inputValue(),beforeExisting);
  // Exercise exact rich selections and cursor insertion against real Milkdown.
  await page.route('**/rich-ai-test',route=>route.fulfill({contentType:'text/html',body:`<meta charset="UTF-8"><div><div class="column-label"></div><textarea id="rich-source"></textarea></div><script type="module">
    import {setupMilkdownEditor} from '/src/milkdownEditor.ts';
    window.richSource=document.querySelector('textarea');richSource.value='前文 **old A** 後文\\n\\nold B\\n';
    window.rich=setupMilkdownEditor(richSource,message=>{throw Error(message)},async source=>source);
  </script>`}));
  await page.goto('http://127.0.0.1:5174/rich-ai-test');await page.locator('.ProseMirror').waitFor();
  await page.evaluate(()=>{const bold=document.querySelector('.ProseMirror strong').firstChild;const range=document.createRange();range.setStart(bold,0);range.setEnd(bold,5);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));});
  await page.waitForFunction(()=>window.rich.captureState().selection.from!==window.rich.captureState().selection.to);
  await page.evaluate(()=>{const draft=rich.captureSelectionEdit(true);if(draft.text!=='')throw Error('Insertion must not consume selected text');draft.apply('![capture](assets/sample.png)');});assert.match(await page.locator('#rich-source').inputValue(),/old A/);assert.match(await page.locator('#rich-source').inputValue(),/assets\/sample.png/);await page.locator('.milkdown-top-bar').getByRole('button',{name:'元に戻す',exact:true}).click();
  await page.evaluate(()=>{window.richDraft=rich.captureSelectionEdit();richDraft.apply(richDraft.text.replace('old A','new A'));});
  await page.waitForFunction(()=>document.querySelector('#rich-source').value.includes('new A'));assert.match(await page.locator('#rich-source').inputValue(),/前文 \*\*new A\*\* 後文/);
  await page.locator('.milkdown-top-bar').getByRole('button',{name:'元に戻す',exact:true}).click();assert.match(await page.locator('#rich-source').inputValue(),/前文 \*\*old A\*\* 後文/);
  await page.locator('.ProseMirror p').filter({hasText:'old B'}).click();await page.keyboard.press('End');
  await page.evaluate(()=>{window.richDraft=rich.captureSelectionEdit();if(richDraft.text!=='')throw Error('Expected empty caret');richDraft.apply('新しい文章');});assert.match(await page.locator('#rich-source').inputValue(),/old B新しい文章/);
  await page.locator('.milkdown-top-bar').getByRole('button',{name:'元に戻す',exact:true}).click();assert.doesNotMatch(await page.locator('#rich-source').inputValue(),/新しい文章/);
  await page.evaluate(()=>{const paragraphs=document.querySelectorAll('.ProseMirror p');const range=document.createRange();range.setStart(paragraphs[0].firstChild,0);range.setEnd(paragraphs[1].firstChild,5);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));});
  await page.waitForFunction(()=>window.rich.captureState().selection.from!==window.rich.captureState().selection.to);
  const beforeRich=await page.locator('#rich-source').inputValue();await page.evaluate(()=>{const draft=rich.captureSelectionEdit();draft.apply(draft.text.replace('old A','new A').replace('old B','new B'));});
  assert.match(await page.locator('#rich-source').inputValue(),/前文 \*\*new A\*\* 後文\n\nnew B/);await page.locator('.milkdown-top-bar').getByRole('button',{name:'元に戻す',exact:true}).click();assert.equal(await page.locator('#rich-source').inputValue(),beforeRich);
  // Screenshot references are whole blocks: inserting at a heading start must preserve its Markdown and undo as one edit.
  await page.evaluate(()=>{window.richBeforeBlock='# Heading\n\nBody\n';rich.replaceMarkdownDocument(richBeforeBlock,richSource.value);const heading=document.querySelector('.ProseMirror h1').firstChild;const range=document.createRange();range.setStart(heading,0);range.collapse(true);getSelection().removeAllRanges();getSelection().addRange(range);document.dispatchEvent(new Event('selectionchange'));});
  await page.waitForFunction(()=>rich.captureState().selection.from===1);
  await page.evaluate(()=>rich.captureSelectionEdit(true).apply('<!-- screenshot:ref id=shot-test -->\n\n![capture](assets/sample.png)\n\n<!-- /screenshot:ref -->\n',true));
  const blockInserted=await page.locator('#rich-source').inputValue();assert.match(blockInserted,/(^|\n)# Heading\n/);assert.match(blockInserted,/(^|\n)<!-- screenshot:ref/);assert.doesNotMatch(blockInserted,/# <!--|-->Heading/);assert.doesNotMatch(blockInserted,/(^|\n)#\n/,'inserting at a heading start does not leave an empty heading');
  // Run the screenshot UI against real proposal/annotation APIs; OS calls and
  // screen capture are mocked because this browser has no native desktop bridge.
  const native=await browser.newPage();await native.addInitScript(()=>{window.nativeCalls=[];window.appProfiles=[{id:'existing',name:'Fixture app',program:'/usr/bin/true',args:[]}];window.__TAURI_INTERNALS__={invoke:async(command,args)=>{nativeCalls.push({command,args});if(command==='save_launch_commands'){appProfiles=args.commands;return;}if(command==='test_launch_application')return window.launchIdentity;if(command==='restore_manual_studio')return;if(command==='choose_application')return '/usr/bin/true';throw Error(command);}};});
  await native.route('**/screenshot-ai-test',route=>route.fulfill({contentType:'text/html',body:`<meta charset="UTF-8"><button id="screenshot-ai-create">撮影指示</button><button id="existing-annotate">画像へAI注釈</button><p id="result"></p><script type="module">
    import {setupScreenshotAi} from '/src/screenshotAi.ts';
    const root=${JSON.stringify(root)},shot=${JSON.stringify(shot.screenshot.id)},recipe=${JSON.stringify(recipe)};
    window.shotActions=[];window.shotRequests=[];window.failAnnotation=false;window.failStage='';window.currentRoot=root;window.refreshCount=0;window.windowPolls=0;
    const controller=setupScreenshotAi({root:()=>window.currentRoot,applications:()=>appProfiles,work:async run=>run(),reloadApplications:async()=>{},refresh:async()=>refreshCount++,report:(message)=>document.querySelector('#result').textContent=message,request:async(action,json)=>{
      shotActions.push(action);shotRequests.push({action,json});if(action===window.failStage)throw Error('stage failure');
      if(action==='list-accessible-windows'){if(window.launchIdentity){windowPolls++;return JSON.stringify([{app:'manual-studio',title:'Munin Manual Studio',pid:111,program:'/usr/bin/true',query:'pid:111:Munin Manual Studio'},...(windowPolls<3?[]:[{app:'manual-studio',title:'Munin Manual Studio',pid:222,program:'/usr/bin/true',query:'pid:222:Munin Manual Studio'},{app:'manual-studio',title:'Munin Manual Studio',pid:333,program:'/usr/bin/true',query:'pid:333:Munin Manual Studio'}])]);}return JSON.stringify([{app:'Fixture',title:'Main',query:'app:Fixture::Main'}]);}
      if(action==='screenshot-ai-plan')return JSON.stringify({summary:'撮影して番号を振る',recipe});
      if(action==='screenshot-ai-capture')return JSON.stringify({screenshot:{id:shot}});
      if(action==='screenshot-ai-annotate'&&failAnnotation)throw Error('metadata unavailable');
      const res=await fetch('/__manual/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({root,action,options:{json,api_key:'fixture-key'}})});const result=await res.json();if(result.error)throw Error(result.error);return result.output;
    }});document.querySelector('#existing-annotate').onclick=()=>controller.annotate(shot);document.querySelector('#screenshot-ai-create').onclick=()=>{window.flowFinished=false;void controller.create().finally(()=>window.flowFinished=true);};
  </script>`}));
  const screenshotFlow=async()=>{await native.locator('#screenshot-ai-create').click();await native.locator('#screenshot-ai-instruction textarea').fill('Fixtureのツールバーに番号を振って');await native.getByRole('combobox',{name:'撮影するアプリ',exact:true}).selectOption('new');await native.getByRole('button',{name:'指示から作成',exact:true}).click();await native.locator('#screenshot-ai-application').waitFor();assert.equal(await native.getByRole('textbox',{name:'起動引数（1行に1つ）',exact:true}).inputValue(),'--workspace\ndemo project\n--mode\ndocs');await native.getByRole('textbox',{name:/^作業フォルダ（省略時はプロジェクト）/}).fill('/tmp/fixture workspace');await native.getByRole('button',{name:'AIで起動設定を補完',exact:true}).click();await native.waitForFunction(()=>document.querySelector('#screenshot-ai-application .muted').textContent.includes('補完しました'));await native.getByRole('button',{name:'登録して起動',exact:true}).click();await native.getByRole('button',{name:'このウィンドウで手順を作成',exact:true}).click();await native.getByRole('button',{name:'この手順で撮影',exact:true}).click();};
  await native.goto('http://127.0.0.1:5174/screenshot-ai-test');await screenshotFlow();await native.waitForFunction(()=>document.querySelector('#result').textContent.includes('AI注釈の候補を保存'));
  assert.equal(await native.evaluate(()=>appProfiles.length),1);assert.equal(await native.evaluate(()=>appProfiles[0].id),'existing');assert.deepEqual(await native.evaluate(()=>nativeCalls.map(c=>c.command)),['test_launch_application','save_launch_commands','restore_manual_studio','restore_manual_studio','restore_manual_studio','restore_manual_studio']);assert.deepEqual(await native.evaluate(()=>nativeCalls[0].args.args),['--workspace','demo project','--mode','docs']);
  assert.equal(await native.evaluate(()=>appProfiles[0].workingDirectory),'/tmp/fixture workspace');assert.equal(await native.evaluate(()=>nativeCalls[0].args.workingDirectory),'/tmp/fixture workspace');
  const registrationCalls=await native.evaluate(()=>shotActions.filter(action=>action==='screenshot-ai-application').length);const savedProfiles=await native.evaluate(()=>nativeCalls.filter(call=>call.command==='save_launch_commands').length);const beforeSecondRefresh=await native.evaluate(()=>refreshCount);await native.locator('#screenshot-ai-create').click();await native.locator('#screenshot-ai-instruction textarea').fill('登録したFixtureを撮影');await native.getByRole('button',{name:'指示から作成',exact:true}).click();await native.getByRole('button',{name:'このウィンドウで手順を作成',exact:true}).click();await native.getByRole('button',{name:'この手順で撮影',exact:true}).click();await native.waitForFunction(count=>refreshCount>=count+3,beforeSecondRefresh);assert.equal(await native.evaluate(()=>shotActions.filter(action=>action==='screenshot-ai-application').length),registrationCalls);assert.equal(await native.evaluate(()=>nativeCalls.filter(call=>call.command==='save_launch_commands').length),savedProfiles);
  // The launched Munin instance appears late and shares its title and executable with the host and another instance.
  const beforeThirdRefresh=await native.evaluate(()=>refreshCount);await native.evaluate(()=>{window.launchIdentity={pid:222,host_pid:111,program:'/usr/bin/true'};});
  await native.locator('#screenshot-ai-create').click();await native.locator('#screenshot-ai-instruction textarea').fill('Muninのトップ画面を撮影');await native.getByRole('button',{name:'指示から作成',exact:true}).click();await native.locator('#screenshot-ai-plan').waitFor();assert.equal(await native.getByRole('combobox',{name:'撮影ウィンドウ'}).count(),0);assert.equal(await native.evaluate(()=>windowPolls),3);await native.getByRole('button',{name:'この手順で撮影',exact:true}).click();await native.waitForFunction(count=>refreshCount>=count+3,beforeThirdRefresh);
  assert.equal(await native.evaluate(()=>shotRequests.filter(r=>r.action==='screenshot-ai-plan').at(-1).json.window),'pid:222:Munin Manual Studio');assert.equal(await native.evaluate(()=>shotRequests.filter(r=>r.action==='screenshot-ai-capture').at(-1).json.window),'pid:222:Munin Manual Studio');
  await native.evaluate(()=>{window.launchIdentity=undefined;});
  const stageCounts=()=>native.evaluate(()=>Object.fromEntries(['screenshot-ai-application','screenshot-ai-plan','screenshot-ai-capture'].map(action=>[action,shotActions.filter(value=>value===action).length])));
  const startRegistered=async()=>{await native.locator('#screenshot-ai-create').click();await native.locator('#screenshot-ai-instruction textarea').fill('登録したFixtureを撮影');await native.getByRole('button',{name:'指示から作成',exact:true}).click();await native.getByRole('button',{name:'このウィンドウで手順を作成',exact:true}).click();};
  await native.evaluate(()=>window.failStage='screenshot-ai-plan');await startRegistered();await native.locator('#screenshot-ai-retry').waitFor();const beforePlanRetry=await stageCounts();await native.evaluate(()=>window.failStage='');await native.getByRole('button',{name:'撮影手順作成だけ再試行',exact:true}).click();await native.locator('#screenshot-ai-plan').waitFor();const afterPlanRetry=await stageCounts();assert.equal(afterPlanRetry['screenshot-ai-application'],beforePlanRetry['screenshot-ai-application']);assert.equal(afterPlanRetry['screenshot-ai-plan'],beforePlanRetry['screenshot-ai-plan']+1);
  await native.evaluate(()=>window.failStage='screenshot-ai-capture');await native.getByRole('button',{name:'この手順で撮影',exact:true}).click();await native.locator('#screenshot-ai-retry').waitFor();const beforeCaptureRetry=await stageCounts();const refreshBefore=await native.evaluate(()=>refreshCount);await native.evaluate(()=>window.failStage='');await native.getByRole('button',{name:'撮影だけ再試行',exact:true}).click();await native.waitForFunction(count=>refreshCount>=count+3,refreshBefore);const afterCaptureRetry=await stageCounts();assert.equal(afterCaptureRetry['screenshot-ai-plan'],beforeCaptureRetry['screenshot-ai-plan']);assert.equal(afterCaptureRetry['screenshot-ai-capture'],beforeCaptureRetry['screenshot-ai-capture']+1);
  await native.evaluate(()=>window.failStage='screenshot-ai-plan');await startRegistered();await native.locator('#screenshot-ai-retry').waitFor();const beforeSwitch=await stageCounts();await native.evaluate(()=>{window.originalRoot=window.currentRoot;window.currentRoot='other-project';});await native.getByRole('button',{name:'撮影手順作成だけ再試行',exact:true}).click();await native.waitForFunction(()=>window.flowFinished===true);assert.deepEqual(await stageCounts(),beforeSwitch);await native.evaluate(()=>{window.currentRoot=window.originalRoot;window.failStage='';});
  await native.evaluate(()=>failAnnotation=true);await screenshotFlow();await native.locator('#screenshot-ai-retry').waitFor();const captureCount=await native.evaluate(()=>shotActions.filter(action=>action==='screenshot-ai-capture').length);const beforeAnnotationRetry=await native.evaluate(()=>refreshCount);await native.evaluate(()=>failAnnotation=false);await native.getByRole('button',{name:'注釈だけ再試行',exact:true}).click();await native.waitForFunction(count=>refreshCount>=count+2,beforeAnnotationRetry);assert.equal(await native.evaluate(()=>shotActions.filter(action=>action==='screenshot-ai-capture').length),captureCount);
  await native.evaluate(()=>failAnnotation=true);await screenshotFlow();await native.getByRole('button',{name:'注釈なしの原本を使う',exact:true}).click();await native.waitForFunction(()=>document.querySelector('#result').textContent.includes('撮影原本と再撮影手順は保存'));
  const beforeExistingAnnotation=await stageCounts();await native.locator('#existing-annotate').click();await native.locator('#screenshot-ai-instruction textarea').fill('既存画像のSaveに番号を振って');await native.getByRole('button',{name:'指示から作成',exact:true}).click();await native.locator('#screenshot-ai-retry').waitFor();const previousExistingRefresh=await native.evaluate(()=>refreshCount);await native.evaluate(()=>failAnnotation=false);await native.getByRole('button',{name:'注釈だけ再試行',exact:true}).click();await native.waitForFunction(count=>refreshCount>count,previousExistingRefresh);assert.deepEqual(await stageCounts(),beforeExistingAnnotation);const existingInstructions=await native.evaluate(()=>shotRequests.filter(request=>request.action==='screenshot-ai-annotate').slice(-2).map(request=>request.json.instruction));assert.deepEqual(existingInstructions,['既存画像のSaveに番号を振って','既存画像のSaveに番号を振って']);
  assert.ok((await rpc('screenshots-image',{id:shot.screenshot.id,json:{original:true}})).data);await native.close();
  assert.deepEqual(errors,[]);
  const proof={initial:beforeScreenshot,cursor:caret,cancelledScreenshotId:cancelledScreenshot[0].id,insertedScreenshotId,insertedOriginalHash,inserted:withScreenshot,savedAfterUndo,captureRetryRequests:captureRetries.map(request=>request.options.json),staleScreenshotId:staleScreenshot[0].id,otherManuscriptAfterLateCapture:otherBefore,steps:['choose AI capture from the editor selection','cancel the first captured preview and preserve one backend screenshot','fail capture transport and retry only capture with the identical retained instruction/recipe','repeat at the original cursor without replacing selected prose','insert one captured screenshot reference and save the actual manuscript','Undo, save original manuscript, retain the captured PNG','hold real post-capture library refresh, navigate through actual document tree to another manuscript, reject stale insertion and retain both files and captured image','return through original document tab and verify original cursor']};
  await writeFile(`${resultDirectory}/storage-proof.json`,JSON.stringify(proof,null,2));
  const artifacts=await Promise.all(['preview.png','storage-proof.json'].map(async name=>({path:name,sha256:fingerprint(await readFile(`${resultDirectory}/${name}`))})));
  const registry=JSON.parse(await readFile('scripts/fixtures/manual-studio-ui-inventory.json','utf8'));
  const testCase=registry.cases.find(item=>item.id==='P04.editor-ai');assert.ok(testCase);
  const results=testCase.entryPoints.map(entryPoint=>({caseId:testCase.id,entryPoint,type:'real-backend',status:'passed',steps:proof.steps,assertions:{visible:true,stored:true,preserved:true,returnTarget:true},artifacts}));
  const completed=await finishVerification(verificationStart);
  await writeFile(`${workflowDirectory}/result.json`,JSON.stringify({...completed,type:'browser-mock',scope:'explicit source selection/review/draft/progress UI scenarios; deterministic local AI, transport/progress mocks, actual manuscript assertions; no provider, native or all-entry proof',records:workflowRecords,results:workflowResults},null,2));
  const build=JSON.parse(await readFile('ui-coverage-results/build.json','utf8'));
  if(['sourceHash','buildHash','os'].every(key=>build[key]===completed[key])){
    await writeFile(`${resultDirectory}/result.json`,JSON.stringify({...completed,type:'real-backend',scope:'deterministic local AI service and routed screenshot plan/capture; actual backend screenshot registration, annotation, reference, manuscript save and Undo; no real OS capture or external AI provider proof',results},null,2));
  }else console.log('Editor AI screenshot evidence withheld: verification build stamp is stale.');
  console.log('AI assistance passed: project-root CLI instructions and read-only draft generation, candidate-only draft/discard/selective adoption, collapsed waiting/cancellation, image preflight, failed-stage retry without repeating capture/registration, existing-image instruction retention, real image request/auth, selected UTF-16 anchors, unsupported-image fallback, stale revision, review filters/jump/fix, selective Diff, source/rich insertion, editor screenshot preview/cancel/cursor/Undo/stale protection, Undo/Redo, stale response, raw screenshot/recipe persistence, native registration flow and annotation-failure fallback.');
}finally{releaseReview?.();await browser?.close();vite?.kill();await new Promise(resolve=>ai.close(resolve));await rm(root,{recursive:true,force:true});}
