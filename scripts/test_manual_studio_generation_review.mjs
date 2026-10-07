import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const source = await readFile(new URL('../apps/manual-studio/src/generationReview.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { diffLines } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
for (const [before, after] of [['a\nb\nc', 'a\nx\nc'], ['', 'new'], ['old', ''], ['同じ', '同じ'], ['a\nb\na', 'b\na\nb'], ['x\n'.repeat(1100), 'y\n'.repeat(1100)]]) {
  const lines = diffLines(before, after);
  assert.equal(lines.filter(line => line.kind !== 'add').map(line => line.text).join('\n'), before);
  assert.equal(lines.filter(line => line.kind !== 'remove').map(line => line.text).join('\n'), after);
}
const root = await mkdtemp(path.join(os.tmpdir(), 'munin-generation-review-'));
const requests = [];
let answer = { answers: [{ id: 'guide', markdown: 'New guide text' }] };
let responseGate;
let observeRequest;
const server = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  requests.push(JSON.parse(body));
  observeRequest?.();
  if (responseGate) await responseGate;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const execute = promisify(execFile);
const rpc = async (action, options = {}) => {
  const { stdout } = await execute(path.resolve('target/debug/manualctl'), ['--request', JSON.stringify({ root, action, options })], { maxBuffer: 5_000_000 });
  return JSON.parse(stdout);
};
try {
  await mkdir(path.join(root, 'manual/docs'), { recursive: true });
  await writeFile(path.join(root, 'manual_setting.json'), JSON.stringify({ docs: 'manual/docs', output: 'site', assets: 'manual/docs/images', connection_type: 'local_llm', endpoint_url: `http://127.0.0.1:${server.address().port}/v1` }));
  const page = 'manual/docs/index.md';
  const original = '# Guide\n\n<!-- ai:task id=guide kind=text\nExplain the guide\n-->\n\nHand edited introduction.\n';
  await writeFile(path.join(root, page), original);
  const preview = await rpc('generation-input', { page });
  assert.equal(requests.length, 0, 'input inspection does not invoke AI');
  assert.equal(preview.existing_content, original);
  assert.ok(preview.requests[0].prompt.includes('Hand edited introduction.'));
  const candidate = await rpc('generate-review', { page, json: { ids: ['guide'], revision: preview.revision } });
  assert.ok(requests[0].messages[1].content.startsWith(preview.requests[0].prompt), 'preview and execution share the exact request builder');
  const history = await rpc('generation-history', { page });
  assert.equal(history.entries[0].id, candidate.history_id);
  const newHistory = path.join(root, '.munin/generation-history', candidate.history_id + '.json');
  assert.ok(await readFile(newHistory, 'utf8'));
  await mkdir(path.join(root, 'manual/ai/history'), {recursive:true});
  const {rename} = await import('node:fs/promises');
  await rename(newHistory, path.join(root,'manual/ai/history',candidate.history_id + '.json'));
  const archivedCandidate = await rpc('generation-history-entry', { id: candidate.history_id });
  assert.ok(await readFile(newHistory, 'utf8'), 'legacy history migrated outside public output');
  await assert.rejects(readFile(path.join(root,'manual/ai/history',candidate.history_id + '.json')), /ENOENT/);
  assert.equal(archivedCandidate.candidate.content, candidate.content);
  assert.equal(archivedCandidate.input.requests[0].prompt, preview.requests[0].prompt);
  await assert.rejects(rpc('generation-history-entry', { id: '../index.md' }), /履歴ID/);
  assert.equal(candidate.before.content, original);
  assert.match(candidate.content, /New guide text/);
  assert.match(candidate.content, /Hand edited introduction/);
  assert.equal(await readFile(path.join(root, page), 'utf8'), original, 'review leaves source untouched');
  assert.equal(requests.length, 1, 'page tasks share one AI request');
  answer = { markdown: 'Revised guide' };
  const retry = await rpc('generate-review', { page, id: 'guide', feedback: 'Shorter please' });
  assert.match(requests.at(-1).messages[1].content, /Shorter please/);
  assert.match(retry.content, /Revised guide/);
  const adopted = await rpc('editor-save', { page, json: { content: retry.content, revision: retry.before.revision } });
  assert.equal(await readFile(path.join(root, page), 'utf8'), retry.content);
  await rpc('editor-save', { page, json: { content: original, revision: adopted.revision } });

  // Direct terminal single-task body injection
  const directSingle = await rpc('generate-review', { page, id: 'guide', body: 'Direct terminal body' });
  assert.equal(directSingle.before.content, original);
  assert.match(directSingle.content, /Direct terminal body/);
  assert.deepEqual(directSingle.updated, ['guide']);

  // Direct terminal batch bodies injection
  const directBatch = await rpc('generate-review', { page, bodies: JSON.stringify({ guide: 'Direct terminal batch body' }) });
  assert.equal(directBatch.before.content, original);
  assert.match(directBatch.content, /Direct terminal batch body/);
  assert.deepEqual(directBatch.updated, ['guide']);
  const evidence = '<button title="日本語 -->">Save</button>';
  await writeFile(path.join(root, 'source.html'), evidence);
  for (let version = 1; version <= 3; version++) {
    const fact = JSON.stringify({ claim: '保存ボタン', file: 'source.html', contains: evidence });
    answer = { answers: [{ id: 'guide', markdown: `Version ${version}\n\n\`\`\`sh\nmunin --help\n\`\`\`\n保存ボタン。<!-- ai:fact ${fact} -->` }] };
    const review = await rpc('generate-review', { page });
    assert.equal((review.content.match(/<!-- ai:task id=guide /g) ?? []).length, 1);
    assert.equal((review.content.match(/Version /g) ?? []).length, 1);
    assert.match(review.content, /Hand edited introduction/);
    assert.ok(review.content.includes(`Version ${version}`));
    await rpc('editor-save', { page, json: { content: review.content, revision: review.before.revision } });
  }
  const stable = await readFile(path.join(root, page), 'utf8');
  answer = { markdown: '<!-- ai:fact {"claim":"broken -->' };
  await assert.rejects(rpc('generate-review', { page, id: 'guide' }), /Invalid generated ai:fact/);
  assert.equal(await readFile(path.join(root, page), 'utf8'), stable);
  const wrapped = '<!-- ai:generated id=guide kind=text -->\nDuplicate\n<!-- /ai:generated -->';
  answer = { markdown: `${wrapped}\n\n${wrapped}` };
  await assert.rejects(rpc('generate-review', { page, id: 'guide' }), /multiple task\/generated/);
  assert.equal(await readFile(path.join(root, page), 'utf8'), stable);
  await writeFile(path.join(root, page), `${original}\nExternal edit\n`);
  await assert.rejects(rpc('editor-save', { page, json: { content: candidate.content, revision: candidate.before.revision } }), /原稿が更新/);
  assert.match(await readFile(path.join(root, page), 'utf8'), /External edit/);
  for (const invalid of [{}, { markdown: 42 }, { markdown: 'Text', reasoning: 'Generating...' }, { markdown: '* <!-- ai:fact ' + JSON.stringify({claim:'保存ボタン',file:'source.html',contains:evidence}) + ' -->' }, {markdown:'<!-- explanation only -->'}, {markdown:'正常な説明。\n\n* <!-- ai:fact ' + JSON.stringify({claim:'保存ボタン',file:'source.html',contains:evidence}) + ' -->'}]) {
    answer = invalid;
    await assert.rejects(rpc('generate-review', { page, id: 'guide' }), /AI回答/);
    assert.match(await readFile(path.join(root, page), 'utf8'), /External edit/);
  }
  answer = { markdown: 'Late final answer' };
  let releaseResponse;
  responseGate = new Promise(resolve => { releaseResponse = resolve; });
  const requestObserved = new Promise(resolve => { observeRequest = resolve; });
  const pendingReview = rpc('generate-review', { page, id: 'guide' });
  const rejected = assert.rejects(pendingReview, /中断/);
  await requestObserved;
  await rpc('agent-cancel');
  // The server deliberately withholds its reply; cancellation must finish first.
  try {
    await Promise.race([rejected, new Promise((_, reject) => setTimeout(() => reject(new Error('API cancellation waited for the server reply')), 1500))]);
  } finally { releaseResponse(); }
  await rejected;
  responseGate = undefined;
  observeRequest = undefined;
  assert.match(await readFile(path.join(root, page), 'utf8'), /External edit/);
  answer = { markdown: '' };
  await assert.rejects(rpc('generate-review', { page, id: 'guide' }), /empty answer/);
  assert.match(await readFile(path.join(root, page), 'utf8'), /External edit/);
  // A selected subset never generates or changes the other task.
  const subsetSource = '# Selected\n\n<!-- ai:task id=first kind=text prompt="First instruction" -->\n\n<!-- /ai:task -->\n\n<!-- ai:task id=second kind=text prompt="Second instruction" -->\n\nOriginal second body\n\n<!-- /ai:task -->\n';
  await writeFile(path.join(root, page), subsetSource);
  const subsetInput = await rpc('generation-input', { page, json: { ids:['first'] } });
  assert.deepEqual(subsetInput.tasks.map(task => task.id), ['first']);
  answer = { answers: [{ id:'first', markdown:'Only first updated' }] };
  const subset = await rpc('generate-review', { page, json: { ids:['first'], revision:subsetInput.revision } });
  assert.deepEqual(subset.updated, ['first']);
  assert.match(subset.content, /Original second body/);
  assert.match(subset.content, /Only first updated/);
  await assert.rejects(rpc('generate-review', { page, json:{ ids:['unknown'] } }), /生成対象/);
  await assert.rejects(rpc('generate-review', { page, json:{ ids:[] } }), /選んで/);
  await writeFile(path.join(root, page), subsetSource + '\nExternal change\n');
  const requestCount = requests.length;
  await assert.rejects(rpc('generate-review', { page, json:{ ids:['first'], revision:subsetInput.revision } }), /入力確認後/);
  assert.equal(requests.length, requestCount, 'stale inputs fail before invoking AI');
  console.log('Generation review checks passed: diff, staged generation, feedback, adoption, restore, repeated fenced results, fact metadata, conflict, and generation failure.');
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
