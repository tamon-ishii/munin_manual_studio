import {invoke} from '@tauri-apps/api/core';

export function cursorCapturePreference(): boolean {
  try {return localStorage.getItem('manual-studio-capture-include-cursor')==='true';}catch{return false;}
}

interface Options {
  captureShortcut?(): Promise<string>;
  root(): string;
  refreshAssets(root: string): Promise<void>;
}

/** Studio only imports completed images. Capture and edit history belong to MarkIts. */
export function setupMarkitsImages(options: Options) {
  async function importImage(command: string, args: Record<string, unknown>) {
    const root = options.root();
    if (!root) throw new Error('プロジェクトを開いてください。');
    if (!('__TAURI_INTERNALS__' in window)) throw new Error('MarkItsはデスクトップ版で利用できます。');
    const path = await invoke<string | null>(command, {root, ...args});
    if (!path || root !== options.root()) return;
    await options.refreshAssets(root);
    return root === options.root() ? {path} : undefined;
  }

  return {
    refresh: () => options.refreshAssets(options.root()),
    recordForInsertion: async (stage?: (stage: string) => void) => {
      stage?.('capture');
      const shortcut = await options.captureShortcut?.();
      return importImage('capture_markits_image', {includeCursor:cursorCapturePreference(),shortcut:shortcut||null});
    },
    editImage: (asset: string, page?: string) => importImage('edit_markits_image', {asset, page: page || null}),
  };
}
