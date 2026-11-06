const storageKey = 'manual-studio-preview-font-size';
const defaultSize = 16;
export function isPreviewFontSize(value: number): boolean {
  return Number.isInteger(value) && value >= 12 && value <= 32;
}
export function applyPreviewFontSize(size: number, persist = true): void {
  if (!isPreviewFontSize(size)) return;
  document.documentElement.style.setProperty('--preview-font-size', `${size}px`);
  if (persist) localStorage.setItem(storageKey, String(size));
  window.dispatchEvent(new CustomEvent('manual-studio-preview-font-size-change', { detail: size }));
}
export function setupPreviewFontSize(control: HTMLInputElement, onChange: (size: number) => void): void {
  let current = defaultSize;
  window.addEventListener('manual-studio-preview-font-size-change', event => {
    current = (event as CustomEvent<number>).detail;
    control.value = String(current);
  });
  const saved = Number(localStorage.getItem(storageKey));
  applyPreviewFontSize(isPreviewFontSize(saved) ? saved : defaultSize, false);
  control.addEventListener('input', () => {
    const size = control.valueAsNumber;
    if (!isPreviewFontSize(size)) return;
    applyPreviewFontSize(size);
    onChange(size);
  });
  control.addEventListener('change', () => { if (!isPreviewFontSize(control.valueAsNumber)) control.value = String(current); });
  window.addEventListener('storage', event => {
    if (event.key !== storageKey) return;
    const size = Number(event.newValue);
    applyPreviewFontSize(isPreviewFontSize(size) ? size : defaultSize, false);
  });
}

