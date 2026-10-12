import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verificationIdentity } from './lib/manual_ui_identity.mjs';
import { execFileSync } from 'node:child_process';
import { executionReportErrors } from './lib/manual_ui_report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const missingReports = [];
async function readReport(relativePath) {
  try { return JSON.parse(await readFile(path.join(root, relativePath), 'utf8')); }
  catch (error) {
    missingReports.push(`${relativePath}: ${error.code || error.message}`);
    return { results: [], records: [], errors: [] };
  }
}

const build = await readReport('ui-coverage-results/build.json');
const nativeGate = await readReport('ui-coverage-results/native-gate.json');
const nativeResults = await readReport('native-workflow-results/result.json');
const faultResults = await readReport('native-workflow-results/faults/result.json');
const insertionResults = await readReport('ui-coverage-results/insertion/result.json');
const managedInsertionResults = await readReport('ui-coverage-results/managed-insertion/result.json');
const clipboardResults = await readReport('native-clipboard-results/result.json');
const manualCaptureResults = await readReport('native-manual-capture-results/result.json');
const editorAiCaptureResults = await readReport('ui-coverage-results/editor-ai-capture/result.json');
const aiWorkflowResults = await readReport('ui-coverage-results/ai-workflows/result.json');
const integrityResults = await readReport('ui-coverage-results/integrity/result.json');
const authorSettingsResults = await readReport('ui-coverage-results/author-settings/result.json');
const imageControlResults = await readReport('ui-coverage-results/image-controls/result.json');
const miscControlResults = await readReport('ui-coverage-results/misc-controls/result.json');

// Verify build hash identity across all unified reports
const errors = [...missingReports];
let current;
try { current = await verificationIdentity(root); }
catch (error) { errors.push(`current build identity unavailable: ${error.code || error.message}`); current = {}; }
for (const key of ['sourceHash', 'buildHash', 'os']) {
  if (build[key] !== current[key]) errors.push(`build ${key} does not match current sources/artifacts`);
}
// These suites are informative until they carry the same provenance as the build.
for (const [name, report] of Object.entries({ insertionResults, managedInsertionResults, clipboardResults, manualCaptureResults, editorAiCaptureResults, aiWorkflowResults, integrityResults, faultResults, authorSettingsResults, imageControlResults, miscControlResults })) {
  if (report.sourceHash !== build.sourceHash) errors.push(`${name} source provenance missing or stale`);
  if (report.buildHash !== build.buildHash) errors.push(`${name} build provenance missing or stale`);
  if (report.os !== current.os) errors.push(`${name} OS provenance missing or stale`);
  const completed = Date.parse(report.completedAt);
  if (!Number.isFinite(completed) || completed > Date.now() + 60_000 || Date.now() - completed > 86_400_000) errors.push(`${name} completion timestamp missing or expired`);
}
if (!nativeResults.results.length || nativeResults.results.some(r => r.status !== 'passed')) errors.push('native desktop cases missing or failed');
if (!clipboardResults.results.length || clipboardResults.results.some(r => r.status !== 'passed')) errors.push('actual OS clipboard cases missing or failed');
if (!manualCaptureResults.results.length || manualCaptureResults.results.some(r => r.status !== 'passed')) errors.push('actual OS manual capture cases missing or failed');
if (!editorAiCaptureResults.results.length || editorAiCaptureResults.results.some(r => r.status !== 'passed')) errors.push('editor AI screenshot cases missing or failed');
if (faultResults.complete !== true || faultResults.identityStable !== true || faultResults.results.length !== 3 || faultResults.results.some(r => r.exitCode === 0 || !r.sourceRestored || !r.binaryRestored)) errors.push('fault injection incomplete or failed');
if (!insertionResults.records.length || insertionResults.records.some(r => !r.assertions?.visible || !r.assertions?.stored || !r.assertions?.preserved || !r.assertions?.returnTarget)) errors.push('insertion contracts incomplete or failed');
if (!managedInsertionResults.records.length || managedInsertionResults.records.some(r => !r.assertions?.visible || !r.assertions?.stored || !r.assertions?.preserved || !r.assertions?.returnTarget)) errors.push('managed insertion contracts incomplete or failed');
if (!aiWorkflowResults.records.length || aiWorkflowResults.records.some(record => record.status !== 'passed')) errors.push('AI workflow scenarios incomplete or failed');
if (!integrityResults.records.length || integrityResults.records.some(r => r.status !== 'passed')) errors.push('integrity workflows incomplete or failed');
if (!authorSettingsResults.results?.length || authorSettingsResults.results.some(r => r.status !== 'passed')) errors.push('author settings contracts incomplete or failed');
if (!imageControlResults.results?.length || imageControlResults.results.some(r => r.status !== 'passed')) errors.push('image control contracts incomplete or failed');
if (!miscControlResults.results?.length || miscControlResults.results.some(r => r.status !== 'passed')) errors.push('misc control contracts incomplete or failed');
const coverageArgs = ['scripts/check_manual_studio_coverage.mjs', '--require-complete'];
const reportIndex = process.argv.indexOf('--report');
if (reportIndex >= 0) {
  if (!process.argv[reportIndex + 1]) throw new Error('--report requires a path');
  coverageArgs.push('--report', process.argv[reportIndex + 1]);
} else {
  const combinedPath=path.join(root,'ui-coverage-results/behavioral-evidence.json');
  const results=[];
  for(const [relativePath,report] of [
    ['native-workflow-results/result.json',nativeResults],
    ['ui-coverage-results/insertion/result.json',insertionResults],
    ['ui-coverage-results/managed-insertion/result.json',managedInsertionResults],
    ['native-clipboard-results/result.json',clipboardResults],
    ['native-manual-capture-results/result.json',manualCaptureResults],
    ['ui-coverage-results/editor-ai-capture/result.json',editorAiCaptureResults],
    ['ui-coverage-results/integrity/result.json',integrityResults],
    ['ui-coverage-results/ai-workflows/result.json',aiWorkflowResults],
    ['ui-coverage-results/author-settings/result.json',authorSettingsResults],
    ['ui-coverage-results/image-controls/result.json',imageControlResults],
    ['ui-coverage-results/misc-controls/result.json',miscControlResults]
  ]) {
    if(['sourceHash','buildHash','os'].some(key=>report[key]!==current[key])) {errors.push(`${relativePath}: evidence cannot be merged with current identity`);continue;}
    for(const result of report.results||[])results.push({...result,artifacts:(result.artifacts||[]).map(artifact=>({...artifact,path:path.relative(path.dirname(combinedPath),path.resolve(root,path.dirname(relativePath),artifact.path))}))});
  }
  // Use the oldest constituent run time: merging cannot renew expired evidence.
  const timestamps=[nativeResults.executedAt,insertionResults.executedAt,managedInsertionResults.executedAt,clipboardResults.executedAt,manualCaptureResults.executedAt,editorAiCaptureResults.executedAt,integrityResults.executedAt,aiWorkflowResults.executedAt,authorSettingsResults.executedAt,imageControlResults.executedAt,miscControlResults.executedAt].map(Date.parse);
  const executedAt=timestamps.every(Number.isFinite)?new Date(Math.min(...timestamps)).toISOString():null;
  await mkdir(path.dirname(combinedPath),{recursive:true});
  await writeFile(combinedPath,JSON.stringify({...current,executedAt,results},null,2)+'\n');
  coverageArgs.push('--report',combinedPath);
}
coverageArgs.push('--output','ui-coverage-results/full-gate.json');
let coverage;
try {
  coverage = JSON.parse(execFileSync(process.execPath, coverageArgs, { cwd: root, encoding: 'utf8' }));
} catch (error) {
  try { coverage = JSON.parse(error.stdout); }
  catch { coverage = { errors: ['full coverage gate could not produce a report'] }; }
}
errors.push(...coverage.errors);
const coverageDetail=await readReport('ui-coverage-results/full-gate.json');
const verifiedDesktopCases=(nativeGate.selectedCases||[]).filter(caseId=>{
  const entries=(coverageDetail.entryResults||[]).filter(entry=>entry.caseId===caseId);
  return entries.length>0&&entries.every(entry=>entry.status==='passed');
}).length;
const checkGroups = [];
for (const name of ['unit', 'ui', 'generation', 'capture', 'native', 'smoke', 'desktop']) {
  const report = await readReport(`ui-coverage-results/check-groups/${name}.json`);
  const groupErrors = executionReportErrors(report, current);
  const verified = groupErrors.length === 0;
  checkGroups.push({ name, status: verified ? 'passed' : 'unverified' });
  if (!verified) errors.push(...groupErrors.map(error => `${name} check group: ${error}`));
}
if (nativeGate.sourceHash !== build.sourceHash) errors.push(`nativeGate sourceHash mismatch: ${nativeGate.sourceHash} !== ${build.sourceHash}`);
if (nativeGate.buildHash !== build.buildHash) errors.push(`nativeGate buildHash mismatch: ${nativeGate.buildHash} !== ${build.buildHash}`);
if (nativeResults.sourceHash !== build.sourceHash) errors.push(`nativeResults sourceHash mismatch: ${nativeResults.sourceHash} !== ${build.sourceHash}`);
if (nativeResults.buildHash !== build.buildHash) errors.push(`nativeResults buildHash mismatch: ${nativeResults.buildHash} !== ${build.buildHash}`);
if (nativeGate.errors.length > 0) errors.push(...nativeGate.errors);

const summary = {
  sourceHash: build.sourceHash,
  buildHash: build.buildHash,
  os: build.os,
  executedAt: new Date().toISOString(),
  status: errors.length === 0 ? 'passed' : 'failed',
  errors,
  coverage,
  suites: {
    nativeDesktopWorkflow: {
      cases: nativeResults.results.length,
      passed: nativeResults.results.filter(r => r.status === 'passed').length,
      type: 'real-desktop',
      verifiedCases: verifiedDesktopCases
    },
    nativeFaultInjection: {
      mutants: faultResults.results.length,
      rejected: faultResults.results.filter(r => r.exitCode !== 0 && r.sourceRestored && r.binaryRestored).length,
      type: 'real-desktop-fault-injection'
    },
    nativeClipboard: {
      entries: clipboardResults.results.length,
      verifiedCases: [...new Set(clipboardResults.results.map(result => result.caseId))].filter(caseId => {
        const entries = (coverageDetail.entryResults || []).filter(entry => entry.caseId === caseId);
        return entries.length > 0 && entries.every(entry => entry.status === 'passed');
      }).length,
      type: clipboardResults.type,
      scope: clipboardResults.scope
    },
    insertionContracts: {
      entries: insertionResults.records.length,
      allPassed: insertionResults.records.length>0&&insertionResults.records.every(r => r.assertions?.visible && r.assertions?.stored && r.assertions?.preserved && r.assertions?.returnTarget),
      type: insertionResults.type
    },
    managedInsertionContracts: {
      entries: managedInsertionResults.records.length,
      verifiedCases: (managedInsertionResults.records || []).filter(record => {
        const entries = (coverageDetail.entryResults || []).filter(entry => entry.caseId === record.caseId);
        return entries.length > 0 && entries.every(entry => entry.status === 'passed');
      }).length,
      type: managedInsertionResults.type,
      scope: managedInsertionResults.scope
    },
    aiWorkflows: {
      scenarios: aiWorkflowResults.records.length,
      passed: aiWorkflowResults.records.filter(record => record.status === 'passed').length,
      type: aiWorkflowResults.type, scope: aiWorkflowResults.scope
    },
    integrityWorkflows: {
      scenarios: integrityResults.records.length,
      passed: integrityResults.records.filter(r => r.status === 'passed').length,
      scope: integrityResults.scope
    },
    authorSettingsContracts: {
      entries: authorSettingsResults.results?.length || 0,
      passed: (authorSettingsResults.results || []).filter(r => r.status === 'passed').length,
      type: authorSettingsResults.type,
      scope: authorSettingsResults.scope
    },
    imageControlContracts: {
      entries: imageControlResults.results?.length || 0,
      passed: (imageControlResults.results || []).filter(r => r.status === 'passed').length,
      type: imageControlResults.type,
      scope: imageControlResults.scope
    },
    miscControlContracts: {
      entries: miscControlResults.results?.length || 0,
      passed: (miscControlResults.results || []).filter(r => r.status === 'passed').length,
      type: miscControlResults.type,
      scope: miscControlResults.scope
    },
    checkGroups
  },
  osCoverageNote: 'Historical Linux reports include real OS workflows; current coverage requires matching provenance. Windows and macOS have no evidence in this summary.'
};

const outputPath = path.join(root, 'ui-coverage-results/verification-summary.json');
await writeFile(outputPath, JSON.stringify(summary, null, 2) + '\n');
console.log(`Verification summary generated: ${outputPath}`);
console.log(JSON.stringify({status:summary.status,sourceHash:summary.sourceHash,buildHash:summary.buildHash,verifiedCases:coverage.verifiedCases,unreviewedEntries:coverage.unreviewedEntries,checkGroups,errorCount:errors.length,errors:errors.slice(0,12)},null,2));

if (errors.length > 0) {
  process.exitCode = 1;
}
