import type { ExecutionLimits } from './executionHistory';
import type { Task } from './types';

export const taskStatusLabels: Record<string, string> = {
  missing: '未生成', stale: '更新候補', current: '生成済み', approved: '確定済み', failed: '失敗',
};
export const taskKindLabels: Record<string, string> = { text: '文章', screenshot: '画像', diagram: '図' };
export function generationSummary(tasks: Task[], approved = 0): string {
  return ['text', 'diagram'].map(kind => `${taskKindLabels[kind]}${tasks.filter(task => task.kind === kind).length}件`).join('・')
    + `を更新／確定済み${approved}件は維持`;
}

export function selectGenerationPages(pages: Array<{ page: string; tasks: Task[] }>): Promise<{ pages: string[]; limits: ExecutionLimits } | null> {
  const dialog = document.createElement('dialog');
  dialog.id = 'generation-pages-dialog'; dialog.className = 'generation-input-dialog';
  dialog.setAttribute('aria-labelledby', 'generation-pages-title');
  dialog.innerHTML = '<h2 id="generation-pages-title">AI更新する文書を選択</h2><p>原稿フォルダー内の文書が対象です。実行時に各文書の指示を確認できます。</p><div class="generation-page-choices"></div><fieldset class="execution-controls"><legend>一括実行の制御</legend><label>処理ごとの制限時間（秒）<input id="batch-timeout" type="number" min="5" max="1800" value="300" /></label><label>再試行回数<input id="batch-retries" type="number" min="0" max="3" value="0" /></label></fieldset><p id="generation-pages-summary" role="status"></p><div class="actions"><button type="button" data-cancel>キャンセル</button><button type="button" data-run class="primary">選択した文書を確認して更新</button></div>';
  const list = dialog.querySelector('.generation-page-choices')!;
  for (const { page, tasks } of pages) {
    const label = document.createElement('label'); label.className = 'generation-task-choice';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = page;
    const eligible = tasks.filter(task => task.status !== 'approved');
    checkbox.checked = Boolean(eligible.length); checkbox.disabled = !eligible.length;
    const text = document.createElement('span'); text.textContent = `${page}\n${generationSummary(eligible, tasks.filter(task => task.status === 'approved').length)}`;
    label.append(checkbox, text);
    const row = document.createElement('div'); row.className = 'generation-page-order';
    row.append(label);
    for (const direction of [-1, 1]) {
      const move = document.createElement('button'); move.type = 'button'; move.textContent = direction < 0 ? '↑' : '↓';
      move.setAttribute('aria-label', `${page}を${direction < 0 ? '前' : '後'}に移動`);
      move.addEventListener('click', () => {
        const neighbor = direction < 0 ? row.previousElementSibling : row.nextElementSibling;
        if (neighbor) list.insertBefore(direction < 0 ? row : neighbor, direction < 0 ? neighbor : row);
        update();
      }); row.append(move);
    }
    list.append(row);
  }
  const selected = () => [...list.querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value);
  const run = dialog.querySelector<HTMLButtonElement>('[data-run]')!;
  const update = () => {
    const chosen = pages.filter(item => selected().includes(item.page));
    run.disabled = !chosen.length;
    dialog.querySelector('#generation-pages-summary')!.textContent = `${chosen.length}文書：${generationSummary(chosen.flatMap(item => item.tasks).filter(task => task.status !== 'approved'), chosen.flatMap(item => item.tasks).filter(task => task.status === 'approved').length)}`;
  };
  list.addEventListener('change', update); update();
  document.body.append(dialog); dialog.showModal();
  return new Promise(resolve => {
    const finish = (result: { pages:string[]; limits:ExecutionLimits } | null) => { dialog.close(); dialog.remove(); resolve(result); };
    run.addEventListener('click', () => {
      const timeout = dialog.querySelector<HTMLInputElement>('#batch-timeout')!;
      const retries = dialog.querySelector<HTMLInputElement>('#batch-retries')!;
      if (!run.disabled && timeout.reportValidity() && retries.reportValidity()) finish({pages:selected(),limits:{timeout_seconds:Number(timeout.value),retries:Number(retries.value)}});
    });
    dialog.querySelector('[data-cancel]')!.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
  });
}
