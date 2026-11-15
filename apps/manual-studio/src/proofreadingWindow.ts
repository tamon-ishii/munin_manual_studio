import {currentTheme,type ThemeId} from './theme';
import {createWindowChannel} from './windowChannel';

export interface ProofreadingWindowData {
  original:string;
  variants:Array<{id:string;content?:string;error?:string}>;
  selections:number[];
  theme?:ThemeId;
}

type ComparisonMessage={type:'ready'}|{type:'init';data:ProofreadingWindowData}|{type:'theme';theme:ThemeId}|{type:'result';content:string|null};
export function createProofreadingChannel(session:string){
  return createWindowChannel<ComparisonMessage>(`proofreading-${session}`);
}

/** Exchange draft data in memory; manuscript contents never enter the URL or storage. */
export async function openProofreadingWindow(data:ProofreadingWindowData,signal:AbortSignal):Promise<string|null>{
  const session=crypto.randomUUID();
  const channel=await createProofreadingChannel(session);
  const url=`proofreading.html?session=${encodeURIComponent(session)}`;
  let close:()=>void=()=>{},poll:ReturnType<typeof setInterval>|undefined;
  let cleanup=()=>{};
  const result=new Promise<string|null>((resolve,reject)=>{
    let settled=false;
    const finish=(content:string|null)=>{if(settled)return;settled=true;cleanup();resolve(content);};
    const fail=(error:unknown)=>{if(settled)return;settled=true;cleanup();reject(error);};
    const syncTheme=()=>channel.postMessage({type:'theme',theme:currentTheme()});
    window.addEventListener('manual-studio-theme-change',syncTheme);
    cleanup=()=>{window.removeEventListener('manual-studio-theme-change',syncTheme);channel.close();if(poll)clearInterval(poll);signal.removeEventListener('abort',abort);};
    const abort=()=>{close();finish(null);};signal.addEventListener('abort',abort,{once:true});
    channel.onmessage=event=>{
      if(event.data?.type==='ready')channel.postMessage({type:'init',data:{...data,theme:currentTheme()}});
      if(event.data?.type==='result'&&(typeof event.data.content==='string'||event.data.content===null)){finish(event.data.content);close();}
    };
    if('__TAURI_INTERNALS__' in window){
      void import('@tauri-apps/api/webviewWindow').then(async({WebviewWindow})=>{
        if(signal.aborted){finish(null);return;}
        const {invoke}=await import('@tauri-apps/api/core');
        const lineCount=Math.max(data.original.split('\n').length,...data.variants.map(variant=>(variant.content??'').split('\n').length));
        await invoke('open_proofreading_window',{session,columnCount:data.variants.length+2,lineCount});
        const child=await WebviewWindow.getByLabel(`proofreading-${session}`);
        if(!child)throw new Error('比較ウィンドウが見つかりません。');
        close=()=>{void child.close().catch(()=>{});};
        const unlistenClose=await child.once('tauri://destroyed',()=>finish(null));
        const earlier=cleanup;cleanup=()=>{earlier();unlistenClose();};
        if(signal.aborted)abort();
      }).catch(fail);
    }else{
      const lines=Math.max(data.original.split('\n').length,...data.variants.map(variant=>(variant.content??'').split('\n').length));
      const width=Math.round(Math.min((data.variants.length+2)*300+48,screen.availWidth*0.92));
      const height=Math.round(Math.min(Math.max(560,Math.min(900,lines*24+300)),screen.availHeight*0.85));
      const child=window.open(url,`proofreading-${session}`,`popup,width=${width},height=${height},resizable=yes,scrollbars=yes`);
      if(!child){fail(new Error('別ウィンドウを開けませんでした。ブラウザーのポップアップ許可を確認してください。'));return;}
      close=()=>child.close();poll=setInterval(()=>{if(child.closed)finish(null);},400);
    }
  });
  return result;
}
