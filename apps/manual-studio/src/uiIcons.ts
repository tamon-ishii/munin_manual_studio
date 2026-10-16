const paths = {
  newFile: '<path d="M14 2H6v20h12V6zM14 2v4h4M9 14h6M12 11v6"/>',
  newFolder: '<path d="M3 7V4h6l2 3h10v13H3zM9 13h6M12 10v6"/>',
  open: '<path d="M3 9V4h6l2 3h10v4M3 9h18l-3 11H3z"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  connect: '<path d="M8 3v5M16 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>',
  disconnect: '<path d="m3 3 18 18M8 3v3M16 3v5M12 8h6v3a6 6 0 0 1-1 3M6 10v1a6 6 0 0 0 6 6v4"/>',
  clear: '<path d="m14 3 7 7-11 11H5l-3-3zM7 13l7 7M10 21h11"/>',
  sparkle: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM20 3v4M18 5h4"/>',
  review: '<path d="M14 2H5v20h14V6zM14 2v4h5M8 10h7M8 14h3m1 4 2 2 4-4"/>',
  camera: '<path d="M3 7h5l2-3h4l2 3h5v14H3z"/><circle cx="12" cy="13" r="4"/>',
  library: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  application: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 8h18M7 5.5h.01M10 5.5h.01"/>',
  export: '<path d="M12 16V3m-5 5 5-5 5 5M4 14v7h16v-7"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  history: '<path d="M3 4v6h6M3 10a9 9 0 1 1 1 8M12 7v5l3 2"/>',

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
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  zoom: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6M7 10h6M10 7v6"/>',
};
export type UiIconName = keyof typeof paths;
export function uiIcon(name: keyof typeof paths): string {
  return `<svg class="ui-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true">${paths[name]}</svg>`;
}
