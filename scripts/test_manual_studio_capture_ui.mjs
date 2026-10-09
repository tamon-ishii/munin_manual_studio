import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
const root=await mkdtemp(path.join(os.tmpdir(),'munin-library-'));
const base='http://127.0.0.1:5174';let server,browser;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
try {
  await mkdir(path.join(root,'docs'),{recursive:true});
  const prompt=Array.from({length:90},(_,i)=>`操作 ${i}: アノテーション情報を含む長い指示`).join('&#10;');
  await writeFile(path.join(root,'docs/index.md'),`# Guide\n\n<!-- ai:task id=long kind=text name="Same" prompt="${prompt}" -->\n生成済みの本文\n<!-- /ai:task -->\n\n<!-- ai:task id=other kind=text name="Same" prompt="短い指示" -->\n別の本文\n<!-- /ai:task -->\n`);
  await writeFile(path.join(root,'manual_setting.json'),JSON.stringify({docs:'docs',targets:['docs'],connection_type:'none'}));
  server=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--config','apps/manual-studio/vite.config.ts'],{stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  const rpc=async(action,options={})=>{const response=await fetch(`${base}/__manual/rpc`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({root,action,options})});const result=await response.json();if(result.error)throw new Error(result.error);return result.output;};
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1000,height:720}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/?root=${encodeURIComponent(root)}`);
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  const card=page.locator('[data-ai-task-id=long]');await card.waitFor();
  assert.equal(await card.locator('details').getAttribute('open'),null);
  assert.equal(await card.locator('.milkdown-ai-task-body').isVisible(),true);
  const before=await page.locator('#markdown-editor').inputValue();
  await card.locator('summary').focus();await page.keyboard.press('Enter');
  const input=card.locator('textarea');await input.waitFor();assert.ok((await input.boundingBox()).height<=216);
  assert.equal(await page.locator('#markdown-editor').inputValue(),before,'disclosure does not edit document');
  await page.reload();await card.waitFor();assert.notEqual(await card.locator('details').getAttribute('open'),null,'disclosure persists per document');
  const displayName=card.getByRole('textbox',{name:'AI指示の名前（省略可）'});
  await displayName.fill('Renamed');assert.equal(await card.locator('.milkdown-ai-task-name').textContent(),'Renamed');assert.equal(await page.locator('[data-ai-task-id=other] .milkdown-ai-task-name').textContent(),'Same');
  const changed=await page.locator('#markdown-editor').inputValue();
  const instruction=card.locator('textarea');await instruction.evaluate(element=>{element.value='変換中';element.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));});assert.equal(await page.locator('#markdown-editor').inputValue(),changed,'IME intermediate input is not persisted');
  await instruction.evaluate(element=>element.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('prompt="変換中"'));
  await instruction.press('Control+z');assert.doesNotMatch(await page.locator('#markdown-editor').inputValue(),/prompt="変換中"/);await instruction.press('Control+Shift+z');assert.match(await page.locator('#markdown-editor').inputValue(),/prompt="変換中"/);
  await page.locator('[data-tab=screenshots]').click();
  await page.locator('#screenshot-library-import').setInputFiles('apps/manual-studio/src-tauri/icons/icon.png');
  await page.locator('.screenshot-library-card img').waitFor();
  const first=JSON.parse(await rpc('screenshots-list')).items[0];assert.equal(first.adopted!==null,true);
  const original=JSON.parse(await rpc('screenshots-image',{id:first.id,json:{original:true}}));
  const sourceHash=hash(Buffer.from(original.data.split(',')[1],'base64'));
  await page.locator('.screenshot-library-card').getByRole('button',{name:'文書に挿入',exact:true}).click();
  await page.locator('[data-tab=editor]').click();await page.locator('#save-page').click();await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  const saved=await readFile(path.join(root,'docs/index.md'),'utf8');assert.match(saved,/screenshot:ref id=shot-/);assert.match(saved,/!\[icon\]\(assets\/screenshots\//);
  const listed=JSON.parse(await rpc('screenshots-list')).items[0];assert.equal(listed.usage.length,1);
  await assert.rejects(()=>rpc('screenshots-change',{id:first.id,json:{delete:true}}),/参照中/);
  await rpc('screenshots-register',{json:{id:first.id,source:original.data,render:original.data,scene:{canvas:{width:128,height:128},annotations:[]},adopt:false}});
  assert.equal(hash(Buffer.from(JSON.parse(await rpc('screenshots-image',{id:first.id,json:{original:true}})).data.split(',')[1],'base64')),sourceHash);
  const plan=JSON.parse(await rpc('screenshots-recapture-plan'));assert.equal(plan.items[0].status,'skipped');assert.equal(plan.items[0].reason,'撮影手順なし');
  // Native calls are mocked here; this verifies the UI contract without claiming OS capture.
  const nativePage=await browser.newPage();
  await nativePage.addInitScript(({png})=>{
    const calls=[];let profiles={},shot=null,recordedId='',recordedRoot='',imports=0,next=1;
    window.__libraryMock={calls};window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
    window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'}},transformCallback(){return next++;},unregisterCallback(){},convertFileSrc:path=>path,invoke(command,args={}){
      calls.push({command,args});
      if(command==='plugin:event|listen')return Promise.resolve(next++);
      if(command==='choose_application')return Promise.resolve('/path with spaces/app');
      if(command==='test_launch_application')return args.program==='/missing/app'?Promise.reject(new Error('起動パスが見つかりません')):Promise.resolve();
      if(command==='load_launch_commands')return Promise.resolve(profiles[args.root]||[]);
      if(command==='save_launch_commands'){if(!args.root)return Promise.reject(new Error("project required"));profiles[args.root]=args.commands;return Promise.resolve();}
      if(command==='start_operation_recording'){recordedId=args.taskId;recordedRoot=args.root;return Promise.resolve('recording');}
      if(command==='finish_operation_recording'){shot={ownerRoot:recordedRoot,id:recordedId,name:'',adopted:null,protected:false,edits:[{id:'edit-one',created_at:'now',flattened:false}],usage:[],thumbnail:null,recipe:{steps:[]}};return Promise.resolve({screenshotId:recordedId,sourceFile:'/tmp/source',annotationFile:'/tmp/output',completionFile:'/tmp/complete',markitsStarted:true,message:'edited'});}
      if(command==='markits_annotation_ready')return Promise.resolve('{"annotations":[]}');
      if(command==='import_library_capture'){imports++;if(imports===1)return Promise.reject(new Error('simulated import failure'));const complete=()=>{shot.adopted='edit-one';shot.thumbnail=png;return '{}';};if(window.__libraryMock.holdImports)return new Promise(resolve=>{window.__libraryMock.release=()=>resolve(complete());});return Promise.resolve(complete());}
      if(command==='manual_request'){
        const {action}=args.request;
        if(action==='state')return Promise.resolve(JSON.stringify({has_config:true,config:{docs:'docs',output:'manual',connection_type:'none',agent:'codex',model:'',mkdocs:{site_name:'Test',theme:'material',language:'ja',use_directory_urls:true}},brief:'',pages:[],project_entries:[],tasks:[],image_assets:{},capture_sources:{},ui_map:null,agents:[]}));
        if(action==='screenshots-list')return Promise.resolve(JSON.stringify({items:shot&&shot.ownerRoot===args.request.root?[shot]:[]}));
        if(action==='agent-progress')return Promise.resolve('{"logs":[],"total":0}');
        return Promise.resolve('{}');
      }
      return Promise.resolve(null);
    }};
  },{png:original.data});
  await nativePage.goto(base);
  assert.equal(await nativePage.locator('#open-applications').isDisabled(),true,'application registration requires an opened project');
  assert.equal(await nativePage.locator('#settings-menu [data-tab=applications]').count(),0,'registration belongs to the Project menu');
  await nativePage.goto(`${base}/?root=${encodeURIComponent('/tmp/library-native-fixture')}`);
  await nativePage.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  await nativePage.locator('#project-menu summary').click();await nativePage.getByRole('button',{name:'アプリ登録',exact:true}).click();await nativePage.locator('#add-launch-command').click();
  await nativePage.locator('[data-launch-program="0"]').fill('/missing/app');
  await nativePage.getByRole('button',{name:'起動確認',exact:true}).click();
  await nativePage.waitForFunction(()=>document.querySelector('#status').textContent.includes('起動パスが見つかりません'));
  await nativePage.locator('[data-launch-browse="0"]').click();
  await nativePage.waitForFunction(()=>document.querySelector('[data-launch-program="0"]').value==='/path with spaces/app');
  await nativePage.getByRole('button',{name:'起動確認',exact:true}).click();
  await nativePage.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  await nativePage.locator('#add-launch-command').click();
  await nativePage.locator('[data-launch-remove="1"]').click();
  await nativePage.locator('[data-launch-program="0"]').fill('/path with spaces/app');await nativePage.locator('[data-launch-args="0"]').fill('--flag\n value with spaces $(literal) ');
  await nativePage.locator('#save-launch-commands').click();await nativePage.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');await nativePage.locator('[data-close-dialog=panel-applications]').click();
  await nativePage.locator('[data-tab=screenshots]').click();await nativePage.locator('#screenshot-library-record').click();await nativePage.getByRole('button',{name:'記録を開始',exact:true}).click();
  await nativePage.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');await nativePage.locator('#screenshot-library-stop').click();
  await nativePage.waitForFunction(()=>document.querySelector('#screenshot-library-status').textContent.includes('simulated import failure'));
  await nativePage.evaluate(()=>{window.__libraryMock.holdImports=true;});
  await nativePage.locator('#screenshot-library-retry').click();
  await nativePage.waitForFunction(()=>typeof window.__libraryMock.release==='function');
  await nativePage.evaluate(()=>{document.querySelector('#project-root').value='/tmp/another-library-project';document.querySelector('#project-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
  await nativePage.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  assert.equal(await nativePage.locator('#screenshot-launch-command option').count(),1,'another project cannot use the previous application registrations');
  await nativePage.evaluate(()=>window.__libraryMock.release());
  await nativePage.waitForFunction(()=>localStorage.getItem('manual-library-handoffs')==='[]');
  assert.equal(await nativePage.locator('.screenshot-library-card').count(),0,'late completion cannot populate another project');
  assert.doesNotMatch(await nativePage.locator('#screenshot-library-status').textContent(),/編集内容を画像一覧へ保存しました/);
  await nativePage.evaluate(()=>{document.querySelector('#project-root').value='/tmp/library-native-fixture';document.querySelector('#project-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
  await nativePage.locator('.screenshot-library-card img').waitFor();
  await nativePage.waitForFunction(()=>document.querySelector('#screenshot-launch-command').options.length===2);
  const nativeCalls=await nativePage.evaluate(()=>window.__libraryMock.calls);assert.equal(nativeCalls.find(call=>call.command==='save_launch_commands').args.root,'/tmp/library-native-fixture');assert.ok(nativeCalls.some(call=>call.command==='load_launch_commands'&&call.args.root==='/tmp/another-library-project'));const start=nativeCalls.find(call=>call.command==='start_operation_recording');assert.equal(start.args.program,'/path with spaces/app');assert.deepEqual(start.args.args,['--flag',' value with spaces $(literal) ']);assert.match(start.args.taskId,/^shot-/);
  assert.equal(nativeCalls.filter(call=>call.command==='import_library_capture').length,2,'failed handoff can retry without recording again');assert.equal(nativeCalls.filter(call=>call.command==='start_operation_recording').length,1);assert.equal(nativeCalls.filter(call=>call.command==='manual_request'&&call.args.request.action==='editor-save').length,0,'capture has no selected document dependency');
  await nativePage.close();
  assert.deepEqual(errors,[]);
  console.log('Independent screenshot import, immutable original, Markdown insertion, reference protection, recapture eligibility and 90-line instruction disclosure checks passed.');
} finally {await browser?.close();server?.kill();await rm(root,{recursive:true,force:true});}
