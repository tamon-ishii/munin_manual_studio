import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,unlink,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
const root=await mkdtemp(path.join(os.tmpdir(),'munin-tab-session-'));
const other=await mkdtemp(path.join(os.tmpdir(),'munin-tab-other-'));
const base='http://127.0.0.1:5174';let server,browser;
try {
  for(const project of [root,other]){
    await mkdir(path.join(project,'docs'),{recursive:true});
    await writeFile(path.join(project,'manual_setting.json'),JSON.stringify({docs:'docs',assets:'docs/assets',connection_type:'none'}));
    for(const page of ['index.md','guide.md','deep.md'])await writeFile(path.join(project,'docs',page),`# ${page}\n`);
  }
  server=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--config','apps/manual-studio/vite.config.ts'],{stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext();let page=await context.newPage();const errors=[];
  function watch(){page.on('pageerror',error=>errors.push(error.message));}watch();
  const idle=()=>page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  const tabs=()=>page.locator('[data-document-page]').evaluateAll(nodes=>nodes.map(node=>node.dataset.documentPage));
  async function open(file){await page.locator('#tree-search').fill(file);await page.locator(`[data-page="docs/${file}"]`).click();await idle();await page.locator('#tree-search').fill('');}
  await page.goto(`${base}/?root=${encodeURIComponent(root)}`);await idle();
  await open('index.md');await open('guide.md');await open('deep.md');
  await page.locator('[data-document-page="guide.md"]').click();await idle();
  const expected=await tabs();
  await page.close();page=await context.newPage();watch();
  await page.goto(`${base}/?root=${encodeURIComponent(root)}`);await idle();
  assert.deepEqual(await tabs(),expected,'reopening restores tab order');
  await page.frameLocator('#markdown-preview').getByRole('heading',{name:'guide.md',exact:true}).waitFor();
  assert.equal(await page.locator('[data-document-page="guide.md"]').getAttribute('aria-selected'),'true','active tab restored');
  await page.getByRole('button',{name:'index.mdを閉じる',exact:true}).click();await idle();
  await page.reload();await idle();assert.ok(!(await tabs()).includes('index.md'),'closed tab stays closed');
  await unlink(path.join(root,'docs/deep.md'));await page.reload();await idle();assert.deepEqual(await tabs(),['guide.md'],'deleted manuscript is skipped');
  await page.goto(`${base}/?root=${encodeURIComponent(other)}`);await idle();await open('deep.md');
  await page.goto(`${base}/?root=${encodeURIComponent(root)}`);await idle();assert.deepEqual(await tabs(),['guide.md'],'project sessions are independent');
  await page.getByRole('button',{name:'guide.mdを閉じる',exact:true}).click();await idle();await page.reload();await idle();assert.deepEqual(await tabs(),[],'empty session stays empty');
  await page.evaluate(root=>localStorage.setItem(`manual-studio-document-tabs:${root}`,'{invalid'),root);
  await page.reload();await idle();assert.ok((await tabs()).length===1,'invalid saved state falls back to the initial manuscript');
  assert.deepEqual(errors,[]);console.log('Document tab sessions: reopen, order, active tab, closed/deleted pages, project isolation, empty and invalid state passed.');
} finally {await browser?.close();server?.kill();await rm(root,{recursive:true,force:true});await rm(other,{recursive:true,force:true});}
