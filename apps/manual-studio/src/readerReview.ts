import {featureDialog} from './screenshotWorkflow';
export interface ReviewFinding {category:'reader'|'proofreading'|'image';severity:string;quote:string;message:string;suggestion:string;image:string;start:number;end:number;}
export interface ReaderReport {issues:ReviewFinding[];images:Array<{path:string;status:string;reason?:string}>;warnings:string[];}
export interface ReviewCapabilities {supports_images:boolean;images:number;connection:string;agent:string;note:string;}
export function askReader(defaultReader:string,hasSelection=false,preflight?:(scope:"document"|"selection")=>Promise<ReviewCapabilities>):Promise<{reader:string;scope:"document"|"selection"}|null>{
  const {dialog,body}=featureDialog('読者目線のレビュー・校正');dialog.id='reader-review-options';
  const scope=document.createElement('select');scope.setAttribute('aria-label','レビュー対象');scope.add(new Option('文書全体','document'));if(hasSelection)scope.add(new Option('選択範囲','selection'));scope.value=hasSelection?'selection':'document';
  const help=document.createElement('p');help.textContent='説明不足・操作手順・用語・誤字脱字・表記揺れと、画像と説明の整合性を確認します。原稿は変更しません。';
  const label=document.createElement('label');label.textContent='想定する読者・目的';const input=document.createElement('textarea');input.rows=3;input.value=defaultReader||'初めてこのアプリを使う人。操作を迷わず完了できるか確認する。';label.append(input);
  const note=document.createElement('p');note.textContent='画像を確認するため、文書内の対応画像も文章生成AIへ送信します。画像入力を利用できない接続では未確認と表示します。';note.className='muted';
  const run=document.createElement('button');run.type='button';run.className='primary';run.textContent='レビューを実行';run.dataset.uiIcon="review";const scopeLabel=document.createElement('label');scopeLabel.textContent='レビュー対象';scopeLabel.append(scope);body.append(help,scopeLabel,label,note,run);
  if(preflight){
    note.id='reader-review-capabilities';note.role='status';let generation=0;
    const retry=document.createElement('button');retry.type='button';retry.textContent='対応状況を再確認';retry.hidden=true;body.append(retry);
    const update=async()=>{const current=++generation;retry.hidden=true;run.disabled=true;note.textContent='画像レビューの対応状況を確認しています…';try{const result=await preflight(scope.value as "document"|"selection");if(current!==generation||!dialog.open)return;note.textContent=`対象画像 ${result.images}件。${result.note}`;run.disabled=false;}catch(error){if(current===generation&&dialog.open){note.textContent=`対応状況を確認できませんでした：${String(error)}`;retry.hidden=false;}}};
    scope.onchange=retry.onclick=()=>{void update();};void update();
  }
  return new Promise(resolve=>{let result:{reader:string;scope:"document"|"selection"}|null=null;run.onclick=()=>{result={reader:input.value.trim(),scope:scope.value as "document"|"selection"};dialog.close();};dialog.addEventListener('close',()=>{resolve(result);dialog.remove();},{once:true});});
}
export function showReaderReport(report:ReaderReport,valid:()=>boolean,jump:(finding:ReviewFinding)=>void,fix:(finding:ReviewFinding)=>void):void{
  const existing=document.querySelector<HTMLDialogElement>('#reader-review-results');
  if(existing?.open){existing.focus();return;}
  const {dialog,body}=featureDialog('読者レビュー・校正の結果',false);dialog.id='reader-review-results';
  const summary=document.createElement('p');summary.role='status';summary.textContent=`指摘 ${report.issues.length}件・画像確認 ${report.images.filter(image=>image.status==='checked').length}/${report.images.length}件`;
  const stale=document.createElement('p');stale.role='alert';
  const filter=document.createElement('select');filter.setAttribute('aria-label','指摘の分類');for(const [value,text] of [['all','すべて'],['reader','読者目線'],['proofreading','校正'],['image','画像と説明']])filter.add(new Option(text,value));
  const list=document.createElement('div');list.className='review-findings';const empty=document.createElement('p');empty.className='muted review-empty';const updateEmpty=()=>{empty.hidden=Array.from(list.children).some(card=>!(card as HTMLElement).hidden);empty.textContent=report.issues.length?'この分類の指摘はありません。':'今回のレビューでは指摘はありませんでした。';};const labels={reader:'読者目線',proofreading:'校正',image:'画像と説明'};
  for(const finding of report.issues){
    const card=document.createElement('section');card.className='card review-finding';card.dataset.reviewCategory=finding.category;
    const heading=document.createElement('h3');heading.textContent=finding.message;
    const badges=document.createElement('div');badges.className='review-badges';for(const text of [labels[finding.category],finding.severity==='problem'?'要修正':'改善提案']){const badge=document.createElement('span');badge.textContent=text;badges.append(badge);}
    const quote=document.createElement('blockquote');quote.textContent=finding.quote;
    const suggestion=document.createElement('p');suggestion.textContent=finding.suggestion;const image=document.createElement('small');image.textContent=finding.category==='image'?`対象画像：${finding.image}`:'';
    const actions=document.createElement('div');actions.className='actions';
    for(const [text,callback] of [['該当箇所へ',()=>{jump(finding);}] ,['修正案を作成',()=>{fix(finding);}]] as const){const button=document.createElement('button');button.type='button';button.textContent=text;button.dataset.uiIcon=text==='該当箇所へ'?'eye':'sparkle';button.onclick=()=>{if(!valid()){stale.textContent='原稿が変更されました。レビューを実行し直してください。';return;}callback();};actions.append(button);}
    const ignore=document.createElement('button');ignore.type='button';ignore.textContent='見送り';ignore.onclick=()=>{card.remove();report.issues=report.issues.filter(issue=>issue!==finding);summary.textContent=`指摘 ${report.issues.length}件・画像確認 ${report.images.filter(image=>image.status==='checked').length}/${report.images.length}件`;updateEmpty();};actions.append(ignore);
    card.append(badges,heading,quote,suggestion,image,actions);list.append(card);
  }
  filter.onchange=()=>{list.querySelectorAll<HTMLElement>('[data-review-category]').forEach(card=>{card.hidden=filter.value!=='all'&&card.dataset.reviewCategory!==filter.value;});updateEmpty();};
  body.append(summary,stale,filter,list,empty);updateEmpty();
  for(const warning of [...report.warnings,...report.images.filter(image=>image.status!=='checked').map(image=>`画像未確認：${image.path} ${image.reason||'AIが画像を確認できたと報告していません。'}`)]){const note=document.createElement('p');note.className='muted';note.textContent=warning;body.append(note);}
}
