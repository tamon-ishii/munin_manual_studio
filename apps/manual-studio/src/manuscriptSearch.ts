import {featureDialog} from './screenshotWorkflow';
import {appendContentDiff,replaceMatches,type ManuscriptToolsOptions,type SearchMatch} from './manuscriptTools';
import type {Document} from './types';

interface SearchResult {documents:Document[];matches:SearchMatch[];skipped:{page:string;message:string}[];truncated:boolean}
interface Batch {root:string;before:Document[];documents:Document[]}

export function setupManuscriptSearch(options:ManuscriptToolsOptions):()=>void {
  let lastBatch:Batch|null=null;
  return ()=>{
    if(!options.root()){options.report('先にプロジェクトを開いてください。',true);return;}
    const root=options.root();
    const {dialog,body}=featureDialog('全文検索・選択置換');dialog.dataset.manuscriptSearch='true';
    const form=document.createElement('form');form.className='manuscript-search-form';
    const query=document.createElement('input');query.type='search';query.required=true;query.maxLength=4096;query.setAttribute('aria-label','検索する文字');
    const replacement=document.createElement('input');replacement.setAttribute('aria-label','置換後の文字');
    const label=(text:string,field:HTMLElement)=>{const node=document.createElement('label');node.textContent=text;node.append(field);return node;};
    const sensitive=document.createElement('input');sensitive.type='checkbox';sensitive.checked=true;
    const submit=document.createElement('button');submit.type='submit';submit.textContent='検索';
    form.append(label('検索する文字',query),label('置換後の文字',replacement),label('大文字・小文字を区別',sensitive),submit);
    const message=document.createElement('p');message.role='status';message.className='manuscript-search-status';
    const tools=document.createElement('div');tools.className='actions';
    const all=document.createElement('button');all.textContent='全選択';
    const none=document.createElement('button');none.textContent='選択解除';
    const preview=document.createElement('button');preview.textContent='選んだ置換を確認';
    const apply=document.createElement('button');apply.textContent='選んだ箇所を置換';apply.className='primary';apply.hidden=true;
    const undo=document.createElement('button');undo.textContent='置換を元に戻す';
    tools.append(all,none,preview,apply,undo);
    const list=document.createElement('div');list.className='manuscript-search-results';
    const diff=document.createElement('div');diff.className='manuscript-search-preview';
    body.append(form,message,tools,list,diff);
    let result:SearchResult|null=null,selected=new Set<number>(),changes:Document[]|null=null,running=false;
    const current=()=>dialog.isConnected&&root===options.root();
    const sync=()=>{
      for(const control of [query,replacement,sensitive,submit,all,none,preview,apply,undo])control.disabled=running;
      preview.disabled=running||!selected.size;all.disabled=none.disabled=running||!result?.matches.length;
      undo.disabled=running||lastBatch?.root!==root;apply.disabled=running||!changes?.length;
      list.querySelectorAll<HTMLInputElement|HTMLButtonElement>('input,button').forEach(control=>{control.disabled=running;});
    };
    const invalidate=()=>{changes=null;apply.hidden=true;diff.replaceChildren();sync();};
    const perform=async(operation:()=>Promise<void>)=>{
      if(running||!current())return;running=true;sync();
      try {await options.work(async()=>{try{await operation();}catch(error){if(current()){message.role='alert';message.textContent=String(error);}}});}
      finally {running=false;if(current())sync();}
    };
    const select=(value:boolean)=>{
      selected=new Set(value?result?.matches.map((_,i)=>i):[]);
      list.querySelectorAll<HTMLInputElement>('[data-search-hit]').forEach(node=>{node.checked=value;});invalidate();
    };
    all.onclick=()=>select(true);none.onclick=()=>select(false);
    replacement.oninput=invalidate;
    const reset=()=>{result=null;selected.clear();list.replaceChildren();invalidate();message.textContent='条件を変更しました。検索してください。';};
    query.oninput=reset;sensitive.onchange=reset;
    form.onsubmit=event=>{event.preventDefault();void perform(async()=>{
      await options.prepare();
      const found=JSON.parse(await options.request('project-search',{json:{query:query.value,case_sensitive:sensitive.checked}},root)) as SearchResult;
      if(!current())return;result=found;selected.clear();invalidate();list.replaceChildren();message.role='status';
      message.textContent=`${found.matches.length}件の一致${found.truncated?'（上限に達しました。検索を絞ってください）':''}${found.skipped.length?`・読めなかった原稿 ${found.skipped.length}件`:''}`;
      for(const skipped of found.skipped){const note=document.createElement('p');note.textContent=`${skipped.page}: ${skipped.message}`;list.append(note);}
      found.matches.forEach((match,index)=>{
        const row=document.createElement('div');row.className='manuscript-search-result';
        const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.dataset.searchHit=String(index);checkbox.setAttribute('aria-label',`${match.page} ${match.line}行 ${match.column}列を置換`);
        checkbox.onchange=()=>{checkbox.checked?selected.add(index):selected.delete(index);invalidate();};
        const jump=document.createElement('button');jump.textContent=`${match.page}:${match.line}:${match.column}`;
        jump.onclick=()=>{const ownerRoot=root;dialog.close();void options.work(async()=>{if(ownerRoot!==options.root())return;const saved=JSON.parse(await options.request('editor-read',{page:match.page},root)) as Document;const expected=found.documents.find(d=>d.page===match.page);if(saved.revision!==expected?.revision)throw new Error('原稿が変更されています。検索し直してください。');await options.navigate(match.page,match.start,match.end);});};
        const excerpt=document.createElement('code');excerpt.textContent=match.excerpt;
        row.append(checkbox,jump,excerpt);list.append(row);
      });
    });};
    preview.onclick=()=>{
      if(!result||!current())return;changes=[];diff.replaceChildren();
      try {
        for(const document of result.documents){const matches=result.matches.filter((m,i)=>m.page===document.page&&selected.has(i));if(!matches.length)continue;
          const content=replaceMatches(document.content,matches,replacement.value);if(content===document.content)continue;
          changes.push({...document,content});appendContentDiff(diff,document.content,content,document.page);
        }
        message.textContent=`${selected.size}箇所・${changes.length}原稿の置換候補。変更前と変更後を確認してください。`;apply.hidden=!changes.length;sync();
      } catch(error){message.role='alert';message.textContent=String(error);invalidate();}
    };
    apply.onclick=()=>{void perform(async()=>{
      if(!changes?.length||!current())return;const planned=changes;
      await options.prepare(planned.map(d=>d.page));if(!current())return;
      const saved=JSON.parse(await options.request('editor-batch-save',{json:{documents:planned}},root)) as Omit<Batch,'root'>;
      lastBatch={root,...saved};if(!current())return;
      await options.changed(saved.documents);reset();message.role='status';message.textContent=`${saved.documents.length}原稿を置換しました。置換を元に戻すこともできます。`;
    });};
    undo.onclick=()=>{void perform(async()=>{
      const batch=lastBatch;if(!batch||batch.root!==root)return;
      await options.prepare(batch.before.map(d=>d.page));if(!current())return;
      const documents=batch.before.map((before,i)=>({...before,revision:batch.documents[i].revision}));
      const saved=JSON.parse(await options.request('editor-batch-save',{json:{documents}},root)) as Omit<Batch,'root'>;
      if(lastBatch===batch)lastBatch=null;if(!current())return;
      await options.changed(saved.documents);reset();message.role='status';message.textContent='置換した原稿を元に戻しました。';
    });};
    sync();query.focus();
  };
}
