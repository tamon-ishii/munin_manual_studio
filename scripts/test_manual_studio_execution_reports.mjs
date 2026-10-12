import assert from 'node:assert/strict';
import { executionReportErrors } from './lib/manual_ui_report.mjs';

const now = Date.now();
const identity = { sourceHash: 'source', buildHash: 'build', os: 'linux' };
const valid = { ...identity, executedAt: new Date(now - 1000).toISOString(), completedAt: new Date(now).toISOString(), status: 'passed', identityStable: true, expectedSteps: 2, results: [{status: 'passed'}, {status: 'passed'}] };
assert.deepEqual(executionReportErrors(valid, identity, now), []);
for (const [name, mutate] of [
  ['stale source', r => r.sourceHash = 'old'],
  ['stale build', r => r.buildHash = 'old'],
  ['wrong OS', r => r.os = 'darwin'],
  ['missing timestamp', r => delete r.completedAt],
  ['expired run', r => { r.executedAt = new Date(now - 90_000_000).toISOString(); r.completedAt = r.executedAt; }],
  ['unstable identity', r => r.identityStable = false],
  ['missing steps despite passed status', r => r.results.pop()],
  ['failed step despite passed status', r => r.results[0].status = 'failed'],
  ['empty suite', r => { r.expectedSteps = 0; r.results = []; }],
]) {
  const report = structuredClone(valid); mutate(report);
  assert.ok(executionReportErrors(report, identity, now).length, name);
}
console.log('Execution reports reject stale/missing/expired evidence, wrong OS, incomplete and failed suites.');
