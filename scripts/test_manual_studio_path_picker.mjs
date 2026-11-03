import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';

const bundle=await build({stdin:{contents:`import {askTemplateDestination} from './apps/manual-studio/src/templateCreation';import {setupPathPickers,relativePickedPath} from './apps/manual-studio/src/pathPicker';window.pickerTest={askTemplateDestination,setupPathPickers,relativePickedPath};`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife',platform:'browser'});
const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage();await page.setContent('<html><body></body></html>');await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.evaluate(()=>{
    pickerTest.setupPathPickers({root:()=> 'C:/project',entries:()=>[{path:'docs',directory:true},{path:'specs',directory:true}]});
    window.calls=[];window.picked='C:/project/specs';
    window.__TAURI_INTERNALS__={invoke:async(command,args)=>{calls.push({command,args});return picked;}};
    window.result=undefined;void pickerTest.askTemplateDestination('docs').then(value=>window.result=value);
  });
  const dialog=page.locator('#template-creation-dialog');const browse=dialog.getByRole('button',{name:/参照/});const destination=dialog.locator('[name=destination]');
  await browse.click();await assert.doesNotReject(()=>page.waitForFunction(()=>document.querySelector('[name=destination]').value==='specs'));
  assert.equal(await page.evaluate(()=>calls.at(-1).args.folder),true);
  await page.evaluate(()=>{picked=null;});await browse.click();assert.equal(await destination.inputValue(),'specs');
  await page.evaluate(()=>{picked='C:/elsewhere';});await browse.click();await page.waitForFunction(()=>!document.querySelector('.path-picker-error').hidden);assert.equal(await destination.inputValue(),'specs');
  await dialog.locator('[name=template]').selectOption('readme');await page.evaluate(()=>{picked='C:/project/Readme.md';});await browse.click();assert.equal(await page.evaluate(()=>calls.at(-1).args.folder),false);
  await dialog.getByRole('button',{name:'雛形の候補を作成'}).click();await page.waitForFunction(()=>window.result!==undefined);assert.deepEqual(await page.evaluate(()=>result),{template:'readme',destination:'Readme.md'});
  await page.evaluate(()=>{delete window.__TAURI_INTERNALS__;void pickerTest.askTemplateDestination('docs');});
  await page.locator('#template-creation-dialog').getByRole('button',{name:/参照/}).click();
  const picker=page.locator('dialog').last();await picker.locator('select').selectOption('specs');await picker.getByRole('button',{name:'選択',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[name=destination]').value==='specs');
  assert.equal(await page.evaluate(()=>pickerTest.relativePickedPath('C:/project','c:\\project\\docs')),'docs');
  console.log('Path picker: folder/file browsing, cancellation, outside-project rejection, browser fallback passed.');
}finally{await browser.close();}
