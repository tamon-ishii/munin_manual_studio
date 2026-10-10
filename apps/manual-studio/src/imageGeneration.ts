import {featureDialog} from './screenshotWorkflow';
interface Options {root():string;page():string|undefined;request(action:string,options:Record<string,unknown>,root:string):Promise<string>;work(operation:()=>Promise<void>):Promise<void>;refresh():Promise<void>;insert(path:string):Promise<boolean>}
interface Options {root():string;page():string|undefined;request(action:string,options:Record<string,unknown>,root:string):Promise<string>;work(operation:()=>Promise<void>):Promise<void>;refresh():Promise<void>;insert(path:string):Promise<boolean>}

export function setupImageGeneration(options:Options):void {
  document.getElementById('generate-ai-image')!.addEventListener('click',()=>{void options.work(async()=>{
    const root=options.root();if(!root)throw new Error('プロジェクトを開いてください。');
    const settings=JSON.parse(await options.request('image-generation-settings',{},root)) as {model:string;endpoint:string};
    const {dialog,body}=featureDialog('AI作画');dialog.dataset.aiImage='true';
    const notice=document.createElement('p');notice.className='form-hint';notice.textContent='※この作画は原稿更新とは連動せず、手動で1回だけ画像を生成して原稿へ挿入する補助機能です。';
    function field(label:string,value:string,type='text'){const wrapper=document.createElement('label');wrapper.textContent=label;const input=document.createElement('input');input.type=type;input.value=value;wrapper.append(input);return {wrapper,input};}
    const promptLabel=document.createElement('label');promptLabel.textContent='画像の指示';const prompt=document.createElement('textarea');prompt.rows=4;prompt.setAttribute('aria-label','画像の指示');promptLabel.append(prompt);
    const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='作画の接続設定（オプション）';details.append(summary);
    const model=field('画像モデル',settings.model),endpoint=field('画像APIのURL',settings.endpoint),key=field('外部画像APIキー（空欄ならAgyで生成・保存しません）','','password');key.input.autocomplete='off';
    const apiHint=document.createElement('p');apiHint.className='form-hint';apiHint.textContent='※APIキーが空欄の場合は、環境の Agy（Antigravity）CLI を使ってAPIキー不要で画像を生成します。OpenAIなどのAPIキーをお持ちの場合は入力して直接APIから生成することもできます。';
    details.append(model.wrapper,endpoint.wrapper,key.wrapper,apiHint);
    const actions=document.createElement('div');actions.className='actions';const generate=document.createElement('button');generate.type='button';generate.textContent='画像を生成';generate.className='primary';const insert=document.createElement('button');insert.type='button';insert.textContent='原稿に挿入';insert.disabled=true;actions.append(generate,insert);
    const status=document.createElement('p');status.role='status';status.setAttribute('aria-live','polite');
    const stack=document.createElement('div');stack.className='generated-images-stack';
    const image=document.createElement('img');image.className='generated-image-preview';image.alt='AI生成画像';image.hidden=true;
    body.append(notice,promptLabel,details,actions,status,stack,image);
    interface GeneratedItem { path: string; previewUrl: string; }
    const history: GeneratedItem[] = [];
    let selectedIndex = -1, running = false;
    function renderStack() {
      stack.replaceChildren();
      history.forEach((item, index) => {
        const itemEl = document.createElement('div');
        itemEl.className = 'generated-stack-item' + (index === selectedIndex ? ' selected' : '');
        itemEl.title = `画像 #${index + 1} - クリックしてプレビュー・選択`;
        const thumb = document.createElement('img');
        thumb.src = item.previewUrl;
        thumb.alt = `生成画像 #${index + 1}`;
        const badge = document.createElement('span');
        badge.className = 'generated-stack-badge';
        badge.textContent = `#${index + 1}`;
        itemEl.append(thumb, badge);
        itemEl.onclick = () => {
          selectedIndex = index;
          image.src = item.previewUrl;
          image.hidden = false;
          insert.disabled = false;
          renderStack();
        };
        stack.append(itemEl);
      });
    }
    dialog.addEventListener('cancel',event=>{if(running)event.preventDefault();});
    generate.onclick=()=>{void(async()=>{let timer:ReturnType<typeof setInterval>|undefined;await options.work(async()=>{
      if(root!==options.root())throw new Error('プロジェクトが変更されています。');
      if(!prompt.value.trim()){status.textContent='画像の指示を入力してください。';return;}
      running=true;const started=Date.now();status.textContent='画像を生成中です…';timer=setInterval(()=>{status.textContent=`画像を生成中です… ${Math.floor((Date.now()-started)/1000)}秒`;},1000);
      try{await options.request('image-generation-settings',{json:{save:true,model:model.input.value,endpoint:endpoint.input.value}},root);
        const result=JSON.parse(await options.request('image-generate',{json:{prompt:prompt.value,api_key:key.input.value}},root)) as {path:string};
        const previewUrl=await options.request('preview-asset',{page:options.page()||'index.md',asset:result.path},root);
        history.push({path:result.path,previewUrl});
        selectedIndex=history.length-1;
        image.src=previewUrl;image.hidden=false;
        renderStack();
        await options.refresh();status.textContent=`画像 #${history.length} を保存しました。一覧から選択して原稿へ追加できます。`;
      }catch(error){
        const err=String(error);
        if(err.includes('APIキー')){
          details.open=true;key.input.focus();
          status.textContent=`${err}（※上記「作画の接続設定」にAPIキーを入力するか、AGYチャットで画像生成を依頼してください）`;
        } else {
          status.textContent=err;
        }
      }finally{if(timer)clearInterval(timer);running=false;}
    });insert.disabled=selectedIndex<0;})();};
    insert.onclick=()=>{
      if(selectedIndex<0||!history[selectedIndex])return;
      const chosen=history[selectedIndex];
      dialog.close();void options.work(async()=>{if(root===options.root())await options.insert(chosen.path);});
    };
  });});
}
