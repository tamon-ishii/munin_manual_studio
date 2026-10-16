import {moveSection,sameOwner,type ManuscriptOwner,type ManuscriptToolsOptions,type OutlineHeading} from './manuscriptTools';

export function setupManuscriptOutline(options:ManuscriptToolsOptions):{refresh:()=>void} {
  const host=document.getElementById('manuscript-outline-list')!;
  let timer:ReturnType<typeof setTimeout>|undefined,version=0,source:ManuscriptOwner|null=null,headings:OutlineHeading[]=[];
  let dragged:{index:number;version:number;owner:ManuscriptOwner}|null=null;
  const move=(from:number,to:number,after=false)=>{
    if(options.busy()||!source||!sameOwner(options.current(),source))return;
    try{const owner=source;const result=moveSection(owner.content,headings,from,to,after);options.applyContent(result.content,owner);options.report('節を移動しました。元に戻す操作で復元できます。');}
    catch(error){options.report(String(error),true);}
  };
  const render=()=>{
    host.replaceChildren();
    if(!source||!headings.length){const empty=document.createElement('p');empty.className='muted';empty.textContent=source?'見出しがありません。':'原稿を選択すると見出しが表示されます。';host.append(empty);return;}
    headings.forEach((heading,index)=>{
      const row=document.createElement('div');row.className='manuscript-outline-row';row.dataset.outlineIndex=String(index);row.style.paddingInlineStart=`${(heading.level-1)*12}px`;
      row.draggable=!options.busy();
      row.ondragstart=event=>{if(!source||!sameOwner(options.current(),source))return;dragged={index,version,owner:source};event.dataTransfer?.setData('application/x-munin-heading',JSON.stringify({index,version}));if(event.dataTransfer)event.dataTransfer.effectAllowed='move';};
      row.ondragover=event=>{if(event.dataTransfer?.types.includes('application/x-munin-heading'))event.preventDefault();};
      row.ondrop=event=>{const value=event.dataTransfer?.getData('application/x-munin-heading');if(!value)return;event.preventDefault();try{const data=JSON.parse(value);if(!dragged||dragged.version!==version||data.version!==version||data.index!==dragged.index||!sameOwner(options.current(),dragged.owner))throw new Error('原稿が変更されました。ドラッグし直してください。');move(dragged.index,index);}catch(error){options.report(String(error),true);}finally{dragged=null;}};
      row.ondragend=()=>{dragged=null;};
      const jump=document.createElement('button');jump.textContent=`H${heading.level} ${heading.label||'（無題）'}`;jump.className='manuscript-outline-jump';jump.disabled=options.busy();
      jump.onclick=()=>{const owner=source;if(!owner||!sameOwner(options.current(),owner))return;void options.work(async()=>{await options.navigate(owner.page,heading.start,heading.heading_end);});};
      const siblings=headings.map((h,i)=>({h,i})).filter(({h})=>h.parent===heading.parent&&h.level===heading.level);
      const position=siblings.findIndex(({i})=>i===index);
      const up=document.createElement('button');up.textContent='↑';up.setAttribute('aria-label',`${heading.label}を上へ`);up.disabled=options.busy()||position===0;
      up.onclick=()=>move(index,siblings[position-1].i);
      const down=document.createElement('button');down.textContent='↓';down.setAttribute('aria-label',`${heading.label}を下へ`);down.disabled=options.busy()||position===siblings.length-1;
      down.onclick=()=>move(index,siblings[position+1].i,true);
      row.append(jump,up,down);host.append(row);
    });
  };
  const refresh=()=>{
    const owner=options.current();
    if(source&&owner&&sameOwner(owner,source)){render();return;}
    clearTimeout(timer);const requestVersion=++version;
    if(!owner){source=null;headings=[];render();return;}
    source=null;headings=[];render();
    timer=setTimeout(()=>{void(async()=>{
      try{
        const result=JSON.parse(await options.request('editor-outline',{json:{content:owner.content}},owner.root)) as {headings:OutlineHeading[]};
        if(requestVersion!==version||!sameOwner(options.current(),owner))return;
        if(!Array.isArray(result.headings))throw new Error('見出しの応答が不正です。');
        source=owner;headings=result.headings;render();
      }catch(error){if(requestVersion===version){host.textContent=`見出しを読み取れません: ${String(error)}`;}}
    })();},180);
  };
  return {refresh};
}
