import { uiIcon, type UiIconName } from './uiIcons';

/** Explicit annotations keep labels and accessible names intact. */
export function setupControlIcons(): void {
  const decorate = (root: ParentNode) => {
    const controls = [...root.querySelectorAll<HTMLElement>('[data-ui-icon]')];
    if (root instanceof HTMLElement && root.matches('[data-ui-icon]')) controls.unshift(root);
    controls.forEach(control => {
      if (control.querySelector(':scope > .ui-icon')) return;
      const name = control.dataset.uiIcon as UiIconName;
      control.insertAdjacentHTML('afterbegin', uiIcon(name));
      control.classList.add('icon-control');
    });
  };
  decorate(document);
  new MutationObserver(records => {
    for (const record of records) {
      if (record.target instanceof HTMLElement && record.target.matches('[data-ui-icon]')) decorate(record.target);
      for (const node of record.addedNodes) if (node instanceof HTMLElement) decorate(node);
    }
  }).observe(document.body, { childList: true, subtree: true });
}
