import { invoke } from "@tauri-apps/api/core";

const storageKey = "manual-studio-workspace-history";
function validHistory(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())))].slice(0, 20) : [];
}
export async function loadWorkspaceHistory(native: boolean): Promise<string[]> {
  return validHistory(native ? await invoke("load_workspace_history") : JSON.parse(localStorage.getItem(storageKey) || "[]"));
}
export async function recordWorkspaceHistory(native: boolean, root: string): Promise<void> {
  if (native) { await invoke("record_workspace_history", { root }); return; }
  const history = await loadWorkspaceHistory(false);
  localStorage.setItem(storageKey, JSON.stringify([root, ...history.filter(entry => entry !== root)].slice(0, 20)));
}
export function showWorkspaceHistory(history: string[], current: string, open: (root: string) => Promise<void>): void {
  const trigger = document.getElementById('workspace-name')!;
  if (document.getElementById('workspace-history-dialog')) return;
  const list = document.createElement('div');
  list.id = 'workspace-history-dialog'; list.className = 'folder-history-dropdown';
  list.role = 'listbox'; list.setAttribute('aria-label', '最近開いたフォルダ');
  const heading = document.createElement('strong'); heading.id = 'workspace-history-title'; heading.textContent = '最近開いたフォルダ'; list.append(heading);
  const close = () => {
    list.remove(); trigger.setAttribute('aria-expanded', 'false'); trigger.removeEventListener('click', close);
    document.removeEventListener('pointerdown', outside);
    window.removeEventListener('resize', close); window.removeEventListener('scroll', onScroll, true);
  };
  const onScroll = (event: Event) => { if (!(event.target instanceof Node) || !list.contains(event.target)) close(); };
  const outside = (event: PointerEvent) => { if (!list.contains(event.target as Node) && !trigger.contains(event.target as Node)) close(); };
  const buttons: HTMLButtonElement[] = [];
  for (const root of history) {
    const button = document.createElement('button'); button.type = 'button'; button.role = 'option';
    button.dataset.workspaceRoot = root; button.className = 'workspace-history-entry';
    button.setAttribute('aria-selected', String(root === current)); button.title = root;
    const name = document.createElement('strong'); name.textContent = `${root === current ? '✓ ' : ''}${root.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || root}`;
    const path = document.createElement('span'); path.textContent = root; button.append(name, path);
    button.onclick = () => { close(); trigger.focus(); if (root !== current) void open(root); };
    buttons.push(button); list.append(button);
  }
  if (!history.length) { const empty = document.createElement('p'); empty.textContent = '最近開いたフォルダはまだありません。'; list.append(empty); }
  const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.dataset.historyClose = ''; dismiss.textContent = '閉じる'; dismiss.onclick = () => { close(); trigger.focus(); }; list.append(dismiss);
  list.addEventListener('keydown', event => {
    if (event.key === 'Escape' || event.key === 'Tab') { close(); trigger.focus(); if (event.key === 'Escape') event.preventDefault(); return; }
    const focusable = [...buttons, dismiss];
    const index = focusable.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | undefined;
    if (event.key === 'ArrowDown') next = (index + 1) % focusable.length;
    if (event.key === 'ArrowUp') next = (index - 1 + focusable.length) % focusable.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = focusable.length - 1;
    if (next !== undefined) { event.preventDefault(); focusable[next].focus(); }
  });
  document.body.append(list); trigger.setAttribute('aria-expanded', 'true'); trigger.setAttribute('aria-controls', list.id);
  const box = trigger.getBoundingClientRect();
  list.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - Math.min(420, window.innerWidth - 16) - 8))}px`;
  list.style.top = `${box.bottom + 6}px`;
  list.style.maxHeight = `${Math.max(100, window.innerHeight - box.bottom - 14)}px`;
  (buttons.find(button => button.getAttribute('aria-selected') === 'true') || buttons[0] || dismiss).focus();
  document.addEventListener('pointerdown', outside); window.addEventListener('resize', close); window.addEventListener('scroll', onScroll, true);
  trigger.addEventListener('click', close, { once: true });
}
