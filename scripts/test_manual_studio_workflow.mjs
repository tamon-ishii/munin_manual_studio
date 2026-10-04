import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../apps/manual-studio/src/markitsWorkflow.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { completeMarkitsCapture } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

const events = [];
let markdownHasTag = false;
let documentDirty = false;
let captureSourceSaved = false;
let failCaptureSourceOnce = true;
const run = () => completeMarkitsCapture({
  alreadyInserted: markdownHasTag,
  dirty: documentDirty,
  importImage: async () => { events.push('import-image'); return '<!-- ai:generated id=screen-one -->'; },
  insertTag: () => { events.push('insert-tag'); markdownHasTag = true; documentDirty = true; },
  saveDocument: async () => { events.push('save-document'); documentDirty = false; },
  saveCaptureSource: async () => {
    events.push('save-capture-source');
    if (failCaptureSourceOnce) { failCaptureSourceOnce = false; throw new Error('simulated retryable failure'); }
    captureSourceSaved = true;
  },
  refreshWorkspace: async () => { events.push('refresh'); },
  reportStage: (stage) => events.push(`stage:${stage}`),
});

await assert.rejects(run(), /simulated retryable failure/);
assert.equal(markdownHasTag, true, 'the tag is already durable when the later registration step fails');
assert.equal(documentDirty, false);
assert.deepEqual(events.filter((event) => ['import-image', 'insert-tag', 'save-document'].includes(event)), ['import-image', 'insert-tag', 'save-document']);

events.length = 0;
await run();
assert.equal(captureSourceSaved, true);
assert.equal(events.includes('import-image'), false, 'retry must not import or duplicate the existing tag');
assert.equal(events.includes('insert-tag'), false);
assert.equal(events.includes('save-document'), false);
assert.deepEqual(events.filter((event) => event.startsWith('stage:')), ['stage:capture-source', 'stage:refresh']);
console.log('Manual Studio MarkIts workflow retry check passed.');
