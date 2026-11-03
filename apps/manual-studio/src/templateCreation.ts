import {featureDialog} from './imageDialogs';
import {addPathBrowse} from './pathPicker';

export interface TemplateOptions {template:string;destination:string;}
export function askTemplateDestination(docs:string):Promise<TemplateOptions|null>{
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
  const note=document.createElement('p');note.textContent='出力先は開いているプロジェクトからの相対パスで指定します。新しいフォルダーも指定できます。作成した候補を確認・採用してから保存します。';
  const error=document.createElement('p');error.role='alert';
  const submit=document.createElement('button');submit.type='submit';submit.className='primary';submit.textContent='雛形の候補を作成';
  const update=()=>{
    const readme=kind.value==='readme';caption.textContent=readme?'出力ファイル（.md）':'出力フォルダー';
    destination.value=readme?'Readme.md':kind.value==='specification'?'specs':docs;
    destination.placeholder=readme?'Readme.md':'docs/manual';
    guidance.textContent=readme?'概要・導入・クイックスタート・使い方・開発方法を一つのファイルにまとめます。':kind.value==='specification'?'目的・機能要件・入出力・制約・受け入れ条件を整理します。':'対象読者・前提条件・基本操作・手順・トラブル対処を整理します。';
  };
  kind.onchange=update;update();form.append(kindLabel,guidance,destinationLabel,note,error,submit);body.append(form);
  return new Promise(resolve=>{
    let result:TemplateOptions|null=null;
    form.onsubmit=event=>{
      event.preventDefault();const path=destination.value.trim().replace(/\\/g,'/').replace(/\/+$/,'');
      if(!path||path.startsWith('/')||path.includes(':')||path.split('/').some(part=>part==='..'||part==='')||(kind.value==='readme'&&!/\.md$/.test(path))){error.textContent='プロジェクト内の相対パスを指定してください。Readme.mdの出力先には.mdファイルを指定します。';return;}
      result={template:kind.value,destination:path};dialog.close();
    };
    dialog.addEventListener('close',()=>resolve(result),{once:true});
  });
}
