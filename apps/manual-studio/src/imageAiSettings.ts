export interface ImageAiSettings {
  provider?:string;model:string;endpoint:string;shared_provider?:string;shared_endpoint?:string;shared_error?:string;
}
interface Options {
  root():string;request(action:string,options:Record<string,unknown>,root:string):Promise<string>;
  prepare():Promise<void>;
}
export function setupImageAiSettings(options:Options) {
  const panel=document.getElementById('image-ai-settings')!;
  panel.innerHTML='<h2>画像生成</h2><label>画像生成のAI<select id="image-ai-provider"><option value="shared">文章・図の生成AIと同じ接続</option><option value="agy">Agy（個別設定）</option><option value="codex">Codex（個別設定）</option><option value="api">画像API（個別設定）</option></select></label><p id="image-ai-connection" class="muted"></p><div class="settings-grid"><label id="image-ai-model-label">画像モデル<input id="image-ai-model" /></label><label id="image-ai-endpoint-label">画像APIのURL<input id="image-ai-endpoint" /></label><label id="image-ai-key-label">画像APIキー（保存しません）<input id="image-ai-key" type="password" autocomplete="off" /></label></div><p class="muted">画像モデルは文章モデルとは別に指定します。画像APIキーの入力はこの起動中だけ保持します。</p><div class="actions"><button type="button" id="image-ai-save">画像生成AIを保存</button><span id="image-ai-save-state" role="status" aria-live="polite"></span></div>';
  const provider=panel.querySelector<HTMLSelectElement>('#image-ai-provider')!;
  const model=panel.querySelector<HTMLInputElement>('#image-ai-model')!;
  const endpoint=panel.querySelector<HTMLInputElement>('#image-ai-endpoint')!;
  const key=panel.querySelector<HTMLInputElement>('#image-ai-key')!;
  const status=panel.querySelector<HTMLElement>('#image-ai-save-state')!;
  const connection=panel.querySelector<HTMLElement>('#image-ai-connection')!;
  const save=panel.querySelector<HTMLButtonElement>('#image-ai-save')!;
  let version=0,loadedRoot='',settings:ImageAiSettings|undefined;
  const keys=new Map<string,string>();
  const keyId=(root:string,url:string)=>JSON.stringify([root,url.trim().replace(/\/+$/,'')]);
  function visibility(){
    const shared=provider.value==='shared',api=provider.value==='api'||shared&&settings?.shared_provider==='api';
    panel.querySelector<HTMLElement>('#image-ai-model-label')!.hidden=!api;
    panel.querySelector<HTMLElement>('#image-ai-endpoint-label')!.hidden=shared||!api;
    panel.querySelector<HTMLElement>('#image-ai-key-label')!.hidden=shared||!api;
    connection.textContent=shared?settings?.shared_error||`文章・図と同じ接続：${settings?.shared_provider||''}${settings?.shared_endpoint?` ／ ${settings.shared_endpoint}`:''}`:'文章・図の生成AIとは独立した接続です。';
  }
  provider.onchange=()=>{visibility();status.textContent='未保存';};
  endpoint.oninput=()=>{key.value=keys.get(keyId(loadedRoot,endpoint.value))||'';status.textContent='未保存';};
  model.oninput=key.oninput=()=>{status.textContent='未保存';};
  async function refresh(){
    const current=++version,root=options.root();save.disabled=true;status.textContent='読込中…';
    if(!root){loadedRoot='';settings=undefined;key.value='';status.textContent='プロジェクトを開いてください。';return;}
    try{
      const next=JSON.parse(await options.request('image-generation-settings',{},root)) as ImageAiSettings;
      if(current!==version||root!==options.root())return;
      settings=next;loadedRoot=root;provider.value=next.provider&&['shared','agy','codex','api'].includes(next.provider)?next.provider:'agy';
      model.value=next.model;endpoint.value=next.endpoint;key.value=keys.get(keyId(root,endpoint.value))||'';visibility();status.textContent='保存済み';
    }catch(error){if(current===version&&root===options.root())status.textContent=String(error);}
    finally{if(current===version)save.disabled=!loadedRoot||loadedRoot!==options.root();}
  }
  save.onclick=()=>{void(async()=>{
    const root=loadedRoot;if(!root||root!==options.root())return;save.disabled=true;
    const values={save:true,provider:provider.value,model:model.value,endpoint:endpoint.value};
    const apiKey=key.value;status.textContent='保存中…';
    try{
      if(values.provider==='shared')await options.prepare();
      if(root!==options.root())return;
      const saved=JSON.parse(await options.request('image-generation-settings',{json:values},root)) as ImageAiSettings;
      if(root!==options.root())return;
      keys.set(keyId(root,values.endpoint),apiKey);settings=saved;visibility();status.textContent='保存済み';
    }catch(error){if(root===options.root())status.textContent=`保存失敗: ${String(error)}`;}
    finally{if(root===options.root())save.disabled=false;}
  })();};
  async function updateShared(){
    const root=options.root();
    try{const next=JSON.parse(await options.request('image-generation-settings',{},root)) as ImageAiSettings;
      if(root!==options.root()||loadedRoot!==root||!settings)return;
      settings.shared_provider=next.shared_provider;settings.shared_endpoint=next.shared_endpoint;settings.shared_error=next.shared_error;visibility();
    }catch(error){if(root===options.root()&&provider.value==='shared')connection.textContent=String(error);}
  }
  return {refresh,updateShared,key:(root:string,url:string)=>keys.get(keyId(root,url))||''};
}
