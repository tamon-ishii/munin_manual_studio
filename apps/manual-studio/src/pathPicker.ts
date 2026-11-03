import {invoke} from '@tauri-apps/api/core';

interface Context {root():string;entries():Array<{path:string;directory:boolean}>;}
let context:Context;
export function setupPathPickers(value:Context):void {context=value;}
export function relativePickedPath(root:string,path:string):string {
  const base=root.replace(/\\/g,'/').replace(/\/+$/,'');
  const target=path.replace(/\\/g,'/').replace(/\/+$/,'');
  const windows=/^[a-z]:/i.test(base)||base.startsWith('//');
  const normalized=windows?target.toLowerCase():target;
  const prefix=windows?base.toLowerCase():base;
  if(normalized===prefix)return '.';
  if(!normalized.startsWith(prefix+'/'))throw new Error('開いているプロジェクト内の保存先を選択してください。');
  return target.slice(base.length+1);
}

/** Attach to each path field, including dynamically created dialogs. */
export function addPathBrowse(input:HTMLInputElement,kind:()=> 'folder'|'file',base:()=>string=()=>'.'):HTMLButtonElement {
  const button=document.createElement('button');button.type='button';button.textContent='参照';button.className='path-browse';
  button.setAttribute('aria-label',`${input.getAttribute('aria-label')||input.name||'保存先'}を参照`);
  const error=document.createElement('p');error.role='alert';error.className='path-picker-error';error.hidden=true;
  const row=document.createElement('span');row.className='path-picker-row';
  input.before(row);row.append(input,button);row.after(error);
  button.onclick=()=>{void(async()=>{
    const root=context.root();const directory=base();const mode=kind();
    error.hidden=true;button.disabled=true;
    try{
      if(!root)throw new Error('先にプロジェクトを開いてください。');
      let selected:string|null;
      if('__TAURI_INTERNALS__' in window){
        const initial=[root,directory==='.'?'':directory,input.value].filter(Boolean).join('/');
        const absolute=await invoke<string|null>('choose_path',{initialPath:initial,folder:mode==='folder'});
        selected=absolute===null?null:relativePickedPath(root,absolute);
      }else{
        selected=await browserPathPicker(mode,context.entries(),directory,input.value);
      }
      if(selected===null||!input.isConnected)return;
      if(context.root()!==root)throw new Error('プロジェクトが切り替わりました。もう一度選択してください。');
      if(directory!=='.')selected=relativePickedPath(directory,selected);
      input.value=selected;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
    }catch(reason){error.textContent=String(reason);error.hidden=false;}
    finally{button.disabled=false;}
  })();};
  return button;
}

function browserPathPicker(kind:'folder'|'file',entries:Array<{path:string;directory:boolean}>,base:string,current:string):Promise<string|null>{
  const dialog=document.createElement('dialog');dialog.className='panel-dialog';
  const heading=document.createElement('h2');heading.textContent=kind==='folder'?'フォルダーを参照':'保存ファイルを指定';
  const form=document.createElement('form');const label=document.createElement('label');label.textContent='フォルダー';
  const folders=document.createElement('select');folders.add(new Option('プロジェクト直下','.'));
  for(const entry of entries.filter(e=>e.directory))folders.add(new Option(entry.path,entry.path));
  folders.value=[base==='.'?'':base,kind==='folder'?current:current.split('/').slice(0,-1).join('/')].filter(Boolean).join('/')||'.';
  if(folders.selectedIndex<0)folders.value='.';label.append(folders);
  const nameLabel=document.createElement('label');nameLabel.textContent='ファイル名';const name=document.createElement('input');name.value=current.split('/').at(-1)||'';name.required=kind==='file';nameLabel.append(name);nameLabel.hidden=kind==='folder';
  const cancel=document.createElement('button');cancel.type='button';cancel.textContent='キャンセル';cancel.onclick=()=>dialog.close();
  const accept=document.createElement('button');accept.type='submit';accept.textContent='選択';
  form.append(label,nameLabel,cancel,accept);dialog.append(heading,form);document.body.append(dialog);dialog.showModal();
  return new Promise(resolve=>{let result:string|null=null;form.onsubmit=event=>{event.preventDefault();if(kind==='file'&&(/[\\/:]/.test(name.value)||['.','..'].includes(name.value)))return;result=kind==='folder'?folders.value:[folders.value==='.'?'':folders.value,name.value].filter(Boolean).join('/');dialog.close();};dialog.addEventListener('close',()=>{dialog.remove();resolve(result);},{once:true});});
}
