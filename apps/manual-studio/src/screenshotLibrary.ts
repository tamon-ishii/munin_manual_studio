import {stageLabels} from './operationTimings';
import {setupResourceBrowser, type Resource, type ResourceUsage} from './resourceBrowser';
import type {ImageGenerationEntry} from './imageGeneration';
import { featureDialog,confirmAction,requestText } from './screenshotWorkflow';
import { showImageComparison } from './imageComparison';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { LaunchCommand } from './types';
interface Revision { id: string; created_at: string; flattened: boolean; requires_review?: boolean; scene?: unknown }
const sceneCount = (scene: unknown): number | undefined => { const list = Array.isArray(scene) ? scene : (scene as { annotations?: unknown } | null | undefined)?.annotations; return Array.isArray(list) ? list.length : undefined; };
interface Screenshot { output: string; capture_id?: string; id: string; name: string; adopted: string | null; protected: boolean; edits: Revision[]; usage: string[]; thumbnail: string | null; recipe: unknown }
interface Options {
  root(): string;
  refreshAssets(root:string):Promise<void>;
  request(action: string, options: Record<string, unknown>, root: string): Promise<string>;
  work(operation: () => Promise<void>): Promise<void>;
  insert(markdown: string): void;
  page(): string | undefined;
  chooseDestination(): Promise<boolean>;
  openPage(page:string): Promise<void>;
  applications(): LaunchCommand[];
  insertAsset(path:string):Promise<boolean>;
  openImage(path:string):Promise<void>;
  editImage(path:string):Promise<void>;
  openUsage(usage:ResourceUsage):Promise<void>;
  generateImage(entry:ImageGenerationEntry,edit:boolean):Promise<void>;
  annotateScreenshot(id:string):Promise<void>;
}
export function setupScreenshotLibrary(options: Options) {
  const list = document.getElementById('screenshot-library-list')!;
  let generation = 0;
  let recording: {root: string; id: string; ready?: (id:string)=>void; failed?:()=>void;cancelled?:()=>void;stage?:(stage:string)=>void} | null = null;
  let currentShots:Screenshot[]=[];
  const editStates=new Map<string,string>();
  function editState(root:string,id:string,message:string){
    editStates.set(JSON.stringify([root,id]),message);
    for(const card of list.querySelectorAll<HTMLElement>('[data-screenshot-id]'))if(card.dataset.screenshotId===id&&root===options.root()){const status=card.querySelector<HTMLElement>('.screenshot-edit-status');if(status)status.textContent=message;}
  }
  const resources=setupResourceBrowser({...options,refresh},()=>render(options.root()));
  async function refresh(refreshAssets = true) {
    const root = options.root(), version = ++generation;
    updateControls();
    if (recaptureOwnerRoot && recaptureOwnerRoot !== root) recaptureStatus.textContent = "";
    if (!root) { list.textContent = 'プロジェクトを開いてください。'; return; }
    const resourceResult=JSON.parse(await options.request('resources-list',{},root)) as {items:Resource[];screenshots?:{items:Screenshot[]}};
    const result=resourceResult.screenshots||JSON.parse(await options.request('screenshots-list',{},root)) as {items:Screenshot[]};
    if (root !== options.root() || version !== generation) return;
    currentShots=result.items||[];resources.setItems(resourceResult.items||[]);render(root);if(refreshAssets)await options.refreshAssets?.(root);
  }
  function render(root:string){
    const result={items:currentShots};resources.captureViews(list);list.replaceChildren();
    for (const shot of result.items) {
      if(!resources.matchesShot(shot.output,{path:shot.output||'',name:shot.name,kind:shot.recipe?'screenshot':'imported',usages:shot.usage.map(page=>({page,line:1,start:0,end:0,snippet:''}))}))continue;
      const card = document.createElement('article'); card.className = 'card screenshot-library-card';card.dataset.screenshotId=shot.id;
      const title = document.createElement('h2'); title.textContent = shot.name || '画像'; card.append(title);resources.decorateShot(card,shot.output);
      if (shot.thumbnail) { const image = document.createElement('img'); image.src = shot.thumbnail; image.alt = title.textContent; image.draggable=Boolean(shot.adopted);image.title='ドラッグして原稿に挿入';card.append(image); }
      const usage = document.createElement('p'); usage.className = 'muted'; usage.textContent = `${card.querySelector('.resource-usages') ? '' : shot.usage.length ? `使用: ${shot.usage.join('、')}` : '未使用'}${shot.protected ? ' 保護中' : ''}${shot.edits.some(edit => edit.requires_review && edit.id !== shot.adopted) ? ' 再撮影候補あり' : ''}`.trim(); if(usage.textContent)card.append(usage);
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
      button('注釈テンプレートを保存',async()=>{const name=await requestText('テンプレート名');if(!name?.trim())return;await options.request('screenshots-change',{id:shot.id,json:{save_template:name.trim(),revision:versions.value}},root);progress.textContent='注釈テンプレートを保存しました。';},false,true);
      button('注釈テンプレートを適用',async()=>{
        const templates=JSON.parse(await options.request('screenshots-templates',{},root)) as {items:Array<{id:string;name:string}>};
        const {dialog,body}=featureDialog('注釈テンプレート');const select=document.createElement('select');select.setAttribute('aria-label','注釈テンプレート');for(const template of templates.items)select.add(new Option(template.name,template.id));
        const message=document.createElement('p');message.role='status';if(!templates.items.length)message.textContent='画像の「履歴・管理」からテンプレートを保存してください。';
        const apply=document.createElement('button');apply.type='button';apply.textContent='候補として適用';apply.disabled=!templates.items.length;
        apply.onclick=()=>{void options.work(async()=>{if(root!==options.root())return;try{await options.request('screenshots-change',{id:shot.id,json:{apply_template:select.value,revision:versions.value}},root);dialog.close();progress.textContent='注釈を候補として適用しました。MarkItsで再編集し、確認後に採用できます。';await refresh();}catch(error){message.textContent=String(error);}});};
        const remove=document.createElement('button');remove.type='button';remove.textContent='テンプレートを削除';remove.disabled=!templates.items.length;remove.onclick=()=>{void options.work(async()=>{if(root!==options.root()||!await confirmAction('テンプレートを削除しますか？作成済み画像は保持されます。'))return;await options.request('screenshots-change',{id:shot.id,json:{delete_template:select.value}},root);select.selectedOptions[0]?.remove();apply.disabled=remove.disabled=!select.options.length;});};body.append(select,message,apply,remove);
      },shot.protected,true);
      button('名前を変更', async () => { const name = await requestText('名前（省略可）', shot.name); if (name !== null) await options.request('screenshots-change', { id: shot.id, json: { name } }, root); }, false, true);
      button(shot.protected ? '保護を解除' : '画像を保護', async () => { await options.request('screenshots-change', { id: shot.id, json: { protected: !shot.protected } }, root); }, false, true);
      const recaptureButton = button('再撮影', async () => { await recapture({ id: shot.id }, root); }, shot.protected || !shot.recipe);
      const versions = document.createElement('select'); versions.setAttribute('aria-label', '画像の編集版');
      for (const edit of [...shot.edits].reverse()) versions.add(new Option(`${edit.id === shot.adopted ? '採用済み' : '候補'} ${edit.created_at}`, edit.id));
      managementActions.append(versions);
      const copyButton = button('コピー', async () => {
        await options.request('screenshots-change', { id: shot.id, json: { copy: true, revision: versions.value } }, root);
        if (root === options.root()) progress.textContent = 'コピーを作成しました。「編集」で注釈を変更できます。';
      });
      const editStatus=document.createElement('p');editStatus.role='status';editStatus.className='screenshot-edit-status';editStatus.textContent=editStates.get(JSON.stringify([root,shot.id]))||'';card.append(editStatus);
      const editButton = button('編集', async () => {
        if (!native) throw new Error('MarkIts編集はデスクトップ版で利用できます。');
        editState(root,shot.id,'MarkItsを起動しています…');
        try {
          await editManaged(shot.id, versions.value, root);
          editState(root,shot.id,'MarkItsで編集中です。「編集終了（Manual Studioへ返す）」で候補を保存します。');
        } catch(error) { editState(root,shot.id,`MarkItsを開けませんでした。${String(error)} 再度「編集」で試せます。`); throw error; }
      }, shot.protected||pending.some(session=>session.root===root&&session.id===shot.id&&watching.has(session.completionFile)));
      editButton.classList.add('primary');
      actions.replaceChildren(editButton, copyButton, insertButton, recaptureButton);
      const aiEdit=document.createElement('button');aiEdit.type='button';aiEdit.textContent='AIで注釈';aiEdit.disabled=shot.protected||!shot.edits.length;
      aiEdit.onclick=()=>{if(root===options.root())void options.annotateScreenshot(shot.id);};actions.append(aiEdit);
      const adoptSelected = async (): Promise<boolean> => {
        if (!await confirmAction(`${shot.usage.length} 文書で使用する画像を選択版へ更新しますか？\n再撮影候補の場合、寸法と注釈の位置を比較し、必要ならMarkItsで再編集してください。`)) return false;
        await options.request('screenshots-change', { id: shot.id, json: { adopt: versions.value, expected_revision: shot.adopted } }, root);
        return true;
      };
      button('選択版を表示', async () => {
        const loaded = JSON.parse(await options.request('screenshots-image', { id: shot.id, json: { revision: versions.value } }, root));
        if (root !== options.root()) return;
        const selectedId = versions.value;
        const images = [{label:'選択版',src:loaded.data,sceneCount:sceneCount(shot.edits.find(edit=>edit.id===selectedId)?.scene)}];
        if (shot.thumbnail) images.unshift({label:'採用済み',src:shot.thumbnail,sceneCount:sceneCount(shot.edits.find(edit=>edit.id===shot.adopted)?.scene)});
        const alreadyAdopted = selectedId === shot.adopted;
        // Comparison closes without touching the card; adoption is offered here so no panel round-trip is needed.
        await showImageComparison(images, '画像の比較・採用前の確認', true, { label: alreadyAdopted ? '採用済みの版です' : '選択版を採用', disabled: shot.protected || alreadyAdopted, run: adoptSelected });
      }, false, true);
      button('選択版を採用', async () => { await adoptSelected(); }, shot.protected, true);
      button('削除', async () => { if (await confirmAction('この画像を管理領域から削除しますか？')) await options.request('screenshots-change', { id: shot.id, json: { delete: true } }, root); }, shot.protected || shot.usage.length > 0, true);
      if (shot.edits.some(edit => edit.flattened)) { const warning = document.createElement("p"); warning.textContent = "平坦化画像からの取り込みです。失われた画素や注釈の編集状態は復元できません。"; card.append(warning); }
      resources.compactCard(card,shot.usage.length);list.append(card);
    }
    resources.renderExtras(list,root);
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
    if (!await confirmAction(`撮影: ${plan.capture_count ?? ready}回 ／ 注釈画像: ${ready}件、対象外: ${plan.items.length - ready}件\n同じ原本は1回だけ撮影し、各画像の注釈・クロップを適用します。採用済みの画像は保持されます。`)) return;
    const run = await executeRecapture(json, root);
    if (!run || root !== options.root()) return;
    const failures = run.items.filter(item => item.status === 'failed');
    if (failures.length && await confirmAction(`${failures.length}件の再撮影に失敗しました。失敗分だけ再試行しますか？`)) await executeRecapture({run: run.id, retry_failed: true}, root);
  }
  document.getElementById('screenshot-library-recapture-all')!.addEventListener('click', () => { void options.work(() => recapture({})); });
  document.getElementById('screenshot-library-cancel')!.addEventListener('click', () => { if (activeRecaptureRoot) { cancellationRequested = true; recaptureStatus.textContent = '中断を要求しました。実行中の操作が停止するまでお待ちください。'; void options.request('agent-cancel', {}, activeRecaptureRoot).catch(error => { recaptureStatus.textContent = `中断要求に失敗しました：${String(error)}`; }); } });
  const native = '__TAURI_INTERNALS__' in window;
  interface Handoff { sourceFile: string; annotationFile: string; completionFile: string; revision?: string }
  interface Pending extends Handoff { root: string; id: string }
  const progress = document.getElementById('screenshot-library-status')!;
  const pendingKey = 'manual-library-handoffs';
  let pending: Pending[] = [];
  try { pending = JSON.parse(localStorage.getItem(pendingKey) || '[]'); } catch { /* No saved sessions. */ }
  const watching = new Set<string>();
  const handoffCallbacks=new Map<string,(id:string)=>void>();
  const handoffProgress=new Map<string,(stage:string)=>void>();
  function updateControls() {
    const root = options.root();
    document.getElementById('screenshot-library-record')!.hidden = Boolean(recording);
    document.getElementById('screenshot-library-stop')!.hidden = !recording || recording.root !== root;
    document.getElementById('screenshot-library-cancel')!.hidden = activeRecaptureRoot !== root;
    document.getElementById('screenshot-library-retry')!.hidden = !pending.some(session => session.root === root && !watching.has(session.completionFile));
  }
  function persist() { localStorage.setItem(pendingKey, JSON.stringify(pending)); updateControls(); }
  async function watch(session: Pending,ready?: (id:string)=>void,stage?: (stage:string)=>void) {
    if(stage)handoffProgress.set(session.completionFile,stage);
    if(ready)handoffCallbacks.set(session.completionFile,ready);
    if (!pending.some(item => item.completionFile === session.completionFile)) { pending.push(session); persist(); }
    if (watching.has(session.completionFile)) return;
    watching.add(session.completionFile); updateControls();
    const poll = async () => {
      let importStarted:number|undefined;
      try {
        const scene = await invoke<string | null>('markits_annotation_ready', { ...session });
        if (scene === null) { setTimeout(() => { void poll(); }, 200); return; }
        const notify=handoffProgress.get(session.completionFile);notify?.('import');
        if(session.root===options.root())progress.textContent=stageLabels.import;
        if(session.root===options.root())await invoke('restore_manual_studio').catch(error=>console.warn('画面に戻れません',error));
        importStarted=performance.now();
        const imported=await invoke<string>('import_library_capture', { root: session.root, id: session.id, revision: session.revision || null, imageFile: session.annotationFile });
        const details=JSON.parse(imported||'{}') as {timings?:Array<{stage:string;duration_ms:number}>};
        const durations=details.timings?.length?details.timings:[{stage:'import',duration_ms:performance.now()-importStarted}];
        // Timing persistence does not delay insertion or invalidate a saved edit.
        void options.request('operation-timings-record',{json:{operation:'markits-import',outcome:'success',stages:durations}},session.root).catch(error=>console.warn('処理時間を記録できません',error));
        notify?.('restore');
        handoffProgress.delete(session.completionFile);
        pending = pending.filter(item => item.completionFile !== session.completionFile); persist(); watching.delete(session.completionFile);
        updateControls();
        const complete=handoffCallbacks.get(session.completionFile);handoffCallbacks.delete(session.completionFile);
        if (session.root === options.root()) {
          editState(session.root,session.id,'編集内容を候補として保存しました。「履歴・管理」で比較し、採用できます。');progress.textContent = '編集内容を画像一覧へ保存しました。';
          // Insertion refreshes the library after saving the document. Do not
          // delay its preview with a full library scan and editor image reload.
          if (!complete) await refresh();
          await invoke('restore_manual_studio').catch(error=>console.warn('画面に戻れません',error));
        }
        complete?.(session.id);
      } catch (error) {
        if(importStarted!==undefined)void options.request('operation-timings-record',{json:{operation:'markits-import',outcome:'error',stages:[{stage:'import',duration_ms:performance.now()-importStarted}]}},session.root).catch(error=>console.warn('処理時間を記録できません',error));
        watching.delete(session.completionFile);
        const message=String(error);
        const ended=message.includes('MarkItsの編集を中止しました')||message.includes('MarkItsが編集完了前に終了しました');
        if(ended){handoffProgress.get(session.completionFile)?.('cancelled');handoffProgress.delete(session.completionFile);pending=pending.filter(item=>item.completionFile!==session.completionFile);handoffCallbacks.delete(session.completionFile);persist();}
        updateControls();
        if(session.root===options.root()){
          const feedback=ended?`${message} 再度「編集」で開始できます。`:`${message} 編集内容を保持しています。「編集結果を再確認」で再試行できます。`;
          handoffProgress.get(session.completionFile)?.('retry');
          editState(session.root,session.id,feedback);progress.textContent=feedback;
          await refresh().catch(()=>{});await invoke('restore_manual_studio').catch(()=>{});
        }
      }
    };
    void poll();
  }
  if (native) for (const session of pending) void watch(session);
  document.getElementById('screenshot-library-retry')!.addEventListener('click', () => { if (native) for (const session of pending) void watch(session); });
  async function accept(result: Handoff & { screenshotId: string; markitsStarted: boolean; message: string }) {
    if (!recording) return;
    const owner = recording; recording = null; updateControls();
    progress.textContent = result.message;
    owner.stage?.('markits');
    if (result.markitsStarted) await watch({ ...result, ...owner, id: result.screenshotId },owner.ready,owner.stage);
    if (owner.root === options.root() && !owner.ready) await refresh();
    if(!result.markitsStarted)owner.ready?.(result.screenshotId);
  }
  if (native) void listen<Handoff & { screenshotId: string; markitsStarted: boolean; message: string }>('manual-studio-screenshot-finished', event => { void accept(event.payload); });
  function failRecording(message:string) {
    const owner=recording; recording=null; updateControls();
    progress.textContent=message;
    owner?.failed?.();
  }
  if (native) void listen('manual-studio-screenshot-cancelled', () => { const owner=recording; recording=null; updateControls(); progress.textContent='撮影をキャンセルしました。'; owner?.stage?.('cancelled'); owner?.cancelled?.(); });
  if (native) void listen<string>('manual-studio-screenshot-failed', event => { failRecording(event.payload); });
  async function startRecording(ready?: (id:string)=>void,started?:()=>void,cancelled?:()=>void,failed?:()=>void,stage?:(stage:string)=>void) {
    if (!native) throw new Error('操作の記録はデスクトップ版で利用できます。');
    if(recording)throw new Error('操作の記録が進行中です。撮影を完了してから開始してください。');
    const root = options.root(); if (!root) throw new Error('プロジェクトを開いてください。');
    const profiles = options.applications(); if (!profiles.length) throw new Error('「撮影するアプリを登録」で撮影するアプリを登録してください。');
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
      await invoke('start_operation_recording', { root, program: profile.program, args: [...profile.args], workingDirectory: profile.workingDirectory || '', windowTitle: '', taskId: id, markitsProgram: '' });
      recording = {root,id,ready,failed,cancelled,stage};stage?.('recording'); updateControls(); dialog.close();started?.(); progress.textContent = '記録中です。操作が終わったら撮影ボタンを押してください。';
      await invoke('show_recording_control');
    }); };
    field.append(select); actions.append(cancel,start); start.className = "primary"; dialog.append(heading,field,actions); dialog.addEventListener('close',()=>{dialog.remove();if(!recording)cancelled?.();}); document.body.append(dialog); dialog.showModal();
  }
  document.getElementById('screenshot-library-record')!.addEventListener('click',()=>{void options.work(()=>startRecording());});
  async function finishRecording() {
    if (!recording) return;
    recording.stage?.('capture');
    await invoke('hide_manual_studio');
    try { const result = await invoke<Handoff & {screenshotId:string;markitsStarted:boolean;message:string}>('finish_operation_recording'); await accept(result); }
    catch(error){failRecording(String(error));throw error;}
    finally { await invoke('restore_manual_studio'); await invoke('close_recording_control'); }
  }
  document.getElementById('screenshot-library-stop')!.addEventListener('click',()=>{void options.work(finishRecording);});
  async function recordForInsertion(stage?:(stage:string)=>void):Promise<string|undefined>{
    const root=options.root();
    return new Promise((resolve,reject)=>{
      let waiting:HTMLDialogElement|undefined,completed=false;
      const ready=(id:string)=>{completed=true;waiting?.close();resolve(root===options.root()?id:undefined);};
      void startRecording(ready,()=>{
        const {dialog,body}=featureDialog('手動でスクショを撮影');waiting=dialog;dialog.id='editor-screenshot-recording';
        const help=document.createElement('p');help.textContent='対象アプリを操作し、撮影したい画面で「撮影する」を押してください。MarkItsで注釈を編集して保存すると、挿入候補を表示します。';
        const capture=document.createElement('button');capture.type='button';capture.textContent='撮影する';capture.className='primary';capture.dataset.uiIcon='camera';
        capture.onclick=()=>{void options.work(async()=>{try{if(recording?.root!==root)throw new Error('記録対象が変更されました。');await finishRecording();capture.hidden=true;help.textContent='MarkItsで編集して保存してください。保存後も候補が表示されない場合は「編集結果を再確認」を押してください。';}catch(error){help.textContent=String(error);}});};
        const stageStatus=document.createElement('p');stageStatus.role='status';stageStatus.dataset.captureStage='';stageStatus.textContent=stageLabels.recording;body.append(stageStatus);
        const stageListener=(event:Event)=>{const code=(event as CustomEvent<string>).detail;stageStatus.textContent=stageLabels[code]||'編集結果を確認してください。';};
        dialog.addEventListener('capture-stage',stageListener);
        const retry=document.createElement('button');retry.type='button';retry.textContent='編集結果を再確認';retry.onclick=()=>{for(const session of pending.filter(item=>item.root===root))void watch(session);};
        const note=document.createElement('p');note.className='muted';note.textContent='閉じると挿入を取り消します。記録は撮影用の操作ウィンドウから完了でき、画像はリソース一覧に保存されます。';body.append(help,capture,retry,note);
        dialog.addEventListener('close',()=>{if(!completed){if(recording?.root===root)recording.ready=undefined;for(const session of pending.filter(item=>item.root===root)){handoffCallbacks.delete(session.completionFile);handoffProgress.delete(session.completionFile);}resolve(undefined);}},{once:true});
      },()=>{completed=true;waiting?.close();resolve(undefined);},()=>{stage?.('error');waiting?.close();resolve(undefined);},code=>{stage?.(code);if(code==='cancelled'){waiting?.close();return;}waiting?.dispatchEvent(new CustomEvent('capture-stage',{detail:code}));}).catch(reject);
    });
  }
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
  async function editManaged(id:string,revision?:string,root=options.root()) {
    if(root!==options.root())throw new Error('プロジェクトが切り替わりました。画像を選び直してください。');
    if(pending.some(session=>session.root===root&&session.id===id&&watching.has(session.completionFile)))throw new Error('この画像はMarkItsで編集中です。編集を完了してください。');
    const result=await invoke<Handoff>('edit_library_screenshot',{root,id,revision:revision||null});
    await watch({...result,root,id});
  }
  return { refresh,recordForInsertion,editManaged };
}
