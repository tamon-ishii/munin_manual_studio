import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,cp,readFile,writeFile,symlink,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {sourcePaths} from './lib/manual_ui_identity.mjs';
import {fingerprint} from './lib/manual_ui_inventory.mjs';
const root=process.cwd(),temp=await mkdtemp(path.join(os.tmpdir(),'munin-ci-gate-'));
const html='apps/manual-studio/index.html',original=fingerprint(await readFile(html));
try{
 for(const relative of sourcePaths){await mkdir(path.dirname(path.join(temp,relative)),{recursive:true});await cp(path.join(root,relative),path.join(temp,relative),{recursive:true});}
 await symlink(path.join(root,'node_modules'),path.join(temp,'node_modules'),'dir');
 await writeFile(path.join(temp,html),(await readFile(path.join(temp,html),'utf8'))+'\n<button id="CI_UNREGISTERED_FAULT">Fault</button>\n');
 const result=await new Promise((resolve,reject)=>{let output='';const child=spawn(process.execPath,['scripts/check_manual_studio.mjs','--group','unit'],{cwd:temp});const timeout=setTimeout(()=>{child.kill();reject(Error('CI fault runner timeout'));},60000);child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);child.on('error',reject);child.on('close',code=>{clearTimeout(timeout);resolve({code,output});});});
 assert.notEqual(result.code,0);assert.match(result.output,/unregistered operation/);assert.match(result.output,/stopped at the first failed stage/);assert.doesNotMatch(result.output,/\[run\] AI credentials checks/,'runner must not continue after coverage rejection');assert.equal(fingerprint(await readFile(html)),original);
 await mkdir('ui-coverage-results',{recursive:true});await writeFile('ui-coverage-results/ci-fault.json',JSON.stringify({fault:'unknown source control in isolated copy',runnerExit:result.code,normalSourcePreserved:true,stoppedBeforeNextStep:true,output:result.output},null,2));console.log('CI runner rejects the isolated unknown-control fault and stops before subsequent checks.');
}finally{await rm(temp,{recursive:true,force:true});}
