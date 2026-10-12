import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sourceInventory,validateRegistry,validateEvidence,entryEvidenceStatus} from './lib/manual_ui_inventory.mjs';

const expected={visible:'candidate visible',stored:'adopted image updated',preserved:'original unchanged',returnTarget:'Studio card'};
const registry={features:[{id:'P05'}],actions:[{id:'edit',feature:'P05',cases:['edit.success'],result:'candidate',returnTarget:'card',spec:'screenshot-library'}],cases:[{id:'edit.success',feature:'P05',entryPoints:['edit'],expected,requiredEvidence:['real-desktop']}]};
const clone=value=>structuredClone(value);
assert.deepEqual(validateRegistry(registry),[]);
const brokenRegistry=[
 ['duplicate ID',r=>r.actions.push(clone(r.actions[0])),/duplicate/],
 ['orphan entry',r=>r.actions[0].cases=[],/orphan/],
 ['missing expectations',r=>delete r.cases[0].expected.stored,/expectations/],
 ['missing reverse case',r=>r.cases[0].entryPoints=['unknown'],/entry/],
 ['invalid evidence type',r=>r.cases[0].requiredEvidence=['native'],/evidence/],
];
for(const [name,mutate,pattern]of brokenRegistry){const r=clone(registry);mutate(r);assert.ok(validateRegistry(r).some(e=>pattern.test(e)),name);}
const reviewedRegistry=clone(registry);reviewedRegistry.actions[0].reviewStatus='reviewed';
const options={sourceHash:'source-current',buildHash:'build-current',os:'linux'};
const report={...options,executedAt:new Date().toISOString(),results:[{caseId:'edit.success',entryPoint:'edit',type:'real-desktop',status:'passed',assertions:{visible:true,stored:true,preserved:true,returnTarget:true},artifacts:[{path:'shot.png',sha256:'hash'}],steps:['Studio edit button','real MarkIts','return','compare','adopt']}]};
assert.deepEqual(validateEvidence(registry,report,options),[]);
assert.equal(entryEvidenceStatus(reviewedRegistry,report,options)[0].status,'passed');
assert.equal(entryEvidenceStatus(registry,report,options)[0].status,'unverified');
assert.equal(entryEvidenceStatus(reviewedRegistry,{...report,results:[]},options)[0].status,'unverified');
const faults=[
 ['missing case',r=>r.results=[],/not run/],
 ['mock substitutes real OS',r=>r.results[0].type='browser-mock',/not run/],
 ['stale source',r=>r.sourceHash='old',/stale/],
 ['stale build',r=>r.buildHash='old',/stale/],
 ['wrong OS',r=>r.os='darwin',/OS/],
 ['timeout',r=>r.results[0].status='timeout',/timeout/],
 ['no preservation assertion',r=>delete r.results[0].assertions.preserved,/preserved/],
 ['no operations',r=>r.results[0].steps=[],/log/],
 ['no artifacts',r=>r.results[0].artifacts=[],/artifacts/],
 ['expired evidence',r=>r.executedAt='2000-01-01',/expired/],
 ['duplicate proof',r=>r.results.push(clone(r.results[0])),/duplicate/],
];
for(const [name,mutate,pattern]of faults){const r=clone(report);mutate(r);assert.ok(validateEvidence(registry,r,options).some(e=>pattern.test(e)),name);}
const temp=await mkdtemp(path.join(os.tmpdir(),'munin-inventory-fault-'));
try {
 await mkdir(path.join(temp,'apps/manual-studio/src'),{recursive:true});
 const html=path.join(temp,'apps/manual-studio/index.html');
 await writeFile(html,'<button id="known">Known</button>');
 await writeFile(path.join(temp,'apps/manual-studio/src/interaction.ts'),`element('known').addEventListener('keydown', e=>{if(e.key==='x')run();}); target.addEventListener('drop',run); const b=document.createElement('button'); b.onclick=run; const delegates={onUpload:upload,onRun:run};`);
 const before=await sourceInventory(temp);assert.ok(before.operations.some(o=>o.kind==='event:drop'));assert.ok(before.operations.some(o=>o.kind==='event:keydown'));assert.ok(before.operations.some(o=>o.kind==='handler'));assert.ok(before.operations.some(o=>o.kind==='callback:onUpload'));assert.ok(before.operations.some(o=>o.kind==='callback:onRun'));
 const r=clone(registry);r.actions=before.operations.map(o=>({...registry.actions[0],id:o.id}));r.cases[0].entryPoints=r.actions.map(a=>a.id);
 assert.deepEqual(validateRegistry(r,before),[]);
 await writeFile(html,'<button id="known">Known</button><button id="new-unregistered">New</button>');
 assert.ok(validateRegistry(r,await sourceInventory(temp)).some(e=>e.includes('unregistered operation')),'an added button must fail without updating the registry');
 await writeFile(html,'');assert.ok(validateRegistry(r,await sourceInventory(temp)).some(e=>e.includes('stale operation')),'a removed operation must be reconciled');
} finally {await rm(temp,{recursive:true,force:true});}
console.log('Coverage gate fault fixtures passed: unknown/missing operations, orphan contracts, missing/stale/mock/timeout evidence.');

// The desktop runner must regenerate the gate immediately after the actual run.
const desktopSteps=execFileSync(process.execPath,['scripts/check_manual_studio.mjs','--group','desktop','--list'],{encoding:'utf8'}).trim().split('\n');
const resourceRun=desktopSteps.findIndex(step=>step.includes('Studio resource edit through real OS windows'));
assert.ok(resourceRun>=0);assert.match(desktopSteps[resourceRun+1],/entry-specific real resource edit evidence gate/,'full checks must not reuse a historical native-gate.json');
const uiSteps=execFileSync(process.execPath,['scripts/check_manual_studio.mjs','--group','ui','--list'],{encoding:'utf8'}).trim().split('\n');
const integrityRun=uiSteps.findIndex(step=>step.includes('document conflict, settings retry, protected sharing and legacy integrity'));
assert.ok(integrityRun>=0);assert.match(uiSteps[integrityRun+1],/entry-specific integrity evidence gate/);
