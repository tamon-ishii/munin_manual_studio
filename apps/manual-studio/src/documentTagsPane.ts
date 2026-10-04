type Position = 'right' | 'left' | 'floating';
interface PaneSettings { position: Position; width: number; x: number; y: number }
const storageKey = 'manual-studio-document-tags-pane';
export function setupDocumentTagsPane(): void {
  const workspace = document.getElementById('editor-workspace');
  const pane = document.getElementById('document-tags-pane');
  const handle = document.getElementById('document-tags-handle');
  const resizer = document.getElementById('document-tags-resizer');
  const picker = document.getElementById('document-tags-position') as HTMLSelectElement | null;
  if (!workspace || !pane || !handle || !resizer || !picker) return;
  let settings: PaneSettings = { position: 'right', width: 270, x: Math.max(0, innerWidth - 320), y: 130 };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    if (['right', 'left', 'floating'].includes(saved.position)) settings.position = saved.position;
    for (const key of ['width', 'x', 'y'] as const) if (typeof saved[key] === 'number' && Number.isFinite(saved[key])) settings[key] = saved[key];
  } catch { /* A damaged preference should not block editing. */ }
  const save = () => { try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch { /* Optional preference. */ } };
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
  const apply = () => {
    if (!workspace.clientWidth) return;
    const maxWidth = settings.position === 'floating' ? innerWidth - 20 : workspace.clientWidth * 0.45;
    settings.width = clamp(settings.width, Math.min(180, Math.max(100, maxWidth)), Math.min(520, Math.max(100, maxWidth)));
    workspace.dataset.tagPosition = settings.position;
    workspace.style.setProperty('--document-tags-width', `${settings.width}px`);
    pane.dataset.collapsed = 'false';
    pane.classList.toggle('document-tags-floating', settings.position === 'floating');
    picker.value = settings.position;
    resizer.setAttribute('aria-valuenow', String(Math.round(settings.width)));
    resizer.setAttribute('aria-valuemin', '100'); resizer.setAttribute('aria-valuemax', '520');
    if (settings.position === 'floating') {
      pane.style.width = `${settings.width}px`;
      settings.x = clamp(settings.x, 0, innerWidth - pane.offsetWidth);
      settings.y = clamp(settings.y, 0, innerHeight - Math.min(pane.offsetHeight || 80, innerHeight));
      pane.style.left = `${settings.x}px`; pane.style.top = `${settings.y}px`;
    } else { pane.style.removeProperty('left'); pane.style.removeProperty('top'); pane.style.removeProperty('width'); }
  };
  picker.addEventListener('change', () => { settings.position = picker.value as Position; apply(); save(); });
  let drag: { id: number; x: number; y: number; left: number; top: number; started: boolean } | null = null;
  handle.addEventListener('pointerdown', event => {
    if ((event.target as HTMLElement).closest('button,select,input') || event.button !== 0) return;
    const rect = pane.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, started: false };
    handle.setPointerCapture(event.pointerId); event.preventDefault();
  });
  handle.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.started && Math.hypot(dx, dy) < 5) return;
    drag.started = true; settings.position = 'floating'; settings.x = drag.left + dx; settings.y = drag.top + dy; apply();
  });
  const finishDrag = (event: PointerEvent) => { if (drag?.id === event.pointerId) { drag = null; save(); } };
  handle.addEventListener('pointerup', finishDrag); handle.addEventListener('pointercancel', finishDrag); handle.addEventListener('lostpointercapture', finishDrag);
  let resize: { id: number; x: number; width: number } | null = null;
  resizer.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    resize = { id: event.pointerId, x: event.clientX, width: settings.width };
    resizer.setPointerCapture(event.pointerId); document.body.classList.add('pane-resizing'); event.preventDefault();
  });
  resizer.addEventListener('pointermove', event => {
    if (!resize || resize.id !== event.pointerId) return;
    settings.width = resize.width + (event.clientX - resize.x) * (settings.position === 'left' ? 1 : -1); apply();
  });
  const finishResize = (event: PointerEvent) => { if (resize?.id === event.pointerId) { resize = null; document.body.classList.remove('pane-resizing'); save(); } };
  resizer.addEventListener('pointerup', finishResize); resizer.addEventListener('pointercancel', finishResize); resizer.addEventListener('lostpointercapture', finishResize);
  resizer.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); settings.width += (event.key === 'ArrowRight' ? 20 : -20) * (settings.position === 'left' ? 1 : -1); apply(); save();
  });
  // The floating pane can also be moved without a pointing device.
  handle.addEventListener('keydown', event => {
    if (event.target !== handle || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    if (settings.position !== 'floating') { const rect = pane.getBoundingClientRect(); settings.position = 'floating'; settings.x = rect.left; settings.y = rect.top; }
    settings.x += event.key === 'ArrowRight' ? 20 : event.key === 'ArrowLeft' ? -20 : 0;
    settings.y += event.key === 'ArrowDown' ? 20 : event.key === 'ArrowUp' ? -20 : 0;
    apply(); save();
  });
  window.addEventListener('resize', apply);
  new ResizeObserver(apply).observe(workspace);
  apply();
}
