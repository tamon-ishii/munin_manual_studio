import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
import path from 'node:path';
const base='http://127.0.0.1:5174';
const config={docs:'docs',output:'manual',assets:'docs/assets',connection_type:'none',agent:'codex',model:'',mkdocs:{site_name:'Guide',theme:'material',language:'ja',use_directory_urls:true}};
let server,browser;
try {
  server=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--config','apps/manual-studio/vite.config.ts'],{stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  await page.route('**/__manual/rpc',async route=>{
    const {action}=route.request().postDataJSON();
    const result=action==='state'?{has_config:true,config,brief:'',pages:[],project_entries:[],tasks:[],image_assets:{},capture_sources:{},agents:[]}:action==='screenshots-list'?{items:[0,1,2].map(i=>({id:`shot-${i}`,capture_id:'shared-source',name:`画面 ${i+1}：`+'長い名前'.repeat(12),adopted:'revision',protected:false,edits:[{id:'revision',created_at:'2026-10-10',flattened:false}],usage:['docs/'+ 'long-directory/'.repeat(8)+'guide.md'],recipe:null,thumbnail:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" fill="#e5edf5"/><text x="24" y="120" font-size="24">Screenshot fixture</text></svg>')}))}:{};
    await route.fulfill({json:{output:JSON.stringify(result)}});
  });
  await page.goto(`${base}/?root=/tmp/munin-dialog-layout-fixture`);
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  await page.getByRole('button',{name:'アプリ登録',exact:true}).click();
  for(let i=0;i<4;i++) await page.locator('#add-launch-command').click();
  await page.locator('[data-launch-program="0"]').fill('/path with spaces/'+ 'very-long-folder/'.repeat(12)+'app');
  const dialogs=await page.locator('dialog[id]').evaluateAll(nodes=>nodes.map(node=>node.id));
  for(const viewport of [{width:1440,height:960},{width:960,height:640},{width:640,height:480}]){
    await page.setViewportSize(viewport);
    for(const id of dialogs){
      const result=await page.evaluate(id=>{
        document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());
        const dialog=document.getElementById(id);dialog.showModal();
        const box=dialog.getBoundingClientRect();
        return {x:box.x,y:box.y,right:box.right,bottom:box.bottom,overflow:dialog.scrollWidth-dialog.clientWidth};
      },id);
      assert.ok(result.x>=-1&&result.y>=-1&&result.right<=viewport.width+1&&result.bottom<=viewport.height+1,`${id} outside ${JSON.stringify(viewport)}: ${JSON.stringify(result)}`);
      assert.ok(result.overflow<=2,`${id} horizontal overflow at ${viewport.width}: ${result.overflow}`);
    }
  }
  await page.setViewportSize({width:1440,height:960});
  await page.evaluate(()=>{document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());const dialog=document.getElementById('panel-applications');dialog.showModal();dialog.scrollTop=0;});
  await page.screenshot({path:'/tmp/munin-ui-applications.png'});
  await page.setViewportSize({width:640,height:480});
  await page.locator('#panel-applications').evaluate(dialog=>dialog.scrollTop=dialog.scrollHeight);
  assert.equal(await page.locator('#save-launch-commands').isVisible(),true);
  await page.screenshot({path:'/tmp/munin-ui-applications-small.png'});
  await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close()));
  await page.locator('[data-tab=screenshots]').click();
  await page.locator('.screenshot-library-card').first().waitFor();
  await page.setViewportSize({width:1440,height:960});
  assert.ok((await page.locator('#panel-screenshots').boundingBox()).width>720,'image library opens in the main work area');
  assert.equal(await page.locator('.screenshot-primary-actions button').count(),12,'four primary actions per image');
  assert.equal(await page.locator('.screenshot-management[open]').count(),0,'management begins collapsed');
  await page.locator('.screenshot-library-card').first().getByRole('button',{name:'文書に挿入',exact:true}).click();
  await page.locator('[data-screenshot-destination]').waitFor();
  assert.equal(await page.getByRole('button',{name:'ここに挿入',exact:true}).isEnabled(),false,'missing destination cannot be inserted');
  await page.locator('[data-screenshot-destination]').getByRole('button',{name:'閉じる',exact:true}).click();
  for(const viewport of [{width:1440,height:960},{width:960,height:640},{width:640,height:480}]){
    await page.setViewportSize(viewport);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'workspace fits viewport horizontally');
    const overflow=await page.locator('.screenshot-library-card').evaluateAll(cards=>cards.map(card=>card.scrollWidth-card.clientWidth));
    assert.ok(overflow.every(value=>value<=2),`image cards overflow at ${viewport.width}: ${overflow}`);
  }
  await page.setViewportSize({width:1440,height:960});
  await page.screenshot({path:'/tmp/munin-ui-screenshots.png'});
  console.log(`${dialogs.length} dialogs fit 1440×960, 960×640, and 640×480; long paths and four application forms remain contained.`);
} finally {await browser?.close();if(server)server.kill();}
