export interface ComparisonImage { label: string; src: string }
export interface AnnotationInfo { state: 'present' | 'missing' | 'invalid' | 'unavailable'; count: number; value?: string }
function normalizeMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeMetadata);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => [key,normalizeMetadata(item)]));
  return value;
}

// MarkIts stores its scene JSON in a PNG tEXt chunk named markits:annotations.
export function readAnnotationInfo(src: string): AnnotationInfo {
  if (!src.startsWith('data:image/png;base64,')) return { state: 'unavailable', count: 0 };
  try {
    const bytes = Uint8Array.from(atob(src.slice(src.indexOf(',') + 1)), char => char.charCodeAt(0));
    if (bytes.length < 8 || [137,80,78,71,13,10,26,10].some((byte,index) => bytes[index] !== byte)) return { state: 'invalid', count: 0 };
    const view = new DataView(bytes.buffer);
    const decode = new TextDecoder('utf-8', {fatal:true});
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      const end = offset + 12 + length;
      if (end > bytes.length) return { state: 'invalid', count: 0 };
      const type = decode.decode(bytes.subarray(offset + 4, offset + 8));
      if (type === 'tEXt') {
        const chunk = bytes.subarray(offset + 8, end - 4);
        const separator = chunk.indexOf(0);
        if (separator >= 0 && decode.decode(chunk.subarray(0, separator)) === 'markits:annotations') {
          const scene = JSON.parse(decode.decode(chunk.subarray(separator + 1)));
          const annotations = Array.isArray(scene) ? scene : scene?.annotations;
          if (!Array.isArray(annotations)) return { state: 'invalid', count: 0 };
          return {state:'present',count:annotations.length,value:JSON.stringify(normalizeMetadata(annotations))};
        }
      }
      if (type === 'IEND') return {state:'missing',count:0};
      offset = end;
    }
    return {state:'invalid',count:0};
  } catch { return {state:'invalid',count:0}; }
}

export function showImageComparison(images: ComparisonImage[], title = '撮影画像を確認'): Promise<void> {
  const dialog = document.createElement('dialog');
  dialog.className = 'image-comparison-dialog';
  dialog.setAttribute('aria-labelledby', 'image-comparison-title');
  dialog.innerHTML = '<div class="panel-header"><h2 id="image-comparison-title"></h2><button type="button" data-close>閉じる</button></div><p class="muted">同じ倍率で撮影前後を比較できます。画像をクリックすると実寸表示へ切り替わります。</p><label class="image-zoom-control">表示倍率 <input type="range" min="25" max="200" step="25" value="100" aria-label="画像の表示倍率" /><output>幅に合わせる</output></label><div class="image-comparison-grid"></div>';
  dialog.querySelector('h2')!.textContent = title;
  const grid = dialog.querySelector<HTMLElement>('.image-comparison-grid')!;
  const metadata = images.map(item => readAnnotationInfo(item.src));
  if (images.length === 2) {
    const note = document.createElement('p'); note.className = 'image-annotation-summary'; note.setAttribute('role', 'status');
    note.textContent = metadata.every(info => info.state === 'present')
      ? metadata[0].value === metadata[1].value ? '撮影前後の注釈データは同一です。' : '撮影前後で注釈データが変わっています。位置と内容を確認してください。'
      : '注釈の保持状況はメタデータから確認できません。';
    grid.before(note);
  }
  for (const [index, item] of images.entries()) {
    const figure = document.createElement('figure');
    const caption = document.createElement('figcaption'); caption.textContent = item.label;
    const viewport = document.createElement('div'); viewport.className = 'image-comparison-viewport';
    const details = document.createElement('p'); details.className = 'image-comparison-meta muted';
    const annotation = metadata[index];
    const annotationText = annotation.state === 'present' ? `注釈${annotation.count}件` : annotation.state === 'missing' ? '注釈メタデータなし' : '注釈データを確認できません';
    details.textContent = annotationText;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'image-comparison-image';
    button.setAttribute('aria-label', `${item.label}を実寸表示`);
    const image = document.createElement('img'); image.alt = item.label; image.src = item.src;
    button.append(image); viewport.append(button); figure.append(caption, details, viewport); grid.append(figure);
    button.addEventListener('click', () => { if (fitted) range.value = '100'; fitted = !fitted; updateZoom(); });
    image.addEventListener('error', () => { caption.textContent = `${item.label}（画像を読み込めませんでした）`; });
    image.addEventListener('load', () => { details.textContent = `${image.naturalWidth} × ${image.naturalHeight}px・${annotationText}`; updateZoom(); });
  }
  const range = dialog.querySelector<HTMLInputElement>('input')!;
  let fitted = true;
  const updateZoom = () => {
    grid.dataset.fitted = String(fitted);
    grid.style.setProperty('--image-zoom', String(Number(range.value) / 100));
    grid.querySelectorAll<HTMLImageElement>('img').forEach(image => { image.style.width = fitted ? '' : `${image.naturalWidth * Number(range.value) / 100}px`; });
    dialog.querySelector('output')!.textContent = fitted ? '幅に合わせる' : `${range.value}%`;
    grid.querySelectorAll<HTMLButtonElement>('.image-comparison-image').forEach(button => {
      button.setAttribute('aria-label', `${button.querySelector('img')!.alt}を${fitted ? '実寸表示' : '幅に合わせて表示'}`);
    });
  };
  range.addEventListener('input', () => { fitted = false; updateZoom(); });
  updateZoom(); document.body.append(dialog); dialog.showModal();
  return new Promise(resolve => {
    const finish = () => { dialog.close(); dialog.remove(); resolve(); };
    dialog.querySelector('[data-close]')!.addEventListener('click', finish);
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  });
}
