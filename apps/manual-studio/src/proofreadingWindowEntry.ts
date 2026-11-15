import './style.css';
import {reviewProofreading} from './proofreadingReview';
import {createProofreadingChannel,type ProofreadingWindowData} from './proofreadingWindow';
import {applyTheme,initializeTheme,isThemeId} from './theme';

initializeTheme();

const session=new URLSearchParams(location.search).get('session');
if(session){
  const channel=await createProofreadingChannel(session);
  let started=false,finished=false;
  channel.onmessage=event=>{
    if(event.data?.type==='theme'){
      if(isThemeId(event.data.theme))applyTheme(event.data.theme,false);
      return;
    }
    if(started||event.data?.type!=='init')return;
    started=true;
    document.querySelector('#proofreading-waiting')?.remove();
    const data=event.data.data as ProofreadingWindowData;
    if(isThemeId(data.theme))applyTheme(data.theme,false);
    void reviewProofreading(data.original,data.variants,{selections:data.selections,standalone:true}).then(content=>{
      finished=true;channel.postMessage({type:'result',content});
    });
  };
  window.addEventListener('beforeunload',()=>{if(!finished)channel.postMessage({type:'result',content:null});});
  channel.postMessage({type:'ready'});
}
