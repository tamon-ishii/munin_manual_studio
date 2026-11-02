import {featureDialog} from './imageDialogs';
import {diffParts,acceptDiff} from './selectableDiff';
import {consultationAgents} from './cliAiSettings';
export interface SelectionDraft { text:string; apply:(content:string)=>void; }
export interface SelectionAction {mode:'consult'|'rewrite';instruction:string;cliAgent?:string}
export function askSelectionAction(selected:string,agents:Array<{id:string;available:boolean}>=[],defaultAgent=''):Promise<SelectionAction|null>{
  const {dialog,body}=featureDialog('AIで選択範囲を書き直す');dialog.id='selection-ai-action-dialog';
  const preview=document.createElement('pre');preview.textContent=selected;preview.className='selection-ai-preview';
  const modeLabel=document.createElement('label');modeLabel.textContent='操作';
  const mode=document.createElement('select');mode.setAttribute('aria-label','AI操作');
  mode.add(new Option('書き直し候補を作成','rewrite'));mode.add(new Option('書き直し方針を相談','consult'));modeLabel.append(mode);
  const aiLabel=document.createElement('label');aiLabel.textContent='相談先のAI';
  const ai=document.createElement('select');ai.setAttribute('aria-label','相談先のAI');
  ai.add(new Option('AI設定の既定の接続先',''));
  for(const agent of consultationAgents){const available=agents.some(item=>item.id===agent.id&&item.available);const option=new Option(agent.label+(available?'':'（CLI未検出）'),agent.id);option.disabled=!available;ai.add(option);}
  if(agents.some(agent=>agent.id===defaultAgent&&agent.available))ai.value=defaultAgent;
  aiLabel.append(ai);
  const label=document.createElement('label');label.textContent='相談内容・指示';
  const instruction=document.createElement('textarea');instruction.rows=5;instruction.required=true;instruction.setAttribute('aria-label','相談内容・指示');label.append(instruction);
  const help=document.createElement('p');const update=()=>{
    help.textContent=mode.value==='consult'?'選択範囲を書き直す前提で方針を相談します。回答を見てから、そのまま書き直し候補を作成できます。':'入力した指示を基に、選択範囲の書き直し候補を作成します。差分を確認してから原稿へ反映します。';
    instruction.placeholder=mode.value==='consult'?'例：初心者向けに書き直すには、どの説明を補うとよいですか？':'例：初心者向けに、短く分かりやすく書き直してください';
  };mode.onchange=update;update();
  const form=document.createElement('form');const run=document.createElement('button');run.type='submit';run.className='primary';run.textContent='AIに送信';run.disabled=true;
  instruction.oninput=()=>{run.disabled=!instruction.value.trim();};form.append(modeLabel,aiLabel,help,label,run);body.append(preview,form);instruction.focus();
  return new Promise(resolve=>{let result:SelectionAction|null=null;form.onsubmit=event=>{event.preventDefault();if(!instruction.value.trim())return;result={mode:mode.value as SelectionAction['mode'],instruction:instruction.value.trim(),cliAgent:ai.value||undefined};dialog.close();};dialog.addEventListener('close',()=>resolve(result),{once:true});});
}
export function showSelectionAdvice(content:string):Promise<string|null>{
  const {dialog,body}=featureDialog('AIからの回答');dialog.id='selection-ai-advice-dialog';
  const answer=document.createElement('div');answer.className='selection-ai-answer';answer.textContent=content;body.append(answer);
  const help=document.createElement('p');help.textContent='この回答を踏まえて、相談した選択範囲を書き直せます。候補の差分を確認してから反映します。';
  const form=document.createElement('form');
  const label=document.createElement('label');label.textContent='書き直しへの追加指示（任意）';
  const instruction=document.createElement('textarea');instruction.rows=3;instruction.setAttribute('aria-label','書き直しへの追加指示（任意）');instruction.placeholder='例：専門用語の説明を加え、短い文章にしてください';label.append(instruction);
  const actions=document.createElement('div');actions.className='actions';
  const keep=document.createElement('button');keep.type='button';keep.textContent='書き直さず閉じる';keep.onclick=()=>dialog.close();
  const rewrite=document.createElement('button');rewrite.type='submit';rewrite.className='primary';rewrite.textContent='選択範囲を書き直す';actions.append(keep,rewrite);form.append(help,label,actions);body.append(form);
  return new Promise(resolve=>{let result:string|null=null;form.onsubmit=event=>{event.preventDefault();result=instruction.value.trim();dialog.close();};dialog.addEventListener('close',()=>resolve(result),{once:true});});
}
export function askSelectionInstruction(selected:string,initial="",failure=""):Promise<string|null>{
  const {dialog,body}=featureDialog(selected?'選択範囲をAIで修正':'カーソル位置へAI文書を挿入');
  const help=document.createElement('p');help.textContent=selected?'選択した文章だけを、下の指示に沿って修正します。差分を確認し、採用した変更だけを反映します。選択範囲外の文章は変更しません。':'カーソル位置に挿入する新しい文章を作成します。候補を確認してから挿入します。';
  const preview=document.createElement('pre');preview.textContent=selected||"挿入位置（選択範囲なし）";preview.style.maxHeight='160px';preview.style.overflow='auto';
  const label=document.createElement('label');label.textContent='AIへの指示';const instruction=document.createElement('textarea');instruction.rows=4;instruction.value=initial;instruction.setAttribute("aria-label","AIへの指示");instruction.placeholder='例：初めて使う人向けの操作手順に書き直す';label.append(instruction);
  const presets=document.createElement('div');presets.className='actions';for(const text of ['簡潔にする','初心者向けに説明する','操作手順にする','誤字脱字・文法を校正する']){const button=document.createElement('button');button.type='button';button.textContent=text;button.onclick=()=>{instruction.value=text;instruction.focus();};presets.append(button);}
  const run=document.createElement('button');run.type='button';run.className='primary';run.textContent='候補を作成';run.dataset.uiIcon='sparkle';run.disabled=!initial.trim();instruction.oninput=()=>{run.disabled=!instruction.value.trim();};presets.addEventListener('click',()=>{run.disabled=!instruction.value.trim();});
  const error=document.createElement('p');error.role='alert';error.textContent=failure;
  body.append(help,error,preview,label,presets,run);
  return new Promise(resolve=>{let answer:string|null=null;run.onclick=()=>{if(!instruction.value.trim())return;answer=instruction.value.trim();dialog.close();};dialog.addEventListener('close',()=>{resolve(answer);dialog.remove();},{once:true});});
}
export interface SelectionReviewState {accepted:number[];feedback:string;}
export function reviewSelection(page:string,before:string,after:string,previous?:SelectionReviewState,failure='',allowRetry=true):Promise<{action:'restore'|'retry'|'adopt';feedback:string;content:string;accepted:number[]}>{
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
    if(part.kind==='change'){if(!previous||previous.accepted.includes(index))accepted.add(index);const label=document.createElement('label');const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=accepted.has(index);checkbox.dataset.diffPart=String(index);checkbox.onchange=()=>{if(checkbox.checked)accepted.add(index);else accepted.delete(index);updateCount();};label.append(checkbox,document.createTextNode('この変更を採用'));section.append(label);}
    const columns=document.createElement('div');columns.className='selection-diff-columns';
    for(const [label,lines] of [['変更前',part.before],['変更後',part.after]] as const){const column=document.createElement('div');const heading=document.createElement('strong');heading.textContent=label;const pre=document.createElement('pre');pre.textContent=lines.join('\n');column.append(heading,pre);columns.append(column);}
    section.append(columns);list.append(section);
  });
  controls.append(count);updateCount();
  const label=document.createElement('label');label.textContent='再作成への指示（任意）';const feedback=document.createElement('textarea');feedback.rows=2;feedback.value=previous?.feedback||'';label.append(feedback);
  label.hidden=!allowRetry;
  const error=document.createElement('p');error.role='alert';error.textContent=failure;
  const actions=document.createElement('div');actions.className='actions diff-footer';
  body.append(help,controls,list,label,error,actions);
  return new Promise(resolve=>{
    let result:{action:'restore'|'retry'|'adopt';feedback:string;content:string;accepted:number[]}={action:'restore',feedback:'',content:before,accepted:[...accepted]};
    const finish=(action:'restore'|'retry'|'adopt')=>{void(async()=>{
      const content=acceptDiff(parts,accepted);
      if(action==='adopt'){try{for(const code of content.matchAll(/```mermaid\s*\n([\s\S]*?)\n```/g))await(await import('mermaid')).default.parse(code[1]);}catch(e){error.textContent=`図の構文を確認してください: ${String(e)}`;return;}}
      result={action,feedback:feedback.value.trim(),content,accepted:[...accepted]};dialog.close();
    })();};
    for(const [text,action] of [['破棄','restore'],['再作成','retry'],['選んだ変更を反映','adopt']] as const){if(action==='retry'&&!allowRetry)continue;const button=document.createElement('button');button.type='button';button.textContent=text;button.dataset.diffAction=action;button.dataset.uiIcon=action==='adopt'?'check':action==='retry'?'refresh':'close';if(action==='adopt')button.className='primary';button.onclick=()=>finish(action);actions.append(button);}
    dialog.addEventListener('close',()=>{resolve(result);dialog.remove();},{once:true});
  });
}
