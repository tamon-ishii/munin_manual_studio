import { spawn } from 'node:child_process';
import process from 'node:process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const steps = [
  { name: 'editor history unit checks', command: process.execPath, args: ['scripts/test_manual_studio_editor_history.mjs'], timeoutMs: 60_000 },
  { name: 'file tree rendering checks', command: process.execPath, args: ['scripts/test_manual_studio_file_tree.mjs'], timeoutMs: 60_000 },
  { name: 'Markdown AI tag checks', command: process.execPath, args: ['scripts/test_manual_studio_markdown_tags.mjs'], timeoutMs: 60_000 },
  { name: 'MarkIts workflow checks', command: npm, args: ['run', 'manual:test-workflow'], timeoutMs: 60_000 },
  { name: 'transport callback mock checks', command: process.execPath, args: ['scripts/test_manual_studio_transport.mjs'], timeoutMs: 60_000 },
  { name: 'capture session checks', command: process.execPath, args: ['scripts/test_manual_studio_capture_session.mjs'], timeoutMs: 60_000 },
];

steps.push(
  { name: 'Manual Studio frontend build', command: npm, args: ['run', 'manual:build'], timeoutMs: 240_000 },
  { name: 'Milkdown and Mermaid browser checks', command: process.execPath, args: ['scripts/test_manual_studio_milkdown.mjs'], timeoutMs: 120_000 },
  { name: 'native capture UI mock checks', command: process.execPath, args: ['scripts/test_manual_studio_capture_ui.mjs'], timeoutMs: 120_000 },
  { name: 'manualctl build for browser smoke', command: 'cargo', args: ['build', '-p', 'manual-core', '--bin', 'manualctl', '--offline'], timeoutMs: 300_000 },
  { name: 'Milkdown AI prompt save checks', command: process.execPath, args: ['scripts/test_manual_studio_ai_prompt.mjs'], timeoutMs: 120_000 },
  { name: 'generation review integration checks', command: process.execPath, args: ['scripts/test_manual_studio_generation_review.mjs'], timeoutMs: 120_000 },
  { name: 'browser smoke checks', command: process.execPath, args: ['scripts/smoke_manual_studio.mjs', '--start-server'], timeoutMs: 240_000 },
  { name: 'Manual Studio Rust checks', command: 'cargo', args: ['test', '--manifest-path', 'apps/manual-studio/src-tauri/Cargo.toml', '--offline'], timeoutMs: 360_000 },
  { name: 'manual-core Rust checks', command: 'cargo', args: ['test', '-p', 'manual-core', '--offline'], timeoutMs: 600_000 },
);

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

console.log('Manual Studio full check started. Each stage runs in sequence with a timeout.');
for (const step of steps) {
  console.log(`\n[run] ${step.name}: ${step.command} ${step.args.join(' ')}`);
  if (!(await runStep(step))) {
    console.error('Manual Studio full check stopped at the first failed stage.');
    process.exitCode = 1;
    break;
  }
}
