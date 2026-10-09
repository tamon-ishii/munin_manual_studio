import {featureDialog} from './screenshotWorkflow';
interface Options {root():string;page():string|undefined;request(action:string,options:Record<string,unknown>,root:string):Promise<string>;work(operation:()=>Promise<void>):Promise<void>;refresh():Promise<void>;insert(path:string):Promise<boolean>}
export function setupImageGeneration(options:Options):void {
  document.getElementById('generate-ai-image')!.addEventListener('click',()=>{void options.work(async()=>{
    const root=options.root();if(!root)throw new Error('プロジェクトを開いてください。');
    const settings=JSON.parse(await options.request('image-generation-settings',{},root)) as {model:string;endpoint:string};
    const {dialog,body}=featureDialog('AI作画');dialog.dataset.aiImage='true';
    function field(label:string,value:string,type='text'){const wrapper=document.createElement('label');wrapper.textContent=label;const input=document.createElement('input');input.type=type;input.value=value;wrapper.append(input);return {wrapper,input};}
    const promptLabel=document.createElement('label');promptLabel.textContent='画像の指示';const prompt=document.createElement('textarea');prompt.rows=4;prompt.setAttribute('aria-label','画像の指示');promptLabel.append(prompt);
    const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='作画の接続設定';details.append(summary);
    const model=field('画像モデル',settings.model),endpoint=field('画像APIのURL',settings.endpoint),key=field('APIキー（保存しません）','','password');key.input.autocomplete='off';details.append(model.wrapper,endpoint.wrapper,key.wrapper);
    const sizeLabel=document.createElement('label');sizeLabel.textContent='画像サイズ';const size=document.createElement('select');size.setAttribute('aria-label','画像サイズ');for(const value of ['1024x1024','1536x1024','1024x1536'])size.add(new Option(value,value));sizeLabel.append(size);
    const actions=document.createElement('div');actions.className='actions';const generate=document.createElement('button');generate.type='button';generate.textContent='画像を生成';generate.className='primary';const insert=document.createElement('button');insert.type='button';insert.textContent='原稿に挿入';insert.disabled=true;actions.append(generate,insert);
    const status=document.createElement('p');status.role='status';status.setAttribute('aria-live','polite');const image=document.createElement('img');image.className='generated-image-preview';image.alt='AI生成画像';image.hidden=true;body.append(promptLabel,details,sizeLabel,actions,status,image);
    let generated='',running=false;
    dialog.addEventListener('cancel',event=>{if(running)event.preventDefault();});
    generate.onclick=()=>{void(async()=>{let timer:ReturnType<typeof setInterval>|undefined;await options.work(async()=>{
      if(root!==options.root())throw new Error('プロジェクトが変更されています。');
      if(!prompt.value.trim()){status.textContent='画像の指示を入力してください。';return;}
      running=true;const started=Date.now();status.textContent='画像を生成中です…';timer=setInterval(()=>{status.textContent=`画像を生成中です… ${Math.floor((Date.now()-started)/1000)}秒`;},1000);
      try{await options.request('image-generation-settings',{json:{save:true,model:model.input.value,endpoint:endpoint.input.value}},root);
        const result=JSON.parse(await options.request('image-generate',{json:{prompt:prompt.value,api_key:key.input.value,size:size.value}},root)) as {path:string};generated=result.path;
        image.src=await options.request('preview-asset',{page:options.page()||'index.md',asset:generated},root);image.hidden=false;
        await options.refresh();status.textContent='画像を保存しました。挿入先を選んで原稿へ追加できます。';
      }catch(error){status.textContent=String(error);}finally{if(timer)clearInterval(timer);running=false;}
    });insert.disabled=!generated;})();};
    insert.onclick=()=>{if(!generated)return;dialog.close();void options.work(async()=>{if(root===options.root())await options.insert(generated);});};
  });});
}
