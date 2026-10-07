import type { ExecutionLimits } from './executionHistory';
import { generationSummary } from './taskPresentation';
import type { Task } from './types';

export interface GenerationInput {
  limits?: ExecutionLimits; failure_policy?: "ask" | "keep" | "rollback";
  page: string; revision: string; existing_content: string; tasks: Task[];
  references: string[]; source_note: string; feedback: string;
  connection_type: string; agent: string; model: string;
  requests: Array<{ ids: string[]; prompt: string; schema: unknown }>;
}

export function showGenerationInput(initial: GenerationInput, reload: (ids: string[], revision: string) => Promise<GenerationInput>, approvedCount = 0): Promise<GenerationInput | null> {
  const dialog = document.createElement('dialog');
  dialog.id = 'generation-input-dialog'; dialog.className = 'generation-input-dialog';
  dialog.setAttribute('aria-labelledby', 'generation-input-title');
  dialog.innerHTML = '<h2 id="generation-input-title">生成するタグと入力を確認</h2><p id="generation-input-summary" role="status"></p><p id="generation-input-model"></p><div id="generation-input-tasks"></div><p id="generation-input-note"></p><details><summary>既存本文・参照ファイル</summary><p id="generation-input-references"></p><pre id="generation-input-content"></pre></details><details><summary>AIへの依頼全文</summary><pre id="generation-input-prompt"></pre></details><fieldset class="execution-controls"><legend>実行の制御</legend><label>処理ごとの制限時間（秒）<input id="execution-timeout" type="number" min="5" max="1800" value="300" /></label><label>失敗時の再試行回数<input id="execution-retries" type="number" min="0" max="3" value="0" /></label><label>一部失敗した場合<select id="execution-policy"><option value="ask">結果を見て選ぶ</option><option value="keep">成功分を採用</option><option value="rollback">文書と画像を元に戻す</option></select></label></fieldset><p id="generation-input-error" role="alert"></p><div class="actions"><button type="button" id="generation-input-cancel">キャンセル</button><button type="button" id="generation-input-run" class="primary">選択したタグを生成</button></div>';
  const run = dialog.querySelector<HTMLButtonElement>('#generation-input-run')!;
  let current = initial, version = 0, closed = false;
  const renderInput = (input: GenerationInput) => {
    dialog.querySelector('#generation-input-summary')!.textContent = generationSummary(input.tasks, approvedCount);
    dialog.querySelector('#generation-input-model')!.textContent = `${input.connection_type} / ${input.agent} / ${input.model || '既定モデル'}`;
    dialog.querySelector('#generation-input-note')!.textContent = input.source_note;
    dialog.querySelector('#generation-input-references')!.textContent = `参照先: ${input.references.join(', ')}`;
    dialog.querySelector('#generation-input-content')!.textContent = input.existing_content;
    dialog.querySelector('#generation-input-prompt')!.textContent = input.requests.map(request => `${request.ids.join(', ')}\n${request.prompt}`).join('\n\n');
  };
  const list = dialog.querySelector('#generation-input-tasks')!;
  for (const task of initial.tasks) {
    const label = document.createElement('label'); label.className = 'generation-task-choice';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = true; checkbox.value = task.id;
    const text = document.createElement('span'); text.textContent = `${task.id} (${task.kind === 'text' ? '文章' : task.kind === 'diagram' ? '図' : '画像'})\n${task.prompt}`;
    label.append(checkbox, text); list.append(label);
  }
  renderInput(current);
  if(initial.limits){dialog.querySelector<HTMLInputElement>('#execution-timeout')!.value=String(initial.limits.timeout_seconds);dialog.querySelector<HTMLInputElement>('#execution-retries')!.value=String(initial.limits.retries);}
  document.body.append(dialog); dialog.showModal();
  return new Promise(resolve => {
    const finish = (result: GenerationInput | null) => { closed = true; version++; dialog.close(); dialog.remove(); resolve(result); };
    list.addEventListener('change', () => {
      const ids = [...list.querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value);
      const requestVersion = ++version;
      run.disabled = true;
      dialog.querySelector('#generation-input-error')!.textContent = ids.length ? '選択した入力を読み直しています…' : '生成するタグを選んでください。';
      if (!ids.length) return;
      void reload(ids, initial.revision).then(input => {
        if (closed || requestVersion !== version) return;
        current = input; renderInput(current); run.disabled = false;
        dialog.querySelector('#generation-input-error')!.textContent = '';
      }).catch(error => {
        if (!closed && requestVersion === version) dialog.querySelector('#generation-input-error')!.textContent = String(error);
      });
    });
    run.disabled = !initial.tasks.length;
    run.addEventListener('click', () => {
      const timeout = dialog.querySelector<HTMLInputElement>('#execution-timeout')!;
      const retries = dialog.querySelector<HTMLInputElement>('#execution-retries')!;
      if (run.disabled || !timeout.reportValidity() || !retries.reportValidity()) return;
      current.limits = { timeout_seconds: Number(timeout.value), retries: Number(retries.value) };
      current.failure_policy = dialog.querySelector<HTMLSelectElement>('#execution-policy')!.value as GenerationInput['failure_policy'];
      finish(current);
    });
    dialog.querySelector('#generation-input-cancel')!.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
  });
}
