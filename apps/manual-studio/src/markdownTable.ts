export type TableAlignment = 'left' | 'center' | 'right' | 'default';
export interface MarkdownTable { rows: string[][]; alignments: TableAlignment[] }
export interface LocatedTable extends MarkdownTable { start: number; end: number }

function cells(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '\\' && i + 1 < line.length) {
      current += char + line[++i];
    } else if (char === '|') { parts.push(current.trim()); current = ''; }
    else current += char;
  }
  parts.push(current.trim());
  if (line.trimStart().startsWith('|')) parts.shift();
  if (parts.length > 1 && parts[parts.length - 1] === '' && line.trimEnd().endsWith('|')) parts.pop();
  return parts.map(cell => cell.replace(/\\\|/g, '|'));
}
export function findMarkdownTable(source: string, caret: number): LocatedTable | null {
  const lines = source.split('\n');
  const offsets: number[] = [];
  let offset = 0;
  let fence: { marker: string; count: number } | null = null;
  const fenced: boolean[] = [];
  for (const line of lines) {
    offsets.push(offset); offset += line.length + 1;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    fenced.push(Boolean(fence) || Boolean(marker));
    if (marker) {
      if (!fence) fence = { marker: marker[1][0], count: marker[1].length };
      else if (marker[1][0] === fence.marker && marker[1].length >= fence.count && !marker[2].trim()) fence = null;
    }
  }
  for (let i = 0; i < lines.length - 1; i++) {
    if (fenced[i] || fenced[i + 1] || !lines[i].includes('|')) continue;
    const header = cells(lines[i]);
    const separator = cells(lines[i + 1]);
    if (!header.length || separator.length !== header.length || !separator.every(cell => /^:?-{3,}:?$/.test(cell))) continue;
    let last = i + 1;
    const rows = [header];
    while (last + 1 < lines.length && !fenced[last + 1] && lines[last + 1].trim() && lines[last + 1].includes('|')) rows.push(cells(lines[++last]));
    const end = offsets[last] + lines[last].length;
    if (caret < offsets[i] || caret > end) { i = last; continue; }
    const width = Math.max(header.length, ...rows.map(row => row.length));
    const alignments: TableAlignment[] = separator.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : 'default');
    while (alignments.length < width) alignments.push('default');
    rows.forEach(row => { while (row.length < width) row.push(''); });
    return { rows, alignments, start: offsets[i], end };
  }
  return null;
}
export function serializeMarkdownTable(table: MarkdownTable): string {
  const row = (values: string[]) => `| ${values.map(value => value.replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|')).join(' | ')} |`;
  const separators = table.alignments.map(alignment => ({ left: ':---', center: ':---:', right: '---:', default: '---' })[alignment]);
  return [row(table.rows[0]), row(separators), ...table.rows.slice(1).map(row)].join('\n');
}

interface TableEditorOptions {
  editor: HTMLTextAreaElement;
  canEdit: () => boolean;
  replace: (start: number, end: number, text: string, selectionStart: number, selectionEnd?: number) => void;
  report: (message: string) => void;
}
export function setupMarkdownTableEditor(options: TableEditorOptions): () => void {
  const dialog = document.createElement('dialog');
  dialog.id = 'markdown-table-dialog';
  dialog.innerHTML = `<form method="dialog"><h2 id="markdown-table-title">表を作成・編集</h2><p class="muted">セルを直接編集できます。先頭行は見出しです。原稿の表にカーソルを置いて開くと、その表を編集できます。</p><div class="table-editor-actions"><button type="button" data-table-add-row>＋ 行</button><button type="button" data-table-add-column>＋ 列</button></div><div class="table-editor-grid"><table><thead></thead><tbody></tbody></table></div><details><summary>Markdownを確認</summary><pre class="table-editor-preview"></pre></details><p class="table-editor-error" role="alert"></p><div class="actions"><button type="button" data-table-cancel>キャンセル</button><button type="submit" class="primary">原稿に反映</button></div></form>`;
  dialog.setAttribute('aria-labelledby', 'markdown-table-title');
  document.body.append(dialog);
  let model: MarkdownTable;
  let original = '';
  let start = 0, end = 0;
  let prefix = '', suffix = '';
  let returnStart = 0, returnEnd = 0;
  const error = dialog.querySelector<HTMLElement>('.table-editor-error')!;
  const preview = dialog.querySelector<HTMLElement>('.table-editor-preview')!;
  const updatePreview = () => { preview.textContent = serializeMarkdownTable(model); };
  const render = () => {
    const head = dialog.querySelector('thead')!;
    const body = dialog.querySelector('tbody')!;
    head.replaceChildren(); body.replaceChildren();
    const controls = document.createElement('tr');
    controls.append(document.createElement('th'));
    model.alignments.forEach((alignment, column) => {
      const th = document.createElement('th');
      const label = document.createElement('label'); label.textContent = `列 ${column + 1}`;
      const select = document.createElement('select'); select.setAttribute('aria-label', `列${column + 1}の配置`);
      for (const [value, text] of [['default', '標準'], ['left', '左寄せ'], ['center', '中央'], ['right', '右寄せ']]) {
        const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option);
      }
      select.value = alignment; select.addEventListener('change', () => { model.alignments[column] = select.value as TableAlignment; updatePreview(); });
      label.append(select); th.append(label);
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '列を削除'; remove.disabled = model.alignments.length <= 1;
      remove.setAttribute('aria-label', `列${column + 1}を削除`);
      remove.addEventListener('click', () => { model.alignments.splice(column, 1); model.rows.forEach(row => row.splice(column, 1)); render(); });
      th.append(remove); controls.append(th);
    });
    head.append(controls);
    model.rows.forEach((row, rowIndex) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th'); th.scope = 'row'; th.textContent = rowIndex === 0 ? '見出し' : `行 ${rowIndex}`;
      if (rowIndex > 0) {
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '削除'; remove.setAttribute('aria-label', `行${rowIndex}を削除`);
        remove.addEventListener('click', () => { model.rows.splice(rowIndex, 1); render(); }); th.append(remove);
      }
      tr.append(th);
      row.forEach((value, column) => {
        const td = document.createElement('td');
        const input = document.createElement('input'); input.type = 'text'; input.value = value;
        input.setAttribute('aria-label', `${rowIndex === 0 ? '見出し' : `行${rowIndex}`}・列${column + 1}`);
        input.addEventListener('input', () => { model.rows[rowIndex][column] = input.value; updatePreview(); });
        td.append(input); tr.append(td);
      });
      body.append(tr);
    });
    dialog.querySelector<HTMLButtonElement>('[data-table-add-column]')!.disabled = model.alignments.length >= 50;
    dialog.querySelector<HTMLButtonElement>('[data-table-add-row]')!.disabled = model.rows.length >= 201;
    updatePreview();
  };
  dialog.querySelector('[data-table-add-row]')!.addEventListener('click', () => { model.rows.push(model.alignments.map(() => '')); render(); });
  dialog.querySelector('[data-table-add-column]')!.addEventListener('click', () => { model.alignments.push('default'); model.rows.forEach(row => row.push('')); render(); });
  dialog.querySelector('[data-table-cancel]')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { options.editor.focus(); options.editor.setSelectionRange(returnStart, returnEnd); });
  dialog.querySelector('form')!.addEventListener('submit', event => {
    event.preventDefault();
    if (!options.canEdit() || options.editor.value !== original) { error.textContent = '原稿が変更されたため反映できません。閉じてから、もう一度表を開いてください。'; return; }
    const text = prefix + serializeMarkdownTable(model) + suffix;
    returnStart = start + prefix.length + 2; returnEnd = returnStart + model.rows[0][0].length;
    options.replace(start, end, text, prefix.length + 2, prefix.length + 2 + model.rows[0][0].length);
    dialog.close();
  });
  return () => {
    if (!options.canEdit()) { options.report('先に原稿を開いてください。処理中は編集できません。'); return; }
    original = options.editor.value; start = options.editor.selectionStart; end = options.editor.selectionEnd;
    returnStart = start; returnEnd = end; prefix = ''; suffix = ''; error.textContent = '';
    const existing = findMarkdownTable(original, start);
    if (existing) {
      if (existing.alignments.length > 50 || existing.rows.length > 201) { options.report('この表は大きいため原稿上で編集してください（最大50列・200行）。'); return; }
      model = existing; start = existing.start; end = existing.end;
    } else {
      model = { rows: [['項目', '内容'], ['', ''], ['', '']], alignments: ['default', 'default'] };
      const before = original.slice(0, start), after = original.slice(end);
      prefix = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
      suffix = !after || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
    }
    render(); dialog.showModal();
  };
}
