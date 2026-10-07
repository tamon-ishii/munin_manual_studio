import { showImageComparison } from './imageComparison';
import { executionSummary } from './workflowPresentation';
import { aiErrorAdvice } from './aiErrors';
export interface ExecutionLimits { timeout_seconds: number; retries: number }
export interface ExecutionEntry { task: {id:string;kind:string;prompt:string}; status:string; error?:string; attempts:number; input:unknown; references:Record<string,string>; capture:unknown }
export interface ExecutionRun { id:string;page:string;status:string;created_at:string;limits:ExecutionLimits;entries:ExecutionEntry[];before?:Record<string,string|null>;after?:Record<string,string|null> }
export function showPartialFailure(failures:Array<{id:string;reason:string}>, entries?: ExecutionEntry[]):Promise<boolean> {
 const dialog=document.createElement('dialog');dialog.id='execution-failure-dialog';
 dialog.setAttribute('aria-labelledby','execution-failure-title');
 dialog.innerHTML='<h2 id="execution-failure-title">一部の更新に失敗しました</h2><p class="execution-counts" role="status"></p><p>成功した文章・図・画像の扱いを選んでください。未完了分は、結果を閉じた後に再実行できます。</p><ul></ul><div class="actions"><button type="button" data-keep class="primary">成功分を採用</button><button type="button" data-rollback>文書と画像を元に戻す</button></div>';
 dialog.querySelector('.execution-counts')!.textContent=entries?executionSummary({entries}):`失敗${failures.length}件`;
 for(const failure of failures){const item=document.createElement('li');item.textContent=`${failure.id}: ${failure.reason}`;const advice=aiErrorAdvice(failure.reason);if(advice){const help=document.createElement('p');help.className='muted';help.textContent=`${advice.title}。${advice.action}`;item.append(help);}dialog.querySelector('ul')!.append(item);}
 document.body.append(dialog);dialog.showModal();return new Promise(resolve=>{
  const finish=(rollback:boolean)=>{dialog.close();dialog.remove();resolve(rollback);};
  dialog.querySelector('[data-keep]')!.addEventListener('click',()=>finish(false));
  dialog.querySelector('[data-rollback]')!.addEventListener('click',()=>finish(true));
  dialog.addEventListener('cancel',event=>{event.preventDefault();finish(false);});
 });
}
export async function showExecutionHistory(runs:ExecutionRun[],actions:{load:(id:string)=>Promise<ExecutionRun>;resume:(id:string)=>Promise<void>;restore:(id:string)=>Promise<void>}):Promise<void>{
 const dialog=document.createElement('dialog');dialog.id='execution-history-dialog';dialog.className='generation-input-dialog';
 dialog.innerHTML='<h2>実行記録・再開・復元</h2><p>未完了のタグだけ再開できます。復元は文書と画像をまとめて戻します。</p><div class="execution-history-list"></div><p role="alert" id="execution-history-error"></p><button type="button" data-close>閉じる</button>';
 const labels:Record<string,string>={running:'未完了',partial:'一部未完了',completed:'完了',rolled_back:'復元済み',interrupted:'中断',pending:'未実行',succeeded:'成功',failed:'失敗',cancelled:'中断'};
 const list=dialog.querySelector('.execution-history-list')!;
 for(const run of runs){
  const card=document.createElement('article');card.className='card';
  const title=document.createElement('h3');title.textContent=`${run.page} — ${labels[run.status]||run.status}`;
  const summary=document.createElement('p');summary.textContent=`${run.created_at} / ${executionSummary(run)} / `+run.entries.map(entry=>`${entry.task.id}: ${labels[entry.status]||entry.status}`).join('・');
  const buttons=document.createElement('div');buttons.className='actions';
  for(const [name,action] of [['入力・画像を確認','inspect'],['未完了を再開','resume'],['更新前へ復元','restore']] as const){
   const button=document.createElement('button');button.type='button';button.textContent=name;
   button.disabled=action==='resume'&&run.status==='completed'||action==='restore'&&run.status==='rolled_back';
   button.addEventListener('click',()=>{void (async()=>{
    buttons.querySelectorAll('button').forEach(button=>button.disabled=true);
    try {
     if(action==='inspect'){
      const detail=await actions.load(run.id);let info=card.querySelector<HTMLElement>('.execution-details');
      if(!info){info=document.createElement('div');info.className='execution-details';card.append(info);}info.replaceChildren();
      const pre=document.createElement('pre');pre.className='result';pre.textContent=JSON.stringify(detail.entries,null,2);info.append(pre);
      const imageNames=new Set([...Object.keys(detail.before||{}),...Object.keys(detail.after||{})].filter(name=>name.endsWith('.png')));
      for(const name of imageNames){
       const images=(['before','after'] as const).flatMap(phase=>detail[phase]?.[name]?[{label:`${phase==='before'?'更新前':'更新後'}: ${name}`,src:`data:image/png;base64,${detail[phase]![name]}`}]:[]);
       if(!images.length)continue;
       const pair=document.createElement('div');pair.className='execution-image-pair';
       for(const item of images){const figure=document.createElement('figure');const caption=document.createElement('figcaption');caption.textContent=item.label;const image=document.createElement('img');image.className='task-image';image.alt=item.label;image.src=item.src;figure.append(caption,image);pair.append(figure);}
       const compare=document.createElement('button');compare.type='button';compare.textContent=images.length===2?'撮影前後を比較・拡大':'画像を拡大';compare.addEventListener('click',()=>{void showImageComparison(images);});info.append(pair,compare);
      }
     }else{dialog.close();if(action==='resume')await actions.resume(run.id);else await actions.restore(run.id);finish();}
    }catch(error){dialog.querySelector('#execution-history-error')!.textContent=String(error);if(!dialog.open)dialog.showModal();}
    finally{buttons.querySelectorAll('button').forEach((button,index)=>button.disabled=index===1&&run.status==='completed'||index===2&&run.status==='rolled_back');}
   })();});buttons.append(button);
  }
  card.append(title,summary,buttons);list.append(card);
 }
 if(!runs.length)list.textContent='実行記録はまだありません。';
 document.body.append(dialog);dialog.showModal();let finish:()=>void=()=>{};
 await new Promise<void>(resolve=>{finish=()=>{dialog.close();dialog.remove();resolve();};dialog.querySelector('[data-close]')!.addEventListener('click',finish);dialog.addEventListener('cancel',event=>{event.preventDefault();finish();});});
}
export function showCaptureExpectations(initial:Record<string,unknown>,save:(value:Record<string,unknown>)=>Promise<void>):Promise<void>{
 const dialog=document.createElement('dialog');dialog.id='capture-expectations-dialog';
 dialog.innerHTML='<form><h2>撮影成功の条件</h2><p>指定した条件に合わない撮影では、既存画像を維持します。</p><label>期待するウィンドウタイトル<input name="window_title" /></label><label>期待する画面要素の文字<input name="screen_text" /></label><div class="settings-grid"><label>画像の幅（任意）<input name="width" type="number" min="1" max="32768" /></label><label>画像の高さ（任意）<input name="height" type="number" min="1" max="32768" /></label></div><label class="checkbox-label"><input name="reject_blank" type="checkbox" />単色の画像を失敗にする</label><p role="alert"></p><div class="actions"><button type="button" data-cancel>キャンセル</button><button type="submit" class="primary">条件を保存</button></div></form>';
 for(const input of dialog.querySelectorAll<HTMLInputElement>('input')){if(input.type==='checkbox')input.checked=Boolean(initial[input.name]);else input.value=String(initial[input.name]??'');}
 document.body.append(dialog);dialog.showModal();return new Promise(resolve=>{
 const finish=()=>{dialog.close();dialog.remove();resolve();};dialog.querySelector('[data-cancel]')!.addEventListener('click',finish);dialog.addEventListener('cancel',event=>{event.preventDefault();finish();});
 dialog.querySelector('form')!.addEventListener('submit',event=>{event.preventDefault();const value:Record<string,unknown>={};for(const input of dialog.querySelectorAll<HTMLInputElement>('input'))value[input.name]=input.type==='checkbox'?input.checked:input.type==='number'?(input.value?Number(input.value):null):input.value;void save(value).then(finish).catch(error=>{dialog.querySelector('[role=alert]')!.textContent=String(error);});});
 });
}
