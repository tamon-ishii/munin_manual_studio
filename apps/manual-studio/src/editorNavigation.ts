/** Locate a source offset using the textarea's actual wrapping and typography. */
export function jumpToSource(editor: HTMLTextAreaElement, start: number, end: number): void {
  const style = getComputedStyle(editor);
  const mirror = document.createElement('div');
  for (const property of [
    'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
    'letter-spacing', 'word-spacing', 'text-indent', 'text-transform', 'tab-size',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'word-break', 'overflow-wrap',
  ]) mirror.style.setProperty(property, style.getPropertyValue(property));
  Object.assign(mirror.style, {
    position: 'fixed', visibility: 'hidden', pointerEvents: 'none',
    top: '0', left: '0', boxSizing: 'border-box',
    width: `${editor.clientWidth}px`,
    whiteSpace: editor.wrap === 'off' ? 'pre' : 'pre-wrap',
  });
  mirror.textContent = editor.value.slice(0, start);
  const marker = document.createElement('span');
  marker.textContent = editor.value.slice(start, start + 1) || '\u200b';
  mirror.append(marker);
  document.body.append(mirror);
  const top = marker.getBoundingClientRect().top - mirror.getBoundingClientRect().top;
  mirror.remove();
  editor.focus({ preventScroll: true });
  editor.setSelectionRange(start, end);
  editor.scrollTop = Math.max(0, top - editor.clientHeight * 0.35);
  editor.scrollLeft = 0;
}
