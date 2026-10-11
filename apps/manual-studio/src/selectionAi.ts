import {featureDialog} from './screenshotWorkflow';
import {diffParts,acceptDiff} from './selectableDiff';
export interface SelectionDraft { text:string; apply:(content:string)=>void; }
export function askSelectionInstruction(selected:string,initial=""):Promise<string|null>{
  const {dialog,body}=featureDialog(selected?'指定範囲へAI文書作成':'カーソル位置へAI文書を挿入');
  const help=document.createElement('p');help.textContent=selected?'選択した範囲の文章を作成・修正します。候補を確認してから置き換えます。':'カーソル位置に挿入する新しい文章を作成します。候補を確認してから挿入します。';
  const preview=document.createElement('pre');preview.textContent=selected||"挿入位置（選択範囲なし）";preview.style.maxHeight='160px';preview.style.overflow='auto';
  const label=document.createElement('label');label.textContent='AIへの指示';const instruction=document.createElement('textarea');instruction.rows=4;instruction.value=initial;instruction.setAttribute("aria-label","AIへの指示");instruction.placeholder='例：初めて使う人向けの操作手順に書き直す';label.append(instruction);
  const presets=document.createElement('div');presets.className='actions';for(const text of ['簡潔にする','初心者向けに説明する','操作手順にする','誤字脱字・文法を校正する']){const button=document.createElement('button');button.type='button';button.textContent=text;button.onclick=()=>{instruction.value=text;instruction.focus();};presets.append(button);}
  const run=document.createElement('button');run.type='button';run.className='primary';run.textContent='候補を作成';run.dataset.uiIcon='sparkle';run.disabled=!initial.trim();instruction.oninput=()=>{run.disabled=!instruction.value.trim();};presets.addEventListener('click',()=>{run.disabled=!instruction.value.trim();});
  body.append(help,preview,label,presets,run);
  return new Promise(resolve=>{let answer:string|null=null;run.onclick=()=>{if(!instruction.value.trim())return;answer=instruction.value.trim();dialog.close();};dialog.addEventListener('close',()=>{resolve(answer);dialog.remove();},{once:true});});
}
export function reviewSelection(page:string,before:string,after:string):Promise<{action:'restore'|'retry'|'adopt';feedback:string;content:string}>{
  const {dialog,body}=featureDialog('AI文章の変更を確認');dialog.id='selection-diff-dialog';
  const help=document.createElement('p');help.textContent=`${page}：採用する変更を選択してください。チェックを外した箇所は元の文章を残します。`;
  const parts=diffParts(before,after),accepted=new Set<number>();
  const controls=document.createElement('div');controls.className='actions diff-controls';
  const count=document.createElement('span');count.className='muted';count.role='status';
  const updateCount=()=>{count.textContent=`${accepted.size} / ${parts.filter(part=>part.kind==='change').length}件の変更を採用`;};
  for(const [label,checked] of [['すべて採用',true],['すべて見送り',false]] as const){const button=document.createElement('button');button.type='button';button.textContent=label;button.onclick=()=>{body.querySelectorAll<HTMLInputElement>('[data-diff-part]').forEach(input=>{input.checked=checked;if(checked)accepted.add(Number(input.dataset.diffPart));else accepted.delete(Number(input.dataset.diffPart));});updateCount();};controls.append(button);}
  const list=document.createElement('div');list.className='selectable-diff';
  parts.forEach((part,index)=>{
    const section=document.createElement('section');section.className=`diff-part diff-${part.kind}`;
    if(part.kind==='same'){const context=document.createElement('details');context.className='diff-context';const summary=document.createElement('summary');summary.textContent=`変更のない文章（${part.before.length}行）`;const pre=document.createElement('pre');pre.textContent=part.before.join('\n');context.append(summary,pre);section.append(context);list.append(section);return;}
    if(part.kind==='change'){accepted.add(index);const label=document.createElement('label');const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=true;checkbox.dataset.diffPart=String(index);checkbox.onchange=()=>{if(checkbox.checked)accepted.add(index);else accepted.delete(index);updateCount();};label.append(checkbox,document.createTextNode('この変更を採用'));section.append(label);}
    const columns=document.createElement('div');columns.className='selection-diff-columns';
    for(const [label,lines] of [['変更前',part.before],['変更後',part.after]] as const){const column=document.createElement('div');const heading=document.createElement('strong');heading.textContent=label;const pre=document.createElement('pre');pre.textContent=lines.join('\n');column.append(heading,pre);columns.append(column);}
    section.append(columns);list.append(section);
  });
  controls.append(count);updateCount();
  const label=document.createElement('label');label.textContent='再作成への指示（任意）';const feedback=document.createElement('textarea');feedback.rows=2;label.append(feedback);
  const error=document.createElement('p');error.role='alert';
  const actions=document.createElement('div');actions.className='actions diff-footer';
  body.append(help,controls,list,label,error,actions);
  return new Promise(resolve=>{
    let result:{action:'restore'|'retry'|'adopt';feedback:string;content:string}={action:'restore',feedback:'',content:before};
    const finish=(action:'restore'|'retry'|'adopt')=>{void(async()=>{
      const content=acceptDiff(parts,accepted);
      if(action==='adopt'){try{for(const code of content.matchAll(/```mermaid\s*\n([\s\S]*?)\n```/g))await(await import('mermaid')).default.parse(code[1]);}catch(e){error.textContent=`図の構文を確認してください: ${String(e)}`;return;}}
      result={action,feedback:feedback.value.trim(),content};dialog.close();
    })();};
    for(const [text,action] of [['破棄','restore'],['再作成','retry'],['選んだ変更を反映','adopt']] as const){const button=document.createElement('button');button.type='button';button.textContent=text;button.dataset.diffAction=action;button.dataset.uiIcon=action==='adopt'?'check':action==='retry'?'refresh':'close';if(action==='adopt')button.className='primary';button.onclick=()=>finish(action);actions.append(button);}
    dialog.addEventListener('close',()=>{resolve(result);dialog.remove();},{once:true});
  });
}
