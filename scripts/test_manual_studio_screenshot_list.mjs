import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';

const root=await mkdtemp(path.join(os.tmpdir(),'munin-screenshot-list-'));
const base='http://127.0.0.1:5174';
let server,browser;
try {
  await mkdir(path.join(root,'docs/assets'),{recursive:true});
  await writeFile(path.join(root,'manual_setting.json'),JSON.stringify({docs:'docs',assets:'docs/assets',targets:['docs'],connection_type:'none'}));
  await writeFile(path.join(root,'docs/index.md'),'# Screenshot list\n');
  const png=await readFile('apps/manual-studio/src-tauri/icons/icon.png');
  await writeFile(path.join(root,'docs/assets/unregistered-icon.png'),png);
  server=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--config','apps/manual-studio/vite.config.ts'],{stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  const rpc=async(action,options={})=>{
    const response=await fetch(`${base}/__manual/rpc`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({root,action,options})});
    const result=await response.json();if(result.error)throw new Error(result.error);return JSON.parse(result.output);
  };
  const registered=await rpc('screenshots-register',{json:{name:'Captured screen',source:png.toString('base64'),recipe:{steps:[]}}});
  const imported=await rpc('screenshots-register',{json:{name:'Imported file',source:png.toString('base64'),import:true}});
  browser=await chromium.launch({channel:process.env.MUNIN_TEST_BROWSER || 'chrome',headless:true});
  const page=await browser.newPage();
  await page.goto(`${base}/?root=${encodeURIComponent(root)}&page=index.md`);
  await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  await page.locator('[data-tab=screenshots]').click();
  await page.locator(`[data-screenshot-id="${registered.screenshot.id}"]`).waitFor();
  assert.equal(await page.locator('.screenshot-library-card').count(),2);
  assert.equal(await page.locator(`[data-screenshot-id="${imported.screenshot.id}"]`).getAttribute('data-resource-kind'),'imported');
  assert.equal(await page.locator('[data-resource-path="docs/assets/unregistered-icon.png"]').count(),0);
  assert.equal(await page.locator('#resource-kind option[value=generated]').count(),0);
  assert.equal(await page.locator('#resource-count').textContent(),'2 / 2件');
  await page.locator('#resource-kind').selectOption('imported');
  assert.equal(await page.locator('.screenshot-library-card').count(),1);
  assert.equal(await page.locator(`[data-screenshot-id="${imported.screenshot.id}"]`).count(),1);
  await page.locator('#resource-kind').selectOption('screenshot');
  assert.equal(await page.locator('.screenshot-library-card').count(),1);
  assert.equal(await page.locator(`[data-screenshot-id="${registered.screenshot.id}"]`).count(),1);
  await page.locator('#resource-kind').selectOption('all');
  const card=page.locator(`[data-screenshot-id="${registered.screenshot.id}"]`);
  assert.equal(await card.locator('.resource-item-summary').getByRole('button',{name:'削除',exact:true}).isVisible(),true);
  assert.equal(await card.locator('.resource-item-summary').getByRole('button',{name:'削除',exact:true}).isEnabled(),true);
  await page.locator('#resource-management-menu > summary').click();
  await page.locator('#screenshot-ui-settings').click();
  const settings=page.locator('#capture-settings-dialog');
  assert.equal(await settings.getByRole('spinbutton',{name:'UI探索の最大階層'}).inputValue(),'64');
  await settings.getByRole('spinbutton',{name:'UI探索の最大階層'}).fill('96');
  await settings.getByRole('button',{name:'保存',exact:true}).click();
  await settings.waitFor({state:'hidden'});
  assert.equal((await rpc('capture-settings-read')).max_depth,96);
  await page.locator('#resource-management-menu > summary').click();
  await page.locator('#screenshot-ui-settings').click();
  assert.equal(await settings.getByRole('spinbutton',{name:'UI探索の最大階層'}).inputValue(),'96');
  await settings.getByRole('spinbutton',{name:'UI探索の最大階層'}).fill('129');
  await settings.getByRole('button',{name:'保存',exact:true}).click();
  assert.equal(await settings.isVisible(),true);
  assert.equal((await rpc('capture-settings-read')).max_depth,96);
  await settings.getByRole('button',{name:'キャンセル',exact:true}).click();
  await page.locator('#resource-search').fill('unregistered-icon');
  assert.equal(await page.locator('.screenshot-library-card').count(),0);
  console.log('Screenshot list filtering, visible deletion and persisted UI exploration depth settings verified.');
} finally {
  await browser?.close();server?.kill();await rm(root,{recursive:true,force:true});
}
