import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {chromium} from 'playwright-core';
const root=await mkdtemp(path.join(os.tmpdir(),'munin-document-workflows-'));
const base='http://127.0.0.1:5174';let server,browser,api;let requests=0,fail=false;
const png=await readFile('apps/manual-studio/src-tauri/icons/icon.png');
try {
  await mkdir(path.join(root,'docs/assets'),{recursive:true});await mkdir(path.join(root,'docs/nested'));
  const initial='# Introduction\n\nOriginal text.\n\n## Details\n\nDetails body.\n';
  await writeFile(path.join(root,'docs/index.md'),initial);
  await writeFile(path.join(root,'docs/guide.md'),'# Guide\n\nGuide body.\n');
  await writeFile(path.join(root,'docs/nested/deep.md'),'# Deep\n\nNested body.\n');
  await writeFile(path.join(root,'docs/assets/demo.png'),png);
  await writeFile(path.join(root,'docs/output.md'),'<!-- ai:task id=output kind=text prompt="説明" -->\n<!-- ai:generated id=output kind=text updated-at=2026-10-10 -->\nGenerated body.\n<!-- /ai:generated -->\n<!-- /ai:task -->\n');
  await writeFile(path.join(root,'manual_setting.json'),JSON.stringify({docs:'docs',assets:'docs/assets',targets:['docs'],connection_type:'none'}));
  api=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests++;assert.equal(req.headers.authorization,'Bearer fixture-key');const body=JSON.parse(raw);assert.equal(body.n,1);assert.equal(body.output_format,'png');if(fail){res.writeHead(401);res.end('fixture failure');return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));});
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  server=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--config','apps/manual-studio/vite.config.ts'],{stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const rpc=async(action,options={})=>{const response=await fetch(`${base}/__manual/rpc`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({root,action,options})});const result=await response.json();if(result.error)throw new Error(result.error);return result.output;};
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:960}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${base}/?root=${encodeURIComponent(root)}&page=index.md`);await idle();
  async function idle(){await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');}
  async function tree(file){await page.locator('#tree-search').fill(file.split('/').at(-1));await page.locator(`[data-page="${file}"],[data-image="${file}"]`).click();await idle();await page.locator('#tree-search').fill('');}
  await page.getByRole('button',{name:'Markdownソース',exact:true}).click();
  assert.equal(await page.locator('#save-page').count(),0,'the editor has no save button');
  assert.equal(await page.locator('#shortcut-help + #generate-page').textContent(),'更新');
  await page.locator('#markdown-editor').fill(initial+'Autosaved draft.\n');
  await page.waitForFunction(()=>document.querySelector('#document-tabs [data-document-page="index.md"]').textContent==='index.md');
  assert.match(await readFile(path.join(root,'docs/index.md'),'utf8'),/Autosaved draft/,'idle edits are persisted without a save action');
  let delayedSaveRequests = 0;
  const delayedSave = async route => {
    if (route.request().postDataJSON().action === 'editor-save') {
      delayedSaveRequests++;
      await new Promise(resolve=>setTimeout(resolve,600));
    }
    await route.continue();
  };
  await page.route('**/__manual/rpc', delayedSave);
  await page.locator('#markdown-editor').fill(initial+'Saving draft.\n');
  await page.waitForFunction(()=>document.querySelector('#save-state').dataset.state==='saving');
  await page.locator('#markdown-editor').fill(initial+'Autosaved draft.\n');
  await page.waitForFunction(()=>document.querySelector('#save-state').dataset.state==='saved' && document.querySelector('#document-tabs [data-document-page="index.md"]').textContent==='index.md');
  assert.equal(delayedSaveRequests,2,'an edit during saving causes a second serialized save');
  assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),initial+'Autosaved draft.\n','edits made during saving are saved in a subsequent request');
  await page.unroute('**/__manual/rpc', delayedSave);
  await page.locator('#markdown-editor').fill(initial+'Unsaved draft.\n');
  assert.equal(await page.locator('#document-tabs [data-document-page="index.md"]').textContent(),'index.md *');
  await tree('docs/guide.md');
  assert.equal(await page.locator('#document-tabs [role=tab]').count(),2);
  assert.equal(await page.locator('#document-tabs [data-document-page="index.md"]').textContent(),'index.md');
  await page.locator('[data-document-page="index.md"]').click();await idle();
  assert.match(await page.locator('#markdown-editor').inputValue(),/Unsaved draft/);
  await page.locator('#markdown-editor').focus();await page.keyboard.press('Control+z');assert.equal(await page.locator('#markdown-editor').inputValue(),initial+'Autosaved draft.\n');
  await page.keyboard.press('Control+Shift+z');assert.match(await page.locator('#markdown-editor').inputValue(),/Unsaved draft/);
  await page.locator('#tree-search').fill('demo.png');await page.locator('[data-image]').first().click();await idle();await page.locator('#image-tab-view').waitFor();await page.locator('#image-tab-preview').waitFor();
  assert.ok((await page.locator('#image-tab-view').boundingBox()).height>150,'image tab has a usable visible area');
  assert.equal(await page.locator('#editor-workspace').isVisible(),false,'document editor is hidden behind the image tab');
  await page.locator('[data-document-page="index.md"]').click();await idle();assert.match(await page.locator('#markdown-editor').inputValue(),/Unsaved draft/);
  await page.locator('#markdown-editor').evaluate(editor=>editor.setSelectionRange(editor.value.length,editor.value.length));
  await page.locator('#markdown-editor').evaluate((editor,root)=>{const transfer=new DataTransfer();transfer.setData('application/x-munin-image',JSON.stringify({root,path:'docs/assets/demo.png'}));editor.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));},root);
  assert.match(await page.locator('#markdown-editor').inputValue(),/!\[demo.png\]\(<assets\/demo.png>\)/);
  await page.keyboard.press('Control+s');await idle();
  const savedDraft=await readFile(path.join(root,'docs/index.md'),'utf8');
  await writeFile(path.join(root,'docs/index.md'),savedDraft+'\nExternal update.\n');
  await page.locator('[data-document-page="guide.md"]').click();await idle();
  await page.locator('[data-document-page="index.md"]').click();await idle();
  assert.match(await page.locator('#markdown-editor').inputValue(),/External update/,'clean tabs reload changed files');
  await writeFile(path.join(root,'docs/index.md'),savedDraft+'\nExplicit reload.\n');
  await page.locator('#editor-more>summary').click();await page.locator('#reload-page').click();await idle();
  assert.match(await page.locator('#markdown-editor').inputValue(),/Explicit reload/,'reload reads the active file');
  if (!await page.locator('#markdown-editor').isVisible()) await page.getByRole('button',{name:'Markdownソース',exact:true}).click();
  await page.locator('#markdown-editor').fill(savedDraft+'\nClose cancellation draft.\n');
  await page.getByRole('button',{name:'index.mdを閉じる',exact:true}).click();
  await page.locator('#unsaved-changes-dialog [data-unsaved-action=cancel]').click();await idle();
  assert.match(await page.locator('#markdown-editor').inputValue(),/Close cancellation draft/,'cancelled tab close preserves its draft');
  await page.getByRole('button',{name:'index.mdを閉じる',exact:true}).click();
  await page.locator('#unsaved-changes-dialog [data-unsaved-action=save]').click();await idle();
  assert.match(await readFile(path.join(root,'docs/index.md'),'utf8'),/Close cancellation draft/,'closing a tab can save its draft');
  await tree('docs/index.md');
  await page.locator('#tree-search').fill('nested');await page.locator('[data-folder="docs/nested"]>summary').click({button:'right'});
  await page.getByRole('menuitem',{name:'フォルダーを作成',exact:true}).click();assert.equal(await page.locator('#new-folder-path').inputValue(),'docs/nested/');await page.locator('#new-folder-path').fill('docs/nested/new-folder');await page.locator('#new-folder-form button[type=submit]').click();await idle();
  await readFile(path.join(root,'docs/index.md'));assert.equal((await rpc('state')).includes('docs/nested/new-folder'),true);
  await page.locator('[data-folder="docs/nested"]>summary').click({button:'right'});await page.getByRole('menuitem',{name:'Markdownを作成',exact:true}).click();await page.locator('#new-page-path').fill('docs/nested/new-page.md');await page.locator('#new-page-title').fill('New page');await page.locator('#new-page-form button[type=submit]').click();await idle();assert.match(await readFile(path.join(root,'docs/nested/new-page.md'),'utf8'),/# New page/);
  await tree('docs/output.md');await page.getByRole('button',{name:'Milkdown編集',exact:true}).click();
  await page.locator('.ai-output-metadata').first().waitFor({state:'attached'});assert.equal(await page.locator('.ai-output-metadata').first().isVisible(),false);assert.match(await page.locator('.milkdown-ai-task-body').textContent(),/Generated body/);assert.match(await page.locator('#markdown-editor').inputValue(),/ai:generated/);
  // Preserve rich editor undo state when switching between document tabs.
  await page.locator('.milkdown-ai-task-body p').last().click();await page.keyboard.press('End');await page.keyboard.type(' rich draft');const richDraft=await page.locator('#markdown-editor').inputValue();
  await page.locator('[data-document-page="index.md"]').click();await idle();await page.locator('[data-document-page="output.md"]').click();await idle();assert.equal(await page.locator('#markdown-editor').inputValue(),richDraft);
  await page.locator('.milkdown-ai-task-body p').last().click();await page.keyboard.press('Control+z');assert.doesNotMatch(await page.locator('#markdown-editor').inputValue(),/rich draft/);
  // Display customization persists and can be reset.
  await page.locator('#settings-menu>summary').click();await page.getByRole('button',{name:'外観設定',exact:true}).click();await page.locator('#toolbar-customization>summary').click();
  const bold=page.locator('#toolbar-customization-list label').filter({hasText:/^太字$/}).locator('input');await bold.uncheck();assert.equal(await page.locator('.milkdown-top-bar button[aria-label="太字"]').isVisible(),false);
  await page.locator('#reset-toolbar-customization').click();assert.equal(await bold.isChecked(),true);await page.locator('[data-close-dialog=panel-appearance]').click();
  // Shared originals and reusable scene/crop templates create independent candidates.
  const registered=JSON.parse(await rpc('screenshots-register',{json:{source:`data:image/png;base64,${png.toString('base64')}`,scene:{canvas:{width:png.readUInt32BE(16),height:png.readUInt32BE(20)},annotations:[]},name:'Template source'}}));const id=registered.screenshot.id;
  const template=JSON.parse(await rpc('screenshots-change',{id,json:{save_template:'Reusable annotation'}}));assert.equal(JSON.parse(await rpc('screenshots-templates')).items.length,1);
  const copy=JSON.parse(await rpc('screenshots-change',{id,json:{copy:true}}));const adopted=copy.screenshot.adopted;
  const applied=JSON.parse(await rpc('screenshots-change',{id:copy.screenshot.id,json:{apply_template:template.id}}));assert.equal(applied.screenshot.adopted,adopted);assert.equal(applied.screenshot.edits.at(-1).scene.annotations.length,0);
  assert.equal(JSON.parse(await rpc('screenshots-image',{id:copy.screenshot.id,json:{original:true}})).data,`data:image/png;base64,${png.toString('base64')}`);
  const report=JSON.parse(await rpc('screenshots-diagnose'));assert.match(report.items[0].checks.join(' '),/撮影手順なし/);
  await page.locator('[data-tab=screenshots]').click();await page.locator('#screenshot-library-refresh').evaluate(button=>button.click());await idle();await page.locator('.screenshot-management').first().locator('summary').click();await page.getByRole('button',{name:'共有関係',exact:true}).first().click();await page.getByRole('heading',{name:'共有原本と使用原稿'}).waitFor();assert.match(await page.locator('dialog[open]').textContent(),/派生画像2枚/);await page.locator('dialog[open]').getByRole('button',{name:'閉じる',exact:true}).click();
  // Generate via a local HTTP fixture and insert only after reviewing the saved image.
  await rpc('image-generation-settings',{json:{save:true,model:'fixture-image-model',endpoint:`http://127.0.0.1:${api.address().port}/images/generations`}});
  await page.locator('[data-tab=editor]').click();await page.locator('#editor-more>summary').click();await page.locator('#generate-ai-image').click();await idle();const drawing=page.locator('[data-ai-image]');await drawing.getByRole('textbox',{name:'画像の指示'}).fill('A diagram illustration');await drawing.locator('details>summary').click();await drawing.locator('input[type=password]').fill('fixture-key');await drawing.getByRole('button',{name:'画像を生成',exact:true}).click();await idle();await drawing.locator('img').waitFor();assert.equal(requests,1);
  const settings=await readFile(path.join(root,'.munin/image-generation.json'),'utf8');assert.doesNotMatch(settings,/fixture-key/);assert.match(await drawing.locator('[role=status]').textContent(),/画像を保存/);
  await drawing.getByRole('button',{name:'原稿に挿入',exact:true}).click();await page.getByRole('combobox',{name:'挿入先の原稿',exact:true}).selectOption('index.md');await page.getByRole('combobox',{name:'挿入先の位置',exact:true}).selectOption('end');await page.getByRole('button',{name:'ここに挿入',exact:true}).click();await idle();assert.match(await page.locator('#markdown-editor').inputValue(),/generated\/ai-image-/);
  const beforeFailure=await page.locator('#markdown-editor').inputValue();fail=true;
  await assert.rejects(()=>rpc('image-generate',{json:{prompt:'failed',api_key:'fixture-key',size:'1024x1024'}}),/HTTP 401/);assert.equal(await page.locator('#markdown-editor').inputValue(),beforeFailure);
  assert.deepEqual(errors,[]);console.log('Document tabs, draft/history retention, image tabs/drop, tree context creation, hidden AI metadata, toolbar customization, screenshot templates/relationships/diagnosis, and image API generation/insertion checks passed.');
} finally {await browser?.close();server?.kill();await new Promise(resolve=>api?api.close(resolve):resolve());await rm(root,{recursive:true,force:true});}
