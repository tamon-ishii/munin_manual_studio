import {invoke} from '@tauri-apps/api/core';
import {uiIcon, type UiIconName} from './uiIcons';
import {confirmAction} from './imageDialogs';

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
}
export function setupCaptureResources(options:Options) {
  const panel=document.getElementById('panel-capture-resources')!;
  const list=panel.querySelector<HTMLElement>('#capture-resource-list')!;
  const filter=panel.querySelector<HTMLSelectElement>('#capture-resource-usage')!;
  const importButton=panel.querySelector<HTMLButtonElement>('#capture-resource-import-button')!;
  importButton.innerHTML=uiIcon('image');importButton.setAttribute('aria-label','画像を登録');
  let items:CaptureResource[]=[];let generation=0;let running=false;
  const rpc=(action:string,json:Record<string,unknown>={},root=options.root())=>options.rpc(action,{json},root);
  const observer=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){const img=e.target as HTMLImageElement;observer.unobserve(img);const root=options.root(),version=generation;void rpc('capture-resources-thumbnail',{id:img.dataset.id},root).then(src=>{if(root===options.root()&&version===generation)img.src=src;}).catch(()=>{img.alt='画像が見つかりません';});}},{root:list,rootMargin:'100px'});
  async function run(action:()=>Promise<void>){if(running)return;running=true;panel.setAttribute('aria-busy','true');try{await action();}catch(e){options.status(String(e),true);}finally{running=false;panel.removeAttribute('aria-busy');}}
  async function generate(id:string){const root=options.root();const d=JSON.parse(await rpc('capture-resources-generate',{id},root)) as {path:string};if(root!==options.root())throw Error('プロジェクトが切り替わりました。');return d.path;}
  async function recapture(target:{id:string}|{asset:string;page?:string}){
    if(!('__TAURI_INTERNALS__' in window))throw Error('再撮影はデスクトップ版で利用できます。');
    const root=options.root();
    if(!root)return;
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
    panel.querySelector('#capture-resource-count')!.textContent=`${shown.length} / ${items.length}件`;
    if(!shown.length){const p=document.createElement('p');p.textContent=options.root()?'撮影リソースがありません。撮影または画像を登録してください。':'プロジェクトを開いてください。';list.append(p);}
    for(const r of shown){
      const card=document.createElement('article');card.className='capture-resource-card';card.dataset.captureResource=r.id;
      const img=document.createElement('img');img.alt=r.name||'撮影画像';img.dataset.id=r.id;img.width=240;img.height=150;observer.observe(img);
      const title=document.createElement('strong');title.textContent=r.name||r.created_at;
      const state=document.createElement('p');state.textContent=`${r.missing?'元画像が欠落':r.recorded?'操作記録あり':r.window_recapture?'ウィンドウを再撮影可能':'操作記録なし'} · 派生 ${r.derived.length}件 · 使用 ${r.usages.length}箇所`;
      const controls=document.createElement('div');controls.className='capture-resource-actions';
      const button=(label:string,icon:UiIconName,action:()=>Promise<void>,disabled=false)=>{const b=document.createElement('button');b.type='button';b.innerHTML=uiIcon(icon);b.title=label;b.setAttribute('aria-label',label);b.disabled=disabled;b.onclick=()=>void run(action);controls.append(b);};
      button('MarkItsで編集','annotation',async()=>{await options.edited(await generate(r.id));await refresh();},r.missing);
      button('再撮影','camera',()=>recapture({id:r.id}),r.missing||!(r.recorded||r.window_recapture));
      if(r.pending)button('候補を比較','review',async()=>{
        const root=options.root();const dialog=document.createElement('dialog');dialog.className='capture-comparison';
        const heading=document.createElement('h2');heading.textContent='再撮影の比較';
        const images=document.createElement('div');images.className='capture-comparison-images image-comparison-grid';
        for(const [pending,label] of [[false,'現在'],[true,'再撮影候補']] as const){const figure=document.createElement('figure');const caption=document.createElement('figcaption');caption.textContent=label;const image=document.createElement('img');image.alt=label;image.src=await rpc('capture-resources-thumbnail',{id:r.id,pending},root);figure.append(caption,image);images.append(figure);}
        const feedback=document.createElement('p');feedback.role='status';
        const cancel=document.createElement('button');cancel.textContent='閉じる';cancel.onclick=()=>dialog.close();
        const adopt=document.createElement('button');adopt.textContent='候補を採用して画像を更新';adopt.onclick=()=>{adopt.disabled=true;void invoke('adopt_capture_resource',{root,id:r.id}).then(async()=>{if(root===options.root()){await refresh();await options.changed();}dialog.close();}).catch(e=>{feedback.textContent=String(e);adopt.disabled=false;});};
        dialog.append(heading,images,feedback,cancel,adopt);document.body.append(dialog);dialog.onclose=()=>dialog.remove();dialog.showModal();
      });
      button('撮影リソースを削除','trash',async()=>{
        const root=options.root();
        if(!await confirmAction(`「${title.textContent}」の元画像、編集データ、再撮影候補を削除しますか？\n文書用に生成した画像は保持します。`,'削除する'))return;
        if(root!==options.root())return;
        await rpc('capture-resources-delete',{id:r.id},root);
        if(root!==options.root())return;
        await refresh();
        options.status('撮影リソースを削除しました。');
      });
      const usages=document.createElement('div');for(const u of r.usages){const link=document.createElement('button');link.type='button';link.className='capture-usage';link.textContent=`${u.page}:${u.line}`;link.onclick=()=>void run(()=>options.usage(u));usages.append(link);}
      // The drag payload identifies a resource; the drop path resolves it asynchronously.
      img.draggable=true;img.ondragstart=e=>{e.stopPropagation();if(e.dataTransfer){e.dataTransfer.effectAllowed='copy';e.dataTransfer.setData('application/x-munin-image',JSON.stringify({root:options.root(),path:`capture-resource:${r.id}`,resource_id:r.id}));}};
      card.append(img,title,state,controls,usages);list.append(card);
    }
  }
  async function refresh(){const root=options.root(),version=++generation;if(!root){items=[];render();return;}const result=JSON.parse(await rpc('capture-resources-list',{},root));if(root!==options.root()||version!==generation)return;items=result.items;render();}
  filter.onchange=render;
  importButton.onclick=()=>panel.querySelector<HTMLInputElement>('#capture-resource-import')!.click();
  panel.querySelector<HTMLInputElement>('#capture-resource-import')!.onchange=event=>{const input=event.target as HTMLInputElement;const file=input.files?.[0];input.value='';if(!file)return;void run(async()=>{const root=options.root();const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);await rpc('capture-resources-register',{source:btoa(binary),name:file.name},root);if(root===options.root())await refresh();});};
  return {refresh,recaptureImage(asset:string,page?:string){return run(()=>recapture({asset,page}));},upsert(resource:CaptureResource){generation++;const found=items.findIndex(r=>r.id===resource.id);const item={...resource,usages:resource.usages||[]};if(found>=0)items[found]=item;else items.unshift(item);render();}};
}
