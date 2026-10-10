import {featureDialog} from './screenshotWorkflow';
import type {ImageGenerationEntry} from './imageGeneration';
export interface ResourceUsage {page:string;line:number;start:number;end:number;snippet:string}
export interface Resource {path:string;name:string;kind:'screenshot'|'generated'|'imported';screenshot_id?:string;generation?:ImageGenerationEntry;thumbnail?:string;usages:ResourceUsage[];missing?:boolean;error?:string;sha256?:string}
interface Options {
  root():string;request(action:string,options:Record<string,unknown>,root:string):Promise<string>;
  work(operation:()=>Promise<void>):Promise<void>;refresh():Promise<void>;
  insertAsset(path:string):Promise<boolean>;openImage(path:string):Promise<void>;editImage(path:string):Promise<void>;
  openUsage(usage:ResourceUsage):Promise<void>;generateImage(entry:ImageGenerationEntry,edit:boolean):Promise<void>;
}
export function setupResourceBrowser(options:Options,rerender:()=>void) {
  const search=document.getElementById('resource-search') as HTMLInputElement;
  const kind=document.getElementById('resource-kind') as HTMLSelectElement;
  const used=document.getElementById('resource-usage') as HTMLSelectElement;
  const count=document.getElementById('resource-count')!;
  document.getElementById('screenshot-library-list')!.addEventListener('dragstart',event=>{
    const image=(event.target as Element).closest<HTMLImageElement>('img');
    const card=image?.closest<HTMLElement>('[data-resource-path]');
    const resource=card&&byPath.get(card.dataset.resourcePath!);
    if(!image||!resource||resource.missing||!event.dataTransfer||card?.dataset.resourceRoot!==options.root())return;
    event.dataTransfer.clearData();event.dataTransfer.setData('application/x-munin-image',JSON.stringify({root:options.root(),path:resource.path,screenshot_id:resource.screenshot_id}));event.dataTransfer.effectAllowed='copy';
  });
  const labels={screenshot:'撮影画像',generated:'AI生成',imported:'取り込み画像'};
  let items:Resource[]=[],byPath=new Map<string,Resource>();
  const thumbnails=new Map<string,string>();
  let observer:IntersectionObserver|null=null;let loading=0;
  const queue:Array<{image:HTMLImageElement;root:string;path:string}>=[];
  function drain(){
    while(loading<3&&queue.length){const item=queue.shift()!;if(!item.image.isConnected||item.root!==options.root())continue;
      loading++;void options.request('resources-thumbnail',{asset:item.path},item.root).then(src=>{if(item.image.isConnected&&item.root===options.root()){item.image.src=src;thumbnails.set(`${item.root}:${item.path}`,src);}}).catch(()=>{item.image.alt+='（プレビューを読み込めません）';}).finally(()=>{loading--;drain();});
    }
  }
  function observe(image:HTMLImageElement,root:string,path:string){
    const cached=thumbnails.get(`${root}:${path}`);if(cached){image.src=cached;return;}
    if(!observer)observer=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting){const image=entry.target as HTMLImageElement;observer?.unobserve(image);queue.push({image,root:image.dataset.resourceRoot!,path:image.dataset.resourcePreview!});}}drain();},{rootMargin:'150px'});
    image.dataset.resourceRoot=root;image.dataset.resourcePreview=path;observer.observe(image);
  }
  for(const field of [search,kind,used])field.addEventListener(field===search?'input':'change',()=>rerender());
  function matches(resource:Resource){
    const query=search.value.trim().toLocaleLowerCase();
    return (kind.value==='all'||kind.value===resource.kind)&&(used.value==='all'||(used.value==='used')===Boolean(resource.usages.length))&&(!query||[resource.name,resource.path,resource.generation?.prompt,...resource.usages.map(u=>u.page)].join(' ').toLocaleLowerCase().includes(query));
  }
  function usageLinks(parent:HTMLElement,resource:Resource){
    const group=document.createElement('div');group.className='resource-usages';
    if(!resource.usages.length){const none=document.createElement('span');none.className='muted';none.textContent='未使用';group.append(none);}
    for(const usage of resource.usages){const link=document.createElement('button');link.type='button';link.className='resource-usage-link';link.textContent=`${usage.page}:${usage.line}`;link.title='原稿の使用箇所へ移動';link.onclick=()=>{void options.work(()=>options.openUsage(usage));};group.append(link);}
    parent.append(group);
  }
  function decorate(card:HTMLElement,resource:Resource){
    card.dataset.resourcePath=resource.path;card.dataset.resourceKind=resource.kind;card.dataset.resourceRoot=options.root();
    const info=document.createElement('div');info.className='resource-card-info';const badge=document.createElement('span');badge.className='badge';badge.textContent=labels[resource.kind];const path=document.createElement('span');path.className='resource-path';path.textContent=resource.path;path.title=resource.path;info.append(badge,path);card.querySelector('h2')?.after(info);
    usageLinks(card,resource);
  }
  async function replace(resource:Resource,root:string){
    const detail=JSON.parse(await options.request('resources-detail',{asset:resource.path},root)) as {sha256:string;usages:ResourceUsage[]};
    if(root!==options.root())return;resource={...resource,...detail};
    const {dialog,body}=featureDialog('画像の差し替え');dialog.dataset.resourceReplacement='true';
    const notice=document.createElement('p');notice.textContent=`${resource.path} を差し替えると、下記の使用箇所すべてに反映されます。元画像はバックアップに保存します。`;body.append(notice);usageLinks(body,resource);
    const label=document.createElement('label');label.textContent='新しい画像';const replacement=document.createElement('select');replacement.setAttribute('aria-label','差し替え先の画像');
    for(const item of items.filter(item=>!item.missing&&item.path!==resource.path&&/\.(png|jpe?g)$/i.test(item.path)))replacement.add(new Option(`${item.name} — ${item.path}`,item.path));label.append(replacement);
    const preview=document.createElement('img');preview.className='generated-image-preview';preview.alt='差し替え候補';preview.hidden=true;
    let version=0;replacement.onchange=()=>{const current=++version;void options.request('resources-image',{asset:replacement.value},root).then(src=>{if(version===current){preview.src=src;preview.hidden=false;}}).catch(()=>{preview.hidden=true;});};
    const status=document.createElement('p');status.role='status';
    const confirm=document.createElement('button');confirm.type='button';confirm.className='primary';confirm.textContent='影響箇所を確認して差し替える';confirm.disabled=!replacement.options.length;
    confirm.onclick=()=>{void options.work(async()=>{
      if(root!==options.root())return;confirm.disabled=true;
      try{await options.request('resources-replace',{json:{path:resource.path,replacement:replacement.value,expected_sha256:resource.sha256}},root);dialog.close();await options.refresh();}
      catch(error){status.textContent=String(error);confirm.disabled=false;}
    });};
    body.append(label,preview,status,confirm);if(replacement.options.length)replacement.onchange(new Event('change'));
  }
  function renderExtras(list:HTMLElement,root:string){
    for(const resource of items.filter(item=>!item.screenshot_id&&matches(item))){
      const card=document.createElement('article');card.className='card screenshot-library-card resource-card';const title=document.createElement('h2');title.textContent=resource.name||resource.path.split('/').at(-1)||'画像';card.append(title);decorate(card,resource);
      if(!resource.missing){const image=document.createElement('img');image.alt=title.textContent;image.loading='lazy';image.draggable=true;image.title='ドラッグして原稿に挿入';card.append(image);observe(image,root,resource.path);}
      if(resource.missing){const missing=document.createElement('p');missing.className='resource-error';missing.textContent=resource.error||'画像が見つかりません。';card.append(missing);}
      const actions=document.createElement('div');actions.className='actions screenshot-primary-actions';card.append(actions);
      function button(label:string,run:()=>Promise<unknown>,standalone=false,disabled=Boolean(resource.missing)){
        const button=document.createElement('button');button.type='button';button.textContent=label;button.disabled=disabled;button.onclick=()=>{if(root!==options.root())return;if(standalone){void run();}else{void options.work(async()=>{await run();if(root===options.root())await options.refresh();});}};actions.append(button);return button;
      }
      button('画像を表示',()=>options.openImage(resource.path));
      button('文書に挿入',()=>options.insertAsset(resource.path));
      button('MarkItsで編集',async()=>{const copied=JSON.parse(await options.request('resources-copy',{asset:resource.path},root)) as {path:string};await options.editImage(copied.path);},false,Boolean(resource.missing)||!('__TAURI_INTERNALS__' in window)||!/\.(png|jpe?g)$/i.test(resource.path));
      const seed:ImageGenerationEntry=resource.generation||{id:resource.path,path:resource.path,prompt:'',created_at:''};
      button('AIで修正',()=>options.generateImage(seed,true),true);
      if(resource.generation)button('指示を再利用',()=>options.generateImage(seed,false),true,false);
      const management=document.createElement('details');management.className='screenshot-management';const summary=document.createElement('summary');summary.textContent='履歴・管理';management.append(summary);
      if(resource.generation){const info=document.createElement('p');info.className='muted';info.textContent=`${resource.generation.provider||resource.generation.model} ／ ${resource.generation.created_at}`;const prompt=document.createElement('p');prompt.textContent=resource.generation.prompt;management.append(info,prompt);}
      const restore=document.createElement('button');restore.type='button';restore.textContent='前回の差し替えを戻す';restore.hidden=true;
      const restoreStatus=document.createElement('p');restoreStatus.role='status';restoreStatus.className='muted';
      let restoreDetail:{sha256:string;replacements:Array<{id:string}>}|undefined;
      management.addEventListener('toggle',()=>{if(!management.open||root!==options.root())return;
        void options.request('resources-detail',{asset:resource.path},root).then(raw=>{
          if(!management.isConnected||root!==options.root())return;restoreDetail=JSON.parse(raw);restore.hidden=!restoreDetail?.replacements?.length;
          if(!restore.hidden)restoreStatus.textContent='元の画像に戻すと、この画像を使う全原稿に反映されます。バックアップは保持します。';
        }).catch(error=>{restoreStatus.textContent=String(error);});
      });
      restore.onclick=()=>{void options.work(async()=>{
        if(!restoreDetail?.replacements.length||root!==options.root())return;restore.disabled=true;
        try{await options.request('resources-restore',{json:{id:restoreDetail.replacements[0].id,expected_sha256:restoreDetail.sha256}},root);await options.refresh();}
        catch(error){restoreStatus.textContent=String(error);restore.disabled=false;}
      });};
      management.append(restore,restoreStatus);
      const swap=document.createElement('button');swap.type='button';swap.textContent='差し替えと影響確認';swap.disabled=Boolean(resource.missing)||!/\.(png|jpe?g)$/i.test(resource.path);swap.onclick=()=>{if(root===options.root())void replace(resource,root);};management.append(swap);card.append(management);list.append(card);
    }
    const displayed=list.querySelectorAll('.screenshot-library-card').length;count.textContent=`${displayed} / ${Math.max(items.length,displayed)}件`;
    if(!displayed){list.textContent=items.length?'条件に合うリソースがありません。':'撮影・画像の取り込み・AI作画でリソースを追加できます。';}
  }
  return {
    setItems(next:Resource[]){observer?.disconnect();observer=null;queue.length=0;thumbnails.clear();items=next;byPath=new Map(next.map(item=>[item.path,item]));},
    matchesShot(path:string,fallback:Resource){return matches(byPath.get(path)||fallback);},
    decorateShot(card:HTMLElement,path:string){const item=byPath.get(path);if(item)decorate(card,item);},renderExtras,
  };
}
