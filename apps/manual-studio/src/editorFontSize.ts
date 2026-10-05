const storageKey = 'manual-studio-editor-font-size';
const defaultSize = 14;
export function isEditorFontSize(value: number): boolean {
  return Number.isInteger(value) && value >= 12 && value <= 28;
}
export function applyEditorFontSize(size: number, persist = true): void {
  if (!isEditorFontSize(size)) return;
  document.documentElement.style.setProperty('--editor-font-size', `${size}px`);
  if (persist) localStorage.setItem(storageKey, String(size));
  window.dispatchEvent(new CustomEvent('manual-studio-editor-font-size-change', { detail: size }));
}
export function setupEditorFontSize(control: HTMLInputElement, onChange: (size: number) => void): void {
  let current = defaultSize;
  window.addEventListener('manual-studio-editor-font-size-change', event => {
    current = (event as CustomEvent<number>).detail;
    control.value = String(current);
  });
  const saved = Number(localStorage.getItem(storageKey));
  applyEditorFontSize(isEditorFontSize(saved) ? saved : defaultSize, false);
  control.addEventListener('input', () => {
    const size = control.valueAsNumber;
    if (!isEditorFontSize(size)) return;
    applyEditorFontSize(size);
    onChange(size);
  });
  control.addEventListener('change', () => { if (!isEditorFontSize(control.valueAsNumber)) control.value = String(current); });
  window.addEventListener('storage', event => {
    if (event.key !== storageKey) return;
    const size = Number(event.newValue);
    applyEditorFontSize(isEditorFontSize(size) ? size : defaultSize, false);
  });
}
