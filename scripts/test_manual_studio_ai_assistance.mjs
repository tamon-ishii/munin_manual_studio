import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {chromium} from 'playwright-core';
const exec=promisify(execFile),root=await mkdtemp(path.join(tmpdir(),'munin-assistance-'));
let browser,vite,denyImages=false,delayReview=false,reviewStarted,releaseReview;
const calls=[];
function chunk(type,data){const name=Buffer.from(type),payload=Buffer.concat([name,data]);let crc=0xffffffff;for(const byte of payload){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const header=Buffer.alloc(4),tail=Buffer.alloc(4);header.writeUInt32BE(data.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([header,payload,tail]);}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(100,0);ihdr.writeUInt32BE(60,4);ihdr[8]=8;ihdr[9]=6;
const pixels=Buffer.alloc(60*(1+100*4),255);for(let row=0;row<60;row++)pixels[row*(1+100*4)]=0;
const ui=[{role:'button',name:'Save',x:2,y:3,width:10,height:8}];
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('tEXt',Buffer.from('markits:ui_elements\0'+JSON.stringify(ui))),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);

const ai=createServer(async(req,res)=>{try{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),user=body.messages.at(-1).content;
  const prompt=typeof user==='string'?user:user.find(p=>p.type==='text').text;
  const input=JSON.parse(prompt.split('Input JSON: ')[1].split('\nImage attachments')[0].split('\n\nRespond with')[0]);calls.push({prompt,input,user,key:req.headers.authorization});
  if(denyImages&&Array.isArray(user)){res.writeHead(400);res.end('image input unavailable');return;}
  let result;
  if(prompt.startsWith('Review')){
    if(delayReview){reviewStarted?.();await new Promise(resolve=>releaseReview=resolve);}
    const issues=[];if(input.document.includes('old A'))issues.push({category:'proofreading',severity:'problem',quote:'old A',occurrence:1,message:'用語を校正',suggestion:'new A',image:''});
    if(input.document.includes('old B'))issues.push({category:'reader',severity:'suggestion',quote:'old B',occurrence:1,message:'説明が曖昧',suggestion:'new B',image:''});
    const images=Array.isArray(user)?input.images.filter(i=>i.status==='submitted').map(i=>i.path):[];
    if(images.length&&input.document.includes('画面'))issues.push({category:'image',severity:'problem',quote:'画面',occurrence:1,message:'ボタン説明が画像と異なる',suggestion:'画像を確認して説明を修正',image:images[0]});
    result={issues,checked_images:images};
  }else if(prompt.startsWith('Create or revise'))result={content:input.mode==='insert new text'?'新しい文章です。':input.selected.replaceAll('old A','new A').replaceAll('old B','new B')};
  else if(prompt.startsWith('Choose the target')){assert.ok(input.launch_context.some(file=>file.path==='README.md'&&file.content.includes('--workspace')));assert.ok(input.executable_candidates.some(candidate=>candidate.name==='fixture-app'));result={name:'Fixture app',program:input.selected_application?.program||'/usr/bin/true',args:['--workspace','demo project','--mode','docs']};}
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
  const report=await rpc('document-review',{page:doc.page,json:{revision:doc.revision,reader:'初心者'}});
  assert.equal(report.images.length,1);assert.equal(report.images[0].status,'checked');assert.equal(report.issues.length,3);assert.ok(Array.isArray(calls.at(-1).user));assert.equal(calls.at(-1).key,'Bearer fixture-key');
  const start=original.indexOf('old B'),end=start+5;
  const selected=await rpc('document-review',{page:doc.page,json:{revision:doc.revision,range:{start,end}}});assert.equal(selected.issues.length,1);assert.equal(selected.issues[0].start,start);assert.equal(selected.images.length,0);
  denyImages=true;const fallback=await rpc('document-review',{page:doc.page,json:{revision:doc.revision}});assert.equal(fallback.images[0].status,'unverified');assert.equal(fallback.issues.filter(i=>i.category==='image').length,0);assert.equal(fallback.warnings.length,1);denyImages=false;
  await assert.rejects(rpc('document-review',{page:doc.page,json:{revision:'old'}}),/更新/);assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),original);
  const app=await rpc('screenshot-ai-application',{json:{instruction:'Fixture appを撮影',applications:[]}});assert.equal(app.available,true);assert.equal(app.program,"/usr/bin/true");assert.deepEqual(app.args,['--workspace','demo project','--mode','docs']);
  const recipe={version:1,platform:'desktop',window:'Fixture',steps:[{launch:{program:'/usr/bin/true',args:[]}},{window:'Fixture'},{screenshot:{task:'ai-capture'}}]};
  const shot=await rpc('screenshots-register',{json:{source:`data:image/png;base64,${png.toString('base64')}`,recipe,adopt:false}});
  const annotated=await rpc('screenshot-ai-annotate',{json:{id:shot.screenshot.id,instruction:'Saveに番号1を振って'}});
  assert.equal(annotated.screenshot.edits.length,2);assert.equal(annotated.screenshot.adopted,null);assert.deepEqual(annotated.screenshot.recipe,recipe);assert.deepEqual(annotated.screenshot.edits.at(-1).scene.annotations[0].target,[2,3,10,8]);
  await rpc('screenshots-change',{id:shot.screenshot.id,json:{adopt:annotated.revision}});
  const diagnostic=await rpc('screenshots-diagnose');assert.equal(diagnostic.items.find(item=>item.id===shot.screenshot.id).status,'ready');
  const rawShot=await rpc('screenshots-image',{id:shot.screenshot.id,json:{original:true}});assert.equal(rawShot.data,`data:image/png;base64,${png.toString('base64')}`);
  vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','apps/manual-studio/vite.config.ts'],{stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:5174')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:960}});const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack);});
  await page.goto(`http://127.0.0.1:5174/?root=${encodeURIComponent(root)}&page=docs/index.md`);try{await page.waitForFunction(()=>/^(docs\/)?index\.md$/.test(document.querySelector('#editor-title').textContent));}catch(e){console.log(await page.locator('#status').textContent());throw e;}
  const idle=()=>page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');await idle();await page.getByRole('button',{name:'Markdownソース',exact:true}).click();
  const editor=page.locator('#markdown-editor');const select=async(left,right)=>editor.evaluate((e,[a,b])=>{e.focus();e.setSelectionRange(a,b);},[left,right]);
  await select(original.indexOf('old A'),original.indexOf('old B')+5);await page.locator('#reader-review').click();assert.equal(await page.getByRole('combobox',{name:'レビュー対象'}).inputValue(),'selection');await page.getByRole('button',{name:'レビューを実行',exact:true}).click();await page.locator('#reader-review-results').waitFor();assert.equal(await page.locator('[data-review-category]').count(),2);
  await page.getByRole('combobox',{name:'指摘の分類'}).selectOption('image');assert.equal(await page.locator('[data-review-category]:visible').count(),0);assert.equal(await page.locator('.review-empty').textContent(),'この分類の指摘はありません。');
  await page.getByRole('combobox',{name:'指摘の分類'}).selectOption('proofreading');assert.equal(await page.locator('[data-review-category]:visible').count(),1);
  await page.locator('[data-review-category=proofreading]').getByRole('button',{name:'該当箇所へ',exact:true}).click();assert.equal(await editor.evaluate(e=>e.value.slice(e.selectionStart,e.selectionEnd)),'old A');await page.locator('#reader-review-reopen').click();
  await page.locator('[data-review-category=proofreading]').getByRole('button',{name:'修正案を作成',exact:true}).click();assert.match(await page.getByRole('textbox',{name:'AIへの指示',exact:true}).inputValue(),/用語を校正/);await page.getByRole('button',{name:'候補を作成',exact:true}).click();await page.locator('#selection-diff-dialog').waitFor();await page.locator('[data-diff-action=restore]').click();assert.equal(await editor.inputValue(),original);
  await select(original.indexOf('old A'),original.indexOf('old B')+5);await page.locator('#selection-ai').click();await page.getByRole('textbox',{name:'AIへの指示',exact:true}).fill('校正');await page.getByRole('button',{name:'候補を作成',exact:true}).click();await page.locator('#selection-diff-dialog').waitFor();assert.equal(await page.locator('[data-diff-part]').count(),2);assert.equal(await page.locator('.diff-controls [role=status]').textContent(),'2 / 2件の変更を採用');assert.equal(await page.locator('.diff-same .selection-diff-columns').count(),0);await page.locator('.diff-context summary').first().click();assert.equal(await page.locator('.diff-context').first().getAttribute('open'),'');await page.locator('[data-diff-part]').last().uncheck();assert.equal(await page.locator('.diff-controls [role=status]').textContent(),'1 / 2件の変更を採用');await page.setViewportSize({width:540,height:760});assert.ok(await page.locator('#selection-diff-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1));await page.setViewportSize({width:1440,height:960});await page.locator('[data-diff-action=adopt]').click();await idle();await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('new A'));
  const partial=original.replace('old A','new A');assert.equal(await editor.inputValue(),partial);await editor.press('Control+z');assert.equal(await editor.inputValue(),original);await editor.press('Control+Shift+z');assert.equal(await editor.inputValue(),partial);
  await select(partial.indexOf('後文'),partial.indexOf('後文'));await page.locator('#selection-ai').click();await page.getByRole('textbox',{name:'AIへの指示',exact:true}).fill('新規文章');await page.getByRole('button',{name:'候補を作成',exact:true}).click();await page.locator('#selection-diff-dialog').waitFor();await page.locator('[data-diff-action=adopt]').click();await idle();await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('新しい文章です。'));assert.equal(await editor.inputValue(),partial.replace('後文','新しい文章です。後文'));await editor.press('Control+z');assert.equal(await editor.inputValue(),partial);
  // A pending review must not navigate a different manuscript.
  await select(0,0);delayReview=true;const started=new Promise(resolve=>reviewStarted=resolve);await page.locator('#reader-review').click();await page.getByRole('button',{name:'レビューを実行',exact:true}).click();await started;
  await editor.evaluate(e=>{e.value+='changed';e.dispatchEvent(new InputEvent('input',{bubbles:true}));});releaseReview();delayReview=false;await idle();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('レビューを実行し直してください'));assert.equal(await page.locator('#reader-review-results').count(),0);
  // Cancel while the compatible API is still processing; preserve all text.
  const unchanged=await editor.inputValue();await select(0,0);delayReview=true;const cancelStarted=new Promise(resolve=>reviewStarted=resolve);
  await page.locator('#reader-review').click();await page.getByRole('button',{name:'レビューを実行',exact:true}).click();await cancelStarted;await page.locator('#progress-cancel').click();
  await page.waitForFunction(()=>document.querySelector('#status').classList.contains('error'));releaseReview();delayReview=false;await idle();assert.equal(await editor.inputValue(),unchanged);assert.equal(await page.locator('#reader-review-results').count(),0);
  await page.locator('#progress-dismiss').click();
  // Editor capture keeps the source caret and never replaces selected prose.
  await page.evaluate(()=>{window.__TAURI_INTERNALS__={invoke:async(command)=>{if(['test_launch_application','save_launch_commands','restore_manual_studio'].includes(command))return;throw Error(command);}};});
  await page.route('**/__manual/rpc',async route=>{
    const {action}=route.request().postDataJSON();let result;
    if(action==='list-accessible-windows')result=[{app:'Fixture',title:'Main',query:'Fixture'}];
    else if(action==='screenshot-ai-plan')result={summary:'撮影して番号を振る',recipe};
    else if(action==='screenshot-ai-capture')result=await rpc('screenshots-register',{json:{source:`data:image/png;base64,${png.toString('base64')}`,recipe,adopt:false}});
    else {await route.continue();return;}
    await route.fulfill({json:{output:JSON.stringify(result)}});
  });
  const editorCapture=async()=>{await page.locator('#editor-screenshot-ai').click();await page.getByRole('button',{name:'AIに撮影を指示',exact:true}).click();await page.locator('#screenshot-ai-instruction textarea').fill('FixtureのSaveに番号を振って');await page.getByRole('button',{name:'指示から作成',exact:true}).click();await page.getByRole('button',{name:'登録して起動',exact:true}).click();await page.getByRole('button',{name:'このウィンドウで手順を作成',exact:true}).click();await page.getByRole('button',{name:'この手順で撮影',exact:true}).click();await page.locator('#editor-screenshot-preview').waitFor();};
  const beforeScreenshot=await editor.inputValue(),caret=beforeScreenshot.indexOf('unchanged');
  await select(caret,caret+5);await editorCapture();await page.locator('#editor-screenshot-preview').getByRole('button',{name:'閉じる',exact:true}).click();assert.equal(await editor.inputValue(),beforeScreenshot);
  await select(caret,caret+5);await editorCapture();await page.getByRole('button',{name:'この位置に挿入',exact:true}).click();await idle();await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('screenshots/'));
  const withScreenshot=await editor.inputValue();assert.ok(withScreenshot.indexOf('screenshots/')<withScreenshot.indexOf('unchanged'));assert.ok(withScreenshot.endsWith(beforeScreenshot.slice(caret)));await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');if(await page.locator('.milkdown-top-bar').isVisible())await page.locator('.milkdown-top-bar').getByRole('button',{name:'元に戻す',exact:true}).click();else await editor.press('Control+z');assert.equal(await editor.inputValue(),beforeScreenshot);
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
  await native.route('**/screenshot-ai-test',route=>route.fulfill({contentType:'text/html',body:`<meta charset="UTF-8"><button id="screenshot-ai-create">撮影指示</button><p id="result"></p><script type="module">
    import {setupScreenshotAi} from '/src/screenshotAi.ts';
    const root=${JSON.stringify(root)},shot=${JSON.stringify(shot.screenshot.id)},recipe=${JSON.stringify(recipe)};
    window.shotActions=[];window.shotRequests=[];window.failAnnotation=false;window.refreshCount=0;window.windowPolls=0;
    setupScreenshotAi({root:()=>root,applications:()=>appProfiles,work:async run=>run(),reloadApplications:async()=>{},refresh:async()=>refreshCount++,report:(message)=>document.querySelector('#result').textContent=message,request:async(action,json)=>{
      shotActions.push(action);shotRequests.push({action,json});
      if(action==='list-accessible-windows'){if(window.launchIdentity){windowPolls++;return JSON.stringify([{app:'manual-studio',title:'Munin Manual Studio',pid:111,program:'/usr/bin/true',query:'pid:111:Munin Manual Studio'},...(windowPolls<3?[]:[{app:'manual-studio',title:'Munin Manual Studio',pid:222,program:'/usr/bin/true',query:'pid:222:Munin Manual Studio'},{app:'manual-studio',title:'Munin Manual Studio',pid:333,program:'/usr/bin/true',query:'pid:333:Munin Manual Studio'}])]);}return JSON.stringify([{app:'Fixture',title:'Main',query:'app:Fixture::Main'}]);}
      if(action==='screenshot-ai-plan')return JSON.stringify({summary:'撮影して番号を振る',recipe});
      if(action==='screenshot-ai-capture')return JSON.stringify({screenshot:{id:shot}});
      if(action==='screenshot-ai-annotate'&&failAnnotation)throw Error('metadata unavailable');
      const res=await fetch('/__manual/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({root,action,options:{json,api_key:'fixture-key'}})});const result=await res.json();if(result.error)throw Error(result.error);return result.output;
    }});
  </script>`}));
  const screenshotFlow=async()=>{await native.locator('#screenshot-ai-create').click();await native.locator('#screenshot-ai-instruction textarea').fill('Fixtureのツールバーに番号を振って');await native.getByRole('combobox',{name:'撮影するアプリ',exact:true}).selectOption('new');await native.getByRole('button',{name:'指示から作成',exact:true}).click();await native.locator('#screenshot-ai-application').waitFor();assert.equal(await native.getByRole('textbox',{name:'起動引数（1行に1つ）',exact:true}).inputValue(),'--workspace\ndemo project\n--mode\ndocs');await native.getByRole('button',{name:'AIで起動設定を補完',exact:true}).click();await native.waitForFunction(()=>document.querySelector('#screenshot-ai-application .muted').textContent.includes('補完しました'));await native.getByRole('button',{name:'登録して起動',exact:true}).click();await native.getByRole('button',{name:'このウィンドウで手順を作成',exact:true}).click();await native.getByRole('button',{name:'この手順で撮影',exact:true}).click();};
  await native.goto('http://127.0.0.1:5174/screenshot-ai-test');await screenshotFlow();await native.waitForFunction(()=>document.querySelector('#result').textContent.includes('AI注釈の候補を保存'));
  assert.equal(await native.evaluate(()=>appProfiles.length),1);assert.equal(await native.evaluate(()=>appProfiles[0].id),'existing');assert.deepEqual(await native.evaluate(()=>nativeCalls.map(c=>c.command)),['test_launch_application','save_launch_commands','restore_manual_studio','restore_manual_studio','restore_manual_studio']);assert.deepEqual(await native.evaluate(()=>nativeCalls[0].args.args),['--workspace','demo project','--mode','docs']);
  const registrationCalls=await native.evaluate(()=>shotActions.filter(action=>action==='screenshot-ai-application').length);const savedProfiles=await native.evaluate(()=>nativeCalls.filter(call=>call.command==='save_launch_commands').length);await native.locator('#screenshot-ai-create').click();await native.locator('#screenshot-ai-instruction textarea').fill('登録したFixtureを撮影');await native.getByRole('button',{name:'指示から作成',exact:true}).click();await native.getByRole('button',{name:'このウィンドウで手順を作成',exact:true}).click();await native.getByRole('button',{name:'この手順で撮影',exact:true}).click();await native.waitForFunction(()=>refreshCount>=4);assert.equal(await native.evaluate(()=>shotActions.filter(action=>action==='screenshot-ai-application').length),registrationCalls);assert.equal(await native.evaluate(()=>nativeCalls.filter(call=>call.command==='save_launch_commands').length),savedProfiles);
  // The launched Munin instance appears late and shares its title and executable with the host and another instance.
  await native.evaluate(()=>{window.launchIdentity={pid:222,host_pid:111,program:'/usr/bin/true'};});
  await native.locator('#screenshot-ai-create').click();await native.locator('#screenshot-ai-instruction textarea').fill('Muninのトップ画面を撮影');await native.getByRole('button',{name:'指示から作成',exact:true}).click();await native.locator('#screenshot-ai-plan').waitFor();assert.equal(await native.getByRole('combobox',{name:'撮影ウィンドウ'}).count(),0);assert.equal(await native.evaluate(()=>windowPolls),3);await native.getByRole('button',{name:'この手順で撮影',exact:true}).click();await native.waitForFunction(()=>refreshCount>=6);
  assert.equal(await native.evaluate(()=>shotRequests.filter(r=>r.action==='screenshot-ai-plan').at(-1).json.window),'pid:222:Munin Manual Studio');assert.equal(await native.evaluate(()=>shotRequests.filter(r=>r.action==='screenshot-ai-capture').at(-1).json.window),'pid:222:Munin Manual Studio');
  await native.evaluate(()=>{window.launchIdentity=undefined;});
  await native.evaluate(()=>failAnnotation=true);await screenshotFlow();await native.waitForFunction(()=>document.querySelector('#result').textContent.includes('撮影原本と再撮影手順は保存'));
  assert.ok((await rpc('screenshots-image',{id:shot.screenshot.id,json:{original:true}})).data);await native.close();
  assert.deepEqual(errors,[]);
  console.log('AI assistance passed: real image request/auth, selected UTF-16 anchors, unsupported-image fallback, stale revision, review filters/jump/fix, selective Diff, source/rich insertion, editor screenshot preview/cancel/cursor/Undo/stale protection, Undo/Redo, stale response, raw screenshot/recipe persistence, native registration flow and annotation-failure fallback.');
}finally{releaseReview?.();await browser?.close();vite?.kill();await new Promise(resolve=>ai.close(resolve));await rm(root,{recursive:true,force:true});}
