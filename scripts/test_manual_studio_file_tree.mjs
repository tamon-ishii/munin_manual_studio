import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../apps/manual-studio/src/fileTree.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { renderFileTree } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

const escapedFile = 'docs/a&"<b>.md';
const entries = [
  { path: 'app/one.md', directory: false },
  { path: 'app-old/two.md', directory: false },
  { path: 'application/three.md', directory: false },
  { path: 'docs/guide.md', directory: false },
  { path: escapedFile, directory: false },
  { path: 'manual/README', directory: false },
  { path: 'app', directory: true },
  { path: 'app-old', directory: true },
  { path: 'application', directory: true },
];
const expanded = new Set(['app']);
const html = renderFileTree(entries, ['guide.md', 'manual/README'], 'guide.md', 'docs', expanded);

assert.match(html, /data-folder="app" open/);
assert.match(html, /data-folder="app-old" /);
assert.match(html, /data-folder="application" /);
assert.equal((html.match(/data-folder="app"/g) || []).length, 1, 'prefix-sharing folders remain separate tree nodes');
assert.match(html, /data-page="docs\/guide\.md" class="tree-file selected"[^>]*aria-current="page"/);
assert.ok(expanded.has('app'), 'caller expansion state is preserved');
assert.ok(expanded.has('docs'), 'the current page parent is expanded');
assert.match(html, /data-page="manual\/README" class="tree-file /, 'configured pages are recognized even without an .md suffix');
assert.match(html, /data-page="docs\/a&amp;&quot;&lt;b&gt;\.md"/, 'file paths are escaped for attributes');
assert.doesNotMatch(html, /data-page="docs\/a&"<b>/, 'unescaped file markup is never emitted');

assert.equal(renderFileTree([], [], undefined, 'docs', new Set()), '<p class="muted">フォルダーにファイルがありません。</p>');
console.log('Manual Studio file tree checks passed.');
