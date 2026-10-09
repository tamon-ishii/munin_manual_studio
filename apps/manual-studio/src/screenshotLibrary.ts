import { featureDialog } from './screenshotWorkflow';
import { showImageComparison } from './imageComparison';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { LaunchCommand } from './types';
interface Revision { id: string; created_at: string; flattened: boolean; requires_review?: boolean }
interface Screenshot { capture_id?: string; id: string; name: string; adopted: string | null; protected: boolean; edits: Revision[]; usage: string[]; thumbnail: string | null; recipe: unknown }
interface Options {
  root(): string;
  request(action: string, options: Record<string, unknown>, root: string): Promise<string>;
  work(operation: () => Promise<void>): Promise<void>;
  insert(markdown: string): void;
  page(): string | undefined;
  chooseDestination(): Promise<boolean>;
  openPage(page:string): Promise<void>;
  applications(): LaunchCommand[];
}
export function setupScreenshotLibrary(options: Options) {
  const list = document.getElementById('screenshot-library-list')!;
  let generation = 0;
  let recording: {root: string; id: string} | null = null;
  async function refresh() {
    const root = options.root(), version = ++generation;
    updateControls();
    if (recaptureOwnerRoot && recaptureOwnerRoot !== root) recaptureStatus.textContent = "";
    if (!root) { list.textContent = 'プロジェクトを開いてください。'; return; }
    const result = JSON.parse(await options.request('screenshots-list', {}, root)) as { items: Screenshot[] };
    if (root !== options.root() || version !== generation) return;
    result.items ||= [];
    list.replaceChildren();
    if (!result.items.length) list.textContent = '画像を取り込むと、ここから原本と編集版を管理できます。';
    for (const shot of result.items) {
      const card = document.createElement('article'); card.className = 'card screenshot-library-card';
      const title = document.createElement('h2'); title.textContent = shot.name || 'スクリーンショット'; card.append(title);
      if (shot.thumbnail) { const image = document.createElement('img'); image.src = shot.thumbnail; image.alt = title.textContent; card.append(image); }
      const usage = document.createElement('p'); usage.className = 'muted'; usage.textContent = `${shot.usage.length ? `使用: ${shot.usage.join('、')}` : '未使用'}${shot.protected ? ' ／ 保護中' : ''}${shot.edits.some(edit => edit.requires_review && edit.id !== shot.adopted) ? ' ／ 再撮影候補あり' : ''}`; card.append(usage);
      const sharedCount = result.items.filter(item => (item.capture_id || item.id) === (shot.capture_id || shot.id)).length;
      if (sharedCount > 1) { const shared = document.createElement('p'); shared.className = 'muted'; shared.textContent = `原本を共有：${sharedCount}画像 ／ 撮影1回`; card.append(shared); }
      const actions = document.createElement('div'); actions.className = 'actions screenshot-primary-actions'; card.append(actions);
      const management = document.createElement('details'); management.className = 'screenshot-management';
      const managementTitle = document.createElement('summary'); managementTitle.textContent = '履歴・管理';
      const managementActions = document.createElement('div'); managementActions.className = 'actions';
      management.append(managementTitle, managementActions); card.append(management);
      function button(label: string, run: () => Promise<void>, disabled = false, secondary = false) { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.disabled = disabled; button.addEventListener('click', () => { void options.work(async () => { if (root !== options.root()) return; await run(); if (root === options.root()) await refresh(); }); }); (secondary ? managementActions : actions).append(button); return button; }
      const insertButton = button('文書に挿入', async () => {
        if (!await options.chooseDestination()) return;
        const page = options.page(); if (!page) { progress.textContent = '先に挿入先の原稿を開いてください。'; throw new Error('挿入する原稿を開いてください。'); }
        const markdown = await options.request('screenshots-reference', { id: shot.id, page }, root);
        if (root === options.root() && page === options.page()) options.insert(markdown);
      }, !shot.adopted);
      button('共有関係', async () => {
        const items=(JSON.parse(await options.request('screenshots-list',{},root)) as {items:Screenshot[]}).items;
        const group=items.filter(item=>(item.capture_id||item.id)===(shot.capture_id||shot.id));
        const {body}=featureDialog('共有原本と使用原稿');const source=document.createElement('p');source.textContent=`原本1枚 → 派生画像${group.length}枚 ／ 再撮影1回`;body.append(source);
        for(const item of group){const card=document.createElement('article');card.className='card';const title=document.createElement('h2');title.textContent=item.name||item.id;card.append(title);const usage=document.createElement('p');usage.textContent=item.usage.length?`使用原稿: ${item.usage.join('、')}`:'未使用';card.append(usage);body.append(card);}
      }, false, true);
      button('注釈テンプレートを保存',async()=>{const name=window.prompt('テンプレート名');if(!name?.trim())return;await options.request('screenshots-change',{id:shot.id,json:{save_template:name.trim(),revision:versions.value}},root);progress.textContent='注釈テンプレートを保存しました。';},false,true);
      button('注釈テンプレートを適用',async()=>{
        const templates=JSON.parse(await options.request('screenshots-templates',{},root)) as {items:Array<{id:string;name:string}>};
        const {dialog,body}=featureDialog('注釈テンプレート');const select=document.createElement('select');select.setAttribute('aria-label','注釈テンプレート');for(const template of templates.items)select.add(new Option(template.name,template.id));
        const message=document.createElement('p');message.role='status';if(!templates.items.length)message.textContent='画像の「履歴・管理」からテンプレートを保存してください。';
        const apply=document.createElement('button');apply.type='button';apply.textContent='候補として適用';apply.disabled=!templates.items.length;
        apply.onclick=()=>{void options.work(async()=>{if(root!==options.root())return;try{await options.request('screenshots-change',{id:shot.id,json:{apply_template:select.value,revision:versions.value}},root);dialog.close();progress.textContent='注釈を候補として適用しました。MarkItsで再編集し、確認後に採用できます。';await refresh();}catch(error){message.textContent=String(error);}});};
        const remove=document.createElement('button');remove.type='button';remove.textContent='テンプレートを削除';remove.disabled=!templates.items.length;remove.onclick=()=>{void options.work(async()=>{if(root!==options.root()||!window.confirm('テンプレートを削除しますか？作成済み画像は保持されます。'))return;await options.request('screenshots-change',{id:shot.id,json:{delete_template:select.value}},root);select.selectedOptions[0]?.remove();apply.disabled=remove.disabled=!select.options.length;});};body.append(select,message,apply,remove);
      },shot.protected,true);
      button('名前を変更', async () => { const name = window.prompt('名前（省略可）', shot.name); if (name !== null) await options.request('screenshots-change', { id: shot.id, json: { name } }, root); }, false, true);
      button(shot.protected ? '保護を解除' : '画像を保護', async () => { await options.request('screenshots-change', { id: shot.id, json: { protected: !shot.protected } }, root); }, false, true);
      const recaptureButton = button('再撮影', async () => { await recapture({ id: shot.id }, root); }, shot.protected || !shot.recipe);
      const versions = document.createElement('select'); versions.setAttribute('aria-label', '画像の編集版');
      for (const edit of [...shot.edits].reverse()) versions.add(new Option(`${edit.id === shot.adopted ? '採用済み' : '候補'} ${edit.created_at}`, edit.id));
      managementActions.append(versions);
      const copyButton = button('選択版をコピー', async () => {
        await options.request('screenshots-change', { id: shot.id, json: { copy: true, revision: versions.value } }, root);
        if (root === options.root()) progress.textContent = 'コピーを作成しました。「MarkItsで編集」で注釈を変更できます。';
      });
      const editButton = button('MarkItsで編集', async () => {
        if (!native) throw new Error('MarkIts編集はデスクトップ版で利用できます。');
        const result = await invoke<Handoff>('edit_library_screenshot', { root, id: shot.id, revision: versions.value });
        await watch({ ...result, root, id: shot.id });
      }, shot.protected);
      editButton.classList.add('primary');
      actions.replaceChildren(editButton, copyButton, insertButton, recaptureButton);
      button('選択版を表示', async () => {
        const loaded = JSON.parse(await options.request('screenshots-image', { id: shot.id, json: { revision: versions.value } }, root));
        if (root !== options.root()) return;
        const images = [{label:'選択版',src:loaded.data}];
        if (shot.thumbnail) images.unshift({label:'採用済み',src:shot.thumbnail});
        await showImageComparison(images, '画像の比較・採用前の確認');
      }, false, true);
      button('選択版を採用', async () => { if (window.confirm(`${shot.usage.length} 文書で使用する画像を選択版へ更新しますか？\n再撮影候補の場合、寸法と注釈の位置を比較し、必要ならMarkItsで再編集してください。`)) await options.request('screenshots-change', { id: shot.id, json: { adopt: versions.value, expected_revision: shot.adopted } }, root); }, shot.protected, true);
      button('削除', async () => { if (window.confirm('この画像を管理領域から削除しますか？')) await options.request('screenshots-change', { id: shot.id, json: { delete: true } }, root); }, shot.protected || shot.usage.length > 0, true);
      if (shot.edits.some(edit => edit.flattened)) { const warning = document.createElement("p"); warning.textContent = "平坦化画像からの取り込みです。失われた画素や注釈の編集状態は復元できません。"; card.append(warning); }
      list.append(card);
    }
  }
  const recaptureStatus = document.getElementById('screenshot-recapture-status')!;
  let activeRecaptureRoot: string | null = null;
  let recaptureOwnerRoot: string | null = null;
  let cancellationRequested = false;
  async function executeRecapture(json: Record<string, unknown>, root: string) {
    if (root !== options.root()) return;
    await options.request('agent-progress-clear', {}, root);
    if (root !== options.root()) return;
    activeRecaptureRoot = root; updateControls(); recaptureOwnerRoot = root; cancellationRequested = false;
    const started = Date.now();
    let stopped = false, lastMessage = '撮影手順を準備しています';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = JSON.parse(await options.request('agent-progress', {}, root)) as {logs: {message: string}[]};
        const current = result.logs.at(-1)?.message;
        const image = [...result.logs].reverse().find(entry => /^再撮影 \d+\//.test(entry.message))?.message;
        lastMessage = current ? (image && current !== image ? `${image} ／ ${current}` : current) : lastMessage;
        if (!stopped && root === options.root()) recaptureStatus.textContent = `${cancellationRequested ? "中断要求済み・操作の停止を待っています" : "再撮影中"}（経過 ${Math.floor((Date.now() - started) / 1000)}秒）：${lastMessage}`;
      } catch { /* Keep the last task visible during transient read failures. */ }
      if (!stopped) timer = setTimeout(() => { void poll(); }, 700);
    };
    recaptureStatus.textContent = '再撮影を開始しました。撮影手順を準備しています。';
    void poll();
    try {
      const run = JSON.parse(await options.request('screenshots-recapture', {json}, root)) as {id: string; items: {status: string; reason?: string}[]};
      stopped = true; clearTimeout(timer);
      if (root === options.root()) {
        const count = (status: string) => run.items.filter(item => item.status === status).length;
        const interrupted = count('cancelled') > 0 || count('pending') > 0;
        recaptureStatus.textContent = `再撮影${interrupted ? 'を中断しました' : 'が完了しました'}。成功 ${count('succeeded')}件・失敗 ${count('failed')}件・未完了 ${count('cancelled') + count('pending')}件・対象外 ${count('skipped')}件。成功した画像は候補として保存しました。比較して採用してください。`;
        await refresh();
      }
      return run;
    } catch (error) {
      if (root === options.root()) recaptureStatus.textContent = `再撮影に失敗しました：${String(error)}`;
      throw error;
    } finally {
      stopped = true; clearTimeout(timer); activeRecaptureRoot = null; updateControls();
    }
  }
  async function recapture(json: Record<string, unknown>, root = options.root()) {
    const plan = JSON.parse(await options.request('screenshots-recapture-plan', typeof json.id === 'string' ? {id: json.id} : {}, root)) as {items: {status: string; reason: string | null}[]; capture_count?: number};
    if (root !== options.root()) return;
    const ready = plan.items.filter(item => item.status === 'pending').length;
    if (!ready) { recaptureStatus.textContent = '再撮影できる画像がありません。撮影手順と保護状態を確認してください。'; return; }
    if (!window.confirm(`撮影: ${plan.capture_count ?? ready}回 ／ 注釈画像: ${ready}件、対象外: ${plan.items.length - ready}件\n同じ原本は1回だけ撮影し、各画像の注釈・クロップを適用します。採用済みの画像は保持されます。`)) return;
    const run = await executeRecapture(json, root);
    if (!run || root !== options.root()) return;
    const failures = run.items.filter(item => item.status === 'failed');
    if (failures.length && window.confirm(`${failures.length}件の再撮影に失敗しました。失敗分だけ再試行しますか？`)) await executeRecapture({run: run.id, retry_failed: true}, root);
  }
  document.getElementById('screenshot-library-recapture-all')!.addEventListener('click', () => { void options.work(() => recapture({})); });
  document.getElementById('screenshot-library-migrate')!.addEventListener('click', () => { void options.work(async () => {
    const root = options.root(); const plan = JSON.parse(await options.request('screenshots-migration-plan', {}, root)) as {pages:{page:string;revision:string;items:{id:string;flattened?:boolean;error?:string}[]}[]};
    if (!plan.pages.length) { window.alert('移行する旧撮影タグはありません。'); return; }
    const details=plan.pages.map(page => `${page.page}: ${page.items.map(item => item.error || (item.flattened ? '平坦化画像' : '原本あり')).join('、')}`).join('\n');
    if (!window.confirm(`旧撮影タグを画像参照へ移行します。原稿のバックアップを保存します。\n${details}`)) return;
    if (root !== options.root()) return;
    for (const page of plan.pages) await options.request('screenshots-migrate', {page:page.page,json:page}, root);
    if (root === options.root()) await refresh();
  }); });
  document.getElementById('screenshot-library-cancel')!.addEventListener('click', () => { if (activeRecaptureRoot) { cancellationRequested = true; recaptureStatus.textContent = '中断を要求しました。実行中の操作が停止するまでお待ちください。'; void options.request('agent-cancel', {}, activeRecaptureRoot).catch(error => { recaptureStatus.textContent = `中断要求に失敗しました：${String(error)}`; }); } });
  document.getElementById('screenshot-library-history')!.addEventListener('click', () => { void options.work(async () => {
    const root=options.root(); const history=JSON.parse(await options.request('screenshots-recapture-history',{},root)) as {runs:{id:string;created_at:string;items:{id:string;status:string;reason:string|null;revision:string|null}[]}[]};
    const dialog=document.createElement('dialog');dialog.className='recapture-history';
    const close=document.createElement('button');close.textContent='閉じる';close.onclick=()=>dialog.close();dialog.append(close);
    for(const run of history.runs){const card=document.createElement('article');card.className='card';const title=document.createElement('h2');title.textContent=run.created_at;card.append(title);
      for(const item of run.items){const line=document.createElement('p');line.textContent=`${item.id}: ${item.status} ${item.reason||''}`;card.append(line);}
      const resume=document.createElement('button');resume.textContent='未完了を再開';resume.onclick=()=>{dialog.close();void options.work(async()=>{await executeRecapture({run:run.id},root);if(root===options.root())await refresh();});};card.append(resume);
      const retry=document.createElement('button');retry.textContent='失敗だけ再試行';retry.onclick=()=>{dialog.close();void options.work(async()=>{await executeRecapture({run:run.id,retry_failed:true},root);if(root===options.root())await refresh();});};card.append(retry);
      const adopt=document.createElement('button');adopt.textContent='成功分を採用';adopt.onclick=()=>{if(!window.confirm('各候補の寸法と注釈の位置を比較しましたか？成功した候補を採用し、使用する全原稿へ反映します。'))return;dialog.close();void options.work(async()=>{for(const item of run.items)if(item.status==='succeeded'&&item.revision)await options.request('screenshots-change',{id:item.id,json:{adopt:item.revision}},root);if(root===options.root())await refresh();});};card.append(adopt);dialog.append(card);
    }
    dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();
  }); });
  const native = '__TAURI_INTERNALS__' in window;
  interface Handoff { sourceFile: string; annotationFile: string; completionFile: string; revision?: string }
  interface Pending extends Handoff { root: string; id: string }
  const progress = document.getElementById('screenshot-library-status')!;
  const pendingKey = 'manual-library-handoffs';
  let pending: Pending[] = [];
  try { pending = JSON.parse(localStorage.getItem(pendingKey) || '[]'); } catch { /* No saved sessions. */ }
  const watching = new Set<string>();
  function updateControls() {
    const root = options.root();
    document.getElementById('screenshot-library-record')!.hidden = Boolean(recording);
    document.getElementById('screenshot-library-stop')!.hidden = !recording || recording.root !== root;
    document.getElementById('screenshot-library-cancel')!.hidden = activeRecaptureRoot !== root;
    document.getElementById('screenshot-library-retry')!.hidden = !pending.some(session => session.root === root && !watching.has(session.completionFile));
  }
  function persist() { localStorage.setItem(pendingKey, JSON.stringify(pending)); updateControls(); }
  async function watch(session: Pending) {
    if (!pending.some(item => item.completionFile === session.completionFile)) { pending.push(session); persist(); }
    if (watching.has(session.completionFile)) return;
    watching.add(session.completionFile); updateControls();
    const poll = async () => {
      try {
        const scene = await invoke<string | null>('markits_annotation_ready', { ...session });
        if (scene === null) { setTimeout(() => { void poll(); }, 800); return; }
        await invoke('import_library_capture', { root: session.root, id: session.id, revision: session.revision || null, imageFile: session.annotationFile });
        pending = pending.filter(item => item.completionFile !== session.completionFile); persist(); watching.delete(session.completionFile);
        updateControls();
        if (session.root === options.root()) { progress.textContent = '編集内容を画像一覧へ保存しました。'; await refresh(); }
      } catch (error) { watching.delete(session.completionFile); updateControls(); if (session.root === options.root()) progress.textContent = `${String(error)} 編集内容を保持しています。「編集結果を再確認」で再試行できます。`; }
    };
    void poll();
  }
  if (native) for (const session of pending) void watch(session);
  document.getElementById('screenshot-library-retry')!.addEventListener('click', () => { if (native) for (const session of pending) void watch(session); });
  async function accept(result: Handoff & { screenshotId: string; markitsStarted: boolean; message: string }) {
    if (!recording) return;
    const owner = recording; recording = null; updateControls();
    progress.textContent = result.message;
    if (result.markitsStarted) await watch({ ...result, ...owner, id: result.screenshotId });
    if (owner.root === options.root()) await refresh();
  }
  if (native) void listen<Handoff & { screenshotId: string; markitsStarted: boolean; message: string }>('manual-studio-screenshot-finished', event => { void accept(event.payload); });
  document.getElementById('screenshot-library-diagnose')!.addEventListener('click',()=>{void options.work(async()=>{
    const root=options.root();if(!root)throw new Error('プロジェクトを開いてください。');
    const report=JSON.parse(await options.request('screenshots-diagnose',{},root)) as {environment:string[];items:Array<{name:string;status:string;checks:string[]}>;capture_count:number};
    if(root!==options.root())return;const {body}=featureDialog('再撮影の事前診断');const count=document.createElement('p');count.textContent=`実撮影 ${report.capture_count}回`;body.append(count);
    for(const issue of report.environment){const line=document.createElement('p');line.textContent=issue;body.append(line);}
    for(const item of report.items){const card=document.createElement('article');card.className='card';const title=document.createElement('h2');title.textContent=`${item.name}：${item.status==='ready'?'準備完了':'要確認'}`;card.append(title);for(const check of item.checks){const line=document.createElement('p');line.textContent=check;card.append(line);}body.append(card);}
  });});
  document.getElementById('screenshot-library-record')!.addEventListener('click', () => { void options.work(async () => {
    if (!native) throw new Error('操作の記録はデスクトップ版で利用できます。');
    const root = options.root(); if (!root) throw new Error('プロジェクトを開いてください。');
    const profiles = options.applications(); if (!profiles.length) throw new Error('「アプリ登録」で撮影するアプリを登録してください。');
    const dialog = document.createElement('dialog'); dialog.className = 'capture-application-dialog';
    const heading = document.createElement('h2'); heading.textContent = '撮影するアプリ';
    const field = document.createElement('label'); field.textContent = '登録済みアプリ';
    const actions = document.createElement('div'); actions.className = 'actions';
    const select = document.createElement('select'); select.setAttribute('aria-label', '撮影する対象アプリ');
    profiles.forEach((profile, index) => select.add(new Option(profile.name || profile.program, String(index))));
    const start = document.createElement('button'); start.textContent = '記録を開始'; const cancel = document.createElement('button'); cancel.textContent = 'キャンセル';
    cancel.onclick = () => dialog.close();
    start.onclick = () => { void options.work(async () => {
      const profile = profiles[Number(select.value)]; const id = `shot-${crypto.randomUUID()}`;
      if (root !== options.root()) return;
      await invoke('start_operation_recording', { root, program: profile.program, args: [...profile.args], windowTitle: '', taskId: id, markitsProgram: '' });
      recording = {root,id}; updateControls(); dialog.close(); progress.textContent = '記録中です。操作が終わったら撮影ボタンを押してください。';
      await invoke('show_recording_control');
    }); };
    field.append(select); actions.append(cancel,start); start.className = "primary"; dialog.append(heading,field,actions); dialog.addEventListener('close',()=>dialog.remove()); document.body.append(dialog); dialog.showModal();
  }); });
  document.getElementById('screenshot-library-stop')!.addEventListener('click', () => { void options.work(async () => {
    if (!recording) return;
    await invoke('hide_manual_studio');
    try { const result = await invoke<Handoff & {screenshotId:string;markitsStarted:boolean;message:string}>('finish_operation_recording'); await accept(result); }
    finally { await invoke('restore_manual_studio'); await invoke('close_recording_control'); }
  }); });
  const input = document.getElementById('screenshot-library-import') as HTMLInputElement;
  document.getElementById('screenshot-library-import-button')!.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files?.[0], root = options.root(); input.value = ''; if (!file) return;
    void options.work(async () => {
      const source = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
      await options.request('screenshots-register', { json: { source, name: file.name.replace(/\.png$/i, ''), import: true } }, root);
      if (root === options.root()) await refresh();
    });
  });
  document.getElementById('screenshot-library-refresh')!.addEventListener('click', () => { void options.work(refresh); });
  updateControls();
  return { refresh };
}
