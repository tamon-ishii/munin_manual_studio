// This window deliberately does not load Milkdown, Mermaid, layout or workspace state.
import { invoke } from '@tauri-apps/api/core';
import { emitTo } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
const capture=document.getElementById('capture-now') as HTMLButtonElement;
const cancel=document.getElementById('capture-cancel') as HTMLButtonElement;
const error=document.getElementById('capture-error')!;
let running=false;
async function cancelRecording():Promise<void>{
  if(running)return;
  running=true;capture.disabled=cancel.disabled=true;
  try{await invoke('cancel_operation_recording');}
  catch(failure){error.textContent=String(failure);running=false;capture.disabled=cancel.disabled=false;}
}
// Register before initializing any optional UI behavior.
document.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();void cancelRecording();}},true);
cancel.addEventListener('click',()=>{void cancelRecording();});
capture.addEventListener('click',()=>{void(async()=>{
  if(running)return;running=true;capture.disabled=cancel.disabled=true;capture.textContent='撮影してMarkItsを起動中…';
  try{await emitTo('main','manual-studio-screenshot-requested');await invoke('finish_operation_recording');}
  catch(failure){error.textContent=`撮影に失敗しました: ${String(failure)}`;await invoke('show_recording_control_again').catch(()=>{});await emitTo('main','manual-studio-screenshot-failed',String(failure)).catch(()=>{});running=false;capture.disabled=cancel.disabled=false;capture.textContent='スクリーンショットを実行';}
})();});
document.querySelector('header')!.addEventListener('mousedown',event=>{if(event.button===0)void getCurrentWindow().startDragging().catch(()=>{});});
