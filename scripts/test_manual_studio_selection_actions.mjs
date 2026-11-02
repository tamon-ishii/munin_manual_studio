import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {chromium} from 'playwright-core';

const base='http://127.0.0.1:5188';
let server,browser;
try {
  server=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--config','apps/manual-studio/vite.config.ts','--port','5188'],{stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  browser=await chromium.launch({channel:process.env.MUNIN_TEST_BROWSER||(process.platform==='win32'?'msedge':'chrome'),headless:true});
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const requests=[];
  const state={has_config:true,config:{docs:'docs',assets:'docs/assets',output:'site',agent:'codex',model:'',connection_type:'none',mkdocs:{site_name:'Test',theme:'material',language:'ja',use_directory_urls:true}},brief:'',pages:['index.md'],project_entries:[{path:'docs/index.md',directory:false}],image_assets:{},agents:[]};
  state.agents=[{id:'codex',label:'Codex',available:true},{id:'claude',label:'Claude',available:true},{id:'agy',label:'Agy',available:true}];
  state.config.cli_models={codex:'codex-test',claude:'claude-test',agy:'agy-test'};
  let text='# Test\n\n選択した文章です。\n';
  await page.route('**/__manual/rpc',async route=>{
    const request=route.request().postDataJSON();requests.push(request);
    let output={};
    switch(request.action){
      case 'state': output=state;break;
      case 'editor-read': output={page:'index.md',content:text,revision:'r1'};break;
      case 'editor-save': text=request.options.json.content;output={page:'index.md',content:text,revision:'r1'};break;
      case 'image-generation-settings': output={connection_type:'none',endpoint_url:'',model:''};break;
      case 'preview-page': output='<html><body>Preview</body></html>';break;
      case 'selection-generate':output={content:request.options.json.mode==='consult'?'説明を具体的にすると伝わります。':'書き直した文章です。'};break;
      case 'agent-progress':output={logs:[],total:0};break;
      case 'save':state.config={...state.config,...request.options,cli_models:request.options.json?.cli_models||state.config.cli_models};output=state;break;
    }
    await route.fulfill({json:{output:typeof output==='string'?output:JSON.stringify(output)}});
  });
  await page.goto(base+'/?root=test-project');
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false'&&document.querySelector('#save-page')&&!document.querySelector('#save-page').disabled);
  assert.equal(await page.locator('#tree-filters').isVisible(),false);
  await page.keyboard.press('Control+f');await page.locator('#tree-search').waitFor({state:'visible'});
  await page.locator('#tree-search').fill('missing');assert.equal(await page.locator('[data-page="docs/index.md"]').count(),0);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#tree-filters').isVisible(),false);assert.equal(await page.locator('#tree-search').inputValue(),'');
  assert.equal(await page.locator('#panel-screenshots,#panel-applications,#editor-screenshot-options').count(),0);
  assert.equal(requests.some(r=>r.action==='resources-list'),false);
  await page.locator('[data-tab="settings"]').click();
  await page.getByRole('textbox',{name:'Codexのモデル',exact:true}).fill('codex-custom');
  await page.getByRole('textbox',{name:'Claudeのモデル',exact:true}).fill('claude-custom');
  await page.getByRole('textbox',{name:'Agyのモデル',exact:true}).fill('agy-custom');
  await page.waitForFunction(()=>document.querySelector('#ai-save-state').textContent==='保存済み');
  assert.deepEqual(state.config.cli_models,{codex:'codex-custom',claude:'claude-custom',agy:'agy-custom'});
  await page.locator('#ai-connection-type').selectOption('cli');
  assert.equal(await page.locator('#ai-model').inputValue(),'codex-custom');
  await page.locator('#ai-agent').selectOption('claude');
  assert.equal(await page.locator('#ai-model').inputValue(),'claude-custom');
  await page.waitForFunction(()=>document.querySelector('#ai-save-state').textContent==='保存済み');
  assert.deepEqual(state.config.cli_models,{codex:'codex-custom',claude:'claude-custom',agy:'agy-custom'});
  await page.locator('[data-close-dialog="panel-settings"]').click();
  async function selectText(mode='consult'){
    const paragraph=page.locator('.ProseMirror p').filter({hasText:'選択した文章です。'}).first();
    await paragraph.click();await page.keyboard.press('Home');await page.keyboard.press('Shift+End');
    const toolbar=page.locator('.milkdown-toolbar[data-show="true"]');
    await toolbar.waitFor();
    assert.equal(await toolbar.evaluate(el=>el.scrollWidth<=el.clientWidth&&el.scrollHeight<=el.clientHeight),true,'selection toolbar has no overflow');
    const ai=toolbar.getByRole('button',{name:'AI操作',exact:true});
    assert.equal(await ai.evaluate(el=>el.scrollWidth<=el.clientWidth),true,'AI label fits its button');
    await page.locator('.milkdown-toolbar').getByRole('button',{name:'AI操作',exact:true}).click();
    await page.locator('#selection-ai-action-dialog').waitFor();
    assert.equal(await page.getByRole('combobox',{name:'AI操作',exact:true}).inputValue(),'rewrite','rewriting is the default');
    await page.getByRole('combobox',{name:'AI操作',exact:true}).selectOption(mode);
  }
  const before=await page.locator('#markdown-editor').inputValue();
  await selectText('rewrite');await page.getByRole('combobox',{name:'相談先のAI',exact:true}).selectOption('claude');
  await page.getByRole('textbox',{name:'相談内容・指示',exact:true}).fill('短く書き直す');await page.getByRole('button',{name:'AIに送信',exact:true}).click();
  await page.locator('#selection-diff-dialog').waitFor();assert.equal(await page.locator('#markdown-editor').inputValue(),before);
  assert.equal(requests.filter(r=>r.action==='selection-generate').at(-1).options.json.cli_agent,'claude');
  await page.getByRole('button',{name:'破棄',exact:true}).click();
  await selectText();await page.getByRole('textbox',{name:'相談内容・指示',exact:true}).fill('伝わりやすくするには？');await page.getByRole('button',{name:'AIに送信',exact:true}).click();
  await page.locator('#selection-ai-advice-dialog').waitFor();assert.match(await page.locator('#selection-ai-advice-dialog').textContent(),/具体的/);
  assert.equal(await page.locator('#markdown-editor').inputValue(),before);assert.equal(requests.filter(r=>r.action==='selection-generate').at(-1).options.json.mode,'consult');
  await page.locator('#selection-ai-advice-dialog').getByRole('button',{name:'閉じる',exact:true}).click();
  await page.setViewportSize({width:360,height:800});
  await selectText();await page.getByRole('combobox',{name:'相談先のAI',exact:true}).selectOption('agy');await page.getByRole('textbox',{name:'相談内容・指示',exact:true}).fill('伝わりやすくするには？');await page.getByRole('button',{name:'AIに送信',exact:true}).click();
  await page.locator('#selection-ai-advice-dialog').waitFor();
  await page.getByRole('textbox',{name:'書き直しへの追加指示（任意）',exact:true}).fill('短くする');
  await page.getByRole('button',{name:'選択範囲を書き直す',exact:true}).click();
  await page.locator('#selection-diff-dialog').waitFor();assert.equal(await page.locator('#markdown-editor').inputValue(),before);
  await page.getByRole('button',{name:'選んだ変更を反映',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#markdown-editor').value.includes('書き直した文章です。'));
  const rewrite=requests.filter(r=>r.action==='selection-generate').at(-1).options.json;
  assert.equal(rewrite.mode,'replace');
  assert.equal(rewrite.cli_agent,'agy');
  assert.equal(requests.filter(r=>r.action==='selection-generate').at(-2).options.json.cli_agent,'agy');
  assert.match(rewrite.selected,/選択した文章です/);
  assert.match(rewrite.instruction,/伝わりやすくするには？/);
  assert.match(rewrite.instruction,/説明を具体的にすると伝わります/);
  assert.match(rewrite.instruction,/短くする/);
  assert.deepEqual(errors,[]);
  console.log('Tree search shortcut, removed capture UI, selection consultation and reviewed rewrite passed.');
} finally {await browser?.close();server?.kill();}
