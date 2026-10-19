export const stageLabels: Record<string,string> = {
  retry:'編集結果を保存できませんでした。再確認するか閉じてください',select:'撮影方法・画像の選択',recording:'アプリを操作中',capture:'撮影中',markits:'MarkItsで編集中',
  import:'編集結果を保存中',restore:'Studioへ戻っています',preview:'挿入の準備中',review:'挿入内容の確認',
  adopt:'画像を採用中',reference:'画像参照を準備中',insert:'原稿に挿入中',save:'原稿を保存中',refresh:'表示を更新中',
  'source-read':'原本の読み取り',metadata:'注釈・クロップの読み取り',register:'編集版の登録',ai:'AIで撮影中',
};
export interface TimingStage {stage:string;duration_ms:number;waiting?:boolean}
export interface TimingRecord {at:string;operation:string;outcome:string;stages:TimingStage[]}
type Request=(action:string,options:Record<string,unknown>,root:string)=>Promise<string>;
export class OperationTiming {
  private stages:TimingStage[]=[];
  private current?:{stage:string;at:number};
  private ended=false;
  constructor(private request:Request,private root:string,private operation='screenshot-insert',private now=()=>performance.now()){}
  stage(stage:string):void {
    if(this.ended)return;
    this.flush();this.current={stage,at:this.now()};
  }
  private flush():void {
    if(this.current){this.stages.push({stage:this.current.stage,duration_ms:Math.max(0,this.now()-this.current.at)});this.current=undefined;}
  }
  async finish(outcome:'success'|'cancelled'|'error'):Promise<void>{
    if(this.ended)return;this.flush();this.ended=true;
    await this.request('operation-timings-record',{json:{operation:this.operation,outcome,stages:this.stages}},this.root);
  }
}

/** Visible only while capturing/inserting, and never shown on another project. */
export function operationProgress(root:string,currentRoot:()=>string){
 const host=document.createElement('div');host.id='capture-operation-progress';host.className='capture-operation-progress';
 const label=document.createElement('span');label.role='status';label.setAttribute('aria-live','polite');
 const elapsed=document.createElement('span');elapsed.setAttribute('aria-hidden','true');host.append(label,elapsed);
 document.getElementById('panel-editor')?.prepend(host);
 let started=performance.now();
 const update=()=>{host.hidden=currentRoot()!==root;elapsed.textContent=`${((performance.now()-started)/1000).toFixed(0)}秒`;};
 const timer=setInterval(update,1000);
 return {stage:(stage:string)=>{started=performance.now();label.textContent=stageLabels[stage]||'編集結果を確認してください。';host.dataset.stage=stage;update();},close:()=>{clearInterval(timer);host.remove();}};
}
