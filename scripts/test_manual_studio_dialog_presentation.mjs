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
    import {featureDialog,confirmAction,requestText} from '/src/imageDialogs.ts';
    import {showUnsavedChangesDialog} from '/src/unsavedChangesDialog.ts';
    import {showGenerationReview} from '/src/generationReview.ts';
    initializeTheme();window.setTheme=theme=>applyTheme(theme);
    const source=await(await fetch('/index.html')).text();
    const parsed=new DOMParser().parseFromString(source,'text/html');
    for(const dialog of parsed.querySelectorAll('dialog'))document.body.append(document.importNode(dialog,true));
    window.showStatic=id=>document.getElementById(id).showModal();
    window.feature=()=>{const {dialog,body}=featureDialog('共通ダイアログ');dialog.dataset.dialogExpandable='true';body.innerHTML='<label>内容<textarea rows="6"></textarea></label>';};
    window.confirm=()=>confirmAction('削除しますか？');window.request=()=>requestText('名前');
    window.duplicate=()=>{const first=showUnsavedChangesDialog('duplicate.md',async()=>{});const second=showUnsavedChangesDialog('duplicate.md',async()=>{});window.sameConfirmation=first===second;Promise.all([first,second]).then(value=>window.duplicateResult=value);};
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
      const compact=await page.locator(`#${id}`).getAttribute('data-dialog-size')==='compact';
      assert.equal(state.resize,compact?'none':'both');assert.equal(state.expanded,false);assert.equal(state.within,true);
      if(compact)assert.equal(await page.locator(`#${id} [data-dialog-expand]`).count(),0);
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
  await page.evaluate(()=>unsaved());await page.waitForFunction(()=>document.querySelector('#unsaved-changes-dialog')?.classList.contains('unified-dialog'));
  assert.equal(await page.locator('#unsaved-changes-dialog [data-dialog-expand]').count(),0);
  await page.waitForFunction(()=>document.querySelector('#unsaved-changes-dialog').getBoundingClientRect().width<=480);
  const confirmation=await page.locator('#unsaved-changes-dialog').boundingBox();
  assert.ok(confirmation.width<=480);assert.ok(confirmation.height<300);
  await page.getByRole('button',{name:'保存する',exact:true}).click();await page.getByText(/保存できませんでした/).waitFor();
  assert.equal(await page.locator('#unsaved-changes-dialog').evaluate(d=>d.open),true);
  await page.getByRole('button',{name:'キャンセル',exact:true}).click();await page.waitForFunction(()=>window.result===false);
  await page.evaluate(()=>duplicate());
  assert.equal(await page.evaluate(()=>window.sameConfirmation),true);
  assert.equal(await page.locator('#unsaved-changes-dialog').count(),1);
  await page.getByRole('button',{name:'キャンセル',exact:true}).click();await page.waitForFunction(()=>window.duplicateResult?.length===2);
  assert.deepEqual(await page.evaluate(()=>window.duplicateResult),[false,false]);
  for(const kind of ['confirm','request']){
    await page.evaluate(kind=>{void window[kind]();},kind);await page.waitForFunction(()=>document.querySelector('dialog[open]')?.dataset.dialogSize==='compact');
    assert.equal(await page.locator('dialog[open] [data-dialog-expand]').count(),0);
    await page.keyboard.press('Escape');
  }
  await page.evaluate(()=>diff());await page.locator('#generation-review-dialog [data-dialog-expand]').waitFor();
  const before=await page.locator('#generation-review-dialog').boundingBox();assert.ok(before.width>natural.width);
  await page.getByRole('button',{name:'採用して保存',exact:true}).click();await page.waitForFunction(()=>window.result?.action==='adopt');
  // While a native host starts, the source must stay hidden; failed startup restores it.
  await page.route('**/nativeDialogHost.ts',route=>route.fulfill({contentType:'application/javascript',body:'export async function hostNativeDialog(){throw new Error("fixture startup failure");}'}));
  const startingVisibility=await page.evaluate(()=>{
    window.__TAURI_INTERNALS__={};unsaved();
    return new Promise(resolve=>requestAnimationFrame(()=>resolve(getComputedStyle(document.querySelector('#unsaved-changes-dialog')).visibility)));
  });
  assert.equal(startingVisibility,'hidden');
  await page.getByText(/fixture startup failure/).waitFor();
  assert.equal(await page.locator('#unsaved-changes-dialog').isVisible(),true);
  await page.getByRole('button',{name:'キャンセル',exact:true}).click();await page.waitForFunction(()=>window.result===false);
  assert.deepEqual(errors,[]);console.log(`Shared dialog presentation passed: ${ids.length} static dialogs across 6 themes, dynamic dialogs, fitting, maximize/restore, resize, failed save and diff adoption.`);
}finally{await browser?.close();server.kill();}
