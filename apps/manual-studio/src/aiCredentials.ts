const LEGACY = 'manual-studio-ai-key-unassigned';
const PREFIX = 'manual-studio-ai-key-v2:';
function credentialKey(root: string, endpoint: string): string {
  let normalized = endpoint.trim().replace(/\/+$/, '') || 'http://localhost:11434/v1';
  try { normalized = new URL(normalized).href.replace(/\/+$/, ''); } catch {}
  return PREFIX + JSON.stringify([root.replace(/\/+$/, ''), normalized]);
}
export function readAiCredential(root: string, endpoint: string): string {
  // The old key has no recorded owner. Never assign it to an arbitrary endpoint.
  const previous = localStorage.getItem('manual-studio-ai-api-key');
  if (previous && !localStorage.getItem(LEGACY)) localStorage.setItem(LEGACY, previous);
  localStorage.removeItem('manual-studio-ai-api-key');
  return localStorage.getItem(credentialKey(root, endpoint)) || '';
}
export function saveAiCredential(root: string, endpoint: string, key: string): void {
  const storageKey = credentialKey(root, endpoint);
  if (key.trim()) localStorage.setItem(storageKey, key.trim());
  else localStorage.removeItem(storageKey);
}

export function hasUnassignedAiCredential(): boolean { return Boolean(localStorage.getItem(LEGACY)); }
export function assignLegacyAiCredential(root: string, endpoint: string): string {
  const key = localStorage.getItem(LEGACY) || '';
  saveAiCredential(root, endpoint, key);
  localStorage.removeItem(LEGACY);
  return key;
}
