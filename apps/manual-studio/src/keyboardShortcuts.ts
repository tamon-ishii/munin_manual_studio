export const shortcutCommands = [
  { id: 'save', label: '保存', keys: ['Mod+S'], scope: 'global' },
  { id: 'undo', label: '元に戻す', keys: ['Mod+Z'], scope: 'editor' },
  { id: 'redo', label: 'やり直す', keys: ['Mod+Y', 'Mod+Shift+Z'], scope: 'editor' },
  { id: 'cut', label: '切り取り（未選択時は現在行）', keys: ['Mod+X'], scope: 'editor' },
  { id: 'indent', label: 'インデントを増やす', keys: ['Tab', 'Mod+]'], scope: 'editor' },
  { id: 'outdent', label: 'インデントを減らす', keys: ['Shift+Tab', 'Mod+['], scope: 'editor' },
  { id: 'duplicate', label: '行を下に複製', keys: ['Alt+Shift+ArrowDown'], scope: 'editor' },
  { id: 'deleteLine', label: '行を削除', keys: ['Mod+Shift+K'], scope: 'editor' },
  { id: 'bold', label: '太字', keys: ['Mod+B'], scope: 'editor' },
  { id: 'italic', label: '斜体', keys: ['Mod+I'], scope: 'editor' },
  { id: 'link', label: 'リンク', keys: [], scope: 'editor' },
  { id: 'preview', label: '編集・分割・プレビューの切替', keys: ['Mod+Shift+V'], scope: 'global' },
  { id: 'refresh', label: 'プレビューを再読込', keys: [], scope: 'global' },
  { id: 'selectionAi', label: '選択範囲のAI変更・挿入', keys: [], scope: 'editor' },
  { id: 'treeSearch', label: 'ファイル名・パスを検索', keys: ['Mod+P'], scope: 'global' },
  { id: 'search', label: '全文検索・置換', keys: ['Mod+Shift+F'], scope: 'global' },
  { id: 'settings', label: '設定を開く', keys: ['Mod+,', 'Mod+K Mod+S'], scope: 'global' },
] as const;
export type ShortcutCommand = typeof shortcutCommands[number]['id'];
export type ShortcutBindings = Record<ShortcutCommand, string[]>;
const storageKey = 'manual-studio-keybindings-v1';
export function defaultBindings(): ShortcutBindings {
  return Object.fromEntries(shortcutCommands.map(c => [c.id, [...c.keys]])) as ShortcutBindings;
}
export function keyStroke(event: KeyboardEvent): string | null {
  if (event.isComposing || event.getModifierState('AltGraph') || ['Control','Meta','Alt','Shift','Dead','Process','Unidentified'].includes(event.key)) return null;
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return [event.ctrlKey || event.metaKey ? 'Mod' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', key === ' ' ? 'Space' : key].filter(Boolean).join('+');
}
export function bindingLabel(key: string): string {
  return key.replaceAll('Mod', /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl').replaceAll('ArrowDown', '↓');
}
export function validateBindings(value: ShortcutBindings): string | null {
  const used: {key: string; label: string}[] = [];
  for (const command of shortcutCommands) for (const key of value[command.id]) {
    if (!key || key.split(' ').length > 2) return 'キーの組み合わせが不正です。';
    const conflict = used.find(other => other.key === key || other.key.startsWith(key + ' ') || key.startsWith(other.key + ' '));
    if (conflict) return `「${command.label}」と「${conflict.label}」のキーが重複しています。`;
    used.push({key, label: command.label});
  }
  return null;
}
let bindings = defaultBindings();
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
  if (saved && shortcutCommands.every(c => Array.isArray(saved[c.id]) && saved[c.id].every((k: unknown) => typeof k === 'string')) && !validateBindings(saved)) bindings = saved;
} catch { /* Defaults remain available when storage is unavailable. */ }
export function currentBindings(): ShortcutBindings { return structuredClone(bindings); }
export function saveBindings(value: ShortcutBindings): void {
  const error = validateBindings(value); if (error) throw new Error(error);
  localStorage.setItem(storageKey, JSON.stringify(value)); bindings = structuredClone(value);
  window.dispatchEvent(new Event('manual-studio-keybindings-change'));
}
export function installShortcutRouter(run: (command: ShortcutCommand, event: KeyboardEvent) => void, isEditor: (target: Element) => boolean): void {
  let prefix = '', deadline = 0;
  document.addEventListener('keydown', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || event.isComposing || document.querySelector('dialog:modal') || target.closest('#panel-terminal') || target.matches('input,select,textarea') && !isEditor(target)) { prefix = ''; return; }
    const stroke = keyStroke(event); if (!stroke) return;
    const editor = isEditor(target);
    const candidates = shortcutCommands.filter(c => c.scope === 'global' || editor);
    const sequence = prefix && Date.now() < deadline ? prefix + ' ' + stroke : stroke;
    prefix = '';
    const command = candidates.find(c => bindings[c.id].includes(sequence));
    if (command) {
      event.preventDefault(); event.stopImmediatePropagation();
      run(command.id, event); return;
    }
    if (candidates.some(c => bindings[c.id].some(key => key.startsWith(sequence + ' ')))) {
      event.preventDefault(); event.stopImmediatePropagation(); prefix = sequence; deadline = Date.now() + 1500;
      return;
    }
    // Milkdown's built-in keymap must not keep the previous assignment alive.
    if (editor && (shortcutCommands.some(c => c.scope === 'editor' && (c.keys as readonly string[]).includes(stroke)) || stroke === 'Mod+K')) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
}
