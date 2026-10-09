export interface GenerationHistorySummary {
  id: string; created_at: string; agent: string; model: string; connection_type: string; ids: string[]; feedback: string;
}
export interface GenerationHistoryEntry { id: string; created_at: string; input: { page: string; feedback: string; requests: Array<{ prompt: string }> }; candidate: { content: string; before: { content: string }; updated: string[] } }
export function showGenerationHistory(entries: GenerationHistorySummary[], actions: {
  load: (id: string) => Promise<GenerationHistoryEntry>;
  compare: (before: string, after: string) => Promise<void>;
  reuse: (entry: GenerationHistoryEntry) => Promise<void>;
}): Promise<void> {
  const dialog = document.createElement('dialog'); dialog.id = 'generation-history-dialog'; dialog.className = 'generation-history-dialog';
  dialog.innerHTML = '<h2>生成履歴</h2><p>この原稿の最近50件です。2件を選ぶと生成結果を比較できます。</p><div id="generation-history-list"></div><p id="generation-history-error" role="alert"></p><div class="actions"><button type="button" id="generation-history-compare" disabled>選択した2件を比較</button><button type="button" id="generation-history-close">閉じる</button></div>';
  const list = dialog.querySelector('#generation-history-list')!;
  const compare = dialog.querySelector<HTMLButtonElement>('#generation-history-compare')!;
  const selected = new Set<string>();
  const run = async (button: HTMLButtonElement, operation: () => Promise<void>) => {
    button.disabled = true;
    try { await operation(); dialog.querySelector('#generation-history-error')!.textContent = ''; }
    catch (error) { dialog.querySelector('#generation-history-error')!.textContent = String(error); }
    finally { button.disabled = button === compare ? selected.size !== 2 : false; }
  };
  if (!entries.length) list.textContent = '生成履歴はまだありません。';
  for (const entry of entries) {
    const row = document.createElement('div'); row.className = 'generation-history-row';
    const label = document.createElement('label'); label.className = 'generation-task-choice';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = entry.id;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked && selected.size >= 2) checkbox.checked = false;
      if (checkbox.checked) selected.add(entry.id); else selected.delete(entry.id);
      compare.disabled = selected.size !== 2;
    });
    const metadata = document.createElement('span'); metadata.textContent = `${entry.created_at} / ${entry.connection_type} / ${entry.agent} / ${entry.model || '既定モデル'}\nタグ: ${entry.ids.join(', ')}${entry.feedback ? `\n修正指示: ${entry.feedback}` : ''}`;
    label.append(checkbox, metadata); row.append(label);
    const inspect = document.createElement('button'); inspect.textContent = '入力と生成差分を確認'; inspect.type = 'button';
    inspect.addEventListener('click', () => { void run(inspect, async () => {
      const item = await actions.load(entry.id);
      let detail = row.querySelector('pre');
      if (!detail) { detail = document.createElement('pre'); row.append(detail); }
      detail.textContent = item.input.requests.map(request => request.prompt).join('\n\n');
      await actions.compare(item.candidate.before.content, item.candidate.content);
    }); });
    const reuse = document.createElement('button'); reuse.textContent = '候補として再利用'; reuse.type = 'button';
    reuse.addEventListener('click', () => { void run(reuse, async () => actions.reuse(await actions.load(entry.id))); });
    row.append(inspect, reuse); list.append(row);
  }
  compare.addEventListener('click', () => { void run(compare, async () => {
    const [a, b] = await Promise.all([...selected].map(id => actions.load(id)));
    await actions.compare(a.candidate.content, b.candidate.content);
  }); });
  document.body.append(dialog); dialog.showModal();
  return new Promise(resolve => {
    const finish = () => { dialog.close(); dialog.remove(); resolve(); };
    dialog.querySelector('#generation-history-close')!.addEventListener('click', finish);
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  });
}
