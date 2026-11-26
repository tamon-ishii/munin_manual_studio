import {invoke} from '@tauri-apps/api/core';
import {uiIcon, type UiIconName} from './uiIcons';
import {confirmAction, featureDialog} from './imageDialogs';

export interface CaptureResource {
  id:string;name:string;created_at:string;revision:string;recorded:boolean;window_recapture?:boolean;missing?:boolean;pending?:string;
  derived:{id:string;path:string}[];
  usages:{page:string;line:number;start:number;snippet?:string}[];
}
interface Options {
  root():string;
  rpc(action:string,options:Record<string,unknown>,root:string):Promise<string>;
  edited(path:string):Promise<void>;
  changed():Promise<void>;
  usage(usage:CaptureResource['usages'][number]):Promise<void>;
  status(message:string,error?:boolean):void;
  setButtonDisabled?:(button:HTMLButtonElement,disabled:boolean)=>void;
  onItemsChange?:(count:number,highlight?:boolean)=>void;
}
export function setupCaptureResources(options:Options) {
  const panel=document.getElementById('panel-capture-resources')!;
  const list=panel.querySelector<HTMLElement>('#capture-resource-list')!;
  const filter=panel.querySelector<HTMLSelectElement>('#capture-resource-usage')!;
  const cleanupButton=panel.querySelector<HTMLButtonElement>('#capture-resource-cleanup-btn');
  const restoreTrashButton=panel.querySelector<HTMLButtonElement>('#capture-resource-restore-trash-btn');
  const importButton=panel.querySelector<HTMLButtonElement>('#capture-resource-import-button')!;
  importButton.classList.add('icon-control');
  importButton.innerHTML=`${uiIcon('image')}<span>登録</span>`;importButton.setAttribute('aria-label','画像を登録');
  let items:CaptureResource[]=[];
  let latestTrash:{trash_dir:string;archived_at:string;count:number}|null=null;
  let loadedRoot='';
  let generation=0;let running=false;
  let pollPending=false;
  let refreshingCount=0;
  const rpc=(action:string,json:Record<string,unknown>={},root=options.root())=>options.rpc(action,{json},root);
  const observer=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){const img=e.target as HTMLImageElement;observer.unobserve(img);const root=options.root(),version=generation;void rpc('capture-resources-thumbnail',{id:img.dataset.id},root).then(src=>{if(root===options.root()&&version===generation)img.src=src;}).catch(()=>{img.alt='画像が見つかりません';});}},{root:list,rootMargin:'100px'});
  async function run(action:()=>Promise<void>){if(running)return;running=true;panel.setAttribute('aria-busy','true');try{await action();}catch(e){options.status(String(e),true);}finally{running=false;panel.removeAttribute('aria-busy');}}
  async function generate(id:string){const root=options.root();const d=JSON.parse(await rpc('capture-resources-generate',{id},root)) as {path:string};if(root!==options.root())throw Error('プロジェクトが切り替わりました。');return d.path;}
  async function recapture(target:{id:string}|{asset:string;page?:string}){
    if(!('__TAURI_INTERNALS__' in window))throw Error('再撮影はデスクトップ版で利用できます。');
    const root=options.root();
    if(!root)return;
    const confirmed=await confirmAction(
      '再撮影すると、この撮影リソースを使っている文書の画像が更新されます。\n比較が必要な場合は、再撮影結果を候補として保存し、採用したときに更新します。',
      '再撮影する',
    );
    if(!confirmed||root!==options.root())return;
    options.status('再撮影を準備しています。');
    const updated=await invoke<CaptureResource|null>('recapture_capture_resource',{root,...target});
    if(root!==options.root())return;
    if(updated){
      await refresh();
      if(root!==options.root())return;
      await options.changed();
    }
    if(root!==options.root())return;
    options.status(updated?.pending?'新しい撮影を保存しました。画像を比較して採用してください。':updated?'再撮影し、文書用画像を更新しました。':'再撮影をキャンセルしました。');
  }
  function render(){
    observer.disconnect();list.replaceChildren();
    const shown=items.filter(r=>(filter.value==='all'||(filter.value==='used')===(r.usages.length>0)));
    const unusedCount=items.filter(r=>r.usages.length===0).length;
    panel.querySelector('#capture-resource-count')!.textContent=`${shown.length} / ${items.length}件`;
    options.onItemsChange?.(items.length, false);
    if(cleanupButton){
      const disabled=!options.root()||unusedCount===0;
      if(options.setButtonDisabled)options.setButtonDisabled(cleanupButton,disabled);
      else cleanupButton.disabled=disabled;
      cleanupButton.textContent=unusedCount>0?`未使用を整理 (${unusedCount})`:'未使用を整理';
    }
    if(restoreTrashButton){
      const hasTrash=Boolean(options.root()&&latestTrash&&latestTrash.count>0);
      restoreTrashButton.hidden=!hasTrash;
      if(options.setButtonDisabled)options.setButtonDisabled(restoreTrashButton,!hasTrash);
      else restoreTrashButton.disabled=!hasTrash;
      restoreTrashButton.textContent=hasTrash&&latestTrash?`整理を戻す (${latestTrash.count})`:'整理を戻す';
    }
    if(!shown.length){const p=document.createElement('p');p.textContent=options.root()?'撮影リソースがありません。撮影または画像を登録してください。':'プロジェクトを開いてください。';list.append(p);}
    for(const r of shown){
      const card=document.createElement('article');card.className='capture-resource-card';card.dataset.captureResource=r.id;
      if(r.pending)card.classList.add('has-pending');
      const img=document.createElement('img');img.alt=r.name||'撮影画像';img.title='原稿へドラッグ＆ドロップして挿入できます';img.dataset.id=r.id;img.width=240;img.height=150;observer.observe(img);
      const header=document.createElement('div');header.className='capture-resource-card-header';
      const title=document.createElement('strong');title.textContent=r.name||r.created_at;
      header.append(title);
      if(r.pending){
        const pendingBadge=document.createElement('span');pendingBadge.className='capture-pending-badge';pendingBadge.textContent='再撮影候補あり';
        header.append(pendingBadge);
      }
      const derivedNote = r.derived.length > 0 ? ` · 編集済み画像 ${r.derived.length}件` : '';
      const state=document.createElement('p');state.textContent=`${r.missing?'元画像が欠落':r.recorded?'操作記録あり':r.window_recapture?'ウィンドウを再撮影可能':'操作記録なし'}${derivedNote} · 使用 ${r.usages.length}箇所`;
      const controls=document.createElement('div');controls.className='capture-resource-actions';
      const button=(label:string,icon:UiIconName,action:()=>Promise<void>,disabled=false,shortLabel?:string,className='')=>{const b=document.createElement('button');b.type='button';b.className=`icon-control${className?` ${className}`:''}`;b.innerHTML=shortLabel?`${uiIcon(icon)}<span>${shortLabel}</span>`:uiIcon(icon);b.title=label;b.setAttribute('aria-label',label);b.disabled=disabled;b.onclick=()=>void run(action);controls.append(b);};
      button('MarkItsで編集','annotation',async()=>{await options.edited(await generate(r.id));await refresh();},r.missing,'編集');
      button('再撮影','camera',()=>recapture({id:r.id}),r.missing||!(r.recorded||r.window_recapture),'再撮影');
      if(r.pending)button('候補を比較','review',async()=>{
        const root=options.root();
        const {dialog,body}=featureDialog('再撮影の比較');
        dialog.classList.add('capture-comparison');
        const images=document.createElement('div');images.className='capture-comparison-images image-comparison-grid';
        for(const [pending,label] of [[false,'現在'],[true,'再撮影候補']] as const){const figure=document.createElement('figure');const caption=document.createElement('figcaption');caption.textContent=label;const image=document.createElement('img');image.alt=label;image.src=await rpc('capture-resources-thumbnail',{id:r.id,pending},root);figure.append(caption,image);images.append(figure);}
        const feedback=document.createElement('p');feedback.role='status';
        const actions=document.createElement('div');actions.className='actions dialog-actions';
        const cancel=document.createElement('button');cancel.type='button';cancel.textContent='キャンセル';cancel.onclick=()=>dialog.close();
        const adopt=document.createElement('button');adopt.type='button';adopt.className='primary';adopt.textContent='候補を採用して画像を更新';adopt.onclick=()=>{adopt.disabled=true;void invoke('adopt_capture_resource',{root,id:r.id}).then(async()=>{if(root===options.root()){await refresh();await options.changed();}dialog.close();}).catch(e=>{feedback.textContent=String(e);adopt.disabled=false;});};
        actions.append(cancel,adopt);
        body.append(images,feedback,actions);
      },false,'候補を比較','primary');
      button('撮影リソースを削除','trash',async()=>{
        const root=options.root();
        if(!await confirmAction(`「${title.textContent}」の元画像、編集データ、再撮影候補を削除しますか？\n文書用に生成した画像は保持します。`,'削除する'))return;
        if(root!==options.root())return;
        await rpc('capture-resources-delete',{id:r.id},root);
        if(root!==options.root())return;
        await refresh();
        options.status('撮影リソースを削除しました。');
      },false,undefined,'capture-resource-delete-btn');
      const usages=document.createElement('div');for(const u of r.usages){const link=document.createElement('button');link.type='button';link.className='capture-usage';link.textContent=`${u.page}:${u.line}`;link.onclick=()=>void run(()=>options.usage(u));usages.append(link);}
      // The drag payload identifies a resource; the drop path resolves it asynchronously.
      img.draggable=true;img.ondragstart=e=>{e.stopPropagation();if(e.dataTransfer){e.dataTransfer.effectAllowed='copy';e.dataTransfer.setData('application/x-munin-image',JSON.stringify({root:options.root(),path:`capture-resource:${r.id}`,resource_id:r.id}));}};
      card.append(img,header,state,controls,usages);list.append(card);
    }
  }
  async function refresh(onlyIfChanged=false){
    const root=options.root(),version=++generation;
    if(!root){loadedRoot='';items=[];latestTrash=null;render();return;}
    if(root!==loadedRoot){loadedRoot=root;items=[];latestTrash=null;render();}
    refreshingCount++;
    try{
      const result=JSON.parse(await rpc('capture-resources-list',{},root)) as {items:CaptureResource[];latest_trash?:{trash_dir:string;archived_at:string;count:number}|null};
      if(root!==options.root()||version!==generation)return;
      const nextTrash=result.latest_trash??null;
      if(onlyIfChanged&&JSON.stringify(items)===JSON.stringify(result.items)&&JSON.stringify(latestTrash)===JSON.stringify(nextTrash))return;
      items=result.items;latestTrash=nextTrash;render();
    }finally{refreshingCount--;}
  }
  async function refreshVisible(){
    if(pollPending||running||refreshingCount>0||!options.root()||document.hidden||!panel.getClientRects().length)return;
    pollPending=true;
    try{await refresh(true);}catch{/* Retry if registration is still in progress. */}
    finally{pollPending=false;}
  }
  filter.onchange=render;
  if(cleanupButton){
    cleanupButton.onclick=()=>void run(async()=>{
      const root=options.root();
      const unused=items.filter(r=>r.usages.length===0);
      if(!root||!unused.length)return;
      const confirmed=await confirmAction(
        `未使用の撮影リソース ${unused.length}件（保護されていないもの）と未参照の生成PNGを .munin/trash へ退避して整理しますか？\n使用中または保護済みの画像は対象外です。`,
        '未使用を整理する',
      );
      if(!confirmed||root!==options.root())return;
      const report=JSON.parse(await rpc('capture-resources-cleanup-unused',{},root)) as {
        archived_count:number;trash_dir:string|null;skipped?:Array<{id:string;reason:string}>;
      };
      if(root!==options.root())return;
      await refresh();
      await options.changed();
      const skippedCount=report.skipped?.length||0;
      if(report.archived_count>0){
        options.status(`未使用の撮影リソース ${report.archived_count}件を ${report.trash_dir} へ退避しました${skippedCount?`（対象外 ${skippedCount}件）`:''}。`);
      }else{
        options.status('整理できる未使用の撮影リソースはありませんでした（使用中または保護済み）。');
      }
    });
  }
  if(restoreTrashButton){
    restoreTrashButton.onclick=()=>void run(async()=>{
      const root=options.root();
      const target=latestTrash;
      if(!root||!target)return;
      const confirmed=await confirmAction(
        `直前に退避した撮影リソース ${target.count}件（${target.trash_dir}）と派生画像を元の場所へ復元しますか？`,
        '元に戻す',
      );
      if(!confirmed||root!==options.root())return;
      const report=JSON.parse(await rpc('capture-resources-restore-trash',{trash_dir:target.trash_dir},root)) as {
        restored_count:number;trash_dir:string;
      };
      if(root!==options.root())return;
      await refresh();
      await options.changed();
      options.status(`退避していた撮影リソース ${report.restored_count}件を元に戻しました。`);
    });
  }
  importButton.onclick=()=>panel.querySelector<HTMLInputElement>('#capture-resource-import')!.click();
  panel.querySelector<HTMLInputElement>('#capture-resource-import')!.onchange=event=>{const input=event.target as HTMLInputElement;const file=input.files?.[0];input.value='';if(!file)return;void run(async()=>{const root=options.root();const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);await rpc('capture-resources-register',{source:btoa(binary),name:file.name},root);if(root===options.root())await refresh();});};
  return {refresh,refreshVisible,recaptureImage(asset:string,page?:string){return run(()=>recapture({asset,page}));},upsert(resource:CaptureResource){generation++;const found=items.findIndex(r=>r.id===resource.id);const item={...resource,usages:resource.usages||[]};if(found>=0)items[found]=item;else items.unshift(item);render();options.onItemsChange?.(items.length,true);}};
}
