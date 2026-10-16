import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
const production = process.env.MUNIN_TEST_PRODUCTION === '1';
const base = `http://127.0.0.1:${production ? 5175 : 5174}`;
const tasks = [
  { id:'write', kind:'text', page:'docs/index.md', prompt:'Explain', status:'missing' },
  { id:'screen', kind:'screenshot', page:'docs/index.md', prompt:'Capture', status:'current' },
  { id:'diagram', kind:'diagram', page:'docs/index.md', prompt:'Draw', status:'stale' },
  { id:'protected', kind:'text', page:'docs/index.md', prompt:'Keep', status:'approved' },
];
const content = '# Guide\n\n' + (production ? '```mermaid\ngraph TD\n A[Start] --> B[End]\n```\n\n' : '') + tasks.map(task => `<!-- ai:task id=${task.id} kind=${task.kind} prompt="${task.prompt}" ${task.status === 'approved' ? 'approved-at=2026-10-08T00:00:00Z' : ''} -->\n${task.status === 'missing' ? '' : 'Existing result'}\n<!-- /ai:task -->`).join('\n\n');
const state = { has_config:true, config:{docs:'docs', output:'manual', agent:'codex', model:'test', connection_type:'local_llm', endpoint_url:'http://localhost:11434/v1', mkdocs:{site_name:'Guide',theme:'material',language:'ja',use_directory_urls:true}}, brief:'', pages:['docs/index.md'], project_entries:[{path:'docs/index.md',directory:false}], tasks, capture_sources:{}, image_assets:{},  agents:[] };
const inputFor = ids => ({page:'docs/index.md',revision:'r1',existing_content:content,tasks:tasks.filter(task => task.kind !== 'screenshot' && task.status !== 'approved' && (!ids || ids.includes(task.id))),references:[],source_note:'Test',feedback:'',connection_type:'local_llm',agent:'codex',model:'test',requests:[]});
let browser, server, saveFails=false, saveMessage="原稿が変更されています", saveDelay=0, previewFails=false, previewDelay=0;
const actions=[];
try {
  server=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'), ...(production ? ['preview', '--port', '5175', '--strictPort'] : []), '--config','apps/manual-studio/vite.config.ts'],{stdio:'ignore'});
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
      if(saveFails){await route.fulfill({status:500,json:{error:saveMessage}});return;}
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
  assert.equal(await page.locator('[data-tab=uimap],#panel-uimap,#map-refresh,#explore-web,#import-map').count(),0);
  await page.waitForFunction(()=>document.querySelector('#editor-title').textContent==='docs/index.md');
  const idle=()=>page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');await idle();
  // The panel shares data-editor-view with the controls, but must never inherit
  // a native tooltip containing the entire editor UI and document.
  if (production) await page.locator('.mermaid-preview svg').first().waitFor();
  const editorPanel=page.locator('#panel-editor');
  assert.equal(await editorPanel.getAttribute('title'),null);
  assert.equal(await editorPanel.getAttribute('aria-pressed'),null);
  const viewControls=page.locator('#panel-editor button[data-editor-view]');
  assert.equal(await viewControls.count(),3);
  for(const mode of ['edit','preview','split']) {
    const control=page.locator(`#panel-editor button[data-editor-view="${mode}"]`);
    await control.click();
    assert.equal(await editorPanel.getAttribute('data-editor-view'),mode);
    assert.equal(await editorPanel.getAttribute('title'),null);
    assert.equal(await editorPanel.getAttribute('aria-pressed'),null);
    assert.equal(await control.getAttribute('aria-pressed'),'true');
    assert.ok((await control.getAttribute('title')).length<60);
  }

  assert.equal(await page.locator('.document-heading #document-tabs').count(),1);
  if(!await page.locator('#editor-more').evaluate(el=>el.open)) await page.locator('#editor-more > summary').click();

  await page.getByRole('button',{name:'執筆方針',exact:true}).click();
  assert.equal(await page.locator('#panel-brief #manual-brief').isVisible(),true);
  await page.locator('[data-close-dialog=panel-brief]').click();
  await page.locator('.column-label button').click();
  await page.locator('#markdown-editor').evaluate(el=>{el.focus();el.setSelectionRange(0,7);el.dispatchEvent(new Event('select'));});
  assert.match(await page.locator('#selection-ai').textContent(),/選択範囲をAIで編集/);
  await page.locator('#markdown-editor').evaluate(el=>{el.setSelectionRange(7,7);el.dispatchEvent(new Event('select'));});
  assert.match(await page.locator('#selection-ai').textContent(),/AIで文章を挿入/);
  await page.locator('.column-label button').click();
  await page.locator('#milkdown-editor .ProseMirror').focus();
  for(let attempt=0;attempt<5;attempt++){
    await page.keyboard.press('Control+Home');await page.keyboard.press('Shift+End');
    await page.waitForFunction(()=>document.querySelector('#selection-ai').textContent.includes('選択範囲をAIで編集'));
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(()=>document.querySelector('#selection-ai').textContent.includes('AIで文章を挿入'));
  }
  await page.evaluate(()=>localStorage.setItem('manual-studio-workspace-history',JSON.stringify(['/tmp/munin-ui-fixture','/tmp/second-folder','/tmp/third-folder'])));
  await page.locator('#workspace-name').focus();await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#workspace-name').getAttribute('aria-expanded'),'true');
  assert.equal(await page.locator('#workspace-history-dialog [aria-selected=true]').count(),1);
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-workspace-root')),'/tmp/second-folder');
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-workspace-root')),'/tmp/munin-ui-fixture');
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(()=>document.activeElement?.hasAttribute('data-history-close')),true);

  assert.equal(await page.locator('#workspace-history-dialog').getAttribute('role'),'listbox');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#workspace-name').getAttribute('aria-expanded'),'false');
  await page.locator('#tree-create-menu>summary').click();
  assert.equal(await page.locator('#new-page').isVisible(),true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#tree-create-menu').getAttribute('open'),null);
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
  await page.locator('#editor-more > summary').click();await page.locator('#shortcut-help').click();assert.equal(await page.locator('#shortcut-help-dialog').isVisible(),true);
  await page.locator('#shortcut-help-dialog [data-close]').click();
  const priorView=await page.locator('#panel-editor').getAttribute('data-editor-view');
  await page.keyboard.press('Control+Shift+P');assert.notEqual(await page.locator('#panel-editor').getAttribute('data-editor-view'),priorView);
  await page.locator('#panel-editor button[data-editor-view=split]').click();
  saveDelay=600;saveFails=true;await page.keyboard.press('Control+s');
  await page.waitForFunction(()=>document.querySelector('#save-state').dataset.state==='saving');await idle();
  assert.equal(await page.locator('#save-state').getAttribute('data-state'),'error');
  assert.match(await page.locator('#save-state').getAttribute('title'),/原稿が変更/);
  assert.equal(await page.locator('#save-conflict').isVisible(),true);
  const retained=await page.locator('#markdown-editor').inputValue();
  await page.locator('#save-conflict').click();await idle();
  assert.equal(await page.locator('#save-conflict-dialog').isVisible(),true);
  assert.equal(await page.locator('#markdown-editor').inputValue(),retained);
  await page.getByRole('button',{name:'編集中の内容を保持して閉じる'}).click();

  saveFails=false;saveDelay=0;await page.keyboard.press('Control+s');await idle();
  assert.equal(await page.locator('#save-state').getAttribute('data-state'),'saved');
  saveFails=true;saveMessage='保存先に書き込めません';await page.keyboard.press('Control+s');await idle();
  assert.equal(await page.locator('#save-retry').isVisible(),true);
  assert.equal(await page.locator('#save-conflict').isVisible(),false);
  saveFails=false;await page.locator('#save-retry').click();await idle();
  assert.equal(await page.locator('#save-state').getAttribute('data-state'),'saved');
  assert.equal(await page.locator('#save-retry').isVisible(),false);

  await page.locator('[data-tab=publish]').click();
  assert.equal(await page.locator('#build-html,#build-mode,#open-output').count(),0);assert.equal(await page.locator('#quality-check').isVisible(),true);assert.equal(await page.locator('#generate-draft').isVisible(),false,'AI draft creation is an authoring action, not an output action');
  assert.equal(await page.locator('#ai-connection-type').isVisible(),false);
  await page.locator('[data-close-dialog=panel-publish]').click();
  await page.locator('[data-tab=settings]').click();
  assert.equal(await page.locator('#ai-connection-type').isVisible(),true);
  assert.equal(await page.locator('#panel-settings #manual-brief').count(),0);
  assert.equal(await page.locator('#save-launch-commands').isVisible(),false);
  const savesBefore=actions.filter(action=>action==='editor-save').length;
  await page.locator('#ai-model').focus();await page.keyboard.press('Control+s');
  assert.equal(actions.filter(action=>action==='editor-save').length,savesBefore,'settings shortcuts do not save the document');
  await page.locator('[data-close-dialog=panel-settings]').click();
  assert.equal(await page.locator('[data-tab=tasks],#generate-page,#generate-all-pages').count(),0);
  assert.equal(await page.locator('#reader-review,#selection-ai').count(),2);
  const rich=page.locator('#milkdown-editor');
  await rich.getByText('挿入・その他',{exact:true}).click();
  assert.equal(await rich.getByText('Mermaidの図を挿入',{exact:true}).isVisible(),true);
  await rich.getByText('Mermaidの図を挿入',{exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('graph TD'));
  // Capture is an independent panel and AI instructions contain no screenshot operation.
  await page.locator('[data-tab=screenshots]').click();
  assert.equal(await page.locator('#screenshot-library-record').isVisible(),true);
  await page.locator('#resource-management-menu>summary').click();
  assert.equal(await page.locator('#screenshot-library-recapture-all').isVisible(),true);
  await page.keyboard.press('Escape');
  await page.locator('[data-tab=editor]').click();
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

  await page.evaluate(()=>localStorage.removeItem('manual-studio-project'));
  await page.goto(base);await idle();
  assert.equal(await page.locator('#editor-empty-state').isVisible(),true);
  assert.equal(await page.locator('#empty-open-folder').isVisible(),true);
  assert.equal(await page.locator('#editor-workspace').isVisible(),false);
  await page.locator('#empty-open-folder').click();
  assert.equal(await page.locator('#workspace-dialog').isVisible(),true);
  await page.locator('#cancel-open-workspace').click();
  state.pages=[];state.project_entries=[];
  await page.goto(`${base}/?root=${encodeURIComponent('/tmp/munin-empty-fixture')}`);await idle();
  assert.equal(await page.locator('#empty-create-page').isVisible(),true);
  await page.locator('#empty-create-page').click();
  assert.equal(await page.locator('#new-page-dialog').isVisible(),true);
  await page.locator('#cancel-new-page').click();
  console.log('UI improvements passed: settings separation, AI assistance entry points, rich insert menu, source formatting, capture entry and themes.');
} finally { await browser?.close();server?.kill(); }
