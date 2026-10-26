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
  browser=await chromium.launch({channel:process.env.MUNIN_TEST_BROWSER || 'chrome',headless:true});const page=await browser.newPage({viewport:{width:1000,height:720}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/?root=${encodeURIComponent(root)}`);
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  await page.locator('[data-tab=screenshots]').click();
  await page.locator('#screenshot-library-import').setInputFiles('apps/manual-studio/src-tauri/icons/icon.png');
  await page.locator('.screenshot-library-card img').waitFor();
  const first=JSON.parse(await rpc('screenshots-list')).items[0];assert.equal(first.adopted!==null,true);
  const original=JSON.parse(await rpc('screenshots-image',{id:first.id,json:{original:true}}));
  const sourceHash=hash(Buffer.from(original.data.split(',')[1],'base64'));
  if(!await page.locator('.resource-item-menu').evaluate(node=>node.open))await page.locator('.resource-item-menu>summary').click();
  await page.locator('.screenshot-library-card').getByRole('button',{name:'文書に挿入',exact:true}).click();
  await page.getByRole('button',{name:'ここに挿入',exact:true}).click();
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  assert.equal(await page.locator('#milkdown-editor').isVisible(),true,'insertion returns to the rich editor');
  await page.locator('#milkdown-editor img[data-type=image-block]').waitFor();
  let recaptureId;
  await page.route('**/__manual/rpc',async route=>{
    const request=route.request().postDataJSON();
    if(request.action==='screenshots-recapture-plan'){
      recaptureId=request.options.id;
      await route.fulfill({json:{output:JSON.stringify({items:[{status:'pending',reason:null}],capture_count:1})}});
    }else await route.continue();
  });
  await page.locator('#milkdown-editor img[data-type=image-block]').hover();
  await page.locator('.milkdown-image-recapture-btn').click();
  await page.locator('[data-confirm-action]').waitFor();
  assert.equal(recaptureId,first.id,'the image overlay recaptures the clicked screenshot');
  await page.locator('[data-confirm-action]').getByRole('button',{name:'キャンセル',exact:true}).click();
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  await page.unroute('**/__manual/rpc');
  await page.locator('[data-tab=editor]').click();
  await page.locator('#milkdown-editor .ProseMirror').focus();
  await page.keyboard.press('Control+z');
  await page.waitForFunction(()=>!document.querySelector('#markdown-editor').value.includes('screenshot:ref'));
  await page.locator('#milkdown-editor .ProseMirror').focus();
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('screenshot:ref'));

  await page.locator('[data-tab=editor]').click();await page.keyboard.press('Control+s');await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  const saved=await readFile(path.join(root,'docs/index.md'),'utf8');assert.match(saved,/screenshot:ref id=shot-/);assert.match(saved,/!\[icon\]\(assets\/screenshots\//);
  await page.getByRole('button',{name:'Markdownソース',exact:true}).click();
  await page.locator('#markdown-editor').evaluate(editor=>editor.setSelectionRange(0,editor.value.length));
  const sourceBefore=await page.locator('#markdown-editor').inputValue();
  await page.locator('[data-tab=screenshots]').click();
  if(!await page.locator('.resource-item-menu').evaluate(node=>node.open))await page.locator('.resource-item-menu>summary').click();
  await page.locator('.screenshot-library-card').getByRole('button',{name:'文書に挿入',exact:true}).click();
  await page.getByRole('button',{name:'ここに挿入',exact:true}).click();
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  assert.equal(await page.locator('#markdown-editor').isVisible(),true,'source insertion returns to its editor');
  assert.ok((await page.locator('#markdown-editor').inputValue()).endsWith(sourceBefore),'source image insertion preserves the selected manuscript');
  await page.keyboard.press('Control+z');
  assert.equal(await page.locator('#markdown-editor').inputValue(),sourceBefore,'source insertion can be undone');
  await page.keyboard.press('Control+Shift+z');
  assert.equal((await page.locator('#markdown-editor').inputValue()).match(/<!-- screenshot:ref id=/g).length,2,'source insertion can be redone');
  await page.keyboard.press('Control+s');await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  // Cancel and a failed reference request preserve the same source cursor.
  const beforeReferenceRetry=await page.locator('#markdown-editor').inputValue();
  await page.locator('#markdown-editor').evaluate(editor=>{editor.focus();editor.setSelectionRange(0,0);});
  async function openReferenceDestination(){
    await page.locator('[data-tab=screenshots]').click();
    if(!await page.locator('.resource-item-menu').evaluate(node=>node.open))await page.locator('.resource-item-menu>summary').click();
    await page.locator('.screenshot-library-card').getByRole('button',{name:'文書に挿入',exact:true}).click();
    await page.locator('[data-screenshot-destination]').waitFor();
  }
  await openReferenceDestination();await page.locator('[data-screenshot-destination]').getByRole('button',{name:'閉じる',exact:true}).click();
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  assert.equal(await page.locator('#markdown-editor').inputValue(),beforeReferenceRetry);
  assert.equal(await page.locator('#markdown-editor').evaluate(editor=>editor.selectionStart),0);
  await page.route('**/__manual/rpc',async route=>{
    if(route.request().postDataJSON().action==='screenshots-reference')await route.fulfill({json:{error:'Fixture reference unavailable'}});
    else await route.continue();
  });
  await openReferenceDestination();await page.getByRole('button',{name:'ここに挿入',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Fixture reference unavailable')&&document.body.getAttribute('aria-busy')==='false');
  assert.equal(await page.locator('#markdown-editor').inputValue(),beforeReferenceRetry);
  assert.equal(await page.locator('#markdown-editor').evaluate(editor=>editor.selectionStart),0);
  await page.unroute('**/__manual/rpc');
  await openReferenceDestination();await page.getByRole('button',{name:'ここに挿入',exact:true}).click();
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  assert.ok((await page.locator('#markdown-editor').inputValue()).endsWith(beforeReferenceRetry));
  await page.locator('#markdown-editor').press('Control+z');
  assert.equal(await page.locator('#markdown-editor').inputValue(),beforeReferenceRetry);
  // Reference loading blocks navigation; keep that contract explicit rather
  // than simulating a manuscript switch through disabled controls.
  const beforeLateReference=await page.locator('#markdown-editor').inputValue();
  let releaseReference,referenceStarted;
  const heldReference=new Promise(resolve=>referenceStarted=resolve);
  await page.route('**/__manual/rpc',async route=>{
    if(route.request().postDataJSON().action==='screenshots-reference'){
      referenceStarted();await new Promise(resolve=>releaseReference=resolve);
    }
    await route.continue();
  });
  await page.locator('[data-tab=screenshots]').click();
  if(!await page.locator('.resource-item-menu').evaluate(node=>node.open))await page.locator('.resource-item-menu>summary').click();
  await page.locator('.screenshot-library-card').getByRole('button',{name:'文書に挿入',exact:true}).click();
  await page.getByRole('button',{name:'ここに挿入',exact:true}).click();
  await Promise.race([heldReference,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Screenshot reference did not start')),10000);timer.unref();})]);
  assert.equal(await page.locator('[data-tab=editor]').isDisabled(),true,'reference loading prevents leaving the resource panel');
  assert.equal(await page.locator('[data-document-page="index.md"]').isDisabled(),true,'reference loading prevents manuscript navigation');
  assert.equal(await page.locator('#markdown-editor').inputValue(),beforeLateReference,'pending reference leaves the manuscript intact');
  const lateReference=page.waitForResponse(response=>response.url().includes('/__manual/rpc')&&response.request().postDataJSON()?.action==='screenshots-reference');
  releaseReference();await lateReference;
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  assert.equal((await page.locator('#markdown-editor').inputValue()).match(/<!-- screenshot:ref id=/g).length,3);
  await page.locator('#markdown-editor').press('Control+z');
  assert.equal(await page.locator('#markdown-editor').inputValue(),beforeLateReference,'Undo restores the manuscript after the delayed reference');
  await page.unroute('**/__manual/rpc');
  await page.locator('#markdown-editor').press('Control+s');await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  const listed=JSON.parse(await rpc('screenshots-list')).items[0];assert.equal(listed.usage.length,1);
  await assert.rejects(()=>rpc('screenshots-change',{id:first.id,json:{delete:true}}),/参照中/);
  await rpc('screenshots-register',{json:{id:first.id,source:original.data,render:original.data,scene:{canvas:{width:128,height:128},annotations:[]},adopt:false}});
  assert.equal(hash(Buffer.from(JSON.parse(await rpc('screenshots-image',{id:first.id,json:{original:true}})).data.split(',')[1],'base64')),sourceHash);
  const plan=JSON.parse(await rpc('screenshots-recapture-plan'));assert.equal(plan.items[0].status,'skipped');assert.equal(plan.items[0].reason,'撮影手順なし');
  await page.locator('[data-tab=screenshots]').click();
  if(!await page.locator('.resource-item-menu').evaluate(node=>node.open))await page.locator('.resource-item-menu>summary').click();
  await page.locator('.screenshot-library-card').getByRole('button',{name:'コピー',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.screenshot-library-card').length===2);
  const copiedItems=JSON.parse(await rpc('screenshots-list')).items;
  const copy=copiedItems.find(item=>item.id!==first.id);
  assert.equal(copy.capture_id,first.capture_id);
  assert.equal(copy.usage.length,0);
  assert.equal(JSON.parse(await rpc('screenshots-image',{id:copy.id,json:{original:true}})).data,original.data);
  assert.match(await page.locator('.screenshot-library-card').first().textContent(),/原本を共有：2画像/);
  // Native calls are mocked here; this verifies the UI contract without claiming OS capture.
  const nativePage=await browser.newPage();
  await nativePage.addInitScript(({png})=>{
    const calls=[];let profiles={},shot=null,recordedId='',recordedRoot='',imports=0,next=1;
    window.__libraryMock={calls};window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
    window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'}},transformCallback(){return next++;},unregisterCallback(){},convertFileSrc:path=>path,invoke(command,args={}){
      calls.push({command,args});
      if(command==='paste_clipboard_image')return new Promise((resolve,reject)=>{window.__libraryMock.releasePaste=()=>resolve({filePath:'docs/assets/native-paste.png',filename:'native-paste.png',alt:'Native paste'});window.__libraryMock.failPaste=()=>reject(new Error('Fixture native clipboard failure'));});
      if(command==='plugin:event|listen')return Promise.resolve(next++);
      if(command==='choose_application')return Promise.resolve('/path with spaces/app');
      if(command==='test_launch_application')return args.program==='/missing/app'?Promise.reject(new Error('起動パスが見つかりません')):Promise.resolve();
      if(command==='load_launch_commands')return Promise.resolve(profiles[args.root]||[]);
      if(command==='save_launch_commands'){if(!args.root)return Promise.reject(new Error("project required"));profiles[args.root]=args.commands;return Promise.resolve();}
      if(command==='start_operation_recording'){recordedId=args.taskId;recordedRoot=args.root;return Promise.resolve('recording');}
      if(command==='finish_operation_recording'){if(window.__libraryMock.failFinish)return Promise.reject(new Error('simulated capture failure'));shot={ownerRoot:recordedRoot,id:recordedId,name:'',adopted:null,protected:false,edits:[{id:'edit-one',created_at:'now',flattened:false}],usage:[],thumbnail:null,recipe:{steps:[]}};return Promise.resolve({screenshotId:recordedId,sourceFile:'/tmp/source',annotationFile:'/tmp/output',completionFile:'/tmp/complete',markitsStarted:true,message:'edited'});}
      if(command==='edit_library_screenshot')return window.__libraryMock.failEdit?Promise.reject(new Error('simulated MarkIts startup failure')):Promise.resolve({sourceFile:'/tmp/edit-source',annotationFile:'/tmp/edit-output',completionFile:`/tmp/edit-complete-${next++}`,revision:'edit-one'});
      if(command==='markits_annotation_ready')return Promise.resolve(window.__libraryMock.holdAnnotations?null:'{"annotations":[]}');
      if(command==='import_library_capture'){imports++;if(imports===1)return Promise.reject(new Error('simulated import failure'));const complete=()=>{shot.adopted='edit-one';shot.thumbnail=png;return JSON.stringify({revision:'edit-one'});};if(window.__libraryMock.holdImports)return new Promise(resolve=>{window.__libraryMock.release=()=>resolve(complete());});return Promise.resolve(complete());}
      if(command==='manual_request'){
        const {action}=args.request;
        if(action==='state')return Promise.resolve(JSON.stringify({has_config:true,config:{docs:'docs',output:'manual',connection_type:'none',agent:'codex',model:'',mkdocs:{site_name:'Test',theme:'material',language:'ja',use_directory_urls:true}},brief:'',pages:window.__libraryMock.documentEnabled?['index.md']:[],project_entries:window.__libraryMock.documentEnabled?[{path:'docs/index.md',directory:false}]:[],tasks:[],image_assets:{},capture_sources:{},agents:[]}));
        if(action==='editor-read')return Promise.resolve(JSON.stringify({page:'index.md',content:window.__libraryMock.content||'# Manual\n\nKeep this prose.\n',revision:'r1'}));
        if(action==='editor-save'){window.__libraryMock.content=args.request.options.json.content;return Promise.resolve(JSON.stringify({page:'index.md',content:window.__libraryMock.content,revision:'r1'}));}
        if(action==='editor-preview')return Promise.resolve('<html><body>Preview</body></html>');
        if(action==='screenshots-image')return Promise.resolve(JSON.stringify({data:png,edit:shot.edits[0],screenshot:shot}));
        if(action==='screenshots-change'){shot.adopted=args.request.options.json.adopt;return Promise.resolve(JSON.stringify({screenshot:shot}));}
        if(action==='screenshots-reference')return Promise.resolve('![capture](assets/screenshots/'+shot.id+'.png)');
        if(action==='screenshots-list')return Promise.resolve(JSON.stringify({items:shot&&shot.ownerRoot===args.request.root?[shot]:[]}));
        if(action==='agent-progress')return Promise.resolve('{"logs":[],"total":0}');
        return Promise.resolve('{}');
      }
      return Promise.resolve(null);
    }};
  },{png:original.data});
  await nativePage.goto(base);
  assert.equal(await nativePage.locator('#open-applications').isDisabled(),true,'application registration requires an opened project');
  assert.equal(await nativePage.locator('#settings-menu [data-tab=applications]').count(),0,'registration is outside global settings');
  await nativePage.goto(`${base}/?root=${encodeURIComponent('/tmp/library-native-fixture')}`);
  await nativePage.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  assert.equal(await nativePage.locator('.workspace-tabs #open-applications').count(),1,'application registration is beside the resource library');
  assert.equal(await nativePage.locator('#panel-editor').isVisible(),true);
  assert.equal(await nativePage.locator('#open-applications').isVisible(),true,'registration is accessible while editing');
  await nativePage.getByRole('button',{name:'撮影するアプリを登録',exact:true}).click();await nativePage.locator('#add-launch-command').click();
  await nativePage.locator('[data-launch-program="0"]').fill('/missing/app');
  await nativePage.getByRole('button',{name:'起動確認',exact:true}).click();
  await nativePage.waitForFunction(()=>document.querySelector('#status').textContent.includes('起動パスが見つかりません'));
  await nativePage.locator('[data-launch-browse="0"]').click();
  await nativePage.waitForFunction(()=>document.querySelector('[data-launch-program="0"]').value==='/path with spaces/app');
  await nativePage.getByRole('button',{name:'起動確認',exact:true}).click();
  await nativePage.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  await nativePage.locator('[data-launch-args="0"]').fill('--flag\n value with spaces $(literal) ');
  await nativePage.locator('#add-launch-command').click();
  assert.equal(await nativePage.locator('[data-launch-program="0"]').inputValue(),'/path with spaces/app','adding an application preserves the edited path');
  assert.equal(await nativePage.locator('[data-launch-args="0"]').inputValue(),'--flag\n value with spaces $(literal) ','adding an application preserves literal arguments');
  await nativePage.locator('[data-launch-name="0"]').fill('Edited application');
  await nativePage.locator('[data-launch-remove="1"]').click();
  assert.equal(await nativePage.locator('[data-launch-name="0"]').inputValue(),'Edited application','removing another application preserves edits');
  await nativePage.locator('[data-launch-program="0"]').fill('/path with spaces/app');await nativePage.locator('[data-launch-args="0"]').fill('--flag\n value with spaces $(literal) ');
  await nativePage.locator('#save-launch-commands').click();await nativePage.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');await nativePage.locator('[data-close-dialog=panel-applications]').click();
  await nativePage.locator('[data-tab=screenshots]').click();
  for(const id of ['stop','retry','cancel']) assert.equal(await nativePage.locator(`#screenshot-library-${id}`).isVisible(),false,`${id} is hidden while idle`);
  await nativePage.locator('#screenshot-library-record').click();await nativePage.getByRole('button',{name:'記録を開始',exact:true}).click();
  await nativePage.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  assert.equal(await nativePage.locator('#screenshot-library-stop').isVisible(),true,'recording exposes the finish action');
  assert.equal(await nativePage.locator('#screenshot-library-record').isVisible(),false,'recording hides the start action');
  await nativePage.locator('#screenshot-library-stop').click();
  await nativePage.waitForFunction(()=>document.querySelector('#screenshot-library-status').textContent.includes('simulated import failure'));
  assert.equal(await nativePage.locator('#screenshot-library-stop').isVisible(),false,'completion hides the finish action');
  assert.equal(await nativePage.locator('#screenshot-library-retry').isVisible(),true,'failed import exposes retry');
  await nativePage.evaluate(()=>{window.__libraryMock.holdImports=true;});
  await nativePage.locator('#screenshot-library-retry').click();
  await nativePage.waitForFunction(()=>typeof window.__libraryMock.release==='function');
  await nativePage.evaluate(()=>{document.querySelector('#project-root').value='/tmp/another-library-project';document.querySelector('#project-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
  await nativePage.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  assert.equal(await nativePage.locator('[data-launch-program]').count(),0,'another project cannot use the previous application registrations');
  await nativePage.evaluate(()=>window.__libraryMock.release());
  await nativePage.waitForFunction(()=>localStorage.getItem('manual-library-handoffs')==='[]');
  assert.equal(await nativePage.locator('.screenshot-library-card').count(),0,'late completion cannot populate another project');
  assert.doesNotMatch(await nativePage.locator('#screenshot-library-status').textContent(),/編集内容を画像一覧へ保存しました/);
  await nativePage.evaluate(()=>{document.querySelector('#project-root').value='/tmp/library-native-fixture';document.querySelector('#project-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
  await nativePage.locator('.screenshot-library-card img').waitFor();
  await nativePage.waitForFunction(()=>document.querySelectorAll('[data-launch-program]').length===1);
  const nativeCalls=await nativePage.evaluate(()=>window.__libraryMock.calls);assert.equal(nativeCalls.find(call=>call.command==='save_launch_commands').args.root,'/tmp/library-native-fixture');assert.ok(nativeCalls.some(call=>call.command==='load_launch_commands'&&call.args.root==='/tmp/another-library-project'));const start=nativeCalls.find(call=>call.command==='start_operation_recording');assert.equal(start.args.program,'/path with spaces/app');assert.deepEqual(start.args.args,['--flag',' value with spaces $(literal) ']);assert.match(start.args.taskId,/^shot-/);
  assert.equal(nativeCalls.filter(call=>call.command==='import_library_capture').length,2,'failed handoff can retry without recording again');assert.equal(nativeCalls.filter(call=>call.command==='start_operation_recording').length,1);assert.equal(nativeCalls.filter(call=>call.command==='manual_request'&&call.args.request.action==='editor-save').length,0,'capture has no selected document dependency');
  await nativePage.evaluate(()=>{window.__libraryMock.documentEnabled=true;window.__libraryMock.holdImports=false;document.querySelector('#project-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
  await nativePage.waitForFunction(()=>document.querySelector('#editor-title').textContent==='index.md');await nativePage.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  await nativePage.locator('[data-tab=editor]').click();await nativePage.getByRole('button',{name:'Markdownソース',exact:true}).click();const nativeEditor=nativePage.locator('#markdown-editor');const manuscript=await nativeEditor.inputValue();
  await nativeEditor.fill(manuscript+'\nUnsaved capture insertion.\n');
  await nativePage.locator('#editor-screenshot-ai').click();
  await nativePage.getByRole('heading',{name:'撮影するアプリ',exact:true}).waitFor();
  assert.equal(await nativePage.locator('#editor-screenshot-method').count(),0);
  await nativePage.getByRole('button',{name:'キャンセル',exact:true}).click();
  assert.equal(await nativeEditor.inputValue(),manuscript+'\nUnsaved capture insertion.\n','opening capture preserves unsaved prose');
  await nativeEditor.fill(manuscript);
  await nativeEditor.evaluate(el=>{el.focus();el.setSelectionRange(10,10);});await nativePage.locator('#editor-screenshot-ai').click();assert.equal(await nativePage.locator('#editor-screenshot-method').count(),0);await nativePage.getByRole('button',{name:'キャンセル',exact:true}).click();assert.equal(await nativeEditor.inputValue(),manuscript);
  await nativeEditor.evaluate(el=>{el.focus();el.setSelectionRange(10,10);});await nativePage.locator('#editor-screenshot-ai').click();assert.equal(await nativePage.locator('#editor-screenshot-method').count(),0);await nativePage.getByRole('button',{name:'記録を開始',exact:true}).click();await nativePage.locator('#editor-screenshot-recording').waitFor();await nativePage.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  await nativePage.evaluate(()=>{__libraryMock.failFinish=true;});await nativePage.getByRole('button',{name:'撮影する',exact:true}).click();await nativePage.waitForFunction(()=>!document.querySelector('#editor-screenshot-recording')&&document.querySelector('#screenshot-library-record').hidden===false);assert.equal(await nativeEditor.inputValue(),manuscript);assert.equal(await nativeEditor.evaluate(el=>el.selectionStart),10);
  await nativePage.evaluate(()=>{__libraryMock.failFinish=false;__libraryMock.holdImports=true;delete __libraryMock.release;});await nativeEditor.evaluate(el=>{el.focus();el.setSelectionRange(10,10);});await nativePage.locator('#editor-screenshot-ai').click();assert.equal(await nativePage.locator('#editor-screenshot-method').count(),0);await nativePage.getByRole('button',{name:'記録を開始',exact:true}).click();await nativePage.locator('#editor-screenshot-recording').waitFor();await nativePage.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');await nativePage.getByRole('button',{name:'撮影する',exact:true}).click();
  await nativePage.waitForFunction(()=>typeof __libraryMock.release==='function');
  await nativePage.locator('[data-capture-stage]').getByText('編集結果を保存中',{exact:true}).waitFor();
  assert.equal(await nativePage.locator('#capture-operation-progress').getAttribute('data-stage'),'import');
  await nativePage.evaluate(()=>{__libraryMock.holdImports=false;__libraryMock.release();});
  assert.equal(await nativePage.locator('#editor-screenshot-preview').count(),0);await nativePage.waitForFunction(()=>document.querySelector('#status').textContent.includes('指定位置にスクショを挿入しました。')&&document.body.getAttribute('aria-busy')==='false');
  const previewCalls=await nativePage.evaluate(()=>{
    const calls=__libraryMock.calls;
    const imported=calls.findLastIndex(call=>call.command==='import_library_capture');
    const preview=calls.findIndex((call,index)=>index>imported&&call.command==='manual_request'&&call.args.request.action==='screenshots-image');
    return calls.slice(imported+1,preview+1);
  });
  assert.ok(previewCalls.some(call=>call.args?.request?.action==='screenshots-image'&&call.args.request.options.json.latest===true));
  assert.equal(previewCalls.some(call=>['screenshots-list','resources-list','editor-preview'].includes(call.args?.request?.action)),false,'insertion preview does not wait for library scans or editor refresh');
  await nativePage.waitForFunction(()=>__libraryMock.calls.some(call=>call.args?.request?.action==='operation-timings-record'&&call.args.request.options.json.operation==='screenshot-insert'&&call.args.request.options.json.outcome==='success'));
  assert.equal(await nativePage.locator('#capture-operation-progress').count(),0);
  const inserted=await nativeEditor.inputValue();assert.ok(inserted.startsWith(manuscript.slice(0,10)));assert.ok(inserted.endsWith(manuscript.slice(10)));assert.match(inserted,/assets\/screenshots\//);await nativeEditor.press('Control+z');assert.equal(await nativeEditor.inputValue(),manuscript);
  assert.equal(await nativePage.evaluate(()=>__libraryMock.calls.some(call=>call.command==='manual_request'&&call.args.request.action.startsWith('screenshot-ai-'))),false,'manual insertion needs no AI requests');
  // Native clipboard invocation is mocked: check UI/session guards without
  // claiming an actual OS clipboard read or an asset write.
  for(const outcome of ['cancel','failure','retry','stale']){
    await nativePage.evaluate(()=>{delete __libraryMock.releasePaste;delete __libraryMock.failPaste;});
    await nativeEditor.evaluate(node=>{node.focus();node.setSelectionRange(10,10);});
    await nativePage.waitForTimeout(650);await nativeEditor.press('Control+v');
    await nativePage.waitForFunction(()=>typeof __libraryMock.releasePaste==='function');
    assert.equal(await nativePage.locator('#cancel-image-paste').isVisible(),true);
    if(outcome==='cancel')await nativePage.locator('#cancel-image-paste').click();
    if(outcome==='retry')await nativeEditor.evaluate(node=>node.setSelectionRange(0,0));
    if(outcome==='stale')await nativeEditor.fill(manuscript+'Changed while clipboard waits.');
    await nativePage.evaluate(outcome=>outcome==='failure'?__libraryMock.failPaste():__libraryMock.releasePaste(),outcome);
    await nativePage.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
    assert.equal(await nativePage.locator('#cancel-image-paste').isVisible(),false);
    if(outcome==='retry'){
      assert.equal(await nativeEditor.inputValue(),manuscript.slice(0,10)+'![Native paste](assets/native-paste.png)'+manuscript.slice(10));
      await nativeEditor.press('Control+z');assert.equal(await nativeEditor.inputValue(),manuscript);
    }else if(outcome==='stale'){
      assert.equal(await nativeEditor.inputValue(),manuscript+'Changed while clipboard waits.');
      assert.match(await nativePage.locator('#status').textContent(),/原稿が変更されました/);
      await nativeEditor.fill(manuscript);
    }else{
      assert.equal(await nativeEditor.inputValue(),manuscript);
      assert.match(await nativePage.locator('#status').textContent(),outcome==='cancel'?/挿入はキャンセルされました/:/Fixture native clipboard failure/);
    }
  }
  await nativePage.locator('[data-tab=screenshots]').click();await nativePage.evaluate(()=>{__libraryMock.failEdit=true;});
  if(!await nativePage.locator('.resource-item-menu').evaluate(node=>node.open))await nativePage.locator('.resource-item-menu>summary').click();
  await nativePage.getByRole('button',{name:'編集',exact:true}).click();await nativePage.waitForFunction(()=>document.querySelector('.screenshot-edit-status')?.textContent.includes('simulated MarkIts startup failure'));assert.equal(await nativePage.getByRole('button',{name:'編集',exact:true}).isEnabled(),true);
  await nativePage.evaluate(()=>{__libraryMock.failEdit=false;__libraryMock.holdAnnotations=true;});await nativePage.getByRole('button',{name:'編集',exact:true}).click();await nativePage.waitForFunction(()=>document.querySelector('.screenshot-edit-status')?.textContent.includes('MarkItsで編集中'));
  assert.equal(await nativePage.getByRole('button',{name:'編集',exact:true}).isEnabled(),true,'pending editing exposes recovery');
  await nativePage.getByRole('button',{name:'編集',exact:true}).click();
  const recovery=nativePage.getByRole('dialog').filter({has:nativePage.getByRole('heading',{name:'MarkItsの編集状態を確認',exact:true})});
  await recovery.waitFor();
  assert.equal(await nativePage.evaluate(()=>__libraryMock.calls.filter(call=>call.command==='edit_library_screenshot').length),2,'opening recovery cannot launch duplicate editors');
  await recovery.getByRole('button',{name:'閉じる',exact:true}).click();
  await nativePage.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  assert.equal(await nativePage.evaluate(()=>__libraryMock.calls.filter(call=>call.command==='edit_library_screenshot').length),2,'cancelling recovery keeps the existing editor');
  await nativePage.getByRole('button',{name:'編集',exact:true}).click();
  await recovery.getByRole('button',{name:'編集状態を解除して開き直す',exact:true}).click();
  await nativePage.waitForFunction(()=>__libraryMock.calls.filter(call=>call.command==='edit_library_screenshot').length===3&&document.body.getAttribute('aria-busy')==='false');
  assert.equal(await nativePage.evaluate(()=>JSON.parse(localStorage.getItem('manual-library-recovered-handoffs')).length),1,'recovery preserves the abandoned handoff');
  assert.equal(await nativePage.evaluate(()=>JSON.parse(localStorage.getItem('manual-library-handoffs')).length),1,'only the replacement session remains active');
  await nativePage.evaluate(()=>{__libraryMock.holdAnnotations=false;});await nativePage.waitForFunction(()=>document.querySelector('.screenshot-edit-status')?.textContent.includes('編集内容を反映しました')&&document.body.getAttribute('aria-busy')==='false');assert.equal(await nativePage.getByRole('button',{name:'編集',exact:true}).isEnabled(),true);assert.equal(await nativePage.evaluate(()=>__libraryMock.calls.filter(call=>call.command==='edit_library_screenshot').length),3);assert.equal(await nativePage.evaluate(()=>__libraryMock.calls.some(call=>call.command==='restore_manual_studio')),true);
  await nativePage.close();
  assert.deepEqual(errors,[]);
  console.log('Independent screenshot import, immutable original, Markdown insertion, reference protection, recapture eligibility and editor manual capture failure/retry/direct cursor insertion/Undo without AI checks passed.');
} finally {await browser?.close();server?.kill();await rm(root,{recursive:true,force:true});}
