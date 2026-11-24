import {createWindowChannel} from './windowChannel';
import {applyDialogFields,dialogFields,type DialogMessage} from './nativeDialogProtocol';
import {currentTheme} from './theme';
import {isCompactDialog,removeNativeWindowControls} from './dialogSizing';

const hosts=new WeakSet<HTMLDialogElement>();
const disposers=new WeakMap<HTMLDialogElement,()=>void>();

export function releaseNativeDialog(dialog:HTMLDialogElement):void{
  if(dialog.isConnected)return;
  if(dialog.open)dialog.close();
  disposers.get(dialog)?.();
}

/** The original dialog owns handlers and persistence; the OS window displays its live controls. */
export async function hostNativeDialog(dialog:HTMLDialogElement):Promise<void>{
  if(hosts.has(dialog)||!dialog.open||!dialog.isConnected)return;
  hosts.add(dialog);
  const session=crypto.randomUUID();
  let destroyed=false,ready=false,queued=false,nextId=0,ack=0;
  let child:import('@tauri-apps/api/webviewWindow').WebviewWindow|null=null;
  let unlistenClose:(()=>void)|undefined;
  const ids=new WeakMap<Element,string>();
  const channel=await createWindowChannel<DialogMessage>(`dialog-${session}`);
  if(!dialog.open||!dialog.isConnected){channel.close();hosts.delete(dialog);return;}
  const assignIds=()=>{
    for(const element of [dialog,...dialog.querySelectorAll('*')]){
      if(!ids.has(element)){const id=String(++nextId);ids.set(element,id);element.setAttribute('data-dialog-node',id);}
    }
  };
  const snapshot=()=>{
    queued=false;if(destroyed||!ready)return;
    if(!dialog.open||!dialog.isConnected){dispose();return;}
    assignIds();
    const clone=dialog.cloneNode(true) as HTMLDialogElement;
    clone.classList.remove('native-dialog-source','dialog-expanded');
    removeNativeWindowControls(clone);
    const focused=document.activeElement instanceof Element?ids.get(document.activeElement):undefined;
    channel.postMessage({type:'snapshot',snapshot:{html:clone.outerHTML,fields:dialogFields(dialog),theme:currentTheme(),focus:focused,ack}});
  };
  const schedule=()=>{if(!queued&&!destroyed){queued=true;requestAnimationFrame(snapshot);}};
  const observer=new MutationObserver(schedule);
  const dispose=()=>{
    if(destroyed)return;destroyed=true;observer.disconnect();channel.close();unlistenClose?.();
    window.removeEventListener('manual-studio-theme-change',schedule);window.removeEventListener('beforeunload',dispose);
    dialog.removeEventListener('close',dispose);dialog.classList.remove('native-dialog-source');hosts.delete(dialog);disposers.delete(dialog);
    if(child)void child.destroy().catch(()=>{});
  };
  disposers.set(dialog,dispose);
  channel.onmessage=({data})=>{
    if(destroyed)return;
    if(data.type==='ready'){ready=true;if(!dialog.open||!dialog.isConnected){dispose();return;}dialog.classList.add('native-dialog-source');snapshot();}
    if(data.type==='cancel'){
      const proceed=dialog.dispatchEvent(new Event('cancel',{cancelable:true}));
      if(proceed&&dialog.open)dialog.close();
      if(!dialog.open||!dialog.isConnected)dispose();
      else schedule();
    }
    if(data.type==='event'){
      ack=Math.max(ack,data.sequence);
      applyDialogFields(dialog,data.fields);
      const target=[dialog,...dialog.querySelectorAll('[data-dialog-node]')].find(element=>element.getAttribute('data-dialog-node')===data.id);
      if(!target){schedule();return;}
      if(data.files&&target instanceof HTMLInputElement&&target.type==='file'){
        const transfer=new DataTransfer();
        for(const file of data.files){
          const binary=atob(file.data.slice(file.data.indexOf(',')+1));
          transfer.items.add(new File([Uint8Array.from(binary,char=>char.charCodeAt(0))],file.name,{type:file.mime,lastModified:file.modified}));
        }
        target.files=transfer.files;target.dispatchEvent(new Event('input',{bubbles:true}));
      }
      if(data.event==='click'){
        target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,ctrlKey:data.ctrlKey,altKey:data.altKey,shiftKey:data.shiftKey,metaKey:data.metaKey}));
      }
      else if(data.event==='keydown')target.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:data.key,code:data.code,ctrlKey:data.ctrlKey,altKey:data.altKey,shiftKey:data.shiftKey,metaKey:data.metaKey}));
      else if(['dragstart','dragover','drop','dragend'].includes(data.event)){
        const transfer=new DataTransfer();for(const [type,value] of Object.entries(data.dragData??{}))transfer.setData(type,value);
        const bounds=target.getBoundingClientRect();
        target.dispatchEvent(new DragEvent(data.event,{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:bounds.left+(data.xRatio??0.5)*bounds.width,clientY:bounds.top+(data.yRatio??0.5)*bounds.height}));
      }
      else if(data.event!=='toggle')target.dispatchEvent(new Event(data.event,{bubbles:true,cancelable:true}));
      if(!dialog.open||!dialog.isConnected)dispose();else schedule();
    }
  };
  dialog.addEventListener('close',dispose);
  window.addEventListener('beforeunload',dispose);
  window.addEventListener('manual-studio-theme-change',schedule);
  observer.observe(dialog,{subtree:true,childList:true,attributes:true,characterData:true});
  const title=dialog.querySelector('h1,h2')?.textContent||'Munin Manual Studio';
  const columns=dialog.querySelector('.proofreading-grid') as HTMLElement|null;
  const wide=dialog.querySelector('table,.selection-diff-columns,.generation-diff,.image-comparison-grid,.settings-grid');
  const compact=isCompactDialog(dialog);
  const imagePresentation=dialog.hasAttribute('data-image-presentation');
  const initialWidth=Number(dialog.dataset.dialogInitialWidth);
  const initialHeight=Number(dialog.dataset.dialogInitialHeight);
  const width=initialWidth>0?initialWidth:imagePresentation?520:compact?480:columns?Number(columns.style.getPropertyValue('--proofreading-columns'))*300+48:wide?1040:dialog.querySelector('textarea,pre,dl')||dialog.querySelectorAll('input,select').length>4?760:560;
  // scrollHeight already includes the dialog's padding; do not add empty space.
  const height=initialHeight>0?initialHeight:imagePresentation?Math.max(560,Math.min(640,dialog.scrollHeight+32)):compact?Math.max(120,Math.min(420,Math.ceil(dialog.scrollHeight))):Math.max(320,Math.min(900,dialog.scrollHeight+80));
  try{
    const {invoke}=await import('@tauri-apps/api/core');
    await invoke('open_dialog_window',{session,title,width,height});
    const {WebviewWindow}=await import('@tauri-apps/api/webviewWindow');
    child=await WebviewWindow.getByLabel(`dialog-${session}`);
    if(destroyed){if(child)await child.destroy();return;}
    if(!child)throw new Error('ダイアログのウィンドウを開けませんでした。');
    unlistenClose=await child.once('tauri://destroyed',()=>{
      if(!destroyed&&dialog.open)dialog.close();dispose();
    });
  }catch(error){
    dispose();
    if(dialog.isConnected&&dialog.open){const message=document.createElement('p');message.role='alert';message.textContent=`独立ウィンドウを開けませんでした: ${String(error)}`;dialog.append(message);}
  }
}
