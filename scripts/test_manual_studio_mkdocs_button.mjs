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
  const idle=()=>page.waitForFunction(()=>document.body.getAttribute('aria-busy')==='false');
  const invocations=[];
  for(const [label,mode,draft] of [['確認用の出力','preview',true],['通常の出力','final',false]]) {
    const action='build-mkdocs';
    const response=page.waitForResponse(response=>response.url().includes('/__manual/rpc')&&response.request().postDataJSON()?.action===action);
    await page.locator('#build-mode').selectOption(mode);await page.getByRole('button',{name:'HTML出力',exact:true}).click();
    const result=await response;const request=result.request().postDataJSON();
    assert.equal(Boolean(request.options.draft),draft);assert.equal(result.ok(),true);
    await idle();
    assert.match(await readFile(path.join(root,'manual/index.html'),'utf8'),/Built via button|Current manuscript/);
    assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),source);
    invocations.push({label,action,draft,entry:'HTML出力'});
  }
  const published=await readFile(path.join(root,'manual/index.html'),'utf8');
  await page.locator('[data-close-dialog=panel-publish]').click();
  await page.getByRole('button',{name:'Markdownソース',exact:true}).click();
  await page.locator('#markdown-editor').fill(source+'\n[Missing](missing.md)\n');await page.keyboard.press('Control+s');await idle();
  await page.locator('[data-tab=publish]').click();
  const failed=page.waitForResponse(response=>response.url().includes('/__manual/rpc')&&response.request().postDataJSON()?.action==='build-mkdocs');
  await page.locator('#build-mode').selectOption('final');await page.locator('#build-html').click();await failed;await idle();
  assert.equal(await readFile(path.join(root,'manual/index.html'),'utf8'),published,'strict failure preserves the published output');
  assert.match(await page.locator('#status').textContent(),/チェック|リンク|問題|missing/);
  await page.locator('#quality-check').click();await idle();await page.locator('.quality-issue').first().getByRole('button').click();await idle();
  assert.equal(await page.locator('#markdown-editor').isVisible(),true);
  const selected=await page.locator('#markdown-editor').evaluate(el=>el.value.slice(el.selectionStart,el.selectionEnd));assert.match(selected,/missing\.md/);
  await page.locator('#markdown-editor').fill(source);await page.keyboard.press('Control+s');await idle();
  await page.locator('[data-tab=publish]').click();await page.locator('#quality-check').click();await idle();assert.match(await page.locator('#publish-result').textContent(),/合格/);
  await page.locator('#build-mode').selectOption('final');await page.locator('#build-html').click();await idle();assert.match(await readFile(path.join(root,'manual/index.html'),'utf8'),/Built via button|Current manuscript/);
  console.log('Publication workflow passed: '+JSON.stringify(invocations)+'; strict failure preserves output; finding -> source fix -> recheck -> final build. MkDocs process uses '+(process.env.MUNIN_REAL_MKDOCS?'real installation':'fixture executable')+'.');
} finally {
  await browser?.close();
  if(server && server.exitCode===null) {const ended=new Promise(resolve=>server.once('exit',resolve));server.kill();await ended;}
  await rm(root,{recursive:true,force:true});
}
