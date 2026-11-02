import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';

const exec=promisify(execFile),root=await mkdtemp(path.join(tmpdir(),'munin-selection-capture-'));
const title='Munin Capture Verification '+Date.now();
let browser,calls=0,stubError;
const server=createServer(async(req,res)=>{
  try{
    let raw='';for await(const part of req)raw+=part;
    const body=JSON.parse(raw),prompt=body.messages.find(message=>message.role==='user').content;
    const data=JSON.parse(prompt.split('\nInput: ')[1].split('\n\nRespond with')[0]);
    calls++;let result;
    if(data.windows){
      const window=data.windows.find(window=>window.title.includes(title));assert.ok(window,'fixture window must be listed');
      result={captures:[{window:window.id,caption:'保存ボタン'}]};
    }else{
      const image=data.screenshots[0];assert.ok(image.uimap?.some(item=>item.name==='保存'),'real capture must contain the Save button UIMap');
      result={content:`保存ボタンを押します。\n\n![保存](<${image.link}>)`,images:[{index:1,annotations:[{type:'rect',target:'保存',style:'primary'},{type:'badge',target:'保存',step:1,style:'step'}]}]};
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));
  }catch(error){stubError=error;res.statusCode=500;res.end(JSON.stringify({error:String(error)}));}
});
try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await mkdir(path.join(root,'docs'));
  await writeFile(path.join(root,'manual_setting.json'),JSON.stringify({docs:'docs',assets:'docs/assets',output:'site',targets:['docs'],agent:'agy',connection_type:'api',endpoint_url:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture'}));
  await writeFile(path.join(root,'docs/index.md'),'# Original\n\n保存します。\n');
  browser=await chromium.launch({channel:process.env.MUNIN_TEST_BROWSER||(process.platform==='win32'?'msedge':'chrome'),headless:false,args:['--force-renderer-accessibility']});
  const page=await browser.newPage({viewport:{width:900,height:650}});
  await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(`<html lang="ja"><title>${title}</title><body style="font:24px system-ui;padding:60px"><h1>撮影テスト</h1><p>設定を保存します。</p><button style="font-size:24px;padding:16px 40px">保存</button></body></html>`));
  await page.bringToFront();
  const cli=path.resolve('target/debug/manualctl'+(process.platform==='win32'?'.exe':''));
  const rpc=async(action,options={})=>JSON.parse((await exec(cli,['--request',JSON.stringify({root,action,options})],{timeout:90000,maxBuffer:4*1024*1024,windowsHide:true})).stdout);
  let found=false;
  for(let attempt=0;attempt<30;attempt++){if((await rpc('list-windows')).some(window=>window.title.includes(title))){found=true;break;}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(found,'fixture must become visible to native window enumeration');
  const document=await rpc('editor-read',{page:'index.md'});
  const result=await rpc('selection-generate',{page:'index.md',json:{revision:document.revision,selected:'保存します。',instruction:'保存ボタンを撮影して番号付きで説明してください。',mode:'replace',include_screenshots:true}});
  assert.equal(calls,2);assert.match(result.content,/assets\/capture-.*\.png/);
  const images=await readdir(path.join(root,'docs/assets'));assert.equal(images.length,1);
  assert.ok((await readFile(path.join(root,'docs/assets',images[0]))).length>1000);
  assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),document.content,'candidate generation does not edit the manuscript');
  assert.equal(stubError,undefined);
  console.log('Actual window capture, UIMap, MarkIts rectangle/badge, linked candidate and unchanged manuscript passed.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
