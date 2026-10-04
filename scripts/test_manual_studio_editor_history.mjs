import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../apps/manual-studio/src/editorHistory.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { EditorHistory } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
const trusted = (inputType) => ({ inputType, isTrusted: true });
const synthetic = (inputType) => ({ inputType, isTrusted: false });

const history = new EditorHistory();
history.reset({ value: '', start: 0, end: 0 });
assert.equal(history.canUndo, false);
assert.equal(history.canRedo, false);

// Adjacent same-kind input is grouped; a delay or different input type starts a step.
history.record({ value: 'a', start: 1, end: 1 }, trusted('insertText'), 1000);
history.record({ value: 'ab', start: 2, end: 2 }, trusted('insertText'), 1700);
assert.equal(history.length, 2);
assert.deepEqual(history.step(-1), { value: '', start: 0, end: 0 });
assert.deepEqual(history.step(1), { value: 'ab', start: 2, end: 2 });
history.record({ value: 'abc', start: 3, end: 3 }, trusted('insertText'), 2600);
assert.equal(history.length, 3, 'the 800ms boundary must start a new group');

// Selection-only changes update the current snapshot and terminate typing grouping.
history.rememberSelection(1, 3);
assert.deepEqual(history.current, { value: 'abc', start: 1, end: 3 });
history.record({ value: 'abcd', start: 4, end: 4 }, trusted('insertText'), 2700);
assert.equal(history.length, 4);

// A new edit after undo truncates redo, and synthetic input is never grouped.
assert.deepEqual(history.step(-1), { value: 'abc', start: 1, end: 3 });
history.record({ value: 'axc', start: 2, end: 2 }, synthetic('insertText'), 2800);
assert.equal(history.canRedo, false);
history.record({ value: 'axcd', start: 4, end: 4 }, synthetic('insertText'), 2850);
assert.equal(history.length, 5);

// Trimming retains the initial available undo state and caps storage at 201.
history.reset({ value: '0', start: 1, end: 1 });
for (let i = 1; i <= 220; i += 1) {
  history.record({ value: String(i), start: String(i).length, end: String(i).length }, synthetic('insertReplacementText'), i * 1000);
}
assert.equal(history.length, 201);
assert.equal(history.canUndo, true);
for (let i = 0; i < 200; i += 1) assert.notEqual(history.step(-1), null);
assert.equal(history.step(-1), null);
assert.deepEqual(history.current, { value: '20', start: 2, end: 2 });

// Invalid cursor offsets cannot escape the text bounds.
history.reset({ value: 'x', start: Number.NaN, end: 50 });
assert.deepEqual(history.current, { value: 'x', start: 0, end: 1 });
console.log('Manual Studio editor history checks passed.');
