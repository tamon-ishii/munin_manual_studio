import { verificationIdentity } from './manual_ui_identity.mjs';

// Capture before executing operations; never certify an old run with a new hash.
export async function beginVerification(root = process.cwd()) {
  return { ...await verificationIdentity(root), executedAt: new Date().toISOString() };
}

export async function finishVerification(start, root = process.cwd()) {
  const current = await verificationIdentity(root);
  for (const key of ['sourceHash', 'buildHash', 'os']) {
    if (start[key] !== current[key]) throw new Error(`Verification ${key} changed during execution`);
  }
  return { ...start, completedAt: new Date().toISOString() };
}

export function executionReportErrors(report, identity, now = Date.now()) {
  const errors = [];
  for (const key of ['sourceHash', 'buildHash', 'os']) {
    if (!identity[key] || report[key] !== identity[key]) errors.push(`${key} missing or stale`);
  }
  const started = Date.parse(report.executedAt), completed = Date.parse(report.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started || completed > now + 60_000 || now - completed > 86_400_000) errors.push('execution timestamps missing or expired');
  if (report.status !== 'passed' || report.identityStable !== true) errors.push('execution did not pass with stable identity');
  if (!Number.isInteger(report.expectedSteps) || report.expectedSteps < 1 || !Array.isArray(report.results) || report.results.length !== report.expectedSteps || report.results.some(step => step.status !== 'passed')) errors.push('required steps missing or failed');
  return errors;
}
