import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,chmod,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium} from 'playwright-core';
const base = 'http://127.0.0.1:5174';
const root = await mkdtemp(path.join(os.tmpdir(),'munin-mkdocs-button-'));
let server,browser;
try {
  await mkdir(path.join(root,'docs')); await mkdir(path.join(root,'.venv/bin'),{recursive:true});
  const source = '# Button test\n\nCurrent manuscript.\n';
  await writeFile(path.join(root,'docs/index.md'),source);
  await writeFile(path.join(root,'manual_setting.json'),JSON.stringify({docs:'docs',output:'manual',targets:['docs']}));
  const mkdocs = path.join(root,'.venv/bin/mkdocs');
  if (process.env.MUNIN_REAL_MKDOCS) await symlink(process.env.MUNIN_REAL_MKDOCS,mkdocs);
  else { await writeFile(mkdocs,"#!/usr/bin/python3\nimport pathlib,sys\nout=pathlib.Path(sys.argv[sys.argv.index('-d')+1]);out.mkdir();(out/'index.html').write_text('<h1>Built via button</h1>')\n"); await chmod(mkdocs,0o755); }
  try { await fetch(base); } catch {
    server=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--config','apps/manual-studio/vite.config.ts'],{stdio:'ignore'});
    for (let i=0;i<100;i++) { try { if((await fetch(base)).ok) break; } catch {} await new Promise(resolve=>setTimeout(resolve,100)); }
  }
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage(); page.setDefaultTimeout(30_000);
  await page.goto(`${base}/?root=${encodeURIComponent(root)}`);
  try { await page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false' && document.querySelector('#markdown-editor').value.includes('Current manuscript')); } catch(error) { console.error(await page.evaluate(()=>({status:document.querySelector('#status')?.textContent,busy:document.body.getAttribute('aria-busy'),editor:document.querySelector('#markdown-editor')?.value}))); throw error; }
  await page.locator('[data-tab=publish]').click();
  const invoked=page.waitForRequest(request=>request.url().includes('/__manual/rpc') && request.postData()?.includes('build-mkdocs'));
  await page.getByRole('button',{name:'MkDocsでビルド',exact:true}).click();
  await invoked;
  await page.waitForFunction(()=>document.querySelector('#publish-result').textContent.includes('Site:'));
  assert.match(await readFile(path.join(root,'manual/index.html'),'utf8'),/Built via button|Current manuscript/);
  assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),source);
  console.log('MkDocs button checks passed: explicit build request, HTML output, source preservation.');
} finally {
  await browser?.close();
  if(server && server.exitCode===null) {const ended=new Promise(resolve=>server.once('exit',resolve));server.kill();await ended;}
  await rm(root,{recursive:true,force:true});
}
