const paths = {
  file: '<path d="M14 2H6v20h12V6zM14 2v4h4M9 11h6M9 15h6"/>',
  folder: '<path d="M3 7V4h6l2 3h10v13H3z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
  link: '<path d="m10 13 4-4M8 15l-2 2a4 4 0 0 1-5-5l5-5a4 4 0 0 1 5 0M16 9l2-2a4 4 0 0 1 5 5l-5 5a4 4 0 0 1-5 0"/>',
  undo: '<path d="M8 4 3 9l5 5M3 9h11a6 6 0 0 1 0 12"/>',
  redo: '<path d="m16 4 5 5-5 5M21 9H10a6 6 0 0 0 0 12"/>',
  back: '<path d="m14 5-7 7 7 7"/>',
  forward: '<path d="m10 5 7 7-7 7"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 2M4 17l2 2a8 8 0 0 0 13-3"/>',
  save: '<path d="M5 3h12l4 4v14H3V3h2ZM7 3v6h10V3M7 21v-8h10v8"/>',
  settings: '<path d="M4 7h16M4 17h16M8 4v6M16 14v6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  zoom: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6M7 10h6M10 7v6"/>',
};
export type UiIconName = keyof typeof paths;
export function uiIcon(name: keyof typeof paths): string {
  return `<svg class="ui-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true">${paths[name]}</svg>`;
}
