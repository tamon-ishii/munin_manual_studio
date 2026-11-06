interface FontSizePreference {
  storageKey: string;
  cssProperty: string;
  changeEvent: string;
  defaultSize: number;
  min: number;
  max: number;
}

/** Shared persistence and window synchronization for independent font settings. */
export function createFontSizePreference(options: FontSizePreference) {
  const isValid = (value: number): boolean => Number.isInteger(value) && value >= options.min && value <= options.max;
  const apply = (size: number, persist = true): void => {
    if (!isValid(size)) return;
    document.documentElement.style.setProperty(options.cssProperty, `${size}px`);
    if (persist) localStorage.setItem(options.storageKey, String(size));
    window.dispatchEvent(new CustomEvent(options.changeEvent, {detail: size}));
  };
  const setup = (control: HTMLInputElement, onChange: (size: number) => void): void => {
    let current = options.defaultSize;
    window.addEventListener(options.changeEvent, event => {
      current = (event as CustomEvent<number>).detail;
      control.value = String(current);
    });
    const saved = Number(localStorage.getItem(options.storageKey));
    apply(isValid(saved) ? saved : options.defaultSize, false);
    control.addEventListener('input', () => {
      const size = control.valueAsNumber;
      if (!isValid(size)) return;
      apply(size);
      onChange(size);
    });
    control.addEventListener('change', () => {if (!isValid(control.valueAsNumber)) control.value = String(current);});
    window.addEventListener('storage', event => {
      if (event.key !== options.storageKey) return;
      const size = Number(event.newValue);
      apply(isValid(size) ? size : options.defaultSize, false);
    });
  };
  return {isValid, apply, setup};
}
