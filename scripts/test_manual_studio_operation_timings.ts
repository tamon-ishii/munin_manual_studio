import assert from 'node:assert/strict';
import {OperationTiming} from '../apps/manual-studio/src/operationTimings';
let time=0;const requests:Array<{root:string;options:Record<string,unknown>}>=[];
const trace=new OperationTiming(async(_action,options,root)=>{requests.push({root,options});return '{}';},'/original-project','screenshot-insert',()=>time);
trace.stage('markits');time=2000;trace.stage('import');time=2125;trace.stage('save');time=2200;await trace.finish('success');time=9999;await trace.finish('error');trace.stage('preview');
assert.equal(requests.length,1);assert.equal(requests[0].root,'/original-project');assert.deepEqual(requests[0].options,{json:{operation:'screenshot-insert',outcome:'success',stages:[{stage:'markits',duration_ms:2000},{stage:'import',duration_ms:125},{stage:'save',duration_ms:75}]}});
for(const outcome of ['cancelled','error'] as const){const item=new OperationTiming(async(_a,options,root)=>{requests.push({root,options});return '{}';},'/owner');item.stage('preview');await item.finish(outcome);assert.equal((requests.at(-1)!.options.json as {outcome:string}).outcome,outcome);}
console.log('Operation durations, original owner, completion idempotency and failure/cancellation records passed.');
