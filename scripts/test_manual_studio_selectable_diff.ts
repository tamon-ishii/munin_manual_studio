import assert from 'node:assert/strict';
import {diffParts,acceptDiff} from '../apps/manual-studio/src/selectableDiff';
for(const [before,after] of [['','新規文\n'],['a\n',''],['😀本文\n\n残す\n旧文','😀新文\n\n残す\n新文'],['a','a\n'],['a\nb','b\na']]){
 const parts=diffParts(before,after);assert.equal(acceptDiff(parts,new Set()),before);assert.equal(acceptDiff(parts,new Set(parts.map((_,i)=>i))),after);
}
const parts=diffParts('old A\nunchanged\nold B','new A\nunchanged\nnew B');assert.equal(acceptDiff(parts,new Set([0])),'new A\nunchanged\nold B');
console.log('Selective Diff passed: partial/all/rejected edits, insertion/deletion, Unicode and trailing newlines.');
