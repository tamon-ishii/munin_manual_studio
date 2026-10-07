import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
const base = 'http://127.0.0.1:5174';
const tasks = [
  { id:'write', kind:'text', page:'docs/index.md', prompt:'Explain', status:'missing' },
  { id:'screen', kind:'screenshot', page:'docs/index.md', prompt:'Capture', status:'current' },
  { id:'diagram', kind:'diagram', page:'docs/index.md', prompt:'Draw', status:'stale' },
  { id:'protected', kind:'text', page:'docs/index.md', prompt:'Keep', status:'approved' },
];
const content = '# Guide\n\n' + tasks.map(task => `<!-- ai:task id=${task.id} kind=${task.kind} prompt="${task.prompt}" ${task.status === 'approved' ? 'approved-at=2026-10-08T00:00:00Z' : ''} -->\n${task.status === 'missing' ? '' : 'Existing result'}\n<!-- /ai:task -->`).join('\n\n');
const state = { has_config:true, config:{docs:'docs', output:'manual', agent:'codex', model:'test', connection_type:'local_llm', endpoint_url:'http://localhost:11434/v1', mkdocs:{site_name:'Guide',theme:'material',language:'ja',use_directory_urls:true}}, brief:'', pages:['docs/index.md'], project_entries:[{path:'docs/index.md',directory:false}], tasks, capture_sources:{}, image_assets:{}, ui_map:null, agents:[] };
const inputFor = ids => ({page:'docs/index.md',revision:'r1',existing_content:content,tasks:tasks.filter(task => task.status !== 'approved' && (!ids || ids.includes(task.id))),references:[],source_note:'Test',feedback:'',connection_type:'local_llm',agent:'codex',model:'test',requests:[]});
let browser, server, saveFails=false, saveDelay=0, previewFails=false, previewDelay=0;
const actions=[];
try {
  server=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--config','apps/manual-studio/vite.config.ts'],{stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/__manual/rpc', async route => {
    const {action,options}=route.request().postDataJSON(); actions.push(action);
    if(action==='generate-review') { await route.fulfill({status:500,json:{error:'Test generation failure'}});return; }
    let result;
    if(action==='state') result=state;
    else if(action==='page-tasks') result=tasks;
    else if(action==='editor-read') result={page:'docs/index.md',content,revision:'r1'};
    else if(action==='editor-preview') {
      if(previewDelay)await new Promise(resolve=>setTimeout(resolve,previewDelay));
      if(previewFails){await route.fulfill({status:500,json:{error:'Preview unavailable'}});return;}
      result='<html><body><h1>Guide</h1></body></html>';
    }
    else if(action==='editor-save') {
      if(saveDelay)await new Promise(resolve=>setTimeout(resolve,saveDelay));
      if(saveFails){await route.fulfill({status:500,json:{error:'原稿が変更されています'}});return;}
      result={page:options.page,content:options.json.content,revision:'r2'};
    }
    else if(action==='generation-input') result=inputFor(options.json?.ids);
    else if(action==='execution-begin') result={id:'123-1',entries:[]};
    else if(action==='agent-progress') result={logs:[]};
    else if(action==='preview-asset') {await route.fulfill({status:404,json:{error:'No image'}});return;}
    else result={};
    await route.fulfill({json:{output:typeof result==='string'?result:JSON.stringify(result)}});
  });
  await page.goto(`${base}/?root=${encodeURIComponent('/tmp/munin-ui-fixture')}`);
  await page.waitForFunction(()=>document.querySelector('#editor-title').textContent==='docs/index.md');
  const idle=()=>page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');await idle();
  // Shared outline icons stay visible and unfilled in the real editor toolbar.
  const iconStyles=await page.locator('.milkdown-top-bar .ui-icon, .preview-toolbar .ui-icon').evaluateAll(nodes=>nodes.map(node=>({fill:getComputedStyle(node.querySelector('path')).fill,width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height})));
  assert.ok(iconStyles.length>=5);
  for(const icon of iconStyles){assert.equal(icon.fill,'none');assert.equal(icon.width,20);assert.equal(icon.height,20);}
  const emptyDividers=await page.locator('.top-bar-divider').evaluateAll(nodes=>nodes.filter(node=>!node.previousElementSibling||node.previousElementSibling.classList.contains('top-bar-divider')||!node.nextElementSibling).length);
  assert.equal(emptyDividers,0,'empty toolbar groups do not leave separators');
  await page.waitForFunction(()=>document.querySelector('#preview-nav-status').dataset.state==='ready');
  previewDelay=600;await page.locator('#preview-nav-refresh').click();
  await page.waitForFunction(()=>document.querySelector('#preview-nav-status').dataset.state==='loading');
  assert.equal(await page.locator('#preview-nav-refresh').isDisabled(),true);await idle();previewDelay=0;
  previewFails=true;await page.locator('#preview-nav-refresh').click();await idle();
  assert.equal(await page.locator('#preview-nav-status').getAttribute('data-state'),'error');
  previewFails=false;await page.locator('#preview-nav-refresh').click();await idle();
  await page.locator('#shortcut-help').click();assert.equal(await page.locator('#shortcut-help-dialog').isVisible(),true);
  await page.locator('#shortcut-help-dialog [data-close]').click();
  const priorView=await page.locator('#panel-editor').getAttribute('data-editor-view');
  await page.keyboard.press('Control+Shift+P');assert.notEqual(await page.locator('#panel-editor').getAttribute('data-editor-view'),priorView);
  await page.locator('[data-editor-view=split]').click();
  saveDelay=600;saveFails=true;await page.locator('#save-page').click();
  await page.waitForFunction(()=>document.querySelector('#save-state').dataset.state==='saving');await idle();
  assert.equal(await page.locator('#save-state').getAttribute('data-state'),'error');
  assert.match(await page.locator('#save-state').getAttribute('title'),/原稿が変更/);
  saveFails=false;saveDelay=0;await page.keyboard.press('Control+s');await idle();
  assert.equal(await page.locator('#save-state').getAttribute('data-state'),'saved');
  await page.locator('[data-tab=publish]').click();
  assert.equal(await page.locator('#build-draft').isVisible(),true);
  assert.equal(await page.locator('#ai-connection-type').isVisible(),false);
  await page.locator('[data-close-dialog=panel-publish]').click();
  await page.locator('#settings-menu summary').click();await page.locator('[data-tab=settings]').click();
  assert.equal(await page.locator('#ai-connection-type').isVisible(),true);
  assert.equal(await page.locator('#save-launch-commands').isVisible(),true);
  const savesBefore=actions.filter(action=>action==='editor-save').length;
  await page.locator('#ai-model').focus();await page.keyboard.press('Control+s');
  assert.equal(actions.filter(action=>action==='editor-save').length,savesBefore,'settings shortcuts do not save the document');
  await page.locator('[data-close-dialog=panel-settings]').click();
  await page.locator('[data-tab=tasks]').click();
  assert.equal(await page.locator('#task-list article').count(),4);
  for(const [filter,id,label] of [['missing','write','未生成'],['current','screen','生成済み'],['stale','diagram','更新候補'],['approved','protected','確定済み']]) {
    await page.locator('#task-status-filter').selectOption(filter);
    assert.equal(await page.locator('#task-list article').count(),1);
    assert.equal(await page.locator('#task-list article').getAttribute('data-task'),id);
    assert.match(await page.locator('#task-list .badge').textContent(),new RegExp(label));
  }
  await page.locator('#task-status-filter').selectOption('all');await page.locator('#task-kind-filter').selectOption('diagram');
  assert.equal(await page.locator('#task-list article').count(),1);
  await page.locator('#task-kind-filter').selectOption('all');
  await page.locator('[data-tab=editor]').click();
  await page.locator('#generate-page').click();
  assert.match(await page.locator('#generation-input-summary').textContent(),/文章1件・画像1件・図1件を更新／確定済み1件は維持/);
  assert.equal(await page.locator('#generation-input-tasks input[value=protected]').count(),0);
  await page.locator('#generation-input-tasks input[value=screen]').uncheck();
  await page.waitForFunction(()=>document.querySelector('#generation-input-summary').textContent.includes('画像0件'));
  await page.locator('#generation-input-cancel').click();await idle();
  assert.ok(!actions.includes('generate-review'),'cancel does not generate');
  await page.locator('#generate-all-pages').click();
  assert.match(await page.locator('#generation-pages-summary').textContent(),/1文書.*確定済み1件/);
  await page.locator('.generation-page-choices input').uncheck();assert.equal(await page.locator('[data-run]').isDisabled(),true);
  await page.locator('[data-cancel]').click();await idle();
  // A failed AI run appears in the status filter without touching protected tags.
  await page.locator('#generate-page').click();await page.locator('#generation-input-run').click();await page.locator('#execution-failure-dialog [data-keep]').click();await idle();
  await page.locator('[data-tab=tasks]').click();await page.locator('#task-status-filter').selectOption('failed');
  assert.equal(await page.locator('#task-list article').count(),2);
  assert.match(await page.locator('#task-list').textContent(),/Test generation failure/);
  await page.locator('[data-tab=editor]').click();
  const rich=page.locator('#milkdown-editor');
  await rich.getByText('挿入・その他',{exact:true}).click();
  assert.equal(await rich.getByText('Mermaidの図を挿入',{exact:true}).isVisible(),true);
  await rich.getByText('Mermaidの図を挿入',{exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('graph TD'));
  // Capture stages are shown before recording, including browser-only guidance.
  await rich.getByText('AIタグを追加',{exact:true}).click();await rich.getByRole('button',{name:'撮影の指示',exact:true}).click();
  assert.equal(await page.locator('[data-capture-step][aria-current=step]').getAttribute('data-capture-step'),'1');
  assert.match(await page.locator('#capture-step-help').textContent(),/起動コマンド/);
  await page.locator('#cancel-screenshot-task').click();
  await page.locator('.column-label button').click();
  await page.locator('.format-insert-menu summary').click();
  assert.equal(await page.locator('[data-format=mermaid]').isVisible(),true);
  await page.locator('[data-format=mermaid]').click();
  const duplicateIds=await page.evaluate(()=>{const ids=[...document.querySelectorAll('[id]')].filter(el=>el instanceof HTMLElement && el.id).map(el=>el.id);return ids.filter((id,i)=>ids.indexOf(id)!==i);});
  assert.deepEqual(duplicateIds,[]);assert.deepEqual(errors,[]);
  await mkdir('/tmp/munin-ui-review',{recursive:true});
  for(const [theme,width] of [['forest',1440],['midnight',1440],['forest',900]]){
    await page.setViewportSize({width,height:960});
    await page.locator('[data-tab=appearance]').dispatchEvent('click');await page.locator('#ui-theme').selectOption(theme);await page.locator('[data-close-dialog=panel-appearance]').click();
    await page.screenshot({path:`/tmp/munin-ui-review/${theme}-${width}.png`});
  }
  // AI setup is optional, and dismissing the guide is scoped to the workspace.
  state.config.connection_type='none';await page.reload();await idle();
  assert.equal(await page.locator('#workspace-guide').isVisible(),true);
  await page.locator('#workspace-guide summary').click();await page.locator('[data-guide-settings]').click();
  assert.equal(await page.locator('#panel-settings').isVisible(),true);await page.locator('[data-close-dialog=panel-settings]').click();
  await page.locator('[data-guide-dismiss]').click();await page.reload();await idle();
  assert.equal(await page.locator('#workspace-guide').isVisible(),false);
  console.log('UI improvements passed: settings separation, filters, protected counts, cancellation, bulk selection, failure states, rich insert menu and capture step.');
} finally { await browser?.close();server?.kill(); }
