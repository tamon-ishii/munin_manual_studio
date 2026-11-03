export interface FileTab {kind:'document'|'image';path:string;}
export function setupFileTabMenu(options:{tabs():FileTab[];busy():boolean;close(tabs:FileTab[]):Promise<void>;report(error:unknown):void}):void{
  const strip=document.getElementById('document-tabs')!;
  const menu=document.createElement('div');menu.id='file-tab-context-menu';menu.className='tree-context-menu';menu.role='menu';menu.setAttribute('aria-label','ファイルタブの操作');menu.hidden=true;document.body.append(menu);
  let anchor:HTMLElement|null=null;
  const dismiss=(restore=false)=>{menu.hidden=true;if(restore)anchor?.focus();};
  function show(target:HTMLElement,x:number,y:number){
    if(options.busy())return;
    const tab=target.closest('.document-tab')?.querySelector<HTMLElement>('[role=tab]');if(!tab)return;
    anchor=tab;const kind=tab.dataset.documentPage!==undefined?'document':'image';const path=tab.dataset.documentPage??tab.dataset.imagePage;
    const tabs=options.tabs();const index=tabs.findIndex(item=>item.kind===kind&&item.path===path);if(index<0)return;
    const actions:Array<[string,FileTab[]]>=[['このタブを閉じる',[tabs[index]]],['このタブ以外を閉じる',tabs.filter((_,i)=>i!==index)],['左側のタブを閉じる',tabs.slice(0,index)],['右側のタブを閉じる',tabs.slice(index+1)],['すべてのタブを閉じる',tabs]];
    menu.replaceChildren();
    for(const [label,targets] of actions){const button=document.createElement('button');button.type='button';button.role='menuitem';button.textContent=label;button.disabled=!targets.length;button.onclick=()=>{dismiss();if(!options.busy())void options.close(targets).catch(options.report);};menu.append(button);}
    menu.hidden=false;const bounds=menu.getBoundingClientRect();menu.style.left=`${Math.max(0,Math.min(x,innerWidth-bounds.width))}px`;menu.style.top=`${Math.max(0,Math.min(y,innerHeight-bounds.height))}px`;menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }
  strip.addEventListener('contextmenu',event=>{if(!(event.target as HTMLElement).closest('.document-tab'))return;event.preventDefault();show(event.target as HTMLElement,event.clientX,event.clientY);});
  strip.addEventListener('keydown',event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();const target=event.target as HTMLElement;const bounds=target.getBoundingClientRect();show(target,bounds.left,bounds.bottom);}});
  document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target as Node))dismiss();});
  document.addEventListener('keydown',event=>{if(menu.hidden)return;if(event.key==='Escape'){event.preventDefault();dismiss(true);}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const buttons=[...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];const index=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();}else if(event.key==='Tab')dismiss();});
  strip.addEventListener('scroll',()=>dismiss());window.addEventListener('resize',()=>dismiss());
}
