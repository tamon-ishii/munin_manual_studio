export interface DiffLine { kind: 'same' | 'remove' | 'add'; text: string }
export function diffLines(before: string, after: string): DiffLine[] {
  if (before === after) return before.split('\n').map(text => ({ kind: 'same', text }));
  const a = before.split('\n'), b = after.split('\n');
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
  const left = a.slice(prefix, a.length - suffix), right = b.slice(prefix, b.length - suffix);
  const result: DiffLine[] = a.slice(0, prefix).map(text => ({ kind: 'same', text }));
  if (left.length * right.length <= 1_000_000) {
    const lengths = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
    for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) lengths[i][j] = left[i] === right[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    let i = 0, j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) { result.push({ kind: 'same', text: left[i++] }); j++; }
      else if (i < left.length && (j === right.length || lengths[i + 1][j] >= lengths[i][j + 1])) result.push({ kind: 'remove', text: left[i++] });
      else result.push({ kind: 'add', text: right[j++] });
    }
  } else {
    result.push(...left.map(text => ({ kind: 'remove' as const, text })), ...right.map(text => ({ kind: 'add' as const, text })));
  }
  result.push(...a.slice(a.length - suffix).map(text => ({ kind: 'same' as const, text })));
  return result;
}
export type ReviewDecision = { action: 'adopt' | 'restore' | 'retry'; feedback: string };
export function showGenerationReview(page: string, before: string, after: string, applied = false): Promise<ReviewDecision> {
  const dialog = document.createElement('dialog'); dialog.id = 'generation-review-dialog';
  dialog.setAttribute('aria-labelledby', 'generation-review-title');
  dialog.innerHTML = `<h2 id="generation-review-title">AI更新の差分</h2><p id="generation-review-page"></p><p>${applied ? '採用した結果を確認できます。前の結果に戻すときは、原稿の変更がないことを確認して保存します。' : '生成候補を確認してください。採用すると原稿へ保存します。元に戻すを選ぶと現在の原稿を保持します。'}</p><p id="generation-review-count" role="status"></p><div class="generation-diff" role="region" aria-label="更新前と生成結果の差分" tabindex="0"><div class="generation-diff-heading">更新前</div><div class="generation-diff-heading">${applied ? '採用した結果' : '生成候補'}</div><div id="generation-diff-before"></div><div id="generation-diff-after"></div></div><label>やり直しの指示（省略可）<textarea id="generation-review-feedback" rows="2" placeholder="例: 初めて使う人向けに、操作手順を短くしてください"></textarea></label><div class="actions"><button type="button" data-review-action="restore">${applied ? '前の結果に戻す' : '元に戻す'}</button><button type="button" data-review-action="retry">やり直す</button><button type="button" class="primary" data-review-action="adopt">${applied ? 'この結果を維持' : '採用して保存'}</button></div>`;
  dialog.querySelector('#generation-review-page')!.textContent = page;
  const lines = diffLines(before, after);
  dialog.querySelector('#generation-review-count')!.textContent = `追加 ${lines.filter(line => line.kind === 'add').length}行・削除 ${lines.filter(line => line.kind === 'remove').length}行`;
  const columns = [dialog.querySelector('#generation-diff-before')!, dialog.querySelector('#generation-diff-after')!];
  let oldNumber = 0, newNumber = 0;
  for (const line of lines) {
    if (line.kind !== 'add') oldNumber++;
    if (line.kind !== 'remove') newNumber++;
    for (let column = 0; column < 2; column++) {
      const blank = column === 0 ? line.kind === 'add' : line.kind === 'remove';
      const row = document.createElement('div'); row.className = `generation-diff-line ${blank ? 'diff-blank' : `diff-${line.kind}`}`;
      const number = document.createElement('span'); number.className = 'diff-line-number'; number.textContent = blank ? '' : String(column === 0 ? oldNumber : newNumber);
      const text = document.createElement('code'); text.textContent = blank ? ' ' : `${line.kind === 'same' ? ' ' : line.kind === 'add' ? '+' : '−'} ${line.text || ' '}`;
      row.append(number, text); columns[column].append(row);
    }
  }
  document.body.append(dialog); dialog.showModal();
  return new Promise(resolve => {
    const finish = (action: ReviewDecision['action']) => {
      const feedback = dialog.querySelector<HTMLTextAreaElement>('#generation-review-feedback')!.value.trim();
      dialog.close(); dialog.remove(); resolve({ action, feedback });
    };
    dialog.querySelectorAll<HTMLButtonElement>('[data-review-action]').forEach(button => button.addEventListener('click', () => finish(button.dataset.reviewAction as ReviewDecision['action'])));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(applied ? 'adopt' : 'restore'); });
  });
}
