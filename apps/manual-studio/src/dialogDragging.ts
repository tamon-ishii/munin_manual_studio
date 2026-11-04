/** Move dialogs from their title bar while leaving form controls interactive. */
export function setupDialogDragging(): void {
  type Drag = {dialog: HTMLDialogElement; handle: HTMLElement; pointer: number; x: number; y: number; left: number; top: number};
  let drag: Drag | null = null;
  const initialized = new WeakSet<HTMLDialogElement>();
  const position = (dialog: HTMLDialogElement, left: number, top: number) => {
    const bounds = dialog.getBoundingClientRect();
    const margin = 8;
    const x = Math.max(margin, Math.min(left, Math.max(margin, window.innerWidth - bounds.width - margin)));
    const y = Math.max(margin, Math.min(top, Math.max(margin, window.innerHeight - bounds.height - margin)));
    dialog.style.setProperty('--dialog-drag-x', `${x}px`);
    dialog.style.setProperty('--dialog-drag-y', `${y}px`);
  };
  const finish = () => {
    if (!drag) return;
    const {handle,pointer} = drag;
    drag = null;
    handle.classList.remove('dialog-title-dragging');
    if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
  };
  const observer = new ResizeObserver(entries => {
    for (const {target} of entries) {
      const dialog = target as HTMLDialogElement;
      if (!dialog.open || !dialog.classList.contains('dialog-dragged')) continue;
      const bounds = dialog.getBoundingClientRect();
      position(dialog,bounds.left,bounds.top);
    }
  });
  document.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || !(event.target instanceof Element)) return;
    if (event.target.closest('button,input,select,textarea,a,summary,[contenteditable="true"],[role="button"]')) return;
    const handle = event.target.closest<HTMLElement>('dialog .panel-header,dialog > h1,dialog > h2,dialog > form > h2');
    const dialog = handle?.closest('dialog');
    if (!handle || !(dialog instanceof HTMLDialogElement) || !dialog.open) return;
    finish();
    const bounds = dialog.getBoundingClientRect();
    position(dialog,bounds.left,bounds.top);
    dialog.classList.add('dialog-dragged');
    observer.observe(dialog);
    if (!initialized.has(dialog)) {
      initialized.add(dialog);
      dialog.addEventListener('close', () => {
        if (drag?.dialog === dialog) finish();
        observer.unobserve(dialog);
        dialog.classList.remove('dialog-dragged');
        dialog.style.removeProperty('--dialog-drag-x');
        dialog.style.removeProperty('--dialog-drag-y');
      });
    }
    drag = {dialog,handle,pointer:event.pointerId,x:event.clientX,y:event.clientY,left:bounds.left,top:bounds.top};
    handle.classList.add('dialog-title-dragging');
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  document.addEventListener('pointermove', event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!drag.dialog.isConnected || !drag.dialog.open) {finish();return;}
    position(drag.dialog,drag.left+event.clientX-drag.x,drag.top+event.clientY-drag.y);
  });
  for (const type of ['pointerup','pointercancel','lostpointercapture'] as const) {
    document.addEventListener(type,event=>{if(drag?.pointer===event.pointerId)finish();});
  }
  window.addEventListener('blur',finish);
  window.addEventListener('resize',()=>{
    document.querySelectorAll<HTMLDialogElement>('dialog.dialog-dragged[open]').forEach(dialog=>{
      const bounds=dialog.getBoundingClientRect();position(dialog,bounds.left,bounds.top);
    });
  });
}
