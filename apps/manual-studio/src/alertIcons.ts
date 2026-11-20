import icons from '../../../crates/manual-core/src/alert-icons.json';

export function alertIconStyles(preview: boolean): string {
  const selector = preview ? 'blockquote[class^="markdown-alert-"]' : '.ProseMirror blockquote[data-gfm-alert]';
  const pseudo = preview ? 'after' : 'before';
  const shapes = Object.entries(icons).map(([kind, shape]) => {
    const selectorKind = preview ? `.markdown-alert-${kind === 'danger' ? 'caution' : kind}` :
      `[data-gfm-alert="${kind === 'danger' ? 'CAUTION' : kind.toUpperCase()}"]`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${shape}"/></svg>`;
    return `[data-alert-icons] ${selector}${selectorKind} { --alert-icon: url("data:image/svg+xml,${encodeURIComponent(svg)}"); }`;
  });
  return `
    [data-alert-icons] ${selector} { position: relative; ${preview ? '' : 'padding-inline-start: 42px;'} }
    ${preview ? `[data-alert-icons] ${selector}::before { padding-inline-start: 25px; }` : ''}
    [data-alert-icons] ${selector}::${pseudo} {
      content: ""; position: absolute; inset-inline-start: ${preview ? '16px' : '14px'}; top: 13px;
      width: 19px; height: 19px; background: ${preview ? 'var(--preview-alert-color)' : 'currentColor'};
      mask: var(--alert-icon) center / contain no-repeat; pointer-events: none;
    }
    ${shapes.join('\n')}
  `;
}
