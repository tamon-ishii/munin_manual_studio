type ElementLookup = <T extends HTMLElement>(id: string) => T | null;

const byId: ElementLookup = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T | null;

function readStoredNumber(key: string, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function storeFiniteNumber(key: string, value: number): void {
  if (!Number.isFinite(value)) return;
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Resizing should still work when browser storage is unavailable.
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) return min;
  return Math.max(min, Math.min(max, value));
}

/** Set up the sidebar and editor/preview split handles. */
export function setupPaneResizers(lookup: ElementLookup = byId): void {
  const layout = lookup<HTMLElement>("app-layout");
  const sidebarHandle = lookup<HTMLElement>("sidebar-resizer");
  const editorHandle = lookup<HTMLElement>("editor-resizer");
  const split = document.querySelector<HTMLElement>(".editor-split");
  if (!layout || !sidebarHandle || !editorHandle) return;

  let activeHandle: HTMLElement | null = null;
  let activePointerId: number | null = null;
  const makePointerResize = (handle: HTMLElement, persist: () => void) => {
    const finish = (pointerId: number, releaseCapture: boolean) => {
      if (activeHandle !== handle || activePointerId !== pointerId) return;
      activeHandle = null;
      activePointerId = null;
      document.body.classList.remove("pane-resizing");
      persist();
      if (releaseCapture && handle.hasPointerCapture(pointerId)) {
        try { handle.releasePointerCapture(pointerId); } catch { /* Capture may already be lost. */ }
      }
    };

    handle.addEventListener("pointerdown", (event: PointerEvent) => {
      if (activeHandle) return;
      event.preventDefault();
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        return;
      }
      activeHandle = handle;
      activePointerId = event.pointerId;
      document.body.classList.add("pane-resizing");
    });
    handle.addEventListener("pointerup", (event: PointerEvent) => finish(event.pointerId, true));
    handle.addEventListener("pointercancel", (event: PointerEvent) => finish(event.pointerId, true));
    handle.addEventListener("lostpointercapture", (event: PointerEvent) => finish(event.pointerId, false));
    return (event: PointerEvent) => activeHandle === handle && activePointerId === event.pointerId;
  };

  const sidebarStorageKey = "manual-studio-sidebar-width";
  const applySidebarWidth = (value: number): number => {
    const availableWidth = layout.clientWidth;
    const max = Math.max(1, Math.min(760, availableWidth > 0 ? availableWidth * 0.62 : 760));
    const width = clamp(value, Math.min(210, max), max);
    layout.style.setProperty("--sidebar-width", `${width}px`);
    sidebarHandle.setAttribute("aria-valuenow", String(Math.round(width)));
    return width;
  };
  let sidebarWidth = applySidebarWidth(readStoredNumber(sidebarStorageKey, 350));
  const isSidebarDragging = makePointerResize(sidebarHandle, () => {
    storeFiniteNumber(sidebarStorageKey, Math.round(sidebarWidth));
  });
  sidebarHandle.addEventListener("pointermove", (event: PointerEvent) => {
    if (!isSidebarDragging(event)) return;
    const left = layout.getBoundingClientRect().left;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(left)) return;
    sidebarWidth = applySidebarWidth(event.clientX - left);
  });
  sidebarHandle.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    sidebarWidth = applySidebarWidth(sidebarWidth + (event.key === "ArrowRight" ? 24 : -24));
    storeFiniteNumber(sidebarStorageKey, Math.round(sidebarWidth));
  });

  if (!split) return;
  const editorStorageKey = "manual-studio-editor-ratio";
  const applyEditorRatio = (value: number): number => {
    const ratio = clamp(value, 0.42, 2.38);
    split.style.setProperty("--markdown-fr", `${ratio}fr`);
    editorHandle.dataset.ratio = String(ratio);
    editorHandle.setAttribute("aria-valuenow", String(Math.round(ratio / (ratio + 1) * 100)));
    return ratio;
  };
  let editorRatio = applyEditorRatio(readStoredNumber(editorStorageKey, 1));
  const isEditorDragging = makePointerResize(editorHandle, () => {
    storeFiniteNumber(editorStorageKey, editorRatio);
  });
  editorHandle.addEventListener("pointermove", (event: PointerEvent) => {
    if (!isEditorDragging(event)) return;
    const bounds = split.getBoundingClientRect();
    const available = bounds.width - editorHandle.offsetWidth;
    if (!Number.isFinite(available) || available <= 0) return;
    const left = clamp(event.clientX - bounds.left, available * 0.3, available * 0.7);
    const right = available - left;
    if (right <= 0) return;
    const ratio = left / right;
    if (Number.isFinite(ratio)) editorRatio = applyEditorRatio(ratio);
  });
  editorHandle.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    editorRatio = applyEditorRatio(editorRatio + (event.key === "ArrowRight" ? 0.1 : -0.1));
    storeFiniteNumber(editorStorageKey, editorRatio);
  });
}
