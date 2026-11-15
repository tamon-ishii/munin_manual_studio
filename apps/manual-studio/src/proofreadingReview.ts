import {featureDialog} from './imageDialogs';
import {comparisonBlocks} from './proofreadingDiff';
import {openProofreadingWindow} from './proofreadingWindow';

export function reviewProofreading(original:string,variants:Array<{id:string;content?:string;error?:string}>,options:{selections?:number[];standalone?:boolean}={}):Promise<string|null>{
  // A DOM dialog is clipped to its owning webview, regardless of its CSS size.
  // Desktop comparisons must start in an independent native window.
  if('__TAURI_INTERNALS__' in window&&!options.standalone){
    return openProofreadingWindow({original,variants,selections:options.selections??[]},new AbortController().signal);
  }
  const {dialog,body}=featureDialog('推敲結果の差分比較');dialog.id='proofreading-dialog';
  const help=document.createElement('p');help.textContent='原文と各推敲結果を横に並べて比較します。差分ごとに採用する列を選ぶと、右端の最終結果に反映されます。';
  const sources=[{id:'原文',content:original},...variants];
  const blocks=comparisonBlocks(original,variants.map(variant=>variant.content??original));
  const selections=blocks.map(()=>0);
  const viewport=document.createElement('div');viewport.className='proofreading-viewport';viewport.tabIndex=0;viewport.setAttribute('aria-label','原文・推敲結果・最終結果の差分比較');
  const grid=document.createElement('div');grid.className='proofreading-grid';grid.style.setProperty('--proofreading-columns',String(sources.length+1));
  const status=document.createElement('p');status.role='status';
  const updateStatus=()=>{status.textContent=`差分 ${blocks.filter(block=>block.changed).length}件・推敲案を採用 ${selections.filter(index=>index>0).length}件`;};
  const finalCells:HTMLElement[]=[],radios:Array<Array<HTMLInputElement|undefined>>=[];
  const select=(row:number,column:number)=>{
    selections[row]=column;
    finalCells[row].querySelector('pre')!.textContent=blocks[row].columns[column].join('\n');
    finalCells[row].querySelector('small')!.textContent=`採用：${sources[column].id}`;
    radios[row]?.forEach((radio,i)=>{if(radio){radio.checked=i===column;radio.closest('.proofreading-cell')!.classList.toggle('is-selected',radio.checked);}});
    updateStatus();
  };
  sources.forEach((source,column)=>{
    const heading=document.createElement('div');heading.className='proofreading-heading';
    const title=document.createElement('strong');title.textContent=source.id;
    const all=document.createElement('button');all.type='button';all.textContent='この列をすべて採用';all.setAttribute('aria-label',`${source.id}をすべて採用`);all.disabled=source.content===undefined;
    all.onclick=()=>blocks.forEach((block,row)=>{if(block.changed)select(row,column);});heading.append(title,all);
    if(source.error){const error=document.createElement('span');error.className='proofreading-error';error.textContent=`生成失敗：${source.error}`;heading.append(error);}
    grid.append(heading);
  });
  const finalHeading=document.createElement('div');finalHeading.className='proofreading-heading proofreading-final';finalHeading.textContent='最終結果';grid.append(finalHeading);
  const lineNumbers=sources.map(()=>1);let changeNumber=0;
  const changeRows:HTMLElement[]=[];
  blocks.forEach((block,row)=>{
    radios[row]=[];if(block.changed)changeNumber++;
    block.columns.forEach((lines,column)=>{
      const cell=document.createElement('div');cell.className='proofreading-cell';cell.dataset.comparisonRow=String(row);cell.dataset.comparisonColumn=String(column);
      const differs=lines.join('\n')!==block.columns[0].join('\n')||lines.length!==block.columns[0].length;
      if(block.changed)cell.classList.add(column===0?'proofreading-original':differs?'proofreading-changed':'proofreading-unchanged');
      const meta=document.createElement('div');meta.className='proofreading-cell-meta';
      const number=document.createElement('small');number.textContent=lines.length?`行 ${lineNumbers[column]}${lines.length>1?`–${lineNumbers[column]+lines.length-1}`:''}`:'行なし';lineNumbers[column]+=lines.length;meta.append(number);
      if(block.changed){
        const label=document.createElement('label'),radio=document.createElement('input');radio.type='radio';radio.name=`proofreading-block-${row}`;radio.value=String(column);radio.checked=column===0;radio.disabled=sources[column].content===undefined;
        radio.setAttribute('aria-label',`差分${changeNumber}：${sources[column].id}を採用`);radio.onchange=()=>select(row,column);label.append(radio,'採用');meta.append(label);radios[row][column]=radio;
        if(column===0){cell.classList.add('is-selected');cell.id=`proofreading-change-${changeNumber}`;changeRows.push(cell);}
      }
      const pre=document.createElement('pre');pre.textContent=lines.join('\n');cell.append(meta,pre);grid.append(cell);
    });
    const final=document.createElement('div');final.className='proofreading-cell proofreading-final';final.dataset.finalRow=String(row);
    const source=document.createElement('small');source.textContent=block.changed?'採用：原文':'変更なし';const pre=document.createElement('pre');pre.textContent=block.columns[0].join('\n');final.append(source,pre);finalCells[row]=final;grid.append(final);
  });
  viewport.append(grid);
  const toolbar=document.createElement('div');toolbar.className='actions proofreading-toolbar';
  let currentChange=-1;
  for(const [text,direction] of [['前の差分',-1],['次の差分',1]] as const){
    const button=document.createElement('button');button.type='button';button.textContent=text;button.disabled=!changeRows.length;button.onclick=()=>{currentChange=currentChange<0?(direction>0?0:changeRows.length-1):(currentChange+direction+changeRows.length)%changeRows.length;changeRows[currentChange].scrollIntoView({block:'center',inline:'nearest'});};toolbar.append(button);
  }
  const legend=document.createElement('span');legend.className='proofreading-legend';legend.textContent='赤：原文の変更箇所　緑：推敲による変更　枠：採用中';toolbar.append(legend);
  const actions=document.createElement('div');actions.className='actions';
  const cancel=document.createElement('button');cancel.type='button';cancel.textContent='キャンセル';cancel.onclick=()=>dialog.close();
  const finish=document.createElement('button');finish.type='button';finish.className='primary';finish.textContent='最終結果を確定';
  const error=document.createElement('p');error.role='alert';
  const detach=document.createElement('button');detach.type='button';detach.textContent='別ウィンドウで開く';detach.hidden=Boolean(options.standalone);toolbar.prepend(detach);
  const abort=new AbortController();dialog.addEventListener('close',()=>abort.abort(),{once:true});
  actions.append(cancel,finish);body.append(help,toolbar,viewport,status,error,actions);updateStatus();
  options.selections?.forEach((column,row)=>{if(blocks[row]?.changed&&sources[column]?.content!==undefined)select(row,column);});
  return new Promise(resolve=>{
    let result:string|null=null;
    detach.onclick=()=>{void(async()=>{
      detach.disabled=true;error.textContent='';
      try{
        const content=await openProofreadingWindow({original,variants,selections:[...selections]},abort.signal);
        if(content!==null&&dialog.open){result=content;dialog.close();}
      }catch(e){error.textContent=String(e);}
      finally{detach.disabled=false;}
    })();};
    finish.onclick=()=>{void(async()=>{
      const content=blocks.flatMap((block,row)=>block.columns[selections[row]]).join('\n');
      finish.disabled=true;
      try{
        for(const code of content.matchAll(/```mermaid\s*\n([\s\S]*?)\n```/g))await(await import('mermaid')).default.parse(code[1]);
        if(!dialog.open)return;
        result=content;dialog.close();
      }catch(e){error.textContent=`図の構文を確認してください: ${String(e)}`;}
      finally{finish.disabled=false;}
    })();};
    dialog.addEventListener('close',()=>resolve(result),{once:true});
  });
}
