import {featureDialog} from './imageDialogs';
import {addPathBrowse} from './pathPicker';

export interface TemplateOptions {template:string;destination:string;instruction:string;include_screenshots:boolean;window?:string;automate_steps:boolean;}
export function askTemplateDestination(docs:string,loadWindows:()=>Promise<Array<{id:string;title:string}>>=async()=>[],loadGuide:()=>Promise<string>=async()=>''):Promise<TemplateOptions|null>{
  const {dialog,body}=featureDialog('AIで雛形作成');dialog.id='template-creation-dialog';
  const form=document.createElement('form');
  const kindLabel=document.createElement('label');kindLabel.textContent='文書の種類';
  const kind=document.createElement('select');kind.name='template';
  for(const [value,label] of [['manual','マニュアル'],['specification','仕様書'],['readme','Readme.md']])kind.add(new Option(label,value));
  kindLabel.append(kind);
  const guidance=document.createElement('p');
  const destinationLabel=document.createElement('label');
  const caption=document.createElement('span');const destination=document.createElement('input');destination.name='destination';destination.required=true;
  destinationLabel.append(caption,destination);
  addPathBrowse(destination,()=>kind.value==='readme'?'file':'folder');
  const instructionLabel=document.createElement('label');instructionLabel.textContent='対象アプリ・作成したい内容';
  const instruction=document.createElement('textarea');instruction.name='instruction';instruction.rows=3;instruction.maxLength=20000;instruction.placeholder='対象読者、説明したい作業、重点的に説明する画面など';instructionLabel.append(instruction);
  const captureLabel=document.createElement('label');captureLabel.className='image-reference-control';
  const capture=document.createElement('input');capture.type='checkbox';capture.name='include_screenshots';capture.checked=true;captureLabel.append(capture,document.createTextNode('実画面のスクリーンショットと注釈を含める'));
  const captureSettings=document.createElement('div');
  const windowLabel=document.createElement('label');windowLabel.textContent='撮影対象のウィンドウ';const windows=document.createElement('select');windows.name='window';windows.required=true;windows.add(new Option('対象アプリを開いて選択してください',''));windowLabel.append(windows);
  const refresh=document.createElement('button');refresh.type='button';refresh.textContent='ウィンドウ一覧を更新';
  const windowStatus=document.createElement('p');windowStatus.role='status';
  const automaticLabel=document.createElement('label');automaticLabel.className='image-reference-control';const automatic=document.createElement('input');automatic.type='checkbox';automatic.name='automate_steps';automaticLabel.append(automatic,document.createTextNode('対象アプリを自動操作して手順ごとに撮影する'));
  const captureNote=document.createElement('p');captureNote.className='muted';captureNote.textContent='対象画面を開いてください。自動操作を選ぶと実際のクリック・入力を行います。選ばない場合は現在の画面を撮影します。';
  captureSettings.append(windowLabel,refresh,windowStatus,automaticLabel,captureNote);
  const load=async()=>{refresh.disabled=true;windows.disabled=true;windowStatus.textContent='ウィンドウ一覧を取得しています…';try{const selected=windows.value;const items=await loadWindows();windows.replaceChildren(new Option('撮影対象を選択してください',''));for(const item of items)windows.add(new Option(item.title,item.id));windows.value=selected;windowStatus.textContent=items.length?'':'撮影できるウィンドウがありません。対象アプリを開いて更新してください。';}catch(e){windowStatus.textContent=`一覧を取得できませんでした：${String(e)}`;}finally{refresh.disabled=false;windows.disabled=!capture.checked;}};
  refresh.onclick=()=>{void load();};capture.onchange=()=>{captureSettings.hidden=!capture.checked;windows.required=capture.checked;windows.disabled=!capture.checked;if(capture.checked)void load();};void load();
  const note=document.createElement('p');note.textContent='出力先は開いているプロジェクトからの相対パスで指定します。新しいフォルダーも指定できます。作成した候補を確認・採用してから保存します。';
  const guide=document.createElement('details');guide.className='template-ai-guide';guide.open=true;const guideTitle=document.createElement('summary');guideTitle.textContent='AIに提示する手順書（MarkIts・Manual Studioの機能と作成手順）';const guideText=document.createElement('pre');guideText.textContent='手順書を読み込んでいます…';guideText.setAttribute('aria-label','AIに提示する手順書');guide.append(guideTitle,guideText);
  void loadGuide().then(text=>{guideText.textContent=text||'手順書を取得できませんでした。アプリを更新して再度お試しください。';}).catch(e=>{guideText.textContent=`手順書を表示できませんでした：${String(e)}`;});
  const error=document.createElement('p');error.role='alert';
  const submit=document.createElement('button');submit.type='submit';submit.className='primary';submit.textContent='雛形の候補を作成';
  const update=()=>{
    const readme=kind.value==='readme';caption.textContent=readme?'出力ファイル（.md）':'出力フォルダー';
    destination.value=readme?'Readme.md':kind.value==='specification'?'specs':docs;
    destination.placeholder=readme?'Readme.md':'docs/manual';
    guidance.textContent=readme?'概要・導入・クイックスタート・使い方・開発方法を一つのファイルにまとめます。':kind.value==='specification'?'目的・機能要件・入出力・制約・受け入れ条件を整理します。':'対象読者・前提条件・基本操作・手順・トラブル対処を整理します。';
  };
  kind.onchange=update;update();form.append(kindLabel,guidance,destinationLabel,instructionLabel,captureLabel,captureSettings,guide,note,error,submit);body.append(form);
  return new Promise(resolve=>{
    let result:TemplateOptions|null=null;
    form.onsubmit=event=>{
      event.preventDefault();const path=destination.value.trim().replace(/\\/g,'/').replace(/\/+$/,'');
      if(!path||path.startsWith('/')||path.includes(':')||path.split('/').some(part=>part==='..'||part==='')||(kind.value==='readme'&&!/\.md$/.test(path))){error.textContent='プロジェクト内の相対パスを指定してください。Readme.mdの出力先には.mdファイルを指定します。';return;}
      if(capture.checked&&!windows.value){error.textContent='撮影対象のウィンドウを選択してください。';return;}
      result={template:kind.value,destination:path,instruction:instruction.value.trim(),include_screenshots:capture.checked,window:capture.checked?windows.value:undefined,automate_steps:capture.checked&&automatic.checked};dialog.close();
    };
    dialog.addEventListener('close',()=>resolve(result),{once:true});
  });
}
