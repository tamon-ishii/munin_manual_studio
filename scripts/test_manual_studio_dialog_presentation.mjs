import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';

const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','apps/manual-studio/vite.config.ts','--host','127.0.0.1','--port','5190'],{stdio:'pipe'});
let browser;
try{
  for(let i=0;i<100;i++){
    try{if((await fetch('http://127.0.0.1:5190')).ok)break;}catch{}
    if(i===99)throw Error('Vite did not start');await new Promise(resolve=>setTimeout(resolve,100));
  }
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1400,height:950}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/dialog-test',route=>route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><link rel="stylesheet" href="/src/style.css"><script type="module">
    import {initializeTheme,applyTheme} from '/src/theme.ts';
    import {featureDialog} from '/src/imageDialogs.ts';
    import {showUnsavedChangesDialog} from '/src/unsavedChangesDialog.ts';
    import {showGenerationReview} from '/src/generationReview.ts';
    initializeTheme();window.setTheme=theme=>applyTheme(theme);
    const source=await(await fetch('/index.html')).text();
    const parsed=new DOMParser().parseFromString(source,'text/html');
    for(const dialog of parsed.querySelectorAll('dialog'))document.body.append(document.importNode(dialog,true));
    window.showStatic=id=>document.getElementById(id).showModal();
    window.feature=()=>{const {dialog,body}=featureDialog('共通ダイアログ');body.innerHTML='<label>内容<textarea rows="6"></textarea></label>';};
    window.unsaved=()=>{window.result='pending';showUnsavedChangesDialog('fixture.md',async()=>{throw Error('save failed');}).then(value=>window.result=value);};
    window.diff=()=>{window.result='pending';showGenerationReview('fixture.md','old','new').then(value=>window.result=value);};
    window.ready=true;
  </script>`}));
  await page.goto('http://127.0.0.1:5190/dialog-test');await page.waitForFunction(()=>window.ready);
  const ids=await page.locator('dialog').evaluateAll(dialogs=>dialogs.map(d=>d.id));assert.ok(ids.length>=8);
  for(const theme of ['forest','blue','warm','charcoal','midnight','dark-forest']){
    await page.evaluate(theme=>setTheme(theme),theme);
    for(const id of ids){
      await page.evaluate(id=>showStatic(id),id);
      await page.waitForFunction(id=>document.getElementById(id).classList.contains('unified-dialog'),id);
      const state=await page.locator(`#${id}`).evaluate(dialog=>{
        const root=getComputedStyle(document.documentElement),style=getComputedStyle(dialog),box=dialog.getBoundingClientRect();
        const sample=document.createElement('span');sample.style.backgroundColor=root.getPropertyValue('--surface-bg');sample.style.color=root.getPropertyValue('--text-primary');dialog.append(sample);const expected=getComputedStyle(sample);const palette={background:expected.backgroundColor,text:expected.color};sample.remove();
        return {background:style.backgroundColor,text:style.color,palette,resize:style.resize,expanded:dialog.classList.contains('dialog-expanded'),within:box.width<=innerWidth-16&&box.height<=innerHeight-16};
      });
      assert.equal(state.background,state.palette.background,`${id}: ${theme} background`);assert.equal(state.text,state.palette.text,`${id}: ${theme} text`);
      assert.equal(state.resize,'both');assert.equal(state.expanded,false);assert.equal(state.within,true);
      await page.locator(`#${id}`).evaluate(dialog=>dialog.close());
    }
  }
  await page.evaluate(()=>feature());await page.locator('dialog[open] [data-dialog-expand]').waitFor();
  await page.waitForFunction(()=>document.querySelector('dialog[open]').getBoundingClientRect().width<=720);
  const natural=await page.locator('dialog[open]').boundingBox();assert.ok(natural.width<1000);
  await page.getByRole('button',{name:'ダイアログを最大化',exact:true}).click();
  assert.ok((await page.locator('dialog[open]').boundingBox()).width>natural.width);
  await page.getByRole('button',{name:'ダイアログを元のサイズに戻す',exact:true}).click();
  assert.equal(Math.round((await page.locator('dialog[open]').boundingBox()).width),Math.round(natural.width));
  await page.setViewportSize({width:420,height:500});await page.waitForTimeout(80);
  assert.ok((await page.locator('dialog[open]').boundingBox()).width<=388);
  await page.keyboard.press('Escape');await page.setViewportSize({width:1400,height:950});
  await page.evaluate(()=>unsaved());await page.locator('#unsaved-changes-dialog [data-dialog-expand]').waitFor();
  await page.getByRole('button',{name:'保存する',exact:true}).click();await page.getByText(/保存できませんでした/).waitFor();
  assert.equal(await page.locator('#unsaved-changes-dialog').evaluate(d=>d.open),true);
  await page.getByRole('button',{name:'キャンセル',exact:true}).click();await page.waitForFunction(()=>window.result===false);
  await page.evaluate(()=>diff());await page.locator('#generation-review-dialog [data-dialog-expand]').waitFor();
  const before=await page.locator('#generation-review-dialog').boundingBox();assert.ok(before.width>natural.width);
  await page.getByRole('button',{name:'採用して保存',exact:true}).click();await page.waitForFunction(()=>window.result?.action==='adopt');
  assert.deepEqual(errors,[]);console.log(`Shared dialog presentation passed: ${ids.length} static dialogs across 6 themes, dynamic dialogs, fitting, maximize/restore, resize, failed save and diff adoption.`);
}finally{await browser?.close();server.kill();}
