import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';

// Native fixture: executes actual OS input against an isolated test window.
const exec = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), 'munin-operation-script-'));
const cli = path.resolve('target/debug/manualctl' + (process.platform === 'win32' ? '.exe' : ''));
const title = `Munin Operation Script Fixture ${Date.now()}`;
let browser, sequence = 0;
const tool = async (action, options = {}) => {
  const id = ++sequence;
  const input = path.join(root, `request-${id}.json`), output = path.join(root, `response-${id}.json`);
  await writeFile(input, JSON.stringify({root,action,...options}));
  await exec(cli, ['--studio-tools',input,output], {timeout:90000,windowsHide:true});
  const result = JSON.parse(await readFile(output,'utf8'));
  assert.equal(result.ok,true,JSON.stringify(result));
  return result.result;
};
try {
  await mkdir(path.join(root,'docs'));
  await writeFile(path.join(root,'docs/index.md'),'# Original manuscript\n');
  browser = await chromium.launch({channel:process.env.MUNIN_TEST_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'),headless:false,args:['--force-renderer-accessibility']});
  const page = await browser.newPage({viewport:{width:900,height:650}});
  await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(`<html><title>${title}</title><body style="font:24px system-ui;padding:40px"><h1>Operation script fixture</h1><button onclick="document.querySelector('#form').hidden=false">Open form</button><div id="form" hidden><label>Display name <input aria-label="Display name" id="name"></label><button onclick="document.querySelector('#result').textContent='Saved: '+document.querySelector('#name').value">Save changes</button><p id="result">Not saved</p></div></body></html>`));
  await page.bringToFront();
  let window;
  for (let i=0;i<30;i++) {
    window = (await tool('windows')).find(window => window.title.includes(title));
    if(window)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(window,'native target window must be discoverable');
  const script = {version:1,window:{title:window.title,bounds:[window.x,window.y,window.width,window.height]},steps:[
    {kind:'click',target:{role:'button',name:'Open form'}},
    {kind:'click',target:{role:'input',name:'Display name'}},
    {kind:'key',value:'Control+a'},
    {kind:'text',value:'Alice'},
    {kind:'screenshot',name:'entered'},
    {kind:'click',target:{role:'button',name:'Save changes'}},
    {kind:'wait',milliseconds:100},
    {kind:'screenshot',name:'saved'}
  ]};
  const validated = await tool('operations-validate',{script});assert.equal(validated.valid,true);
  const result = await tool('operations-run',{window:window.id,script,output:'docs/assets/script-run'});
  assert.equal(result.ok,true);assert.equal(result.captures.length,2);
  assert.equal(await page.locator('#name').inputValue(),'Alice');
  assert.equal(await page.locator('#result').textContent(),'Saved: Alice');
  for (const [index, capture] of result.captures.entries()) {
    const png = await readFile(path.join(root,capture.image));assert.ok(png.length>1000);
    const recording = await tool('operations-inspect',{image:capture.image});
    assert.equal(recording.recording.events.filter(event=>event.kind==='screenshot').length,index+1,'PNG retains only operations up to its capture');
  }
  assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),'# Original manuscript\n');
  const manifest = JSON.parse(await readFile(path.join(root,'docs/assets/script-run/run.json'),'utf8'));
  assert.deepEqual(manifest,result);
  console.log('Native operation scripts passed: AI JSON validation, named OS clicks, key/text input, two screenshots, MarkIts recording prefixes, unchanged manuscript.');
} finally {
  await browser?.close();
  await rm(root,{recursive:true,force:true});
}
