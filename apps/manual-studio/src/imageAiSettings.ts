export interface ImageAiSettings {
  provider?:string;model:string;endpoint:string;shared_provider?:string;shared_endpoint?:string;shared_error?:string;
}
interface Options {
  root():string;request(action:string,options:Record<string,unknown>,root:string):Promise<string>;
  prepare():Promise<void>;
}
export function setupImageAiSettings(options:Options) {
  const panel=document.getElementById('image-ai-settings')!;
  panel.innerHTML='<h2>AI作画</h2><label>AI作画の接続<select id="image-ai-provider"><option value="shared">文章・図の生成AIと同じ接続</option><option value="agy">Agy（個別設定）</option><option value="codex">Codex（個別設定）</option><option value="api">画像API（個別設定）</option></select></label><p id="image-ai-connection" class="muted"></p><div class="settings-grid"><label id="image-ai-model-label">画像モデル<input id="image-ai-model" /></label><label id="image-ai-endpoint-label">画像APIのURL<input id="image-ai-endpoint" /></label><label id="image-ai-key-label">画像APIキー（保存しません）<input id="image-ai-key" type="password" autocomplete="off" /></label></div><p class="muted">設定は変更すると自動保存します。画像モデルは文章モデルとは別に指定します。画像APIキーの入力はこの起動中だけ保持します。</p><div class="actions"><button type="button" id="image-ai-save-retry" hidden>保存を再試行</button><span id="image-ai-save-state" role="status" aria-live="polite"></span></div>';
  const provider=panel.querySelector<HTMLSelectElement>('#image-ai-provider')!;
  const model=panel.querySelector<HTMLInputElement>('#image-ai-model')!;
  const endpoint=panel.querySelector<HTMLInputElement>('#image-ai-endpoint')!;
  const key=panel.querySelector<HTMLInputElement>('#image-ai-key')!;
  const status=panel.querySelector<HTMLElement>('#image-ai-save-state')!;
  const connection=panel.querySelector<HTMLElement>('#image-ai-connection')!;
  const retry=panel.querySelector<HTMLButtonElement>('#image-ai-save-retry');
  let version=0,loadedRoot='',settings:ImageAiSettings|undefined;
  let editVersion=0;
  let saveTimer:ReturnType<typeof setTimeout>|undefined;
  let saveQueue:Promise<void>=Promise.resolve();
  let pendingSave:(()=>Promise<void>)|undefined;
  let saveError:unknown;
  const keys=new Map<string,string>();
  const keyId=(root:string,url:string)=>JSON.stringify([root,url.trim().replace(/\/+$/,'')]);
  function visibility(){
    const shared=provider.value==='shared',api=provider.value==='api'||shared&&settings?.shared_provider==='api';
    panel.querySelector<HTMLElement>('#image-ai-model-label')!.hidden=!api;
    panel.querySelector<HTMLElement>('#image-ai-endpoint-label')!.hidden=shared||!api;
    panel.querySelector<HTMLElement>('#image-ai-key-label')!.hidden=shared||!api;
    connection.textContent=shared?settings?.shared_error||`文章・図と同じ接続：${settings?.shared_provider||''}${settings?.shared_endpoint?` ／ ${settings.shared_endpoint}`:''}`:'文章・図の生成AIとは独立した接続です。';
  }
  provider.onchange=()=>{visibility();scheduleSave();};
  endpoint.oninput=()=>{key.value=keys.get(keyId(loadedRoot,endpoint.value))||'';scheduleSave();};
  model.oninput=key.oninput=()=>{scheduleSave();};
  async function refresh(){
    const current=++version,root=options.root();
    flushSave();await saveQueue;
    if(current!==version||root!==options.root())return;
    loadedRoot='';saveError=undefined;status.textContent='読込中…';
    if(retry)retry.hidden=true;
    if(!root){loadedRoot='';settings=undefined;key.value='';status.textContent='プロジェクトを開いてください。';return;}
    try{
      const next=JSON.parse(await options.request('image-generation-settings',{},root)) as ImageAiSettings;
      if(current!==version||root!==options.root())return;
      settings=next;loadedRoot=root;provider.value=next.provider&&['shared','agy','codex','api'].includes(next.provider)?next.provider:'agy';
      model.value=next.model;endpoint.value=next.endpoint;key.value=keys.get(keyId(root,endpoint.value))||'';visibility();status.textContent='保存済み';
    }catch(error){if(current===version&&root===options.root())status.textContent=String(error);}
  }
  function flushSave(){
    clearTimeout(saveTimer);
    const operation=pendingSave;pendingSave=undefined;
    if(operation)saveQueue=saveQueue.then(operation);
  }
  function scheduleSave(){
    const root=loadedRoot;if(!root||root!==options.root())return;
    const current=++editVersion;
    saveError=undefined;
    const values={save:true,provider:provider.value,model:model.value,endpoint:endpoint.value};
    keys.set(keyId(root,values.endpoint),key.value);
    const isCurrent=()=>root===options.root()&&root===loadedRoot&&current===editVersion;
    status.textContent='未保存（自動保存待ち）';if(retry)retry.hidden=true;
    pendingSave=async()=>{
      if(isCurrent())status.textContent='保存中…';
      try{
        if(values.provider==='shared'&&root===options.root())await options.prepare();
        const saved=JSON.parse(await options.request('image-generation-settings',{json:values},root)) as ImageAiSettings;
        if(!isCurrent())return;
        settings=saved;visibility();status.textContent='保存済み';if(retry)retry.hidden=true;
      }catch(error){
        if(isCurrent()){
          saveError=error;
          status.textContent=`保存失敗: ${String(error)}`;
          if(retry)retry.hidden=false;
        }
      }
    };
    clearTimeout(saveTimer);saveTimer=setTimeout(flushSave,400);
  }
  if(retry)retry.onclick=()=>{scheduleSave();flushSave();};
  async function updateShared(){
    const root=options.root();
    try{const next=JSON.parse(await options.request('image-generation-settings',{},root)) as ImageAiSettings;
      if(root!==options.root()||loadedRoot!==root||!settings)return;
      settings.shared_provider=next.shared_provider;settings.shared_endpoint=next.shared_endpoint;settings.shared_error=next.shared_error;visibility();
    }catch(error){if(root===options.root()&&provider.value==='shared')connection.textContent=String(error);}
  }
  async function flush(){flushSave();await saveQueue;if(saveError)throw saveError;}
  return {refresh,updateShared,flush,key:(root:string,url:string)=>keys.get(keyId(root,url))||''};
}
