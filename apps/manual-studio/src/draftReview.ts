import {featureDialog} from './screenshotWorkflow';
import {diffParts,acceptDiff} from './selectableDiff';
export interface DraftPage {path:string;before:string;content:string;revision:string|null;}
export interface DraftCandidate {docs:string;pages:DraftPage[];}

export function reviewDraft(candidate:DraftCandidate,valid:()=>boolean):Promise<DraftPage[]|null>{
  const {dialog,body}=featureDialog('全文下書きの変更を確認');dialog.id='draft-diff-dialog';
  const note=document.createElement('p');note.textContent='原稿はまだ変更していません。ページと変更箇所を選んで反映してください。候補にない既存ページは保持します。';
  const controls=document.createElement('div');controls.className='actions';
  const count=document.createElement('p');count.role='status';
  const error=document.createElement('p');error.role='alert';
  const states=candidate.pages.map(page=>({page,parts:diffParts(page.before,page.content),accepted:new Set<number>(),enabled:true,checkbox:document.createElement('input')}));
  const apply=document.createElement('button');apply.type='button';apply.className='primary';apply.textContent='選んだ変更を反映';apply.dataset.uiIcon='check';
  const selected=()=>states.filter(state=>state.enabled&&acceptDiff(state.parts,state.accepted)!==state.page.before).map(state=>({...state.page,content:acceptDiff(state.parts,state.accepted)}));
  const update=()=>{const pages=selected();count.textContent=`${pages.length} / ${states.length}ページを反映`;apply.disabled=pages.length===0;};
  body.append(note,controls,count,error);
  for(const state of states){
    const card=document.createElement('section');card.className='card draft-page';card.dataset.draftPage=state.page.path;
    const label=document.createElement('label');state.checkbox.type='checkbox';state.checkbox.checked=true;state.checkbox.dataset.draftEnabled=state.page.path;label.append(state.checkbox,document.createTextNode(`${state.page.path}（${state.page.revision===null?'新規':'変更'}）を採用`));card.append(label);
    const list=document.createElement('div');list.className='selectable-diff';
    state.parts.forEach((part,index)=>{
      const section=document.createElement('section');section.className=`diff-part diff-${part.kind}`;
      if(part.kind==='same'){const details=document.createElement('details');const heading=document.createElement('summary');heading.textContent=`変更のない文章（${part.before.length}行）`;const pre=document.createElement('pre');pre.textContent=part.before.join('\n');details.append(heading,pre);section.append(details);}
      else{
        state.accepted.add(index);const change=document.createElement('input');change.type='checkbox';change.checked=true;change.dataset.draftPart=String(index);const changeLabel=document.createElement('label');changeLabel.append(change,document.createTextNode('この変更を採用'));section.append(changeLabel);change.onchange=()=>{if(change.checked)state.accepted.add(index);else state.accepted.delete(index);update();};
        const columns=document.createElement('div');columns.className='selection-diff-columns';for(const [text,lines] of [['変更前',part.before],['変更後',part.after]] as const){const column=document.createElement('div');const title=document.createElement('strong');title.textContent=text;const pre=document.createElement('pre');pre.textContent=lines.join('\n');column.append(title,pre);columns.append(column);}section.append(columns);
      }
      list.append(section);
    });
    state.checkbox.onchange=()=>{state.enabled=state.checkbox.checked;list.querySelectorAll<HTMLInputElement>('input').forEach(input=>input.disabled=!state.enabled);update();};card.append(list);body.append(card);
  }
  for(const [text,checked] of [['すべて採用',true],['すべて見送り',false]] as const){const button=document.createElement('button');button.type='button';button.textContent=text;button.onclick=()=>{for(const state of states){state.enabled=checked;state.checkbox.checked=checked;state.accepted.clear();state.parts.forEach((part,index)=>{if(checked&&part.kind==='change')state.accepted.add(index);});const card=state.checkbox.closest('.draft-page');card?.querySelectorAll<HTMLInputElement>('[data-draft-part]').forEach(input=>input.checked=checked);state.checkbox.onchange?.(new Event('change'));}update();};controls.append(button);}
  const footer=document.createElement('div');footer.className='actions diff-footer';const discard=document.createElement('button');discard.type='button';discard.textContent='破棄';discard.dataset.uiIcon='close';footer.append(discard,apply);body.append(footer);update();
  return new Promise(resolve=>{let result:DraftPage[]|null=null;discard.onclick=()=>dialog.close();apply.onclick=()=>{void(async()=>{if(!valid()){error.textContent='原稿が変更されました。候補を作り直してください。';return;}const pages=selected();try{for(const page of pages)for(const code of page.content.matchAll(/```mermaid\s*\n([\s\S]*?)\n```/g))await(await import('mermaid')).default.parse(code[1]);}catch(e){error.textContent=`図の構文を確認してください：${String(e)}`;return;}if(!valid()){error.textContent='原稿が変更されました。候補を作り直してください。';return;}result=pages;dialog.close();})();};dialog.addEventListener('close',()=>{resolve(result);dialog.remove();},{once:true});});
}
