import {invoke} from '@tauri-apps/api/core';
import {featureDialog} from './imageDialogs';
export interface TargetApplication {command:string;arguments:string[];working_directory:string;information:string;}
export async function configureTargetApplication(
  request:(action:string,settings?:TargetApplication)=>Promise<TargetApplication>,
  projectRoot = '',
):Promise<boolean>{
  const current=await request('read');
  const native='__TAURI_INTERNALS__' in window;
  const {dialog,body}=featureDialog('対象アプリケーションの設定');dialog.id='target-application-dialog';
  const form=document.createElement('form');
  const note=document.createElement('p');note.className='muted';note.textContent='マニュアルの対象アプリの起動方法と概要を設定します。画面の再撮影やAIによる操作手順・変更影響の確認に利用します。';
  const field=(title:string,name:string,value:string,multiline=false,browse?:{folder:boolean;title:string})=>{
    const label=document.createElement('label');label.textContent=title;
    const input=multiline?document.createElement('textarea'):document.createElement('input');
    input.name=name;input.value=value;input.setAttribute('aria-label',title);
    if(input instanceof HTMLTextAreaElement)input.rows=3;
    if(browse&&native&&input instanceof HTMLInputElement){
      const row=document.createElement('div');row.className='folder-picker';
      const btn=document.createElement('button');btn.type='button';btn.textContent='参照…';
      btn.onclick=()=>{void invoke<string|null>('choose_path',{initialPath:input.value.trim(),folder:browse.folder,baseDirectory:projectRoot||undefined,title:browse.title}).then(selected=>{if(selected)input.value=selected;}).catch(reason=>{error.textContent=String(reason);});};
      row.append(input,btn);label.append(row);
    }else{
      label.append(input);
    }
    form.append(label);
    return input;
  };
  const error=document.createElement('p');error.role='alert';error.className='dialog-error';
  form.append(note);
  const command=field('起動コマンド','command',current.command,false,{folder:false,title:'起動コマンド（実行ファイル）を選択'});command.required=true;command.placeholder='例：C:\\Apps\\Sample\\sample.exe または python';
  const args=field('引数（1行に1つ）','arguments',current.arguments.join('\n'),true);args.placeholder='例：\napp.py\n--project\nC:\\My Projects\\sample';
  const argNote=document.createElement('p');argNote.className='muted';argNote.textContent='空白を含む引数も、そのまま1行に入力します。引用符で囲む必要はありません。';form.append(argNote);
  const cwd=field('アプリの起動フォルダー（省略可）','working_directory',current.working_directory,false,{folder:true,title:'アプリの起動フォルダーを選択'});cwd.placeholder='空欄なら現在のプロジェクト。絶対パスも指定できます。';
  const info=field('AIに伝えるアプリの概要','information',current.information,true);info.placeholder='アプリ名、説明したい操作、起動後の画面、操作上の注意など';
  const actions=document.createElement('div');actions.className='actions dialog-actions';
  const cancel=document.createElement('button');cancel.type='button';cancel.textContent='キャンセル';cancel.onclick=()=>dialog.close();
  const save=document.createElement('button');save.type='submit';save.className='primary';save.textContent='設定を保存';
  actions.append(cancel,save);
  form.append(error,actions);body.append(form);
  return new Promise(resolve=>{let saved=false,pending=false;form.onsubmit=event=>{event.preventDefault();if(pending)return;pending=true;save.disabled=cancel.disabled=true;const close=dialog.querySelector<HTMLButtonElement>('.panel-header button')!;close.disabled=true;void request('save',{command:command.value.trim(),arguments:args.value?args.value.split(/\r?\n/):[],working_directory:cwd.value.trim(),information:info.value.trim()}).then(()=>{saved=true;dialog.close();}).catch(reason=>{error.textContent=String(reason);}).finally(()=>{pending=false;save.disabled=cancel.disabled=false;close.disabled=false;});};dialog.addEventListener('cancel',event=>{if(pending)event.preventDefault();});dialog.addEventListener('close',()=>resolve(saved),{once:true});});
}
