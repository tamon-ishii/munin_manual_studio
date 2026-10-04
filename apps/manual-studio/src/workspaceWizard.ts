interface WizardActions {
  validate: (root: string, options: Record<string, unknown>) => Promise<void>;
  create: (root: string, options: Record<string, unknown>) => Promise<void>;
  chooseParent: () => Promise<string | null>;
}
export function setupWorkspaceWizard(actions: WizardActions): void {
  const dialog = document.createElement('dialog');
  dialog.id = 'new-workspace-dialog';
  dialog.innerHTML = `<form id="new-workspace-form">
    <h2>新規ワークスペースを作成</h2><p id="workspace-step" role="status"></p>
    <section data-step="0"><h3>1. 保存場所を決める</h3><p>ワークスペースは、原稿・画像・AI設定をまとめて保存するフォルダーです。新しいフォルダーを作ります。</p><label>保存先の親フォルダー<input id="wizard-parent" required placeholder="例: /home/user/Documents" /></label><button type="button" id="wizard-browse">親フォルダーを選ぶ</button><label>新しいフォルダー名<input id="wizard-name" required value="manual-workspace" /></label></section>
    <section data-step="1" hidden><h3>2. 原稿と公開先を設定する</h3><p>Markdown原稿を編集し、HTMLへ出力してマニュアルを公開できます。原稿と出力先には別のフォルダーを指定してください。各パスはワークスペース内の場所です。</p><label>サイト名<input id="wizard-title" required value="マニュアル" /></label><label>原稿フォルダー<input id="wizard-docs" required value="docs" /></label><label>HTML出力先<input id="wizard-output" required value="manual" /></label><label>画像保存フォルダー<input id="wizard-assets" required value="docs/assets" /></label><p>原稿のフォルダーを変えた場合は、画像の保存場所も確認してください。</p></section>
    <section data-step="2" hidden><h3>3. AIとの接続を選ぶ</h3><p>AIタグに書いた指示から文章や図を生成できます。AIは任意です。接続は作成後にも変更でき、Markdownの編集はAIなしで始められます。</p><label>接続方式<select id="wizard-connection"><option value="none">後で設定する（AIなしで始める）</option><option value="cli">CLIツール</option><option value="local_llm">ローカルLLM</option><option value="api">クラウドAPI（OpenAI互換）</option></select></label><label id="wizard-agent-label" hidden>AIエージェント<select id="wizard-agent"><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="gemini">Gemini CLI</option><option value="grok">Grok Build</option><option value="agy">Agy</option></select></label><p id="wizard-cli-note" hidden>AI実行には、選択したCLIのインストールとログインが必要です。</p><label id="wizard-endpoint-label" hidden>エンドポイントURL<input id="wizard-endpoint" placeholder="http://localhost:11434/v1" /></label><label id="wizard-model-label" hidden>モデル（省略可）<input id="wizard-model" /></label><p id="wizard-api-note" hidden>APIキーは作成後に「AI設定・出力」で設定してください。</p></section>
    <section data-step="3" hidden><h3>4. 読者と目的を伝える</h3><p>誰が読むか、何を説明したいかをAIに伝えると、下書きの方向が揃います。後から追加・編集できます。</p><label>読者・目的・含めたい操作（省略可）<textarea id="wizard-brief" rows="5" placeholder="例: 初めて使う人向けに、起動から保存までを説明する"></textarea></label></section>
    <section data-step="4" hidden><h3>5. 設定を確認して作成する</h3><dl id="wizard-review"></dl><p>設定ファイル、原稿・画像フォルダー、最初の原稿を作成します。作成後は原稿を編集し、必要に応じてAIタグを追加できます。</p></section>
    <p id="wizard-error" role="alert"></p><div class="actions"><button type="button" id="wizard-cancel">キャンセル</button><button type="button" id="wizard-back">戻る</button><button type="submit" id="wizard-next" class="primary">次へ</button></div>
  </form>`;
  document.body.append(dialog);
  const node = <T extends HTMLElement>(id: string) => dialog.querySelector<T>(`#${id}`)!;
  const value = (id: string) => node<HTMLInputElement>(id).value.trim();
  const root = () => `${value('wizard-parent').replace(/[\\/]+$/, '')}/${value('wizard-name')}`;
  const options = () => ({ docs: value('wizard-docs'), output: value('wizard-output'), assets: value('wizard-assets'), site_name: value('wizard-title'), agent: value('wizard-agent'), connection_type: value('wizard-connection'), endpoint_url: value('wizard-connection') === 'none' ? '' : value('wizard-endpoint'), model: value('wizard-connection') === 'none' ? '' : value('wizard-model'), brief: value('wizard-brief') });
  let step = 0, saving = false;
  const show = () => {
    dialog.querySelectorAll<HTMLElement>('[data-step]').forEach(section => { section.hidden = Number(section.dataset.step) !== step; });
    node('workspace-step').textContent = `ステップ ${step + 1} / 5`;
    node('wizard-back').hidden = step === 0;
    node('wizard-next').textContent = step === 4 ? '作成して開く' : '次へ';
    node('wizard-error').textContent = '';
    if (step === 4) {
      const review = node('wizard-review'); review.replaceChildren();
      for (const [label, text] of [['保存先', root()], ['サイト名', value('wizard-title')], ['原稿', value('wizard-docs')], ['HTML出力先', value('wizard-output')], ['画像', value('wizard-assets')], ['AI接続', node<HTMLSelectElement>('wizard-connection').selectedOptions[0].text], ...(value('wizard-connection') === 'none' ? [] : [['CLI / 接続先', value('wizard-connection') === 'cli' ? value('wizard-agent') : value('wizard-endpoint') || '既定の接続先'], ['モデル', value('wizard-model') || '既定モデル']])]) {
        const term = document.createElement('dt'); term.textContent = label;
        const definition = document.createElement('dd'); definition.textContent = text;
        review.append(term, definition);
      }
    }
    node<HTMLButtonElement>('wizard-next').focus();
  };
  document.getElementById('new-workspace')!.addEventListener('click', () => { step = 0; show(); dialog.showModal(); });
  node('wizard-back').addEventListener('click', () => { if (!saving) { step--; show(); } });
  node('wizard-cancel').addEventListener('click', () => { if (!saving) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  node('wizard-browse').addEventListener('click', () => { void actions.chooseParent().then(parent => { if (parent) node<HTMLInputElement>('wizard-parent').value = parent; }).catch(error => { node('wizard-error').textContent = String(error); }); });
  node('wizard-connection').addEventListener('change', () => {
    const cli = value('wizard-connection') === 'cli';
    node('wizard-agent-label').hidden = cli === false; node('wizard-cli-note').hidden = !cli;
    node('wizard-endpoint-label').hidden = cli || value('wizard-connection') === 'none';
    node('wizard-model-label').hidden = value('wizard-connection') === 'none';
    node('wizard-api-note').hidden = cli || value('wizard-connection') === 'none';
    node<HTMLInputElement>('wizard-endpoint').placeholder = value('wizard-connection') === 'api' ? 'https://api.openai.com/v1' : 'http://localhost:11434/v1';
  });
  const form = node<HTMLFormElement>('new-workspace-form');
  form.noValidate = true;
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (saving) return;
    for (const control of dialog.querySelectorAll<HTMLInputElement>(`[data-step="${step}"] input`)) if (!control.reportValidity()) return;
    node('wizard-error').textContent = '';
    if (step === 0 && (['.', '..'].includes(value('wizard-name')) || /[\\/]/.test(value('wizard-name')))) { node('wizard-error').textContent = '新しいフォルダー名を入力してください。'; return; }
    if (step === 2 && value('wizard-connection') !== 'none') {
      if (value('wizard-model').length > 120) { node('wizard-error').textContent = 'モデル名は120文字以内で入力してください。'; return; }
      const endpoint = value('wizard-endpoint');
      if (value('wizard-connection') !== 'cli' && endpoint) {
        try { if (!['http:', 'https:'].includes(new URL(endpoint).protocol)) throw new Error(); }
        catch { node('wizard-error').textContent = '接続先はhttp://またはhttps://で始まるURLを入力してください。'; return; }
      }
    }
    saving = true;
    const setDisabled = (disabled: boolean) => dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input,button,select,textarea').forEach(control => { control.disabled = disabled; });
    setDisabled(true);
    node('wizard-next').textContent = step === 4 ? '作成中…' : '確認中…';
    try {
      if (step <= 1) await actions.validate(root(), { ...options(), step });
      if (step < 4) { step++; show(); }
      else { await actions.create(root(), options()); dialog.close(); }
    } catch (error) { node('wizard-error').textContent = String(error); }
    finally {
      saving = false;
      setDisabled(false);
      node('wizard-next').textContent = step === 4 ? '作成して開く' : '次へ';
      node('wizard-next').focus();
    }
  });
}
