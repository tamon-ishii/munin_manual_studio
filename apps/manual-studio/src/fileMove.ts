import {featureDialog} from './screenshotWorkflow';
import type {Document} from './types';
export interface FileMoveResult {source:string;destination:string;documents:Document[];backup:string}
interface Plan {source:string;destination:string;token:string}
interface Options {
  root():string;busy():boolean;folders():string[];
  request(action:string,options:Record<string,unknown>,root:string):Promise<string>;
  work(operation:()=>Promise<void>):Promise<void>;
  prepare():Promise<void>;changed(result:FileMoveResult):Promise<void>;report(message:string,error?:boolean):void;
}
export function setupFileMove(options:Options){
  return async(source:string,folder?:string):Promise<void>=>{
    const root=options.root();if(!root||options.busy())return;
    const {dialog,body}=featureDialog('ファイルを移動してリンクを更新');dialog.id='file-move-dialog';
    const description=document.createElement('p');description.textContent=`移動元：${source}`;
    const folderLabel=document.createElement('label');folderLabel.textContent='移動先フォルダー';
    const folders=document.createElement('select');folders.setAttribute('aria-label','移動先フォルダー');
    for(const path of ['',...options.folders()])folders.add(new Option(path||'プロジェクト直下',path));
    const originalFolder=source.split('/').slice(0,-1).join('/');folders.value=folder??originalFolder;folderLabel.append(folders);
    const label=document.createElement('label');label.textContent='移動先（プロジェクト相対パス）';const destination=document.createElement('input');destination.setAttribute('aria-label','移動先（プロジェクト相対パス）');
    const name=source.split('/').at(-1)!;destination.value=[folder??originalFolder,name].filter(Boolean).join('/');label.append(destination);
    const message=document.createElement('p');message.role='status';
    const actions=document.createElement('div');actions.className='actions';
    const apply=document.createElement('button');apply.type='button';apply.textContent='移動してリンクを更新';apply.className='primary';
    const close=document.createElement('button');close.type='button';close.textContent='キャンセル';close.onclick=()=>dialog.close();
    let running=false;
    const current=()=>dialog.open&&root===options.root();
    const invalidate=()=>{message.textContent='';};
    folders.onchange=()=>{destination.value=[folders.value,destination.value.split('/').at(-1)].filter(Boolean).join('/');invalidate();};destination.oninput=invalidate;
    const perform=async(run:()=>Promise<void>)=>{if(running||!current())return;running=true;apply.disabled=close.disabled=destination.disabled=folders.disabled=true;try{await options.work(async()=>{try{await run();}catch(error){if(current()){message.role='alert';message.textContent=String(error);}}});}finally{running=false;apply.disabled=close.disabled=destination.disabled=folders.disabled=false;}};
    apply.onclick=()=>{void perform(async()=>{
      await options.prepare();if(!current())return;
      const plan=JSON.parse(await options.request('project-move-file',{json:{source,destination:destination.value.trim()}},root)) as Plan;
      if(!current())return;
      const result=JSON.parse(await options.request('project-move-file',{json:{source:plan.source,destination:plan.destination,token:plan.token,apply:true}},root)) as FileMoveResult;
      if(!current())return;
      dialog.close();await options.changed(result);options.report(`${result.destination}へ移動し、リンクを更新しました。`);
    });};
    actions.append(close,apply);body.append(description,folderLabel,label,message,actions);destination.focus();
  };
}
