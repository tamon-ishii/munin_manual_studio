import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../apps/manual-studio/src/manualTransport.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { sendManualRequest } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
const request = { root: '/project', action: 'editor-save', options: { page: 'guide.md' } };
const response = (body, status = 200) => async () => new Response(body, { status });
assert.equal(await sendManualRequest(request, undefined, response('{"output":"saved"}')), 'saved');
assert.equal(await sendManualRequest(request, undefined, response('{"output":""}')), '');
await assert.rejects(sendManualRequest(request, undefined, response('{}')), /処理結果/);
await assert.rejects(sendManualRequest(request, undefined, response('broken', 502)), /HTTP 502/);
await assert.rejects(sendManualRequest(request, undefined, response('{"error":"conflict"}', 409)), /conflict/);
await assert.rejects(sendManualRequest(request, undefined, response('{"error":"failed"}')), /failed/);
await assert.rejects(sendManualRequest({ ...request, root: '' }), /フォルダー/);
assert.equal(await sendManualRequest(request, async received => {
  assert.deepEqual(received, request);
  return 'native';
}), 'native');
console.log('Manual Studio transport checks passed.');
