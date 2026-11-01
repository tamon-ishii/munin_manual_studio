import {setupResourceBrowser, type Resource, type ResourceUsage} from './resourceBrowser';
import type {ImageGenerationEntry} from './imageGeneration';
import type {LaunchCommand} from './types';

import {invoke} from '@tauri-apps/api/core';

interface Options {
  root():string;
  refreshAssets(root:string):Promise<void>;
  request(action:string,options:Record<string,unknown>,root:string):Promise<string>;
  work(operation:()=>Promise<void>):Promise<void>;
  insert(markdown:string):void;
  page():string|undefined;
  chooseDestination():Promise<boolean>;
  openPage(page:string):Promise<void>;
  applications():LaunchCommand[];
  insertAsset(path:string):Promise<boolean>;
  openImage(path:string):Promise<void>;
  editImage(path:string):Promise<void>;
  openUsage(usage:ResourceUsage):Promise<void>;
  generateImage(entry:ImageGenerationEntry,edit:boolean):Promise<void>;
  annotateScreenshot(id:string):Promise<void>;
}
export interface ImportedCapture {path:string}

export function setupScreenshotLibrary(options:Options) {
  const list=document.getElementById('screenshot-library-list')!;
  const native='__TAURI_INTERNALS__' in window;
  let generation=0;
  const resources=setupResourceBrowser({...options,refresh},render);
  function render(){resources.captureViews(list);list.replaceChildren();resources.renderExtras(list,options.root());}
  async function refresh(refreshAssets=true){
    const root=options.root(), version=++generation;
    if(!root){list.textContent='プロジェクトを開いてください。';return;}
    const result=JSON.parse(await options.request('resources-list',{},root)) as {items:Resource[]};
    if(root!==options.root()||version!==generation)return;
    // Existing managed assets remain usable. New edit history belongs to MarkIts.
    resources.setItems(result.items.map(item=>({...item,screenshot_id:undefined})));
    render();
    if(refreshAssets)await options.refreshAssets(root);
  }
  async function openMarkits(capture=false){
    if(!native)throw new Error('MarkItsはデスクトップ版で利用できます。');
    await invoke('open_markits',{capture});
  }
  async function recordForInsertion(stage?:(stage:string)=>void):Promise<ImportedCapture|undefined>{
    const root=options.root();
    if(!root)throw new Error('プロジェクトを開いてください。');
    if(!native)throw new Error('MarkItsはデスクトップ版で利用できます。');
    stage?.('capture');
    const path=await invoke<string|null>('capture_markits_image',{root});
    if(!path||root!==options.root())return;
    stage?.('import');await refresh();
    return root===options.root()?{path}:undefined;
  }
  document.getElementById('screenshot-library-record')!.textContent='撮影';
  document.getElementById('screenshot-library-record')!.addEventListener('click',()=>{void options.work(async()=>{await recordForInsertion();});});
  document.getElementById('screenshot-library-refresh')!.addEventListener('click',()=>{void options.work(()=>refresh());});
  for(const id of ['screenshot-library-stop','screenshot-library-retry','screenshot-library-cancel','screenshot-library-recapture-all','screenshot-ui-settings'])document.getElementById(id)!.hidden=true;
  const input=document.getElementById('screenshot-library-import') as HTMLInputElement;
  document.getElementById('screenshot-library-import-button')!.addEventListener('click',()=>input.click());
  input.onchange=()=>{
    const file=input.files?.[0],root=options.root();input.value='';if(!file||!root)return;
    void options.work(async()=>{
      const source=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);});
      await invoke('import_markits_image',{root,source});if(root===options.root())await refresh();
    });
  };
  async function editImage(asset:string,page?:string):Promise<ImportedCapture|undefined>{
    const root=options.root();
    if(!native)throw new Error('MarkItsはデスクトップ版で利用できます。');
    const path=await invoke<string|null>('edit_markits_image',{root,asset,page:page||null});
    if(!path||root!==options.root())return;
    await refresh();
    return root===options.root()?{path}:undefined;
  }
  return {refresh,recordForInsertion,openMarkits,editImage};
}
