import {invoke} from '@tauri-apps/api/core';
import {featureDialog} from './screenshotWorkflow';
import type {LaunchCommand} from './types';
interface Options{root():string;applications():LaunchCommand[];request(action:string,json:Record<string,unknown>,root:string):Promise<string>;work(run:()=>Promise<void>):Promise<void>;refresh():Promise<void>;reloadApplications():Promise<void>;report(message:string,error?:boolean):void;}
interface LaunchIdentity{pid:number;host_pid:number;program:string;}
interface TargetApplication extends LaunchCommand{launch?:LaunchIdentity;}
interface TargetWindow{query:string;title:string;app:string;pid?:number;program?:string;}
export function setupScreenshotAi(options:Options){
  let insertionWarning:string|undefined;
  const rawOriginal=Symbol('raw-original');
  function retryStage<T>(stage:string,run:()=>Promise<T>,root:string,allowOriginal?:false):Promise<T|undefined>;
  function retryStage<T>(stage:string,run:()=>Promise<T>,root:string,allowOriginal:true):Promise<T|typeof rawOriginal|undefined>;
  async function retryStage<T>(stage:string,run:()=>Promise<T>,root:string,allowOriginal=false):Promise<T|typeof rawOriginal|undefined>{
    while(root===options.root()){
      try{return await run();}catch(error){
        if(root!==options.root()||/AI.*中断|cancelled|canceled/i.test(String(error)))return;
        await foreground();
        const {dialog,body}=featureDialog(`${stage}を再試行`);dialog.id='screenshot-ai-retry';
        const message=document.createElement('p');message.role='alert';message.textContent=`${stage}で失敗しました：${String(error)}`;
        const retained=document.createElement('p');retained.textContent=allowOriginal?'撮影原本・指示・再撮影手順は保存済みです。注釈だけを再試行します。':'入力した指示と完了した段階は保持しています。失敗した段階から再開します。';
        const retry=document.createElement('button');retry.type='button';retry.className='primary';retry.textContent=`${stage}だけ再試行`;retry.dataset.uiIcon='refresh';
        const stop=document.createElement('button');stop.type='button';stop.textContent='ここで終了';body.append(message,retained,retry,stop);
        const choice=await new Promise<'retry'|'original'|'stop'>(resolve=>{let selected:'retry'|'original'|'stop'='stop';retry.onclick=()=>{selected='retry';dialog.close();};stop.onclick=()=>dialog.close();if(allowOriginal){const original=document.createElement('button');original.type='button';original.textContent='注釈なしの原本を使う';original.onclick=()=>{selected='original';dialog.close();};body.append(original);}dialog.addEventListener('close',()=>{resolve(selected);dialog.remove();},{once:true});});
        if(root!==options.root()||choice==='stop')return;
        if(choice==='original'){insertionWarning=`AI注釈は未完了です。番号・注釈なしの撮影原本を表示しています：${String(error)}`;return rawOriginal;}
      }
    }
  }
  async function launch(application:TargetApplication,root:string):Promise<TargetApplication>{
    let failure:unknown,launched=false;
    await options.work(async()=>{try{application.launch=await invoke<LaunchIdentity|undefined>('test_launch_application',{program:application.program,args:application.args,root});launched=true;}catch(error){failure=error;throw error;}});
    if(failure)throw failure;if(!launched)throw new Error('処理を開始できませんでした。実行中の処理が終わってから再試行してください。');return application;
  }
  async function foreground(){await invoke("restore_manual_studio");}
  async function ai(action:string,json:Record<string,unknown>,root:string){let result='',failure:unknown;await options.work(async()=>{try{result=await options.request(action,json,root);}catch(error){failure=error;throw error;}});if(failure)throw failure;if(!result)throw new Error('処理を開始できませんでした。実行中の処理が終わってから再実行してください。');return JSON.parse(result);}
  function applicationDialog(root:string,instruction:string,initial:LaunchCommand & {available?:boolean;reason?:string}):Promise<TargetApplication|null>{
    const {dialog,body}=featureDialog('撮影アプリの登録と起動');dialog.id='screenshot-ai-application';
    const fields={name:document.createElement('input'),program:document.createElement('input'),args:document.createElement('textarea')};fields.name.value=initial.name||"";fields.program.value=initial.program||"";fields.args.value=(initial.args||[]).join('\n');
    for(const [key,text] of [['name','表示名'],['program','起動パス'],['args','起動引数（1行に1つ）']] as const){const label=document.createElement('label');label.textContent=text;label.append(fields[key]);body.append(label);}
    const availability=document.createElement('p');availability.className='muted';availability.textContent=initial.available?'AIが起動パスと引数を設定しました。そのまま登録して起動できます。必要なら修正してください。':`起動先を確認して選択してください。${initial.reason||''}`;body.append(availability);
    const browse=document.createElement('button');browse.type='button';browse.textContent='アプリを選ぶ';browse.dataset.uiIcon='open';browse.onclick=()=>{void invoke<string|null>('choose_application').then(path=>{if(path){fields.program.value=path;complete.click();}}).catch(error=>options.report(String(error),true));};
    const complete=document.createElement('button');complete.type='button';complete.textContent='AIで起動設定を補完';complete.dataset.uiIcon='sparkle';complete.onclick=()=>{void(async()=>{try{const app=await ai('screenshot-ai-application',{instruction,applications:options.applications(),selected_application:{name:fields.name.value,program:fields.program.value,args:fields.args.value.split('\n').filter(Boolean)}},root) as LaunchCommand;if(root!==options.root()||!dialog.open)return;fields.name.value=app.name||'';fields.program.value=app.program||'';fields.args.value=(app.args||[]).join('\n');availability.textContent='AIが起動パスと引数を補完しました。登録して起動できます。';}catch(e){error.textContent=String(e);}})();};
    const run=document.createElement('button');run.type='button';run.className='primary';run.textContent='登録して起動';run.dataset.uiIcon='application';const error=document.createElement('p');error.role='alert';body.append(browse,complete,error,run);
    return new Promise(resolve=>{let app:TargetApplication|null=null;run.onclick=()=>{void options.work(async()=>{try{
      if(root!==options.root())throw new Error('プロジェクトが変更されました。');
      const proposed={id:initial.id||`app-${crypto.randomUUID()}`,name:fields.name.value.trim(),program:fields.program.value.trim(),args:fields.args.value.split('\n').filter(value=>value.length>0)};
      if(!proposed.program)throw new Error('起動するアプリを選択してください。');
      run.disabled=true;
      const launch=await invoke<LaunchIdentity|undefined>('test_launch_application',{program:proposed.program,args:proposed.args,root});
      if(root!==options.root())return;
      const profiles=options.applications().map(item=>({...item,args:[...item.args]}));const index=profiles.findIndex(item=>item.id===proposed.id||item.program===proposed.program);
      if(index>=0){proposed.id=profiles[index].id||proposed.id;profiles[index]=proposed;}else profiles.push(proposed);
      await invoke('save_launch_commands',{root,commands:profiles});await options.reloadApplications();app={...proposed,launch};dialog.close();
    }catch(e){error.textContent=String(e);}finally{run.disabled=false;}});};dialog.addEventListener('close',()=>resolve(app),{once:true});});
  }
  async function chooseWindow(root:string,application:TargetApplication):Promise<TargetWindow|null>{
    const launch=application.launch;
    let windows:TargetWindow[]=[];
    const deadline=Date.now()+45000;
    do{
      const result=await options.request('list-accessible-windows',{},root);if(root!==options.root())return null;
      windows=(JSON.parse(result) as TargetWindow[]).filter(window=>!launch||window.pid!==launch.host_pid);
      if(launch){
        const exact=windows.filter(window=>window.pid===launch.pid);
        const targets=exact.length?exact:windows.filter(window=>window.program===launch.program);
        if(targets.length){windows=targets;break;}
      }else break;
      await new Promise(resolve=>setTimeout(resolve,300));
    }while(Date.now()<deadline);
    if(launch)windows=windows.filter(window=>window.pid===launch.pid||window.program===launch.program);
    if(!windows.length)throw new Error('起動したアプリのウィンドウが見つかりません。起動状態を確認して再実行してください。');
    if(launch&&windows.length===1)return windows[0];
    await foreground();
    const {dialog,body}=featureDialog('撮影するウィンドウ');const select=document.createElement('select');select.setAttribute('aria-label','撮影ウィンドウ');for(const window of windows)select.add(new Option(`${window.app}：${window.title}`,window.query));const next=document.createElement('button');next.type='button';next.textContent='このウィンドウで手順を作成';body.append(select,next);
    return new Promise(resolve=>{let value:TargetWindow|null=null;next.onclick=()=>{value=windows.find(window=>window.query===select.value)||null;dialog.close();};dialog.addEventListener('close',()=>resolve(value),{once:true});});
  }
  function confirmPlan(plan:{summary:string;recipe:unknown}):Promise<boolean>{
    const {dialog,body}=featureDialog('AI撮影手順を確認');dialog.id='screenshot-ai-plan';const summary=document.createElement('p');summary.textContent=plan.summary;const details=document.createElement('details');const detailsTitle=document.createElement('summary');detailsTitle.textContent='再撮影手順の詳細';details.append(detailsTitle);const recipe=document.createElement('pre');recipe.textContent=JSON.stringify(plan.recipe,null,2);recipe.style.maxHeight='45vh';recipe.style.overflow='auto';const note=document.createElement('p');note.textContent='実際のアプリを操作して撮影し、原本・注釈・再撮影手順を保存します。画像は候補として登録され、確認後に採用できます。';const run=document.createElement('button');run.type='button';run.className='primary';run.textContent='この手順で撮影';run.dataset.uiIcon='camera';details.append(recipe);body.append(summary,note,details,run);
    return new Promise(resolve=>{let value=false;run.onclick=()=>{value=true;dialog.close();};dialog.addEventListener('close',()=>resolve(value),{once:true});});
  }
  async function annotate(id:string,instruction?:string){
    const root=options.root();const text=instruction||await askInstruction('撮影画像にAIで注釈');if(!text||root!==options.root())return;
    await ai('screenshot-ai-annotate',{id,instruction:text},root);if(root===options.root()){await options.refresh();options.report('AI注釈の候補を保存しました。「履歴・管理」で比較して採用してください。');}
  }
  function askInstruction(title:string,chooseApplication?:(app:LaunchCommand|undefined)=>void):Promise<string|null>{
    const {dialog,body}=featureDialog(title);dialog.id='screenshot-ai-instruction';const label=document.createElement('label');label.textContent='撮影・注釈への指示';const input=document.createElement('textarea');input.rows=4;input.placeholder='例：〇〇アプリの設定画面を撮影し、ツールバーのボタンに左から番号を振って';label.append(input);const run=document.createElement('button');run.type='button';run.textContent='指示から作成';const profiles=options.applications();let select:HTMLSelectElement|undefined;if(chooseApplication){const appLabel=document.createElement('label');appLabel.textContent='撮影するアプリ';select=document.createElement('select');select.setAttribute('aria-label','撮影するアプリ');profiles.forEach((app,index)=>select!.add(new Option(app.name||app.program,String(index))));select.add(new Option('新しいアプリ（AIで登録）','new'));appLabel.append(select);const note=document.createElement('p');note.className='muted';note.textContent='登録済みアプリは保存済みの起動パス・引数を使います。アプリ登録のためのAI呼び出しは省略します。';body.append(appLabel,note);}body.append(label,run);
    run.disabled=true;
    input.addEventListener('input',()=>{run.disabled=!input.value.trim();});
    input.focus();
    return new Promise(resolve=>{let value:string|null=null;run.onclick=()=>{if(input.value.trim()){chooseApplication?.(select?.value==='new'?undefined:profiles[Number(select?.value)]);value=input.value.trim();dialog.close();}};dialog.addEventListener('close',()=>resolve(value),{once:true});});
  }
  async function create(fromEditor=false){
    insertionWarning=undefined;
    if(!('__TAURI_INTERNALS__' in window))throw new Error('実画面のAI撮影はデスクトップ版で利用できます。');
    const root=options.root();if(!root)throw new Error('プロジェクトを開いてください。');let registered:LaunchCommand|undefined;const instruction=await askInstruction(fromEditor?'この位置に入れるスクショを指示':'AIに撮影・注釈を指示',app=>registered=app);if(!instruction||root!==options.root())return;
    let app:TargetApplication|null;
    if(registered){options.report('登録済みアプリを起動しています…');app=await retryStage('アプリ起動',()=>launch({...registered!,args:[...registered!.args]},root),root)||null;}
    else{const proposed=await retryStage('アプリ調査',()=>ai('screenshot-ai-application',{instruction,applications:options.applications()},root),root) as LaunchCommand|undefined;if(!proposed||root!==options.root())return;app=await applicationDialog(root,instruction,proposed);}
    if(!app||root!==options.root())return;
    await foreground();
    options.report('起動したアプリのウィンドウを確認しています…');
    const targetWindow=await retryStage('ウィンドウ確認',()=>chooseWindow(root,app!),root);if(!targetWindow||root!==options.root())return;
    await foreground();
    const plan=await retryStage('撮影手順作成',()=>ai('screenshot-ai-plan',{instruction,window:targetWindow.query,application:app},root),root) as {summary:string;recipe:unknown;annotate?:boolean}|undefined;
    if(!plan||root!==options.root())return;
    await foreground();
    if(root!==options.root()||!await confirmPlan(plan)||root!==options.root())return;
    const captured=await retryStage('撮影',()=>ai('screenshot-ai-capture',{instruction,recipe:plan.recipe,window:targetWindow.query},root),root) as {screenshot:{id:string}}|undefined;
    if(!captured)return;
    if(root!==options.root())return;await options.refresh();
    if(plan.annotate!==false){const annotated=await retryStage('注釈',async()=>{await annotate(captured.screenshot.id,instruction);return true;},root,true);if(annotated===undefined)return;await options.refresh();if(annotated===rawOriginal)options.report(`撮影原本と再撮影手順は保存しました。${insertionWarning}`,true);}
    return root===options.root()?captured.screenshot.id:undefined;
  }
  document.getElementById('screenshot-ai-create')!.onclick=()=>{void create().catch(error=>options.report(String(error),true));};
  async function annotateExisting(id:string){const root=options.root();const instruction=await askInstruction('撮影画像にAIで注釈');if(!instruction||root!==options.root())return;await retryStage('注釈',()=>annotate(id,instruction),root);}
  return {create,insertionWarning:()=>insertionWarning,annotate:(id:string)=>annotateExisting(id).catch(error=>options.report(String(error),true))};
}
