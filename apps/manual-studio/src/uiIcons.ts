const paths = {
  file: '<path d="M14 2H6v20h12V6zM14 2v4h4M9 11h6M9 15h6"/>',
  folder: '<path d="M3 7V4h6l2 3h10v13H3z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
  link: '<path d="m10 13 4-4M8 15l-2 2a4 4 0 0 1-5-5l5-5a4 4 0 0 1 5 0M16 9l2-2a4 4 0 0 1 5 5l-5 5a4 4 0 0 1-5 0"/>',
  undo: '<path d="M8 4 3 9l5 5M3 9h11a6 6 0 0 1 0 12"/>',
  redo: '<path d="m16 4 5 5-5 5M21 9H10a6 6 0 0 0 0 12"/>',
};
export function uiIcon(name: keyof typeof paths): string {
  return `<svg class="ui-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
