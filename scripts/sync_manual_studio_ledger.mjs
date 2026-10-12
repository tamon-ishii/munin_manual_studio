// Developer tool: reconcile the UI inventory ledger with changed source after an intentional UI change.
// Dry run by default. With --apply it rewrites scripts/fixtures/manual-studio-ui-inventory.json:
//  - a stale entry whose control still exists (same file+kind, similar expression/line) keeps its review data under the new id;
//  - a new control inherits feature/spec/cases from the nearest entry in the same file and is marked
//    needs-entry-specific-review, so it is never counted as behaviorally verified;
//  - a stale entry with no counterpart is dropped (the control was removed).
// The coverage gate still rejects any entry that lacks real evidence, so this does not certify behavior.
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sourceInventory} from './lib/manual_ui_inventory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'scripts/fixtures/manual-studio-ui-inventory.json');
const apply = process.argv.includes('--apply');
const registry = JSON.parse(await readFile(file, 'utf8'));
const scan = await sourceInventory(root);
const current = new Map(scan.operations.map(op => [op.id, op]));
const known = new Set(registry.actions.map(a => a.id));
const stale = registry.actions.filter(a => !current.has(a.id));
const added = scan.operations.filter(op => !known.has(op.id));
const prefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
const remap = new Map(); // old id -> new id
const claimed = new Set();
for (const old of stale) {
  const options = added.filter(op => !claimed.has(op.id) && op.file === old.file && op.kind === old.kind);
  options.sort((x, y) => (prefix(old.expression, y.expression) - prefix(old.expression, x.expression)) || (Math.abs(x.line - old.line) - Math.abs(y.line - old.line)));
  const best = options[0];
  if (best && (prefix(old.expression, best.expression) >= 24 || Math.abs(best.line - old.line) <= 12)) { remap.set(old.id, best.id); claimed.add(best.id); }
}
const dropped = stale.filter(old => !remap.has(old.id));
const fresh = added.filter(op => !claimed.has(op.id));
const report = {remapped: remap.size, dropped: dropped.map(a => a.id), added: fresh.map(op => `${op.file}:${op.line} ${op.kind}`)};

for (const action of registry.actions) {
  const id = remap.get(action.id);
  if (!id) continue;
  const op = current.get(id);
  Object.assign(action, {id, line: op.line, expression: op.expression});
}
registry.actions = registry.actions.filter(a => !dropped.some(d => d.id === a.id));
for (const op of fresh) {
  const neighbors = registry.actions.filter(a => a.file === op.file).sort((x, y) => Math.abs(x.line - op.line) - Math.abs(y.line - op.line));
  const near = neighbors[0];
  if (!near) { report.unplaced = [...(report.unplaced || []), `${op.file}:${op.line}`]; continue; }
  registry.actions.push({id: op.id, file: op.file, line: op.line, kind: op.kind, expression: op.expression, feature: near.feature, spec: near.spec, result: near.result, returnTarget: near.returnTarget, cases: [...near.cases], reviewStatus: 'needs-entry-specific-review'});
  for (const testCase of registry.cases) if (near.cases.includes(testCase.id)) { const at = testCase.entryPoints.indexOf(near.id); testCase.entryPoints.splice(at < 0 ? testCase.entryPoints.length : at + 1, 0, op.id); }
}
for (const testCase of registry.cases) {
  testCase.entryPoints = [...new Set(testCase.entryPoints.map(id => remap.get(id) || id).filter(id => !dropped.some(d => d.id === id)))];
}
console.log(JSON.stringify(report, null, 2));
if (report.unplaced) { console.error('Some new controls have no neighbor entry; register them manually.'); process.exitCode = 1; }
else if (apply) { await writeFile(file, JSON.stringify(registry, null, 2) + '\n'); console.log('Ledger updated. Review the diff and run node scripts/check_manual_studio_coverage.mjs.'); }
else console.log('Dry run. Re-run with --apply to write the ledger.');
