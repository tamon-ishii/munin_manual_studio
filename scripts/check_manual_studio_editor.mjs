import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {access,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

const artifacts=path.resolve('ui-coverage-results/editor-smoke');await mkdir(artifacts,{recursive:true});
const target=path.resolve(process.env.CARGO_TARGET_DIR||'target');
await access(path.join(target,'debug',process.platform==='win32'?'manualctl.exe':'manualctl')).catch(()=>{throw new Error('Run cargo build -p manual-core --bin manualctl before manual:check-editor');});
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const url=`http://127.0.0.1:${port}`;
let serverLog='',serverExited=false;
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','apps/manual-studio/vite.config.ts','--port',String(port),'--strictPort'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
server.stdout.on('data',data=>{serverLog=(serverLog+data).slice(-50_000);});server.stderr.on('data',data=>{serverLog=(serverLog+data).slice(-50_000);});server.on('exit',()=>{serverExited=true;});server.on('error',error=>{serverLog+=String(error);serverExited=true;});
const results=[];
try{
 let ready=false;for(let attempt=0;attempt<150;attempt++){if(serverExited)throw new Error(`Editor test server exited: ${serverLog}`);try{if((await fetch(url)).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
 if(!ready)throw new Error(`Editor test server did not start: ${serverLog}`);
 const tests=['test_manual_studio_editor_integrity.mjs','test_manual_studio_toolbar_customization.mjs','test_manual_studio_live_preview_ai.mjs','test_manual_studio_rich_template.mjs','test_manual_studio_target_application.mjs'];
 for(const test of tests){
   console.log(`[editor] ${test}`);let output='';
   const status=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[`scripts/${test}`],{windowsHide:true,env:{...process.env,MANUAL_STUDIO_TEST_URL:url,MANUAL_EDITOR_RESULTS:artifacts},stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>{child.kill();reject(new Error(`${test} timed out`));},120_000);child.stdout.on('data',data=>{output+=data;process.stdout.write(data);});child.stderr.on('data',data=>{output+=data;process.stderr.write(data);});child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('exit',code=>{clearTimeout(timer);resolve(code);});});
   await writeFile(path.join(artifacts,`${test}.log`),output);results.push({test,status:status===0?'passed':'failed'});if(status!==0)throw new Error(`${test} failed`);
 }
 console.log('Editor regression gate passed.');
}catch(error){process.exitCode=1;console.error(error);results.push({status:'failed',error:String(error)});
}finally{server.kill();await writeFile(path.join(artifacts,'server.log'),serverLog);await writeFile(path.join(artifacts,'result.json'),JSON.stringify({status:process.exitCode?'failed':'passed',platform:process.platform,results},null,2));}
