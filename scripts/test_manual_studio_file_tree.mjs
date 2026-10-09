import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';
const { renderFileTree } = await tsImport('../apps/manual-studio/src/fileTree.ts', import.meta.url);

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

const filtered = renderFileTree(entries, [], undefined, 'docs', new Set(), { query: 'GUIDE', markdownOnly: true });
assert.match(filtered, /data-page="docs\/guide.md"/);
assert.match(filtered, /data-folder="docs" open/);
assert.doesNotMatch(filtered, /data-folder="app"/);
assert.match(renderFileTree(entries, [], undefined, 'docs', new Set(), { query: 'no-matching-file' }), /条件に一致/);
