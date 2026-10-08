import { showImageComparison } from './imageComparison';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { LaunchCommand } from './types';
interface Revision { id: string; created_at: string; flattened: boolean; requires_review?: boolean }
interface Screenshot { id: string; name: string; adopted: string | null; protected: boolean; edits: Revision[]; usage: string[]; thumbnail: string | null; recipe: unknown }
interface Options {
  root(): string;
  request(action: string, options: Record<string, unknown>, root: string): Promise<string>;
  work(operation: () => Promise<void>): Promise<void>;
  insert(markdown: string): void;
  page(): string | undefined;
  applications(): LaunchCommand[];
}
export function setupScreenshotLibrary(options: Options) {
  const list = document.getElementById('screenshot-library-list')!;
  let generation = 0;
  async function refresh() {
    const root = options.root(), version = ++generation;
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
      const usage = document.createElement('p'); usage.className = 'muted'; usage.textContent = `使用文書: ${shot.usage.join('、') || '未使用'} ／ ${shot.protected ? '保護中' : '編集可能'}${shot.edits.some(edit => edit.requires_review && edit.id !== shot.adopted) ? ' ／ 再撮影候補は寸法と注釈の位置を要確認' : ''}`; card.append(usage);
      const actions = document.createElement('div'); actions.className = 'actions'; card.append(actions);
      function button(label: string, run: () => Promise<void>, disabled = false) { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.disabled = disabled; button.addEventListener('click', () => { void options.work(async () => { if (root !== options.root()) return; await run(); if (root === options.root()) await refresh(); }); }); actions.append(button); }
      button('文書に挿入', async () => {
        const page = options.page(); if (!page) throw new Error('挿入する原稿を開いてください。');
        const markdown = await options.request('screenshots-reference', { id: shot.id, page }, root);
        if (root === options.root() && page === options.page()) options.insert(markdown);
      }, !shot.adopted);
      button('名前を変更', async () => { const name = window.prompt('名前（省略可）', shot.name); if (name !== null) await options.request('screenshots-change', { id: shot.id, json: { name } }, root); });
      button(shot.protected ? '保護を解除' : '画像を保護', async () => { await options.request('screenshots-change', { id: shot.id, json: { protected: !shot.protected } }, root); });
      button('再撮影', async () => { await recapture({ id: shot.id }, root); }, shot.protected || !shot.recipe);
      const versions = document.createElement('select'); versions.setAttribute('aria-label', '画像の編集版');
      for (const edit of [...shot.edits].reverse()) versions.add(new Option(`${edit.id === shot.adopted ? '採用済み' : '候補'} ${edit.created_at}`, edit.id));
      actions.append(versions);
      button('MarkItsで編集', async () => {
        if (!native) throw new Error('MarkIts編集はデスクトップ版で利用できます。');
        const result = await invoke<Handoff>('edit_library_screenshot', { root, id: shot.id, revision: versions.value });
        await watch({ ...result, root, id: shot.id });
      }, shot.protected);
      button('選択版を表示', async () => {
        const loaded = JSON.parse(await options.request('screenshots-image', { id: shot.id, json: { revision: versions.value } }, root));
        if (root !== options.root()) return;
        const images = [{label:'選択版',src:loaded.data}];
        if (shot.thumbnail) images.unshift({label:'採用済み',src:shot.thumbnail});
        await showImageComparison(images, '画像の比較・採用前の確認');
      });
      button('選択版を採用', async () => { if (window.confirm(`${shot.usage.length} 文書で使用する画像を選択版へ更新しますか？\n再撮影候補の場合、寸法と注釈の位置を比較し、必要ならMarkItsで再編集してください。`)) await options.request('screenshots-change', { id: shot.id, json: { adopt: versions.value, expected_revision: shot.adopted } }, root); }, shot.protected);
      button('削除', async () => { if (window.confirm('この画像を管理領域から削除しますか？')) await options.request('screenshots-change', { id: shot.id, json: { delete: true } }, root); }, shot.protected || shot.usage.length > 0);
      if (shot.edits.some(edit => edit.flattened)) { const warning = document.createElement("p"); warning.textContent = "平坦化画像からの取り込みです。失われた画素や注釈の編集状態は復元できません。"; card.append(warning); }
      list.append(card);
    }
  }
  async function recapture(json: Record<string, unknown>, root = options.root()) {
    const plan = JSON.parse(await options.request('screenshots-recapture-plan', typeof json.id === 'string' ? { id: json.id } : {}, root)) as { items: { status: string; reason: string | null }[] };
    const ready = plan.items.filter(item => item.status === 'pending').length;
    if (!window.confirm(`再撮影: ${ready}件、対象外: ${plan.items.length - ready}件\n${plan.items.filter(item => item.reason).map(item => item.reason).join('\n')}\n順番にアプリを操作します。採用済みの画像は保持されます。`)) return;
    const run = JSON.parse(await options.request('screenshots-recapture', { json }, root));
    if (root !== options.root()) return;
    await refresh();
    const failures = run.items.filter((item: {status: string}) => item.status === 'failed');
    if (failures.length && window.confirm(`${failures.length}件の再撮影に失敗しました。失敗分だけ再試行しますか？`)) {
      await options.request('screenshots-recapture', { json: { run: run.id, retry_failed: true } }, root); await refresh();
    }
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
  document.getElementById('screenshot-library-cancel')!.addEventListener('click', () => { void options.request('agent-cancel', {}, options.root()); });
  document.getElementById('screenshot-library-history')!.addEventListener('click', () => { void options.work(async () => {
    const root=options.root(); const history=JSON.parse(await options.request('screenshots-recapture-history',{},root)) as {runs:{id:string;created_at:string;items:{id:string;status:string;reason:string|null;revision:string|null}[]}[]};
    const dialog=document.createElement('dialog');dialog.className='recapture-history';
    const close=document.createElement('button');close.textContent='閉じる';close.onclick=()=>dialog.close();dialog.append(close);
    for(const run of history.runs){const card=document.createElement('article');card.className='card';const title=document.createElement('h2');title.textContent=run.created_at;card.append(title);
      for(const item of run.items){const line=document.createElement('p');line.textContent=`${item.id}: ${item.status} ${item.reason||''}`;card.append(line);}
      const resume=document.createElement('button');resume.textContent='未完了を再開';resume.onclick=()=>{dialog.close();void options.work(async()=>{await options.request('screenshots-recapture',{json:{run:run.id}},root);if(root===options.root())await refresh();});};card.append(resume);
      const retry=document.createElement('button');retry.textContent='失敗だけ再試行';retry.onclick=()=>{dialog.close();void options.work(async()=>{await options.request('screenshots-recapture',{json:{run:run.id,retry_failed:true}},root);if(root===options.root())await refresh();});};card.append(retry);
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
  function persist() { localStorage.setItem(pendingKey, JSON.stringify(pending)); }
  async function watch(session: Pending) {
    if (!pending.some(item => item.completionFile === session.completionFile)) { pending.push(session); persist(); }
    if (watching.has(session.completionFile)) return;
    watching.add(session.completionFile);
    const poll = async () => {
      try {
        const scene = await invoke<string | null>('markits_annotation_ready', { ...session });
        if (scene === null) { setTimeout(() => { void poll(); }, 800); return; }
        await invoke('import_library_capture', { root: session.root, id: session.id, revision: session.revision || null, imageFile: session.annotationFile });
        pending = pending.filter(item => item.completionFile !== session.completionFile); persist(); watching.delete(session.completionFile);
        if (session.root === options.root()) { progress.textContent = '編集内容を画像一覧へ保存しました。'; await refresh(); }
      } catch (error) { watching.delete(session.completionFile); if (session.root === options.root()) progress.textContent = `${String(error)} 編集内容を保持しています。「編集結果を再確認」で再試行できます。`; }
    };
    void poll();
  }
  if (native) for (const session of pending) void watch(session);
  document.getElementById('screenshot-library-retry')!.addEventListener('click', () => { if (native) for (const session of pending) void watch(session); });
  let recording: {root: string; id: string} | null = null;
  async function accept(result: Handoff & { screenshotId: string; markitsStarted: boolean; message: string }) {
    if (!recording) return;
    const owner = recording; recording = null;
    progress.textContent = result.message;
    if (result.markitsStarted) await watch({ ...result, ...owner, id: result.screenshotId });
    if (owner.root === options.root()) await refresh();
  }
  if (native) void listen<Handoff & { screenshotId: string; markitsStarted: boolean; message: string }>('manual-studio-screenshot-finished', event => { void accept(event.payload); });
  document.getElementById('screenshot-library-record')!.addEventListener('click', () => { void options.work(async () => {
    if (!native) throw new Error('操作の記録はデスクトップ版で利用できます。');
    const root = options.root(); if (!root) throw new Error('プロジェクトを開いてください。');
    const profiles = options.applications(); if (!profiles.length) throw new Error('設定の「対象アプリ」でアプリを登録してください。');
    const dialog = document.createElement('dialog'); const select = document.createElement('select'); select.setAttribute('aria-label', '撮影する対象アプリ');
    profiles.forEach((profile, index) => select.add(new Option(profile.name || profile.program, String(index))));
    const start = document.createElement('button'); start.textContent = '記録を開始'; const cancel = document.createElement('button'); cancel.textContent = 'キャンセル';
    cancel.onclick = () => dialog.close();
    start.onclick = () => { void options.work(async () => {
      const profile = profiles[Number(select.value)]; const id = `shot-${crypto.randomUUID()}`;
      if (root !== options.root()) return;
      await invoke('start_operation_recording', { root, program: profile.program, args: [...profile.args], windowTitle: '', taskId: id, markitsProgram: '' });
      recording = {root,id}; dialog.close(); progress.textContent = '記録中です。操作が終わったら撮影ボタンを押してください。';
      await invoke('show_recording_control');
    }); };
    dialog.append(select,start,cancel); dialog.addEventListener('close',()=>dialog.remove()); document.body.append(dialog); dialog.showModal();
  }); });
  document.getElementById('screenshot-library-stop')!.addEventListener('click', () => { void options.work(async () => {
    if (!recording) return;
    await invoke('hide_manual_studio');
    try { const result = await invoke<Handoff & {screenshotId:string;markitsStarted:boolean;message:string}>('finish_operation_recording'); await accept(result); }
    finally { await invoke('restore_manual_studio'); await invoke('close_recording_control'); }
  }); });
  const input = document.getElementById('screenshot-library-import') as HTMLInputElement;
  input.addEventListener('change', () => {
    const file = input.files?.[0], root = options.root(); input.value = ''; if (!file) return;
    void options.work(async () => {
      const source = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
      await options.request('screenshots-register', { json: { source, name: file.name.replace(/\.png$/i, ''), import: true } }, root);
      if (root === options.root()) await refresh();
    });
  });
  document.getElementById('screenshot-library-refresh')!.addEventListener('click', () => { void options.work(refresh); });
  return { refresh };
}
