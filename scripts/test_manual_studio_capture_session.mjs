import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../apps/manual-studio/src/captureSession.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { CaptureSessionStore } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

const sessions = new CaptureSessionStore();
sessions.assertInactive();
const selection = { start: 12, end: 19 };
const first = sessions.begin({ root: '/workspace/one', page: 'docs/guide.md', id: 'task-guide-screenshot-1', selection });
selection.start = 99;
assert.equal(first.selection.start, 12, 'the stored text selection is copied at session start');
assert.equal(sessions.matchesTarget(first.generation, '/workspace/one', 'docs/guide.md'), true);
assert.equal(sessions.matchesTarget(first.generation, '/workspace/one', 'docs/other.md'), false, 'a different page is not the capture target');
assert.equal(sessions.matchesTarget(first.generation, '/workspace/two', 'docs/guide.md'), false, 'a different project is not the capture target');
assert.throws(() => sessions.assertInactive(), /撮影AIタグ/);
assert.throws(() => { first.root = '/workspace/two'; }, TypeError, 'the captured target cannot be mutated after begin');
assert.throws(() => { first.selection.start = 55; }, TypeError, 'the captured selection cannot be mutated after begin');

assert.equal(sessions.invalidate(first.generation), true, 'cancel invalidates the current session');
assert.equal(sessions.isCurrent(first.generation), false, 'a late result from the cancelled session is stale');
const second = sessions.begin({ root: '/workspace/one', page: 'docs/other.md', id: 'task-guide-screenshot-2', selection: { start: 0, end: 0 } });
assert.notEqual(second.generation, first.generation);
assert.equal(sessions.matchesTarget(first.generation, second.root, second.page), false, 'an old result cannot bind to a newer session on another page');
assert.equal(sessions.invalidate(first.generation), false, 'an old cancellation cannot invalidate the new session');
assert.equal(sessions.active, second);
assert.equal(sessions.invalidate(second.generation), true);
sessions.assertInactive();
console.log('Manual Studio capture session lifecycle checks passed.');
