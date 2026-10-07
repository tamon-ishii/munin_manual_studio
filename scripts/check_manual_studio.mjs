import { spawn } from 'node:child_process';
import process from 'node:process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const steps = [
  { group: 'unit', name: "AI credentials checks", command: process.execPath, args: ["scripts/test_manual_studio_ai_credentials.mjs"], timeoutMs: 60_000 },
  { group: 'unit', name: 'preview navigation unit checks', command: npx, args: ['tsx', 'apps/manual-studio/src/previewNavigation.test.ts'], timeoutMs: 60_000 },
  { group: 'unit', name: 'editor history unit checks', command: process.execPath, args: ['scripts/test_manual_studio_editor_history.mjs'], timeoutMs: 60_000 },
  { group: 'unit', name: 'file tree rendering checks', command: process.execPath, args: ['scripts/test_manual_studio_file_tree.mjs'], timeoutMs: 60_000 },
  { group: 'unit', name: 'Markdown AI tag checks', command: process.execPath, args: ['scripts/test_manual_studio_markdown_tags.mjs'], timeoutMs: 60_000 },
  { group: 'unit', name: 'MarkIts workflow checks', command: npm, args: ['run', 'manual:test-workflow'], timeoutMs: 60_000 },
  { group: 'unit', name: 'transport callback mock checks', command: process.execPath, args: ['scripts/test_manual_studio_transport.mjs'], timeoutMs: 60_000 },
  { group: 'unit', name: 'capture session checks', command: process.execPath, args: ['scripts/test_manual_studio_capture_session.mjs'], timeoutMs: 60_000 },
  { group: 'unit', name: 'terminal output parser checks', command: npx, args: ['tsx', 'scripts/test_terminal_output_parser.mjs'], timeoutMs: 60_000 },
  { group: 'unit', name: 'PNG annotation metadata checks', command: npx, args: ['tsx', 'scripts/test_image_comparison.ts'], timeoutMs: 60_000 },
];
const unitStepCount = steps.length;

steps.push(
  { group: 'generation', name: 'durable execution browser checks', command: process.execPath, args: ['scripts/test_manual_studio_execution.mjs'], timeoutMs: 180_000 },
  { group: 'ui', name: 'UI improvements browser checks', command: process.execPath, args: ['scripts/test_manual_studio_ui_improvements.mjs'], timeoutMs: 120_000 },
  { group: 'build', name: 'Manual Studio frontend build', command: npm, args: ['run', 'manual:build'], timeoutMs: 240_000 },
  { group: 'ui', name: 'preview link browser checks', command: process.execPath, args: ['scripts/test_manual_studio_preview_navigation.mjs'], timeoutMs: 120_000 },
  { group: 'ui', name: 'Milkdown and Mermaid browser checks', command: process.execPath, args: ['scripts/test_manual_studio_milkdown.mjs'], timeoutMs: 120_000 },
  { group: 'capture', name: 'recapture display refresh checks', command: process.execPath, args: ['scripts/test_manual_studio_recapture_display.mjs'], timeoutMs: 120_000 },
  { group: 'capture', name: 'native capture UI mock checks', command: process.execPath, args: ['scripts/test_manual_studio_capture_ui.mjs'], timeoutMs: 120_000 },
  { prerequisite: true, group: 'build', name: 'manualctl build for browser smoke', command: 'cargo', args: ['build', '-p', 'manual-core', '--bin', 'manualctl', '--offline'], timeoutMs: 300_000 },
  { group: 'ui', name: 'MkDocs build input checks', command: process.execPath, args: ['scripts/test_manual_studio_build.mjs'], timeoutMs: 120_000 },
  { group: 'ui', name: 'MkDocs build button checks', command: process.execPath, args: ['scripts/test_manual_studio_mkdocs_button.mjs'], timeoutMs: 120_000 },
  { group: 'ui', name: 'Milkdown AI prompt save checks', command: process.execPath, args: ['scripts/test_manual_studio_ai_prompt.mjs'], timeoutMs: 120_000 },
  { group: 'generation', name: 'generation review integration checks', command: process.execPath, args: ['scripts/test_manual_studio_generation_review.mjs'], timeoutMs: 120_000 },
  { group: 'generation', name: 'generation tools browser checks', command: process.execPath, args: ['scripts/test_manual_studio_generation_tools.mjs'], timeoutMs: 120_000 },
  { group: 'smoke', name: 'browser smoke checks', command: process.execPath, args: ['scripts/smoke_manual_studio.mjs', '--start-server'], timeoutMs: 240_000 },
  { group: 'native', name: 'Manual Studio Rust checks', command: 'cargo', args: ['test', '--manifest-path', 'apps/manual-studio/src-tauri/Cargo.toml', '--offline'], timeoutMs: 360_000 },
  { group: 'native', name: 'manual-core Rust checks', command: 'cargo', args: ['test', '-p', 'manual-core', '--offline'], timeoutMs: 600_000 },
);

const groupNames = ['unit', 'ui', 'generation', 'capture', 'build', 'native', 'smoke'];
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
for (const step of selectedSteps) {
  console.log(`\n[run] ${step.name}: ${step.command} ${step.args.join(' ')}`);
  if (!(await runStep(step))) {
    console.error('Manual Studio full check stopped at the first failed stage.');
    process.exitCode = 1;
    break;
  }
}
