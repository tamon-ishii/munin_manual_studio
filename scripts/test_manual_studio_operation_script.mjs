import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(),'munin-operation-tools-'));
const cli = path.resolve('target/debug/manualctl'+(process.platform==='win32'?'.exe':''));
let sequence = 0;
const request = async (action, options={}) => {
  const id = ++sequence, input=path.join(root,`in-${id}.json`), output=path.join(root,`out-${id}.json`);
  await writeFile(input,'\uFEFF'+JSON.stringify({root,action,...options}));
  await exec(cli,['--studio-tools',input,output],{windowsHide:true,timeout:30000});
  return JSON.parse(await readFile(output,'utf8'));
};
try {
  await mkdir(path.join(root,'docs'));
  await writeFile(path.join(root,'docs/index.md'),'# Original\n');
  const original=await readFile('apps/manual-studio/src-tauri/icons/icon.png');
  await writeFile(path.join(root,'source.png'),original);
  const prepared=JSON.parse((await exec(cli,['--request',JSON.stringify({root,action:'terminal-prepare',options:{}})],{windowsHide:true,timeout:30000})).stdout);
  assert.ok(prepared.prompt.includes('operations-run'));
  const schema=await request('operations-schema');assert.equal(schema.ok,true);
  assert.equal(schema.result.schema.properties.version.const,1);
  const onDisk=JSON.parse(await readFile(path.join(root,'.munin/ai-terminal/operation-script.schema.json'),'utf8'));
  assert.deepEqual(onDisk,schema.result.schema);
  const script={version:1,window:{title:'Synthetic fixture',bounds:[100,100,800,600]},steps:[
    {kind:'click',target:{role:'button',name:'Save'}},
    {kind:'key',value:'Ctrl+a'},
    {kind:'text',value:'Sample'},
    {kind:'wait',milliseconds:250},
    {kind:'screenshot',name:'saved'}
  ]};
  const validated=await request('operations-validate',{script});assert.equal(validated.ok,true);
  assert.equal(validated.result.saved_recording.recording.events[1].value,'Control+a');
  const attached=await request('operations-attach',{script,image:'source.png',output:'assets/replay.png'});
  assert.equal(attached.ok,true,JSON.stringify(attached));
  const inspected=await request('operations-inspect',{image:'assets/replay.png'});
  assert.deepEqual(inspected.result,validated.result.saved_recording);
  assert.deepEqual(await readFile(path.join(root,'source.png')),original);
  const duplicate=await request('operations-attach',{script,image:'source.png',output:'assets/replay.png'});
  assert.equal(duplicate.ok,false);
  const bad=structuredClone(script);bad.steps.push({kind:'launch',program:'not-allowed'});
  const rejected=await request('operations-run',{script:bad,window:'not-real',output:'must-not-exist'});
  assert.equal(rejected.ok,false);assert.match(rejected.error,/Invalid operation script/);
  assert.equal(await readFile(path.join(root,'docs/index.md'),'utf8'),'# Original\n');
  console.log('Operation script CLI passed: briefing/schema discovery, BOM requests, validation, PNG attach/inspect, original preservation, overwrite and invalid-action rejection.');
} finally {await rm(root,{recursive:true,force:true});}
