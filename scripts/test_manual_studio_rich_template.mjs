import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';

// Browser integration: native capture is replaced with a fixture; plain AI
// authoring, transcript polling, image preview and adoption use the real backend.
const base=process.env.MANUAL_STUDIO_TEST_URL||'http://127.0.0.1:5174';
const root=await mkdtemp(path.join(os.tmpdir(),'munin-rich-template-'));
let browser,phase='rich',capturedOptions,requests=0;
const api=createServer(async(request,response)=>{
  let raw='';for await(const chunk of request)raw+=chunk;
  const body=JSON.parse(raw);requests++;
  assert.ok(body.messages.some(message=>String(message.content).includes('Use tables and procedures')));
  response.setHeader('content-type','application/json');
  response.end(JSON.stringify({choices:[{message:{content:JSON.stringify({pages:[{path:'index.md',content:'# Plain rich structure\n\n| Step | Result |\n| --- | --- |\n| Save | Saved |'}]})}}]}));
});
try{
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  await mkdir(path.join(root,'docs/assets'),{recursive:true});
  await writeFile(path.join(root,'docs/index.md'),'# Original manuscript\n');
  await writeFile(path.join(root,'docs/assets/fixture.png'),await readFile('apps/manual-studio/src-tauri/icons/icon.png'));
  await writeFile(path.join(root,'manual_setting.json'),JSON.stringify({docs:'docs',assets:'docs/assets',targets:['docs'],connection_type:'api',endpoint_url:`http://127.0.0.1:${api.address().port}/v1`,agent:'agy',model:'fixture'}));
  await mkdir(path.join(root,'.munin'),{recursive:true});await writeFile(path.join(root,'.munin/target-application.json'),JSON.stringify({command:'fixture-app',arguments:[],working_directory:'.',information:'Fixture app'}));
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/__manual/rpc',async route=>{
    const {action,options}=route.request().postDataJSON();
    if(action==='list-windows'){await route.fulfill({json:{output:JSON.stringify([{id:'fixture',title:'Fixture app'}])}});return;}
    if(action==='agent-progress'&&phase==='rich'){
      const logs=[{time:'12:00:00',message:'AIへ送信',detail:'Create a rich manual with a screenshot'},{time:'12:00:01',message:'撮影ツールの実行結果',detail:'fixture.png was captured'},{time:'12:00:02',message:'AIからの応答',detail:'Rich manual candidate'}];
      await route.fulfill({json:{output:JSON.stringify({logs,total:logs.length})}});return;
    }
    if(action==='draft-propose'&&phase==='rich'){
      capturedOptions=options.json;
      await new Promise(resolve=>setTimeout(resolve,950));
      await route.fulfill({json:{output:JSON.stringify({docs:'guide',pages:[{path:'index.md',before:'',revision:null,content:'# Rich manual candidate\n\n![Fixture](../docs/assets/fixture.png)\n\n| Step | Result |\n| --- | --- |\n| Save | Saved |\n\n```mermaid\nflowchart LR\n  A --> B\n```'}],screenshots:[{path:'docs/assets/fixture.png',caption:'Fixture screenshot'}]})}});return;
    }
    const response=await route.fetch({headers:{...route.request().headers(),origin:'http://127.0.0.1:5174'}});await route.fulfill({response});
  });
  await page.goto(`${base}/?root=${encodeURIComponent(root)}&page=index.md`);
  await page.waitForFunction(()=>document.querySelector('#markdown-editor')?.value.includes('Original manuscript'));
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  await page.locator('#create-ai-template').click();
  const dialog=page.locator('#template-creation-dialog');
  await page.waitForFunction(()=>document.querySelector('.template-ai-guide pre')?.textContent.includes('AI向け：Manual Studio・MarkIts'));
  assert.equal(await dialog.locator('[name=include_screenshots]').isChecked(),true);
  await dialog.getByText('対象アプリ：fixture-app',{exact:true}).waitFor();
  await dialog.locator('[name=destination]').fill('guide');
  await dialog.locator('[name=instruction]').fill('Explain saving with screenshots');
  await dialog.getByRole('button',{name:'雛形の候補を作成',exact:true}).click();
  await page.locator('#draft-diff-dialog').waitFor();
  assert.equal(capturedOptions.include_screenshots,true);assert.equal(capturedOptions.target_application,true);assert.equal(capturedOptions.window,undefined);assert.equal(await page.locator('#operation-workbench-dialog').count(),0);
  assert.equal(capturedOptions.instruction,'Explain saving with screenshots');
  const image=page.locator('#draft-diff-dialog .draft-screenshots img');
  await image.waitFor();await page.waitForFunction(()=>document.querySelector('.draft-screenshots img')?.naturalWidth>0);
  assert.match(await page.locator('#progress-log').textContent(),/Create a rich manual with a screenshot/);
  assert.match(await page.locator('#progress-log').textContent(),/Rich manual candidate/);
  assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),'# Original manuscript\n');
  await page.locator('#draft-diff-dialog').getByRole('button',{name:'選んだ変更を反映',exact:true}).click();
  await page.locator('#draft-diff-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  assert.match(await readFile(path.join(root,'guide/index.md'),'utf8'),/fixture.png/);
  phase='plain';
  await page.locator('#create-ai-template').click();
  await dialog.locator('[name=include_screenshots]').uncheck();
  await dialog.locator('[name=destination]').fill('plain-template');
  await dialog.locator('[name=instruction]').fill('Use tables and procedures');
  await dialog.getByRole('button',{name:'雛形の候補を作成',exact:true}).click();
  await page.locator('#draft-diff-dialog').waitFor();
  assert.equal(requests,1);
  const log=await page.locator('#progress-log').textContent();
  assert.ok(log.includes('Use tables and procedures'),'real outgoing AI instruction is visible');
  assert.ok(log.includes('Plain rich structure'),'real AI response is visible');
  assert.ok(log.includes('AI向け：Manual Studio・MarkIts'),'the capability guide is included in the actual outgoing prompt');
  await page.locator('#draft-diff-dialog').getByRole('button',{name:'破棄',exact:true}).click();
  assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),'# Original manuscript\n');
  assert.deepEqual(errors,[]);
  console.log('Rich template UI passed: target/instruction options, automatic-mode request, screenshot preview, review/adoption, real API request/response execution logs, text-only fallback.');
}finally{await browser?.close();await new Promise(resolve=>api.close(resolve));await rm(root,{recursive:true,force:true});}
