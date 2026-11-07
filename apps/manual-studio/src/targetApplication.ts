import {featureDialog} from './imageDialogs';
export interface TargetApplication {command:string;arguments:string[];working_directory:string;information:string;}
export async function configureTargetApplication(request:(action:string,settings?:TargetApplication)=>Promise<TargetApplication>):Promise<boolean>{
  const current=await request('read');
  const {dialog,body}=featureDialog('対象アプリケーションの設定');dialog.id='target-application-dialog';
  const form=document.createElement('form');
  const note=document.createElement('p');note.textContent='起動方法と説明したい内容をAIに伝えます。雛形作成では、AIが対象アプリを起動し、操作・撮影・原稿作成を進めます。';
  const field=(title:string,name:string,value:string,multiline=false)=>{const label=document.createElement('label');label.textContent=title;const input=multiline?document.createElement('textarea'):document.createElement('input');input.name=name;input.value=value;input.setAttribute('aria-label',title);if(input instanceof HTMLTextAreaElement)input.rows=3;label.append(input);form.append(label);return input;};
  form.append(note);
  const command=field('起動コマンド','command',current.command);command.required=true;command.placeholder='例：C:\\Apps\\Sample\\sample.exe または python';
  const args=field('引数（1行に1つ）','arguments',current.arguments.join('\n'),true);args.placeholder='例：\napp.py\n--project\nC:\\My Projects\\sample';
  const argNote=document.createElement('p');argNote.className='muted';argNote.textContent='空白を含む引数も、そのまま1行に入力します。引用符で囲む必要はありません。';form.append(argNote);
  const cwd=field('ワーキングフォルダ','working_directory',current.working_directory);cwd.placeholder='空欄なら現在のプロジェクト。絶対パスも指定できます。';
  const info=field('AIに伝える情報','information',current.information,true);info.placeholder='アプリ名、説明したい操作、起動後の画面、操作上の注意など';
  const error=document.createElement('p');error.role='alert';const save=document.createElement('button');save.type='submit';save.className='primary';save.textContent='設定を保存';form.append(error,save);body.append(form);
  return new Promise(resolve=>{let saved=false,pending=false;form.onsubmit=event=>{event.preventDefault();if(pending)return;pending=true;save.disabled=true;const close=dialog.querySelector<HTMLButtonElement>('.panel-header button')!;close.disabled=true;void request('save',{command:command.value.trim(),arguments:args.value?args.value.split(/\r?\n/):[],working_directory:cwd.value.trim(),information:info.value.trim()}).then(()=>{saved=true;dialog.close();}).catch(reason=>{error.textContent=String(reason);}).finally(()=>{pending=false;save.disabled=false;close.disabled=false;});};dialog.addEventListener('cancel',event=>{if(pending)event.preventDefault();});dialog.addEventListener('close',()=>resolve(saved),{once:true});});
}
