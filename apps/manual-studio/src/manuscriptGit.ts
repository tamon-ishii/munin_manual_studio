import {confirmAction,featureDialog} from './screenshotWorkflow';
import {appendContentDiff,sameOwner,type ManuscriptOwner,type ManuscriptToolsOptions} from './manuscriptTools';
import type {Document} from './types';

interface GitState {available:boolean;repository:boolean;can_initialize?:boolean;repository_root?:string;status?:string;identity_ready?:boolean;identity_message?:string;message?:string}
interface GitCommit {id:string;timestamp:string;message:string}

export function setupManuscriptGit(options:ManuscriptToolsOptions):()=>void {
  return ()=>{
    const initial=options.current();
    if(!initial){options.report('Git履歴を確認する原稿を選択してください。',true);return;}
    const {dialog,body}=featureDialog('Git履歴・復元');dialog.dataset.manuscriptGit='true';
    let owner:ManuscriptOwner=initial,state:GitState|null=null,running=false,version=0;
    let preview:{owner:ManuscriptOwner;content:string;commit:string}|null=null;
    const note=document.createElement('p');note.textContent='保存した原稿だけを手動でコミットします。履歴を比較して復元でき、復元後は通常の元に戻す操作も使えます。';
    const status=document.createElement('p');status.role='status';status.className='manuscript-git-status';
    const init=document.createElement('button');init.textContent='Gitで履歴管理を始める';init.hidden=true;
    const message=document.createElement('input');message.setAttribute('aria-label','コミットの説明');message.placeholder='例：設定手順の説明を更新';message.maxLength=1000;
    const label=document.createElement('label');label.textContent='コミットの説明';label.append(message);
    const commit=document.createElement('button');commit.textContent='この原稿をコミット';
    const reload=document.createElement('button');reload.textContent='Gitの状態を更新';
    const history=document.createElement('select');history.setAttribute('aria-label','原稿のコミット');
    const show=document.createElement('button');show.textContent='選択した版と比較';
    const restore=document.createElement('button');restore.textContent='確認した版を原稿に復元';restore.className='primary';restore.hidden=true;
    const actions=document.createElement('div');actions.className='actions';actions.append(init,commit,reload,show,restore);
    const diff=document.createElement('div');diff.className='manuscript-git-preview';
    body.append(note,status,label,history,actions,diff);
    const current=()=>dialog.isConnected&&sameOwner(options.current(),owner);
    const sync=()=>{
      init.hidden=!state?.can_initialize;init.disabled=running;message.disabled=running||!state?.repository;
      commit.disabled=running||!state?.repository||!state.identity_ready||!state.status?.trim()||!message.value.trim();
      history.disabled=running||!history.options.length;show.disabled=running||!history.value;
      reload.disabled=running;restore.disabled=running||!preview;restore.hidden=!preview;
    };
    const perform=async(operation:()=>Promise<void>)=>{
      if(running)return;
      if(!current()){status.role='alert';status.textContent='原稿が変更されています。Git履歴を開き直してください。';return;}
      running=true;sync();
      try{await options.work(async()=>{try{await operation();}catch(error){if(dialog.isConnected){status.role='alert';status.textContent=String(error);}}});}
      finally{running=false;if(dialog.isConnected)sync();}
    };
    const load=async()=>{
      const snapshot=options.current();if(!snapshot||snapshot.root!==owner.root||snapshot.page!==owner.page||snapshot.session!==owner.session)throw new Error('原稿が切り替わりました。Git履歴を開き直してください。');
      owner=snapshot;preview=null;diff.replaceChildren();history.replaceChildren();
      state=JSON.parse(await options.request('manuscript-git-status',{json:{page:owner.page}},owner.root)) as GitState;
      if(!current())return;status.role='status';
      if(!state.repository){status.textContent=state.message||'このフォルダーはGitで管理されていません。';return;}
      status.textContent=`${owner.page} — ${state.status?.trim()?'保存内容に未コミットの変更があります。':'コミット済みです。'}${state.identity_ready?'':' Gitに名前とメールを設定してください（git config user.name / git config user.email）。'}`;
      const result=JSON.parse(await options.request('manuscript-git-history',{json:{page:owner.page}},owner.root)) as {items:GitCommit[]};
      if(!current())return;
      if(!result.items.length)status.textContent+=' まだこの原稿の履歴はありません。';
      for(const item of result.items){const option=document.createElement('option');option.value=item.id;option.textContent=`${new Date(Number(item.timestamp)*1000).toLocaleString()} — ${item.message} (${item.id.slice(0,8)})`;history.append(option);}
    };
    message.oninput=sync;
    history.onchange=()=>{++version;preview=null;restore.hidden=true;diff.replaceChildren();sync();};
    reload.onclick=()=>{void perform(load);};
    init.onclick=()=>{void perform(async()=>{
      if(!await confirmAction('このプロジェクトでGitによる履歴管理を始めます。原稿は変更せず、Gitの管理情報を作成します。','Gitを初期化'))return;
      if(!current())return;
      await options.request('manuscript-git-init',{json:{confirm:true}},owner.root);await load();
    });};
    commit.onclick=()=>{void perform(async()=>{
      await options.prepare([owner.page]);if(!current())return;const saved=options.current()!;
      await options.request('manuscript-git-commit',{json:{page:saved.page,revision:saved.revision,message:message.value}},saved.root);
      message.value='';await load();if(current())status.textContent+=' 原稿をコミットしました。';
    });};
    show.onclick=()=>{void perform(async()=>{
      const selected=history.value,snapshot=options.current();if(!snapshot||!selected)return;const request=++version;
      const result=JSON.parse(await options.request('manuscript-git-version',{json:{page:snapshot.page,commit:selected}},snapshot.root)) as {content:string};
      if(!current()||request!==version||history.value!==selected||!sameOwner(options.current(),snapshot))return;
      preview={owner:snapshot,content:result.content,commit:selected};diff.replaceChildren();
      appendContentDiff(diff,snapshot.content,result.content,`${snapshot.page} — ${selected.slice(0,8)} の内容へ復元`);
      status.textContent='変更前と変更後を確認してください。復元するまで原稿は変わりません。';
    });};
    restore.onclick=()=>{void perform(async()=>{
      const selected=preview;if(!selected||!sameOwner(options.current(),selected.owner))throw new Error('原稿が変更されています。比較し直してください。');
      await options.prepare([owner.page]);if(!current())return;const saved=options.current()!;
      const result=JSON.parse(await options.request('editor-batch-save',{json:{documents:[{page:saved.page,revision:saved.revision,content:selected.content}]}},saved.root)) as {documents:Document[]};
      if(!sameOwner(options.current(),saved)||!dialog.isConnected)return;
      await options.changed(result.documents);owner=options.current()!;await load();
      status.textContent='確認した版を復元しました。元に戻す操作で復元前の原稿へ戻せます。変更はまだコミットしていません。';
    });};
    sync();void perform(load);
  };
}
