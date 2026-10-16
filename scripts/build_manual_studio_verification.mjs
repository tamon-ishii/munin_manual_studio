import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {treeFingerprint} from './lib/manual_ui_inventory.mjs';
import {verificationIdentity,sourcePaths} from './lib/manual_ui_identity.mjs';

const root=process.cwd();
const before=await treeFingerprint(root,sourcePaths);
async function run(command,args){await new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:'inherit',shell:process.platform==='win32'&&command.endsWith('.cmd')});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`${command} exited ${code}`)));});}
await run(process.platform==='win32'?'npm.cmd':'npm',['run','manual:build']);
await run('cargo',['build','--locked','-p','manual-studio','-p','manual-core']);
const identity=await verificationIdentity(root);
if(identity.sourceHash!==before)throw new Error('Sources changed during build; evidence cannot certify this build');
await mkdir('ui-coverage-results',{recursive:true});
await writeFile('ui-coverage-results/build.json',JSON.stringify({...identity,builtAt:new Date().toISOString()},null,2)+'\n');
console.log('Verified build provenance recorded.');
