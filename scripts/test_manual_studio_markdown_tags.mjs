import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../apps/manual-studio/src/markdownTags.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { collectAiTagIds } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

const markdown = [
  'The prose mentions id=task-page-screenshot-1 and must not reserve that id.',
  '<!-- ai:task id=task-page-screenshot-1 kind=screenshot -->',
  'Prompt text that mentions id=task-page-screenshot-12 is not another tag.',
  '<!-- ai:generated id=task-page-screenshot-10 -->content<!-- /ai:generated -->',
  '<!-- ai:task id=task-page-screenshot-2 kind=text -->',
].join('\n');
assert.deepEqual([...collectAiTagIds(markdown)].sort(), [
  'task-page-screenshot-1', 'task-page-screenshot-10', 'task-page-screenshot-2',
].sort());
assert.equal(collectAiTagIds(markdown).has('task-page-screenshot-12'), false, 'id prefixes and prompt prose do not collide');
assert.deepEqual([...collectAiTagIds('<!-- ai:task id="guide" kind=text prompt="id=fake > 説明" -->\n本文に id=other\n<!-- /ai:task -->')], ['guide']);
console.log('Manual Studio Markdown AI tag ID checks passed.');
