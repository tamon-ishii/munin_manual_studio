/** Shared presentation for both static HTML dialogs and dynamically created dialogs. */
import {isCompactDialog,canExpandDialog,removeNativeWindowControls} from './dialogSizing';
let installed=false;
const prepared=new WeakSet<HTMLDialogElement>();
const pending=new WeakSet<HTMLDialogElement>();
const widthLimits=new WeakMap<HTMLDialogElement,number>();

function sizeDialog(dialog:HTMLDialogElement):void{
  if(!dialog.open||document.body.matches('.proofreading-window,.native-dialog-window'))return;
  if(dialog.classList.contains('dialog-expanded'))return;
  const maxWidth=Math.max(0,innerWidth-32),maxHeight=Math.max(0,innerHeight-32);
  dialog.style.setProperty('max-width',`${maxWidth}px`,'important');
  dialog.style.setProperty('max-height',`${maxHeight}px`,'important');
  if(dialog.dataset.dialogUserSized==='true')return;
  // Settings and docked reports have CSS-defined layouts.
  if(dialog.matches('#panel-settings,#reader-review-results,[data-resource-replacement]'))return;
  const columns=dialog.querySelector('.proofreading-grid') as HTMLElement|null;
  const wide=dialog.querySelector('table,.selection-diff-columns,.generation-diff,.image-comparison-grid,.settings-grid');
  const rich=dialog.querySelector('textarea,pre,dl')||dialog.querySelectorAll('input,select').length>4;
  const initialWidth=Number(dialog.dataset.dialogInitialWidth);
  const initialHeight=Number(dialog.dataset.dialogInitialHeight);
  let preferred=initialWidth>0?initialWidth:isCompactDialog(dialog)?480:columns?Number(columns.style.getPropertyValue('--proofreading-columns'))*280+48:wide?1040:rich?720:520;
  const explicitLimit=widthLimits.get(dialog);
  if(explicitLimit!==undefined)preferred=Math.min(preferred,explicitLimit);
  dialog.style.setProperty('width',`${Math.min(preferred,innerWidth*0.92,maxWidth)}px`,'important');
  // Modal dialogs have both block insets set by the browser. `auto` stretches
  // between them; preserve content sizing instead of filling the viewport.
  dialog.style.height=initialHeight>0?`${Math.min(initialHeight,maxHeight)}px`:'fit-content';
}

function schedule(dialog:HTMLDialogElement):void{
  // Hide the source before the next paint, including while the child webview starts.
  if('__TAURI_INTERNALS__' in window&&!document.body.matches('.proofreading-window,.native-dialog-window')&&dialog.open){
    dialog.classList.add('native-dialog-source');
  }
  if(pending.has(dialog))return;
  pending.add(dialog);requestAnimationFrame(()=>{
    pending.delete(dialog);sizeDialog(dialog);
    if('__TAURI_INTERNALS__' in window&&!document.body.matches('.proofreading-window,.native-dialog-window')&&dialog.open&&dialog.isConnected){
      void import('./nativeDialogHost').then(({hostNativeDialog})=>hostNativeDialog(dialog)).catch(error=>{
        dialog.classList.remove('native-dialog-source');
        if(dialog.isConnected&&dialog.open){const message=document.createElement('p');message.role='alert';message.textContent=`独立ウィンドウを開けませんでした: ${String(error)}`;dialog.append(message);}
        console.error(error);
      });
    }
  });
}

function prepare(dialog:HTMLDialogElement):void{
  if(prepared.has(dialog))return;
  prepared.add(dialog);dialog.classList.add('unified-dialog');
  if(dialog.style.maxWidth.endsWith('px'))widthLimits.set(dialog,parseFloat(dialog.style.maxWidth));
  dialog.addEventListener('pointerdown',event=>{
    const box=dialog.getBoundingClientRect();
    if(event.clientX>box.right-20&&event.clientY>box.bottom-20)dialog.dataset.dialogUserSized='true';
  });
  dialog.addEventListener('close',()=>{
    dialog.classList.remove('dialog-expanded');
    const button=dialog.querySelector<HTMLButtonElement>('[data-dialog-expand]');if(button){button.textContent='最大化';button.setAttribute('aria-label','ダイアログを最大化');}
  });
  if(isCompactDialog(dialog))dialog.dataset.dialogSize='compact';
  if('__TAURI_INTERNALS__' in window&&document.body.matches('.proofreading-window'))removeNativeWindowControls(dialog);
  if(!('__TAURI_INTERNALS__' in window)&&canExpandDialog(dialog)&&!document.body.matches('.proofreading-window,.native-dialog-window')){
    const button=document.createElement('button');button.type='button';button.dataset.dialogExpand='true';button.textContent='最大化';button.setAttribute('aria-label','ダイアログを最大化');
    let savedWidth='',savedHeight='';
    button.onclick=()=>{
      const expanded=dialog.classList.toggle('dialog-expanded');
      if(expanded){savedWidth=dialog.style.width;savedHeight=dialog.style.height;dialog.style.removeProperty('width');dialog.style.removeProperty('max-width');dialog.style.removeProperty('max-height');}
      else{dialog.style.setProperty('width',savedWidth,'important');dialog.style.height=savedHeight;schedule(dialog);}
      button.textContent=expanded?'元のサイズ':'最大化';button.setAttribute('aria-label',expanded?'ダイアログを元のサイズに戻す':'ダイアログを最大化');
    };
    let header=dialog.querySelector<HTMLElement>(':scope > .panel-header');
    if(!header){
      const title=dialog.querySelector<HTMLElement>(':scope > h1,:scope > h2,:scope > form > h2');
      header=document.createElement('div');header.className='panel-header dialog-auto-header';
      if(title){title.before(header);header.append(title);}else dialog.prepend(header);
    }
    let controls=header.querySelector<HTMLElement>(':scope > .actions');
    if(!controls){controls=document.createElement('div');controls.className='actions';header.append(controls);}
    header.querySelectorAll<HTMLButtonElement>(':scope > button').forEach(existing=>controls.append(existing));
    controls.prepend(button);
  }
  schedule(dialog);
}

export function setupDialogPresentation():void{
  if(installed)return;installed=true;
  document.querySelectorAll<HTMLDialogElement>('dialog').forEach(prepare);
  new MutationObserver(records=>{
    for(const record of records){
      if(record.type==='attributes'&&record.target instanceof HTMLDialogElement)schedule(record.target);
      for(const node of record.addedNodes){
        if(!(node instanceof Element))continue;
        if(node instanceof HTMLDialogElement)prepare(node);
        node.querySelectorAll<HTMLDialogElement>('dialog').forEach(prepare);
      }
      for(const node of record.removedNodes){
        if(!(node instanceof Element)||node.isConnected||!('__TAURI_INTERNALS__' in window)||document.body.matches('.proofreading-window,.native-dialog-window'))continue;
        const dialogs=node instanceof HTMLDialogElement?[node]:[...node.querySelectorAll<HTMLDialogElement>('dialog')];
        if(dialogs.length)void import('./nativeDialogHost').then(({releaseNativeDialog})=>dialogs.forEach(releaseNativeDialog));
      }
    }
  }).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['open']});
  window.addEventListener('resize',()=>document.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach(schedule));
}
