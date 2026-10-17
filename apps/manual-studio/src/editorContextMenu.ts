interface EditorContextMenuOptions {
  isEditorTarget: (target: EventTarget | null) => boolean;
  state: () => { active: boolean; enabled: boolean };
  capture: () => (() => void) | undefined;
  sendState: (active: boolean, enabled: boolean) => Promise<unknown>;
  report: (error: unknown) => void;
}

/** Keep the native menu, and capture the selection before it takes focus. */
export function setupEditorContextMenu(options: EditorContextMenuOptions): () => void {
  let captured: (() => void) | undefined;
  let previous = '';
  let queue = Promise.resolve();
  const refresh = () => {
    const { active, enabled } = options.state();
    const key = `${active}:${enabled}`;
    if (key === previous) return;
    previous = key;
    queue = queue.then(() => options.sendState(active, enabled)).then(() => {}, error => {
      previous = '';
      options.report(error);
    });
  };
  document.addEventListener('contextmenu', event => {
    captured = options.isEditorTarget(event.target) ? options.capture() : undefined;
    refresh();
    // Do not preventDefault: WebKit retains all existing native menu entries.
  }, true);
  for (const name of ['focusin', 'focusout', 'selectionchange', 'input', 'mouseup', 'keyup']) {
    document.addEventListener(name, () => queueMicrotask(refresh));
  }
  window.addEventListener('manual-studio-editor-context-ai', () => {
    const run = captured;
    captured = undefined;
    run?.();
  });
  refresh();
  return refresh;
}
