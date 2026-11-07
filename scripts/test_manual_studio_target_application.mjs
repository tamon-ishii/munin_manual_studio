import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';

const base=process.env.MANUAL_STUDIO_TEST_URL||'http://127.0.0.1:5174';
const root=await mkdtemp(path.join(os.tmpdir(),'munin-target-application-'));
let browser;
try{
  await mkdir(path.join(root,'docs'),{recursive:true});await writeFile(path.join(root,'docs/index.md'),'# Original');await writeFile(path.join(root,'manual_setting.json'),JSON.stringify({docs:'docs',assets:'docs/assets',targets:['docs']}));
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/__manual/rpc',async route=>{const response=await route.fetch({headers:{...route.request().headers(),origin:'http://127.0.0.1:5174'}});await route.fulfill({response});});
  await page.goto(`${base}/?root=${encodeURIComponent(root)}&page=index.md`);await page.waitForFunction(()=>document.querySelector('#markdown-editor')?.value.includes('Original'));await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  assert.equal(await page.locator('#operation-workbench-open').count(),0);
  await page.locator('#target-application-open').click();const dialog=page.locator('#target-application-dialog');await dialog.waitFor();
  await dialog.getByLabel('起動コマンド',{exact:true}).fill('python');await dialog.getByLabel('引数（1行に1つ）',{exact:true}).fill('folder with spaces/app.py\n--project\nproject with spaces');await dialog.getByLabel('ワーキングフォルダ',{exact:true}).fill('missing-folder');await dialog.getByLabel('AIに伝える情報',{exact:true}).fill('Fixture app の保存方法を説明。サンプルデータを使う。');
  await dialog.getByRole('button',{name:'設定を保存',exact:true}).click();await dialog.getByRole('alert').filter({hasText:'ワーキングフォルダ'}).waitFor();
  await dialog.getByLabel('ワーキングフォルダ',{exact:true}).fill('.');await dialog.getByRole('button',{name:'設定を保存',exact:true}).click();await dialog.waitFor({state:'hidden'});
  const saved=JSON.parse(await readFile(path.join(root,'.munin/target-application.json'),'utf8'));assert.deepEqual(saved,{command:'python',arguments:['folder with spaces/app.py','--project','project with spaces'],working_directory:'.',information:'Fixture app の保存方法を説明。サンプルデータを使う。'});
  await page.reload();await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');await page.locator('#target-application-open').click();await dialog.waitFor();assert.equal(await dialog.getByLabel('起動コマンド',{exact:true}).inputValue(),'python');assert.match(await dialog.getByLabel('AIに伝える情報',{exact:true}).inputValue(),/サンプルデータ/);
  if(process.env.TARGET_APPLICATION_SCREENSHOT)await page.screenshot({path:process.env.TARGET_APPLICATION_SCREENSHOT});await dialog.getByRole('button',{name:'閉じる',exact:true}).click();
  await page.locator('#create-ai-template').click();const template=page.locator('#template-creation-dialog');await template.getByText('対象アプリ：python',{exact:true}).waitFor();assert.equal(await template.locator('[name=window],[name=automate_steps]').count(),0);assert.equal(await template.locator('.template-ai-guide').getAttribute('open'),null);
  await template.getByRole('button',{name:'対象アプリケーションの設定',exact:true}).click();await dialog.waitFor();await dialog.getByLabel('AIに伝える情報',{exact:true}).fill('Updated instructions');await dialog.getByRole('button',{name:'設定を保存',exact:true}).click();await dialog.waitFor({state:'hidden'});await template.getByText('対象アプリ：python',{exact:true}).waitFor();await template.getByRole('button',{name:'閉じる',exact:true}).click();
  assert.equal(JSON.parse(await readFile(path.join(root,'.munin/target-application.json'),'utf8')).information,'Updated instructions');assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),'# Original');assert.deepEqual(errors,[]);
  console.log('Target application UI passed: settings validation, project-local persistence/reload, exact spaced arguments, supplemental AI information and simple template entry without manual window/plan selection.');
}finally{for(const context of browser?.contexts()||[])for(const page of context.pages())await page.unrouteAll({behavior:'ignoreErrors'});await browser?.close();await rm(root,{recursive:true,force:true});}
