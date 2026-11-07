import {featureDialog} from './imageDialogs';
import {addPathBrowse} from './pathPicker';
import type {TargetApplication} from './targetApplication';

export interface TemplateOptions {template:string;destination:string;instruction:string;include_screenshots:boolean;target_application:boolean;}
export function askTemplateDestination(docs:string,loadTarget:()=>Promise<TargetApplication>,loadGuide:()=>Promise<string>,configure:()=>Promise<unknown>):Promise<TemplateOptions|null>{
  const {dialog,body}=featureDialog('AIで雛形作成');dialog.id='template-creation-dialog';
  const form=document.createElement('form');
  const kindLabel=document.createElement('label');kindLabel.textContent='文書の種類';
  const kind=document.createElement('select');kind.name='template';
  for(const [value,label] of [['manual','マニュアル'],['specification','仕様書'],['readme','Readme.md']])kind.add(new Option(label,value));kindLabel.append(kind);
  const destinationLabel=document.createElement('label'),caption=document.createElement('span'),destination=document.createElement('input');destination.name='destination';destination.required=true;destinationLabel.append(caption,destination);addPathBrowse(destination,()=>kind.value==='readme'?'file':'folder');
  const instructionLabel=document.createElement('label');instructionLabel.textContent='作成したい内容';const instruction=document.createElement('textarea');instruction.name='instruction';instruction.rows=3;instruction.maxLength=20000;instruction.placeholder='例：初めて使う人向けに、画像へモザイクを入れて保存する手順書を作って';instructionLabel.append(instruction);
  const captureLabel=document.createElement('label');captureLabel.className='image-reference-control';const capture=document.createElement('input');capture.type='checkbox';capture.name='include_screenshots';capture.checked=true;captureLabel.append(capture,document.createTextNode('AIにアプリの操作・撮影を任せる'));
  const targetSummary=document.createElement('p');targetSummary.role='status';let ready=false;
  const settings=document.createElement('button');settings.type='button';settings.textContent='対象アプリケーションの設定';
  const load=async()=>{ready=false;targetSummary.textContent='対象アプリの設定を読み込んでいます…';try{const app=await loadTarget();ready=!!app.command;targetSummary.textContent=ready?`対象アプリ：${app.command}`:'最初に対象アプリケーションの起動方法を設定してください。';}catch(error){targetSummary.textContent=String(error);}};
  settings.onclick=()=>{void configure().then(load).catch(error=>{targetSummary.textContent=String(error);});};void load();
  const note=document.createElement('p');note.textContent='AIが設定したアプリを起動し、必要な操作と撮影を進めます。完成した画像と原稿を最後に確認し、採用できます。';
  capture.onchange=()=>{targetSummary.hidden=settings.hidden=!capture.checked;note.textContent=capture.checked?'AIが設定したアプリを起動し、必要な操作と撮影を進めます。完成した画像と原稿を最後に確認し、採用できます。':'文章・表・図を使った雛形を作成します。原稿候補を最後に確認し、採用できます。';};
  const guide=document.createElement('details');guide.className='template-ai-guide';const summary=document.createElement('summary');summary.textContent='AIに渡す手順書を見る';const guideText=document.createElement('pre');guideText.textContent='読み込んでいます…';guide.append(summary,guideText);void loadGuide().then(text=>{guideText.textContent=text;}).catch(error=>{guideText.textContent=String(error);});
  const error=document.createElement('p');error.role='alert';const submit=document.createElement('button');submit.type='submit';submit.className='primary';submit.textContent='雛形の候補を作成';
  const update=()=>{const readme=kind.value==='readme';caption.textContent=readme?'出力ファイル（.md）':'出力フォルダー';destination.value=readme?'Readme.md':kind.value==='specification'?'specs':docs;};kind.onchange=update;update();
  form.append(kindLabel,destinationLabel,instructionLabel,captureLabel,targetSummary,settings,note,guide,error,submit);body.append(form);
  return new Promise(resolve=>{let result:TemplateOptions|null=null;form.onsubmit=event=>{event.preventDefault();const path=destination.value.trim().replace(/\\/g,'/').replace(/\/+$/,'');if(!path||path.startsWith('/')||path.includes(':')||path.split('/').some(part=>part==='..'||part==='')||(kind.value==='readme'&&!/\.md$/.test(path))){error.textContent='プロジェクト内の相対パスを指定してください。Readme.mdには.mdファイルを指定します。';return;}if(capture.checked&&!ready){error.textContent='対象アプリケーションの設定を保存してください。';return;}result={template:kind.value,destination:path,instruction:instruction.value.trim(),include_screenshots:capture.checked,target_application:capture.checked};dialog.close();};dialog.addEventListener('close',()=>resolve(result),{once:true});});
}
