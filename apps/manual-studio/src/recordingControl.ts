// This window deliberately does not load Milkdown, Mermaid, layout or workspace state.
import { invoke } from '@tauri-apps/api/core';
import { emitTo } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
const capture=document.getElementById('capture-now') as HTMLButtonElement;
const cancel=document.getElementById('capture-cancel') as HTMLButtonElement;
const error=document.getElementById('capture-error')!;
let running=false;
let stopped=false;
let historyTimer:ReturnType<typeof setTimeout>|undefined;
const historyList=document.getElementById('capture-history')!;
const historyStatus=document.getElementById('capture-history-status')!;
let previousHistory='';
interface RecordingHistory { total:number;items:Array<{sequence:number;elapsedMs:number;label:string}> }
async function refreshHistory():Promise<void>{
  if(stopped)return;
  if(running){historyTimer=setTimeout(()=>void refreshHistory(),500);return;}
  try{
    const history=await invoke<RecordingHistory>('operation_recording_history');
    if(stopped||running)return;
    if(!history||!Array.isArray(history.items))return;
    historyStatus.textContent='';
    const serialized=JSON.stringify(history);
    if(serialized===previousHistory)return;
    previousHistory=serialized;
    const scrollTop=historyList.scrollTop;
    const following=historyList.scrollHeight-scrollTop-historyList.clientHeight<24;
    const fragment=document.createDocumentFragment();
    for(const item of history.items){
      const row=document.createElement('li');
      const number=document.createElement('span');number.className='history-number';number.textContent=String(item.sequence);
      const time=document.createElement('time');const seconds=Math.floor(item.elapsedMs/1000);time.textContent=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
      const label=document.createElement('span');label.className='history-label';label.textContent=item.label;
      row.append(number,time,label);fragment.append(row);
    }
    historyList.replaceChildren(fragment);historyList.hidden=history.total===0;
    document.getElementById('capture-history-empty')!.hidden=history.total!==0;
    document.getElementById('capture-history-heading')!.textContent=`操作履歴（${history.total}件）`;
    document.getElementById('capture-history-note')!.hidden=history.total<=100;
    historyList.scrollTop=following?historyList.scrollHeight:scrollTop;
  }catch{if(!stopped&&!running)historyStatus.textContent='操作履歴を更新できません。再試行しています。';}
  finally{if(!stopped)historyTimer=setTimeout(()=>void refreshHistory(),500);}
}
window.addEventListener('pagehide',()=>{stopped=true;clearTimeout(historyTimer);});
void refreshHistory();
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
  catch(failure){error.textContent=`撮影に失敗しました: ${String(failure)}`;await invoke('show_recording_control_again').catch(()=>{});await emitTo('main','manual-studio-screenshot-failed',String(failure)).catch(()=>{});running=false;capture.hidden=true;cancel.disabled=false;cancel.textContent='閉じてMunin Manual Studioに戻る';}
})();});
document.querySelector('header')!.addEventListener('mousedown',event=>{if(event.button===0)void getCurrentWindow().startDragging().catch(()=>{});});
