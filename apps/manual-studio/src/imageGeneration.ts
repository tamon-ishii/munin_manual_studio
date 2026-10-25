import { featureDialog } from './screenshotWorkflow';
import { showImageComparison } from './imageComparison';
import type {ImageAiSettings} from './imageAiSettings';
export interface ImageGenerationEntry {
  id:string;path?:string;prompt:string;provider?:string;model?:string;endpoint?:string;
  created_at:string;status?:string;error?:string;reference?:string;parent_id?:string;
}
interface Capability {provider:string;installed:boolean;login:string;image:string;message:string}
interface Options {
  prepare?():Promise<void>;imageKey?(root:string,endpoint:string):string;sharedKey?(root:string):string;
  root():string;page():string|undefined;
  request(action:string,options:Record<string,unknown>,root:string):Promise<string>;
  work(operation:()=>Promise<void>):Promise<void>;refresh():Promise<void>;insert(path:string):Promise<boolean>;
}
export function setupImageGeneration(options:Options) {
  async function open(seed?:ImageGenerationEntry,edit=false) {
    await options.work(async()=>{
      const root=options.root();if(!root)throw new Error('プロジェクトを開いてください。');
      let settings=JSON.parse(await options.request('image-generation-settings',{},root)) as ImageAiSettings;
      if(settings.provider==='shared'){await options.prepare?.();settings=JSON.parse(await options.request('image-generation-settings',{},root)) as ImageAiSettings;}
      if(root!==options.root())return;
      const {dialog,body}=featureDialog('AI作画');dialog.dataset.aiImage='true';
      const close=dialog.querySelector<HTMLButtonElement>('.panel-header button')!;
      function field(label:string,value:string,type='text'){
        const wrapper=document.createElement('label');wrapper.textContent=label;
        const input=document.createElement('input');input.type=type;input.value=value;wrapper.append(input);return {wrapper,input};
      }
      const providerLabel=document.createElement('label');providerLabel.textContent='生成方法';
      const provider=document.createElement('select');provider.setAttribute('aria-label','生成方法');
      for(const [value,label] of [['shared','文章・図の生成AIと同じ接続'],['agy','Agy（Antigravity）'],['codex','Codex'],['api','画像API']])provider.add(new Option(label,value));
      provider.value=settings.provider==='shared'?'shared':seed?.provider&&['agy','codex','api'].includes(seed.provider)?seed.provider:settings.provider==='codex'||settings.provider==='api'?settings.provider:'agy';providerLabel.append(provider);
      const providerHint=document.createElement('p');providerHint.className='form-hint';
      const connectionStatus=document.createElement('p');connectionStatus.className='image-connection-status';connectionStatus.role='status';
      const check=document.createElement('button');check.type='button';check.textContent='接続状態を確認';
      const connection=document.createElement('div');connection.className='image-connection';connection.append(connectionStatus,check);
      const promptLabel=document.createElement('label');promptLabel.textContent='画像の指示';
      const prompt=document.createElement('textarea');prompt.rows=4;prompt.setAttribute('aria-label','画像の指示');prompt.value=edit?'':seed?.prompt||'';prompt.placeholder='描きたい内容、または元画像から変更したい点を入力';promptLabel.append(prompt);
      const referenceLabel=document.createElement('label');referenceLabel.className='image-reference-control';
      const reference=document.createElement('input');reference.type='checkbox';reference.checked=edit||Boolean(seed?.reference&&!seed?.path);reference.setAttribute('aria-label','元画像を使って修正');
      const referenceText=document.createElement('span');referenceText.textContent='元画像を使って修正（元画像は保持）';referenceLabel.append(reference,referenceText);
      let referencePath=seed?.path||seed?.reference||'',parentId=seed?.path?seed.id:seed?.parent_id||'';
      referenceLabel.hidden=!referencePath;
      const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='作画の接続設定（オプション）';details.append(summary);
      const model=field('画像モデル',seed?.provider==='api'?seed.model||settings.model:settings.model);
      const endpoint=field('画像APIのURL',seed?.endpoint||settings.endpoint);
      const key=field('外部画像APIキー（保存しません）',options.imageKey?.(root,settings.endpoint)||'','password');key.input.autocomplete='off';
      const apiHint=document.createElement('p');apiHint.className='form-hint';apiHint.textContent='APIキーを入力するか、起動環境の MUNIN_IMAGE_API_KEY / OPENAI_API_KEY を利用します。';details.append(model.wrapper,endpoint.wrapper,key.wrapper,apiHint);
      const actions=document.createElement('div');actions.className='actions';
      function action(label:string){const button=document.createElement('button');button.type='button';button.textContent=label;actions.append(button);return button;}
      const generate=action('画像を生成');generate.className='primary';
      const cancel=action('生成を中断');cancel.className='progress-control';cancel.hidden=true;
      const retry=action('再試行');retry.hidden=true;
      const insert=action('原稿に挿入');insert.disabled=true;
      const modify=action('この画像を修正');modify.disabled=true;
      const compare=action('選択した画像を比較');compare.disabled=true;
      const status=document.createElement('p');status.className='image-generation-status';status.role='status';status.setAttribute('aria-live','polite');
      const selectionInfo=document.createElement('p');selectionInfo.className='image-selection-info muted';
      const providerName=(name?:string)=>name==='codex'?'Codex':name==='agy'?'Agy':name==='api'?'画像API':name||'画像';
      const historyHeading=document.createElement('h2');historyHeading.textContent='作画履歴';historyHeading.className='image-history-heading';
      const historyHelp=document.createElement('p');historyHelp.className='muted';historyHelp.textContent='指示を再利用できます。比較する画像にチェックを付けてください。';
      const stack=document.createElement('div');stack.className='generated-images-stack';
      const historyFailures=document.createElement('div');historyFailures.className='image-history-failures';
      const image=document.createElement('img');image.className='generated-image-preview';image.alt='AI生成画像';image.hidden=true;
      body.append(providerLabel,providerHint,connection,promptLabel,referenceLabel,details,actions,status,image,selectionInfo,historyHeading,historyHelp,stack,historyFailures);
      let history:ImageGenerationEntry[]=[],selected:ImageGenerationEntry|undefined, running=false,activeJob='',cancelRequested=false;
      let capabilities:Capability[]=[],probeVersion=0,selectionVersion=0;
      const previews=new Map<string,string>(),comparison=new Set<string>();
      function sync(){
        selectionInfo.textContent=selected?`${providerName(selected.provider)} ／ ${selected.created_at||''} ／ ${selected.path}`:'';
        provider.disabled=prompt.disabled=reference.disabled=model.input.disabled=endpoint.input.disabled=key.input.disabled=running;
        close.disabled=generate.disabled=check.disabled=running;
        cancel.hidden=!running;cancel.disabled=cancelRequested;retry.disabled=running;
        insert.disabled=modify.disabled=running||!selected?.path;
        compare.disabled=running||comparison.size<2;
        for(const button of stack.querySelectorAll<HTMLButtonElement>('button'))button.disabled=running;
        for(const input of stack.querySelectorAll<HTMLInputElement>('input'))input.disabled=running;
        for(const button of historyFailures.querySelectorAll<HTMLButtonElement>('button'))button.disabled=running;
      }
      function updateProvider(){
        const shared=provider.value==='shared',effective=shared?settings.shared_provider:provider.value;
        details.hidden=effective!=='api';endpoint.wrapper.hidden=key.wrapper.hidden=shared;
        providerHint.textContent=shared?settings.shared_error||`文章・図と同じ接続を使います：${settings.shared_provider}${settings.shared_endpoint?` ／ ${settings.shared_endpoint}`:''}`:provider.value==='codex'?'Codexの組み込みAI作画を使います。':provider.value==='agy'?'AgyのAI作画を使います。':'画像APIに直接接続します。';
        connectionStatus.textContent=shared&&settings.shared_error?settings.shared_error:capabilities.find(item=>item.provider===effective)?.message||'接続状態は未確認です。';
      }
      async function checkConnection(){
        const version=++probeVersion;check.disabled=true;connectionStatus.textContent='接続状態を確認中…';
        try{const result=JSON.parse(await options.request('image-generation-capabilities',{json:{api_key:provider.value==='shared'?options.sharedKey?.(root)||'':provider.value==='api'?key.input.value:''}},root)) as {items:Capability[]};if(version!==probeVersion||!dialog.isConnected||root!==options.root())return;capabilities=result.items||[];updateProvider();}
        catch(error){if(version===probeVersion)connectionStatus.textContent=String(error);}
        finally{if(version===probeVersion)check.disabled=running;}
      }
      key.input.addEventListener('input',()=>{if(provider.value==='api')connectionStatus.textContent=key.input.value.trim()?'APIキーを入力済みです。利用権限は生成時に確認します。':capabilities.find(item=>item.provider==='api')?.message||'APIキーを入力してください。';});
      endpoint.input.addEventListener('input',()=>{key.input.value=options.imageKey?.(root,endpoint.input.value)||'';});
      provider.addEventListener('change',()=>{updateProvider();});check.onclick=()=>{void checkConnection();};updateProvider();
      async function preview(entry:ImageGenerationEntry){
        if(!entry.path)return '';let source=previews.get(entry.path);
        if(!source){source=await options.request('resources-image',{asset:entry.path},root);previews.set(entry.path,source);}return source;
      }
      async function select(entry:ImageGenerationEntry){
        if(running)return;const version=++selectionVersion;selected=undefined;prompt.value=entry.prompt||'';
        if(provider.value!=='shared'&&entry.provider&&['agy','codex','api'].includes(entry.provider))provider.value=entry.provider;
        if(entry.provider==='api'&&entry.model)model.input.value=entry.model;
        if(entry.endpoint&&entry.endpoint!==endpoint.input.value){endpoint.input.value=entry.endpoint;key.input.value=options.imageKey?.(root,entry.endpoint)||'';}
        referencePath=entry.path||entry.reference||'';parentId=entry.path?entry.id:entry.parent_id||'';reference.checked=!entry.path&&Boolean(entry.reference);referenceLabel.hidden=!referencePath;
        image.hidden=true;image.removeAttribute('src');
        retry.hidden=!['failed','cancelled','interrupted'].includes(entry.status||'');status.textContent=entry.error||'';updateProvider();sync();
        if(entry.path){
          try{const source=await preview(entry);if(version!==selectionVersion||running||!dialog.isConnected||root!==options.root())return;selected=entry;image.src=source;image.hidden=false;}
          catch(error){if(version!==selectionVersion||running||!dialog.isConnected||root!==options.root())return;status.textContent=`画像を読み込めません。${String(error)}`;}
          sync();
        }
      }
      async function loadHistory(){
        const result=JSON.parse(await options.request('image-generation-history',{},root)) as {items:ImageGenerationEntry[]};if(root!==options.root()||!dialog.isConnected)return;
        history=result.items||[];stack.replaceChildren();historyFailures.replaceChildren();
        for(const entry of history){
          if(entry.path){
            const tile=document.createElement('div');tile.className='generated-stack-item';tile.dataset.imageId=entry.id;
            const choose=document.createElement('button');choose.type='button';choose.title=`${entry.prompt} ／ ${providerName(entry.provider)||entry.model||''} ／ ${entry.created_at}`;choose.setAttribute('aria-label',`作画履歴: ${entry.prompt}`);
            const thumb=document.createElement('img');thumb.alt=entry.prompt;choose.append(thumb);choose.onclick=()=>{void select(entry);};
            const compareLabel=document.createElement('label');compareLabel.className='generated-compare-control';const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.setAttribute('aria-label',`比較する画像: ${entry.prompt}`);checkbox.checked=comparison.has(entry.id);checkbox.onchange=()=>{checkbox.checked?comparison.add(entry.id):comparison.delete(entry.id);sync();};compareLabel.append(checkbox);
            tile.append(choose,compareLabel);stack.append(tile);void options.request('resources-thumbnail',{asset:entry.path},root).then(source=>{if(tile.isConnected)thumb.src=source;}).catch(()=>{choose.title+='（画像が見つかりません）';});
          }else{
            const row=document.createElement('div');row.className='image-history-failure';const info=document.createElement('p');info.textContent=`${entry.status==='cancelled'?'中断':entry.status==='running'?'実行中':entry.status==='interrupted'?'異常終了':'失敗'} ／ ${providerName(entry.provider)} ／ ${entry.prompt}`;
            const reuse=document.createElement('button');reuse.type='button';reuse.textContent=entry.status==='interrupted'?'指示を確認して再試行':'指示を再利用';reuse.onclick=()=>{void select(entry);};row.append(info,reuse);historyFailures.append(row);
          }
        }
        historyHelp.textContent=history.length?'指示を再利用できます。比較する画像にチェックを付けてください。':'生成した画像と指示はここに保存され、次回も利用できます。';sync();
      }
      dialog.addEventListener('cancel',event=>{if(running)event.preventDefault();});
      close.onclick=()=>{if(!running)dialog.close();};
      cancel.onclick=()=>{void(async()=>{
        if(!running||!activeJob||cancelRequested)return;cancelRequested=true;sync();status.textContent='中断を要求しています…';
        try{await options.request('image-generation-cancel',{id:activeJob},root);status.textContent='中断要求を送信しました。停止を待っています…';}
        catch(error){cancelRequested=false;status.textContent=String(error);sync();}
      })();};
      async function run(){
        if(running||root!==options.root())return;if(!prompt.value.trim()){status.textContent='画像の指示を入力してください。';return;}
        ++selectionVersion;running=true;cancelRequested=false;activeJob=`image-job-${crypto.randomUUID()}`;retry.hidden=true;sync();
        const started=Date.now();status.textContent='画像を生成中です…';
        const timer=setInterval(()=>{if(!cancelRequested)status.textContent=`画像を生成中です… ${Math.floor((Date.now()-started)/1000)}秒`;},1000);
        await options.work(async()=>{
          try{
            if(provider.value==='shared')await options.prepare?.();
            await options.request('image-generation-settings',{json:{save:true,provider:provider.value,model:model.input.value,endpoint:endpoint.input.value}},root);
            const result=JSON.parse(await options.request('image-generate',{json:{job_id:activeJob,prompt:prompt.value,provider:provider.value,model:model.input.value,endpoint:endpoint.input.value,api_key:provider.value==='shared'?options.sharedKey?.(root)||'':provider.value==='api'?key.input.value:'',reference:reference.checked?referencePath:undefined,parent_id:reference.checked?parentId:undefined}},root)) as ImageGenerationEntry;
            if(root!==options.root())return;
            selected=result;referencePath=result.path||'';parentId=result.id;reference.checked=false;referenceLabel.hidden=!referencePath;
            image.src=await preview(result);image.hidden=false;await options.refresh();status.textContent='画像を保存しました。プレビューを確認して原稿へ挿入できます。';
          }catch(error){status.textContent=String(error);retry.hidden=false;if(provider.value==='api'&&String(error).includes('APIキー')){details.open=true;key.input.focus();}}
          finally{clearInterval(timer);running=false;cancelRequested=false;activeJob='';await loadHistory().catch(()=>{});}
        });sync();
      }
      generate.onclick=retry.onclick=()=>{void run();};
      insert.onclick=()=>{if(!selected?.path||running)return;const path=selected.path;void options.work(async()=>{if(root===options.root()&&await options.insert(path))dialog.close();});};
      modify.onclick=()=>{if(!selected?.path||running)return;referencePath=selected.path;parentId=selected.id;reference.checked=true;referenceLabel.hidden=false;prompt.value='';prompt.focus();status.textContent='この画像から変更したい点を入力してください。元画像は保持します。';};
      compare.onclick=()=>{void options.work(async()=>{const entries=history.filter(entry=>entry.path&&comparison.has(entry.id));await showImageComparison(await Promise.all(entries.map(async entry=>({label:`${entry.provider||entry.model||'画像'} ／ ${entry.prompt}`,src:await preview(entry)}))),'AI画像の比較',false);});};
      await loadHistory();if(seed?.path){await select(seed);if(edit){prompt.value='';reference.checked=true;}}sync();void checkConnection();
    });
  }
  document.getElementById('generate-ai-image')!.addEventListener('click',()=>{void open();});
  return {open};
}
