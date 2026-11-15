export interface WindowChannel<T> {onmessage:((event:{data:T})=>void)|null;postMessage:(data:T)=>void;close:()=>void}

/** Same local transport for browser popups and native windows with different WebView2 profiles. */
export async function createWindowChannel<T>(name:string):Promise<WindowChannel<T>>{
  if(!('__TAURI_INTERNALS__' in window)){
    const transport=new BroadcastChannel(name);
    const channel:WindowChannel<T>={onmessage:null,postMessage:data=>transport.postMessage(data),close:()=>transport.close()};
    transport.onmessage=event=>channel.onmessage?.({data:event.data});return channel;
  }
  const {listen,emit}=await import('@tauri-apps/api/event');
  const channel:WindowChannel<T>={onmessage:null,postMessage:data=>{void emit(name,data);},close:()=>{}};
  channel.close=await listen<T>(name,event=>channel.onmessage?.({data:event.payload}));return channel;
}
