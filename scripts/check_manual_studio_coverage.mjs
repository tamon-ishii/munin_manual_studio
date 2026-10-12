import {readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sourceInventory,validateRegistry,validateEvidence,entryEvidenceStatus,fingerprint,treeFingerprint} from './lib/manual_ui_inventory.mjs';
import {verificationIdentity,sourcePaths} from './lib/manual_ui_identity.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const registry=JSON.parse(await readFile(path.join(root,'scripts/fixtures/manual-studio-ui-inventory.json'),'utf8'));
const scan=await sourceInventory(root);
scan.sourceHash=await treeFingerprint(root,sourcePaths);
const errors=validateRegistry(registry,scan);
const summary={sourceHash:scan.sourceHash,sourceInteractionSites:scan.operations.length,features:registry.features.length,cases:registry.cases.length,verifiedCases:0,unreviewedEntries:registry.actions.filter(item=>item.reviewStatus!=='reviewed').length,scope:'source-registration; behavioral coverage is separate',errors};
const argv=process.argv.slice(2);
if(argv.some((arg,index)=>!['--report','--output','--cases','--require-complete'].includes(arg)&&!['--report','--output','--cases'].includes(argv[index-1])))throw new Error('Usage: node scripts/check_manual_studio_coverage.mjs [--report path] [--output path] [--cases id,id] [--require-complete]');
const value=name=>{const i=argv.indexOf(name);if(i<0)return; if(!argv[i+1]||argv[i+1].startsWith('--'))throw new Error(`${name} requires a path`);return argv[i+1];};
const reportPath=value('--report');
const selected=value('--cases')?.split(',');
const scopedRegistry=selected?{...registry,cases:registry.cases.filter(item=>selected.includes(item.id))}:registry;
let evidenceReport;
let evidenceTrusted=false;
if(selected){for(const id of selected)if(!registry.cases.some(item=>item.id===id))errors.push(`unknown required case ${id}`);summary.selectedCases=selected;summary.scope='explicit cases only; other cases remain unverified';summary.unreviewedEntries=registry.actions.filter(item=>scopedRegistry.cases.some(test=>test.entryPoints.includes(item.id))&&item.reviewStatus!=='reviewed').length;}
if(reportPath) {
  const report=JSON.parse(await readFile(reportPath,'utf8'));
  evidenceReport=report;
  // A report cannot certify its own build: inspect the actual binary and frontend.
  const identity=await verificationIdentity(root);summary.buildHash=identity.buildHash;
  try {
    const stamp=JSON.parse(await readFile(path.join(root,'ui-coverage-results/build.json'),'utf8'));
    if(stamp.sourceHash!==identity.sourceHash||stamp.buildHash!==identity.buildHash||stamp.os!==identity.os)errors.push('build provenance does not match current sources/artifacts');
  }catch{errors.push('verified build provenance missing');}
  const identityForEvidence={sourceHash:scan.sourceHash,buildHash:summary.buildHash,os:process.platform};
  evidenceTrusted=errors.length===0&&validateEvidence({cases:[]},{...report,results:[]},identityForEvidence).length===0;
  errors.push(...validateEvidence(scopedRegistry,report,identityForEvidence));
  const beforeArtifacts=errors.length;
  for(const result of report.results||[])for(const artifact of result.artifacts||[]) {
    if(typeof artifact.path!=='string'||typeof artifact.sha256!=='string'){errors.push('artifact requires path and sha256');continue;}
    try{if(fingerprint(await readFile(path.resolve(path.dirname(reportPath),artifact.path)))!==artifact.sha256)errors.push(`artifact hash mismatch: ${artifact.path}`);}catch{errors.push(`missing artifact: ${artifact.path}`);}
  }
  evidenceTrusted=evidenceTrusted&&errors.length===beforeArtifacts;
  summary.verifiedCases=errors.length?0:scopedRegistry.cases.length;
}
if(argv.includes('--require-complete')) {
  if(!reportPath)errors.push('behavioral evidence report not supplied');
  if(summary.unreviewedEntries)errors.push(`${summary.unreviewedEntries} entry-specific contracts have not been reviewed`);
}
const output=value('--output');
const entryResults=entryEvidenceStatus(scopedRegistry,evidenceReport,{sourceHash:scan.sourceHash,buildHash:summary.buildHash,os:process.platform});
if(!evidenceTrusted)for(const entry of entryResults){entry.status='unverified';entry.errors.push('report provenance or artifact integrity not verified');}
summary.verifiedCases=scopedRegistry.cases.filter(testCase=>testCase.entryPoints.length>0&&entryResults.filter(entry=>entry.caseId===testCase.id).every(entry=>entry.status==='passed')).length;
if(output){
  await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify({...summary,entryResults},null,2)+'\n');
}
console.log(JSON.stringify(summary,null,2));
if(errors.length)process.exitCode=1;
