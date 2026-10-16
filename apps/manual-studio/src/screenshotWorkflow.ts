import { getRecentInsertionTarget, setRecentInsertionTarget } from './insertionContext';

/** Small project-scoped dialogs shared by the screenshot library workflows. */
export function featureDialog(title: string, modal = true): {dialog: HTMLDialogElement; body: HTMLDivElement} {
  const dialog=document.createElement('dialog');dialog.className='panel-dialog';
  const header=document.createElement('div');header.className='panel-header';
  const heading=document.createElement('h1');heading.textContent=title;
  const close=document.createElement('button');close.type='button';close.textContent='閉じる';close.onclick=()=>dialog.close();
  header.append(heading,close);const body=document.createElement('div');dialog.append(header,body);
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);if(modal)dialog.showModal();else dialog.show();return {dialog,body};
}
export function confirmAction(message:string,acceptLabel='続ける'):Promise<boolean>{
  const {dialog,body}=featureDialog('内容を確認');dialog.dataset.confirmAction='true';dialog.style.maxWidth='560px';
  const note=document.createElement('p');note.textContent=message;note.style.whiteSpace='pre-line';
  const actions=document.createElement('div');actions.className='actions';const cancel=document.createElement('button');cancel.type='button';cancel.textContent='キャンセル';cancel.onclick=()=>dialog.close();
  const accept=document.createElement('button');accept.type='button';accept.className='primary';accept.textContent=acceptLabel;accept.dataset.confirmAccept='true';actions.append(cancel,accept);body.append(note,actions);
  return new Promise(resolve=>{let accepted=false;accept.onclick=()=>{accepted=true;dialog.close();};dialog.addEventListener('close',()=>resolve(accepted),{once:true});});
}
export function requestText(label:string,initial=''):Promise<string|null>{
  const {dialog,body}=featureDialog(label);dialog.dataset.requestText='true';dialog.style.maxWidth='560px';
  const form=document.createElement('form');const field=document.createElement('label');field.textContent=label;const input=document.createElement('input');input.value=initial;input.setAttribute('aria-label',label);field.append(input);const save=document.createElement('button');save.type='submit';save.className='primary';save.textContent='保存';form.append(field,save);body.append(form);input.focus();input.select();
  return new Promise(resolve=>{let value:string|null=null;form.onsubmit=event=>{event.preventDefault();value=input.value;dialog.close();};dialog.addEventListener('close',()=>resolve(value),{once:true});});
}
export function headings(markdown: string): Array<{label:string;offset:number;index:number}> {
  let offset=0,fence='',index=0;const result:Array<{label:string;offset:number;index:number}>=[];
  for(const line of markdown.split(/(?<=\n)/)) {
    const marker=line.match(/^\s*(`{3,}|~{3,})/);
    if(marker){if(!fence)fence=marker[1][0];else if(marker[1][0]===fence)fence='';}
    if(!fence){const match=line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);if(match)result.push({label:match[2],offset:offset+line.length,index:index++});}
    offset+=line.length;
  }
  return result;
}

interface DestinationOptions {
  pages:string[];current():{page:string;content:string}|null;
  read(page:string):Promise<string>;open(page:string):Promise<void>;
  select(offset:number,heading:number|null):void;
  root?:string;
}
export function chooseDestination(options:DestinationOptions):Promise<boolean> {
  const {dialog,body}=featureDialog('画像の挿入先');dialog.dataset.screenshotDestination='true';
  const recent=options.root?getRecentInsertionTarget(options.root):undefined;
  const pageLabel=document.createElement('label');pageLabel.textContent='原稿';const page=document.createElement('select');page.setAttribute('aria-label','挿入先の原稿');
  for(const path of options.pages)page.add(new Option(path,path));
  page.value=options.current()?.page||(recent?.page&&options.pages.includes(recent.page)?recent.page:options.pages[0]||'');
  pageLabel.append(page);
  const headingLabel=document.createElement('label');headingLabel.textContent='位置';const position=document.createElement('select');position.setAttribute('aria-label','挿入先の位置');headingLabel.append(position);
  const status=document.createElement('p');status.role='status';const confirm=document.createElement('button');confirm.type='button';confirm.className='primary';confirm.textContent='ここに挿入';
  body.append(pageLabel,headingLabel,status,confirm);
  let version=0,targets:ReturnType<typeof headings>=[],accepted=false,loaded='';
  async function load(){
    const id=++version;confirm.disabled=true;
    try{
      const current=options.current();const content=current?.page===page.value?current.content:await options.read(page.value);
      if(id!==version)return;
      loaded=page.value;targets=headings(content);position.replaceChildren();
      if(current?.page===page.value)position.add(new Option('現在のカーソル位置','cursor'));
      position.add(new Option('原稿の末尾','end'));
      for(const heading of targets)position.add(new Option(heading.label,String(heading.index)));
      if(current?.page===page.value){
        position.value='cursor';
      }else if(recent?.position&&Array.from(position.options).some(opt=>opt.value===recent.position)){
        position.value=recent.position;
      }
      status.textContent='';confirm.disabled=false;
    }catch(error){if(id===version)status.textContent=String(error);}
  }
  page.onchange=()=>{void load();};
  if (options.pages.length) void load();
  else { confirm.disabled = true; status.textContent = '先に挿入先の原稿を作成または開いてください。'; }
  return new Promise(resolve=>{
    dialog.addEventListener('close',()=>resolve(accepted),{once:true});
    confirm.onclick=()=>{void(async()=>{
      confirm.disabled=true;
      try{
        const selected=loaded;if(selected!==page.value)return;
        await options.open(selected);
        const current=options.current();
        if(current?.page!==selected)throw new Error('挿入先が変更されました。選び直してください。');
        if(position.value==='end')options.select(current.content.length,null);
        else if(position.value!=='cursor'){const heading=targets[Number(position.value)];options.select(heading.offset,heading.index);}
        if(options.root)setRecentInsertionTarget(options.root,{page:selected,position:position.value});
        accepted=true;dialog.close();
      }catch(error){status.textContent=String(error);confirm.disabled=false;}
    })();};
  });
}
