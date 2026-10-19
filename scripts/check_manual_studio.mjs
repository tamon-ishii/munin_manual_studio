import { spawn } from 'node:child_process';
import process from 'node:process';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { verificationIdentity } from './lib/manual_ui_identity.mjs';

const registry = JSON.parse(await readFile('scripts/fixtures/manual-studio-ui-inventory.json', 'utf8'));
const nativeResourceCases = registry.cases.filter(test => (test.existingChecks || []).includes('scripts/test_manual_studio_native_resource_edit.py') || test.script === 'scripts/test_manual_studio_native_resource_edit.py').map(test => test.id);
const integrityCases = ["P02.integrity-conflict-project-cancel", "P13.integrity-settings-retry", "P15.integrity-legacy-open", "P06.integrity-protected-sharing", "P08.integrity-recapture-partial-retry"];
const authorSettingsCases = ['P02.brief-persistence', 'P02.editor-autosave', 'P13.toolbar-visibility'];
const imageControlCases = [
  'P06.control-search', 'P06.control-kind', 'P06.control-usage', 'P06.control-compact-menu',
  'P06.control-refresh', 'P06.control-usage-link', 'P06.control-replace', 'P07.control-restore',
  'P07.control-zoom', 'P07.control-fit', 'P07.control-adopt-callback', 'P07.control-escape', 'P07.control-close'
];
const miscControlCases = [
  'P14.failure-preserves-output-and-recheck',
  'I02.document-tags-pane-preferences', 'I01.batch-page-selection', 'P12.workflow-result-actions',
  'I01.generation-input-contract', 'I01.generation-review-contract', 'I01.generation-history-contract',
  'I01.execution-history-and-expectations'
];

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const steps = [
  { group: 'unit', name: 'operation timing ownership and lifecycle', command: npx, args: ['tsx','scripts/test_manual_studio_operation_timings.ts'], timeoutMs: 60_000 },
  { group: 'unit', name: 'execution report provenance and failure checks', command: process.execPath, args: ['scripts/test_manual_studio_execution_reports.mjs'], timeoutMs: 60_000 },
  { group: 'unit', name: 'UI coverage contract and fault checks', command: process.execPath, args: ['scripts/test_manual_studio_coverage.mjs'], timeoutMs: 60_000 },
  { group: 'unit', name: 'UI source operation registration (not behavior proof)', command: process.execPath, args: ['scripts/check_manual_studio_coverage.mjs'], timeoutMs: 60_000 },
  { group: 'unit', name: 'CI runner fault rejection', command: process.execPath, args: ['scripts/test_manual_studio_ci_gate.mjs'], timeoutMs: 90_000 },
  { group: 'unit', name: "AI credentials checks", command: process.execPath, args: ["scripts/test_manual_studio_ai_credentials.mjs"], timeoutMs: 60_000 },
  { group: 'unit', name: 'preview navigation unit checks', command: npx, args: ['tsx', 'apps/manual-studio/src/previewNavigation.test.ts'], timeoutMs: 60_000 },
  { group: 'unit', name: 'editor history unit checks', command: process.execPath, args: ['scripts/test_manual_studio_editor_history.mjs'], timeoutMs: 60_000 },
  { group: 'unit', name: 'file tree rendering checks', command: process.execPath, args: ['scripts/test_manual_studio_file_tree.mjs'], timeoutMs: 60_000 },
  { group: 'unit', name: 'MarkIts workflow checks', command: npm, args: ['run', 'manual:test-workflow'], timeoutMs: 60_000 },
  { group: 'unit', name: 'transport callback mock checks', command: process.execPath, args: ['scripts/test_manual_studio_transport.mjs'], timeoutMs: 60_000 },
  { group: 'unit', name: 'capture session checks', command: process.execPath, args: ['scripts/test_manual_studio_capture_session.mjs'], timeoutMs: 60_000 },
  { group: 'unit', name: 'terminal output parser checks', command: npx, args: ['tsx', 'scripts/test_terminal_output_parser.mjs'], timeoutMs: 60_000 },
  { group: 'unit', name: 'PNG annotation metadata checks', command: npx, args: ['tsx', 'scripts/test_image_comparison.ts'], timeoutMs: 60_000 },
];
steps.push({ group: 'unit', name: 'shared insertion context checks', command: npx, args: ['tsx','scripts/test_manual_studio_insertion_context.ts'], timeoutMs: 60_000 });
steps.push({ group: 'unit', name: 'selective Diff checks', command: npx, args: ['tsx','scripts/test_manual_studio_selectable_diff.ts'], timeoutMs: 60_000 });
steps.push({group:'unit',name:'manuscript replacement and section move checks',command:npx,args:['tsx','scripts/test_manuscript_tools.ts'],timeoutMs:60_000});
steps.push({group:'unit',name:'review correction apply and batch checks',command:process.execPath,args:['scripts/test_manual_studio_review_corrections.mjs'],timeoutMs:60_000});
const unitStepCount = steps.length;

steps.push(
  {group:'ui',name:'manuscript search real-backend contracts',command:process.execPath,args:['scripts/test_manual_studio_manuscript_tools.mjs'],timeoutMs:120_000},
  {group:'ui',name:'manuscript Git real-backend contracts',command:process.execPath,args:['scripts/test_manual_studio_manuscript_git.mjs'],timeoutMs:120_000},
  ...[['tools','P17.contracts'],['git','P19.contracts']].map(([name,cases])=>({group:'ui',name:`manuscript ${name} evidence gate`,command:process.execPath,args:['scripts/check_manual_studio_coverage.mjs','--cases',cases,'--report',`ui-coverage-results/manuscript-${name}/result.json`,'--require-complete'],timeoutMs:60_000})),
  { group: 'ui', name: 'UI runtime discovery and unknown/unreachable-control faults', command: process.execPath, args: ['scripts/test_manual_studio_runtime_inventory.mjs'], timeoutMs: 90_000 },
  { group: 'generation', name: 'reader review and screenshot instruction integration', command: process.execPath, args: ['scripts/test_manual_studio_ai_assistance.mjs'], timeoutMs: 180_000 },
  { group: 'generation', name: 'entry-specific review, selection Diff, full draft and progress evidence gate', command: process.execPath, args: ['scripts/check_manual_studio_coverage.mjs', '--cases', "P12.compact-progress-dismiss-cancel,P12.full-draft-discard,P12.full-draft-selective-page-part-adoption,P09.review-preflight-retry,P09.selection-review-filter-rerun-jump,P09.review-finding-correction-chain,P09.report-reopen-after-reload,P12.progress-log-reopen-after-review,P10.selection-diff-partial-retry-undo-redo,P10.cursor-position-new-text-undo", '--report', 'ui-coverage-results/ai-workflows/result.json', '--require-complete', '--output', 'ui-coverage-results/ai-workflows-gate.json'], timeoutMs: 60_000 },
  { group: 'generation', name: 'Entry-specific editor AI screenshot evidence gate', command: process.execPath, args: ['scripts/check_manual_studio_coverage.mjs', '--cases', 'P04.editor-ai', '--report', 'ui-coverage-results/editor-ai-capture/result.json', '--require-complete', '--output', 'ui-coverage-results/editor-ai-capture-gate.json'], timeoutMs: 60_000 },
  { group: 'ui', name: 'UI improvements browser checks', command: process.execPath, args: ['scripts/test_manual_studio_ui_improvements.mjs'], timeoutMs: 120_000 },
  { group: 'build', name: 'Manual Studio frontend build', command: npm, args: ['run', 'manual:build'], timeoutMs: 240_000 },
  { group: 'ui', name: 'preview link browser checks', command: process.execPath, args: ['scripts/test_manual_studio_preview_navigation.mjs'], timeoutMs: 120_000 },
  { group: 'ui', name: 'workspace path settings and timing history', command: process.execPath, args: ['scripts/test_manual_studio_priority_improvements.mjs'], timeoutMs: 120_000 },
  { group: 'ui', name: 'Milkdown and Mermaid browser checks', command: process.execPath, args: ['scripts/test_manual_studio_milkdown.mjs'], timeoutMs: 120_000 },
  { group: 'capture', name: 'screenshot recapture task progress checks', command: process.execPath, args: ['scripts/test_manual_studio_recapture_progress.mjs'], timeoutMs: 120_000 },
  { group: 'capture', name: 'recapture display refresh checks', command: process.execPath, args: ['scripts/test_manual_studio_recapture_display.mjs'], timeoutMs: 120_000 },
  { group: 'capture', name: 'MarkIts crop restoration checks', command: process.execPath, args: ['scripts/test_manual_markits_crop.mjs'], timeoutMs: 120_000 },
  { group: 'ui', name: 'dialog layout at desktop and small viewport sizes', command: process.execPath, args: ['scripts/test_manual_studio_dialog_layout.mjs'], timeoutMs: 90_000 },
  { group: 'ui', name: 'resource and image generation workflows', command: process.execPath, args: ['scripts/test_manual_studio_resources.mjs'], timeoutMs: 180_000 },
  { group: 'ui', name: 'document conflict, settings retry, protected sharing and legacy integrity', command: process.execPath, args: ['scripts/test_manual_studio_integrity_workflows.mjs'], timeoutMs: 120_000 },
  { group: 'ui', name: 'entry-specific integrity evidence gate', command: process.execPath, args: ['scripts/check_manual_studio_coverage.mjs', '--cases', integrityCases.join(','), '--report', 'ui-coverage-results/integrity/result.json', '--require-complete', '--output', 'ui-coverage-results/integrity-gate.json'], timeoutMs: 60_000 },
  { group: 'ui', name: 'file, clipboard, drop and rich image insertion contracts', command: process.execPath, args: ['scripts/test_manual_studio_insertion_contracts.mjs'], timeoutMs: 120_000 },
  { group: 'ui', name: 'managed, generated, library and rich/source drag insertion contracts', command: process.execPath, args: ['scripts/test_manual_studio_managed_insertion.mjs'], timeoutMs: 180_000 },
  { group: 'ui', name: 'entry-specific managed insertion evidence gate', command: process.execPath, args: ['scripts/check_manual_studio_coverage.mjs', '--cases', 'P03.imported-card,P11.generated-card,P04.screenshot-card,P11.editor-dialog,P11.resource-dialog,P03.resource-drop-source,P03.resource-drop-rich,P03.tree-drop-source,P03.tree-drop-rich,P04.editor-existing', '--report', 'ui-coverage-results/managed-insertion/result.json', '--require-complete', '--output', 'ui-coverage-results/managed-insertion-gate.json'], timeoutMs: 60_000 },
  { group: 'ui', name: 'entry-specific insertion evidence gate', command: process.execPath, args: ['scripts/check_manual_studio_coverage.mjs', '--cases', 'P03.source-file,P03.source-clipboard,P03.document-clipboard,P03.source-drop,P03.rich-upload,P03.rich-paste,P03.rich-drop', '--report', 'ui-coverage-results/insertion/result.json', '--require-complete', '--output', 'ui-coverage-results/insertion-gate.json'], timeoutMs: 60_000 },
  { group: 'ui', name: 'author settings and editor autosave contracts', command: process.execPath, args: ['scripts/test_manual_studio_author_settings_contracts.mjs'], timeoutMs: 120_000 },
  { group: 'ui', name: 'entry-specific author settings evidence gate', command: process.execPath, args: ['scripts/check_manual_studio_coverage.mjs', '--cases', authorSettingsCases.join(','), '--report', 'ui-coverage-results/author-settings/result.json', '--require-complete', '--output', 'ui-coverage-results/author-settings-gate.json'], timeoutMs: 60_000 },
  { group: 'ui', name: 'resource filter, compact menu, replacement and comparison contracts', command: process.execPath, args: ['scripts/test_manual_studio_image_control_contracts.mjs'], timeoutMs: 120_000 },
  { group: 'ui', name: 'entry-specific image control evidence gate', command: process.execPath, args: ['scripts/check_manual_studio_coverage.mjs', '--cases', imageControlCases.join(','), '--report', 'ui-coverage-results/image-controls/result.json', '--require-complete', '--output', 'ui-coverage-results/image-controls-gate.json'], timeoutMs: 60_000 },
  { group: 'ui', name: 'manuscript check, external build and legacy generation contracts', command: process.execPath, args: ['scripts/test_manual_studio_misc_control_contracts.mjs'], timeoutMs: 120_000 },
  { group: 'ui', name: 'entry-specific misc control evidence gate', command: process.execPath, args: ['scripts/check_manual_studio_coverage.mjs', '--cases', miscControlCases.join(','), '--report', 'ui-coverage-results/misc-controls/result.json', '--require-complete', '--output', 'ui-coverage-results/misc-controls-gate.json'], timeoutMs: 60_000 },
  { group: 'ui', name: 'document tab session restoration', command: process.execPath, args: ['scripts/test_manual_studio_tab_session.mjs'], timeoutMs: 120_000 },
  { group: 'ui', name: 'document tabs and image workflows', command: process.execPath, args: ['scripts/test_manual_studio_document_workflows.mjs'], timeoutMs: 180_000 },
  { group: 'capture', name: 'screenshot library and instruction disclosure checks', command: process.execPath, args: ['scripts/test_manual_studio_capture_ui.mjs'], timeoutMs: 120_000 },
  { prerequisite: true, group: 'build', name: 'manualctl build for browser smoke', command: 'cargo', args: ['build', '-p', 'manual-core', '--bin', 'manualctl', '--offline'], timeoutMs: 300_000 },
  { group: 'ui', name: 'MkDocs build input checks', command: process.execPath, args: ['scripts/test_manual_studio_build.mjs'], timeoutMs: 120_000 },
  { group: 'ui', name: 'MkDocs backend and manuscript check tests', command: process.execPath, args: ['scripts/test_manual_studio_mkdocs_button.mjs'], timeoutMs: 120_000 },
  { group: 'smoke', name: 'browser smoke checks', command: process.execPath, args: ['scripts/smoke_manual_studio.mjs', '--start-server'], timeoutMs: 240_000 },
  { group: 'native', name: 'Manual Studio Rust checks', command: 'cargo', args: ['test', '--manifest-path', 'apps/manual-studio/src-tauri/Cargo.toml', '--offline'], timeoutMs: 360_000 },
  { group: 'native', name: 'manual-core Rust checks', command: 'cargo', args: ['test', '-p', 'manual-core', '--offline'], timeoutMs: 600_000 },
  { group: 'desktop', name: 'Studio resource edit through real OS windows', command: process.platform === 'linux' ? '/usr/bin/python3' : 'python', args: ['scripts/test_manual_studio_native_resource_edit.py'], timeoutMs: 420_000 },
  { group: 'desktop', name: 'entry-specific real resource edit evidence gate', command: process.execPath, args: ['scripts/check_manual_studio_coverage.mjs', '--cases', nativeResourceCases.join(','), '--report', 'native-workflow-results/result.json', '--require-complete', '--output', 'ui-coverage-results/native-gate.json'], timeoutMs: 60_000 },
  { group: 'desktop', name: 'Editor manual screenshot capture through GTK and MarkIts', command: '/usr/bin/python3', args: ['scripts/test_manual_studio_native_manual_capture.py'], timeoutMs: 240_000 },
  { group: 'desktop', name: 'Entry-specific real manual capture evidence gate', command: process.execPath, args: ['scripts/check_manual_studio_coverage.mjs', '--cases', 'P04.editor-manual', '--report', 'native-manual-capture-results/result.json', '--require-complete', '--output', 'ui-coverage-results/manual-capture-gate.json'], timeoutMs: 60_000 },
  { group: 'desktop', name: 'Native editor menu preserves clipboard actions and opens AI correction', command: '/usr/bin/python3', args: ['scripts/test_manual_studio_native_context_menu.py'], timeoutMs: 180_000 },
  { group: 'desktop', name: 'Actual OS bitmap clipboard save, failure, retry and Undo', command: '/usr/bin/python3', args: ['scripts/test_manual_studio_native_clipboard.py'], timeoutMs: 180_000 },
  { group: 'desktop', name: 'Entry-specific real clipboard evidence gate', command: process.execPath, args: ['scripts/check_manual_studio_coverage.mjs', '--cases', 'P03.desktop-bitmap-paste', '--report', 'native-clipboard-results/result.json', '--require-complete', '--output', 'ui-coverage-results/clipboard-gate.json'], timeoutMs: 60_000 },
  { group: 'desktop', name: 'Isolated native conversion and return fault rejection', command: '/usr/bin/python3', args: ['scripts/test_manual_studio_native_faults.py'], timeoutMs: 600_000 },
);

const groupNames = ['unit', 'ui', 'generation', 'capture', 'build', 'native', 'desktop', 'smoke'];
const groupIndex = process.argv.indexOf('--group');
const selectedGroup = groupIndex >= 0 ? process.argv[groupIndex + 1] : undefined;
const knownArgs = process.argv.slice(2);
if ((selectedGroup && !groupNames.includes(selectedGroup)) || groupIndex >= 0 && !selectedGroup || knownArgs.some((arg, index) => !['--group', '--list'].includes(arg) && knownArgs[index - 1] !== '--group')) {
  console.error(`Usage: npm run manual:check -- [--group ${groupNames.join('|')}] [--list]`);
  process.exit(2);
}
// Browser checks call the native CLI: build it before any browser stage.
const cliIndex = steps.findIndex(step => step.prerequisite);
const [cliStep] = steps.splice(cliIndex, 1);
steps.splice(unitStepCount, 0, cliStep);
const selectedSteps = steps.filter(step => !selectedGroup || step.group === selectedGroup || step === cliStep && ['ui', 'generation', 'capture', 'smoke'].includes(selectedGroup));
if (process.argv.includes('--list')) {
  for (const step of selectedSteps) console.log(`[${step.group}] ${step.name}`);
  process.exit(0);
}

function runStep(step) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(step.command, step.args, {
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      shell: process.platform === 'win32' && step.command.endsWith('.cmd'),
    });
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      console.error(`[timeout] ${step.name} exceeded ${Math.round(step.timeoutMs / 1000)} seconds; terminating process`);
      terminate(child);
    }, step.timeoutMs);

    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const ok = !timedOut && !error && code === 0;
      console.log(`[${ok ? 'pass' : 'fail'}] ${step.name} (${seconds}s${signal ? `, ${signal}` : ''})`);
      if (error) console.error(`Could not start ${step.command}: ${error.message}`);
      resolve(ok);
    };

    child.once('error', (error) => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal));
  });
}

function terminate(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  const hardStop = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }, 2_000);
  hardStop.unref();
}

console.log(`Manual Studio ${selectedGroup || 'full'} check started. Each stage runs in sequence with a timeout.`);
const executedAt = new Date().toISOString();
for (const group of selectedGroup ? [selectedGroup] : groupNames) {
  await rm(`ui-coverage-results/check-groups/${group}.json`, { force: true });
}
const initialIdentity = await verificationIdentity(process.cwd()).catch(() => null);
const results = [];
for (const step of selectedSteps) {
  console.log(`\n[run] ${step.name}: ${step.command} ${step.args.join(' ')}`);
  const passed = await runStep(step);
  results.push({ group: step.group, name: step.name, status: passed ? 'passed' : 'failed' });
  if (!passed) {
    console.error('Manual Studio full check stopped at the first failed stage.');
    process.exitCode = 1;
    break;
  }
}
const finalIdentity = await verificationIdentity(process.cwd()).catch(() => null);
const stable = initialIdentity && finalIdentity && ['sourceHash', 'buildHash', 'os'].every(key => initialIdentity[key] === finalIdentity[key]);
await mkdir('ui-coverage-results/check-groups', { recursive: true });
for (const group of selectedGroup ? [selectedGroup] : groupNames) {
  const expected = selectedSteps.filter(step => step.group === group);
  const executed = results.filter(step => step.group === group);
  const passed = stable && expected.length > 0 && executed.length === expected.length && executed.every(step => step.status === 'passed') && !process.exitCode;
  await writeFile(`ui-coverage-results/check-groups/${group}.json`, JSON.stringify({
    ...finalIdentity, executedAt, completedAt: new Date().toISOString(),
    status: passed ? 'passed' : 'unverified',
    identityStable: Boolean(stable), expectedSteps: expected.length, results: executed,
  }, null, 2) + '\n');
}
