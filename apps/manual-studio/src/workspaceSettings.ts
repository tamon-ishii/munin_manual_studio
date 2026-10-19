import {featureDialog} from './screenshotWorkflow';
import {stageLabels,type TimingRecord} from './operationTimings';
interface Paths {docs:string;assets:string;output:string}
interface Options {
 root():string;
 request(action:string,options:Record<string,unknown>,root:string):Promise<string>;
 prepare():Promise<boolean>;
 changed(root:string):Promise<void>;
}
export async function showWorkspacePaths(options:Options):Promise<void>{
 const root=options.root();if(!root)throw new Error('先にプロジェクトを開いてください。');
 const paths=JSON.parse(await options.request('workspace-paths-read',{},root)) as Paths;
 if(root!==options.root())return;
 const {dialog,body}=featureDialog('原稿・画像の保存先');dialog.id='workspace-paths-dialog';
 const project=document.createElement('p');project.textContent=`プロジェクト: ${root}`;
 const note=document.createElement('p');note.textContent='プロジェクト内の相対パスを指定します。「.」は開いたフォルダー自身です。既存の原稿・画像は移動しません。原稿フォルダーを変えると一覧を読み直します。';
 const form=document.createElement('form');const fields={} as Record<keyof Paths,HTMLInputElement>;
 for(const [key,title] of [['docs','原稿フォルダー'],['assets','画像保存先'],['output','HTML出力先']] as const){
  const label=document.createElement('label');label.textContent=title;const input=document.createElement('input');
  input.value=paths[key];input.required=true;input.setAttribute('aria-label',title);input.dataset.workspacePath=key;
  label.append(input);form.append(label);fields[key]=input;
 }
 const error=document.createElement('p');error.role='alert';
 const save=document.createElement('button');save.type='submit';save.className='primary';save.textContent='保存先を変更';
 const cancel=document.createElement('button');cancel.type='button';cancel.textContent='キャンセル';cancel.onclick=()=>dialog.close();
 const actions=document.createElement('div');actions.className='actions';actions.append(cancel,save);form.append(error,actions);body.append(project,note,form);
 let saving=false;
 const setSaving=(value:boolean)=>{saving=value;dialog.querySelectorAll<HTMLButtonElement|HTMLInputElement>('button,input').forEach(control=>{control.disabled=value;});};
 dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
 form.onsubmit=event=>{event.preventDefault();if(saving)return;setSaving(true);
  void(async()=>{try{
   if(root!==options.root())throw new Error('プロジェクトが切り替わりました。開き直してください。');
   if(!await options.prepare())return;
   if(root!==options.root())throw new Error('プロジェクトが切り替わりました。');
   await options.request('workspace-paths-save',{json:{expected:paths,docs:fields.docs.value,assets:fields.assets.value,output:fields.output.value}},root);
   dialog.close();await options.changed(root);
  }catch(reason){error.textContent=String(reason);}finally{setSaving(false);}})();
 };
 fields.docs.focus();
}
export async function showOperationTimings(options:Pick<Options,'root'|'request'>):Promise<void>{
 const root=options.root();const result=JSON.parse(await options.request('operation-timings-read',{},root)) as {items:TimingRecord[]};
 if(root!==options.root())return;
 const {dialog,body}=featureDialog('撮影・挿入の処理時間');dialog.id='operation-timings-dialog';
 const note=document.createElement('p');note.textContent='直近50件を表示します。アプリ操作・MarkItsでの編集と保存・挿入確認の時間は操作待ちに含み、Studio内の処理時間と分けて表示します。本文・画像・APIキーは記録しません。';body.append(note);
 if(!result.items.length){const empty=document.createElement('p');empty.textContent='処理時間の記録はまだありません。';body.append(empty);}
 for(const item of result.items){
  const details=document.createElement('details');const summary=document.createElement('summary');
  const processing=item.stages.filter(stage=>!stage.waiting).reduce((sum,stage)=>sum+stage.duration_ms,0);
  const waiting=item.stages.filter(stage=>stage.waiting).reduce((sum,stage)=>sum+stage.duration_ms,0);
  summary.textContent=`${new Date(item.at).toLocaleString()} ${item.operation==='markits-import'?'MarkIts取り込み':'スクリーンショット挿入'}・${({success:'完了',cancelled:'取消',error:'失敗'} as Record<string,string>)[item.outcome]||item.outcome}：処理 ${(processing/1000).toFixed(2)}秒 / 操作待ち ${(waiting/1000).toFixed(2)}秒`;
  const table=document.createElement('table');const head=document.createElement('tr');for(const label of ['工程','区分','秒']){const cell=document.createElement('th');cell.textContent=label;head.append(cell);}table.append(head);
  for(const stage of item.stages){const row=document.createElement('tr');for(const text of [stageLabels[stage.stage]||stage.stage,stage.waiting?'操作待ち':'処理',(stage.duration_ms/1000).toFixed(3)]){const cell=document.createElement('td');cell.textContent=text;row.append(cell);}table.append(row);}
  details.append(summary,table);body.append(details);
 }
}
