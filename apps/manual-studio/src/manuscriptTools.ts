import type {Document} from './types';
import {diffLines} from './generationReview';

export interface ManuscriptOwner extends Document {root:string; session:number}
export interface ManuscriptToolsOptions {
  root:()=>string;
  current:()=>ManuscriptOwner|null;
  busy:()=>boolean;
  request:(action:string,options?:Record<string,unknown>,root?:string)=>Promise<string>;
  work:(operation:()=>Promise<void>)=>Promise<void>;
  prepare:(pages?:string[])=>Promise<void>;
  navigate:(page:string,start:number,end:number)=>Promise<void>;
  applyContent:(next:string,expected:ManuscriptOwner)=>void;
  changed:(documents:Document[])=>Promise<void>;
  report:(message:string,error?:boolean)=>void;
}

export function sameOwner(current:ManuscriptOwner|null,expected:ManuscriptOwner):boolean {
  return Boolean(current&&current.root===expected.root&&current.page===expected.page&&current.session===expected.session&&current.content===expected.content);
}

export interface SearchMatch {page:string;start:number;end:number;text:string;line:number;column:number;excerpt:string}
export function replaceMatches(content:string,matches:SearchMatch[],replacement:string):string {
  let next=content,last=content.length;
  for(const match of [...matches].sort((a,b)=>b.start-a.start)) {
    if(!Number.isInteger(match.start)||!Number.isInteger(match.end)||match.start<0||match.end>last||match.start>=match.end||content.slice(match.start,match.end)!==match.text)
      throw new Error('検索結果と原稿が一致しません。検索し直してください。');
    next=next.slice(0,match.start)+replacement+next.slice(match.end);last=match.start;
  }
  return next;
}

export interface OutlineHeading {start:number;heading_end:number;end:number;level:number;label:string;parent:number|null}
export function moveSection(content:string,headings:OutlineHeading[],from:number,to:number,after=false):{content:string;start:number} {
  const source=headings[from],target=headings[to];
  if(!source||!target||source.level!==target.level||source.parent!==target.parent)
    throw new Error('同じ親・階層の見出しへ移動してください。');
  if(from===to)return {content,start:source.start};
  const at=after?target.end:target.start;
  if(source.start<0||source.end>content.length||source.start>=source.end||at>source.start&&at<source.end)
    throw new Error('見出しの位置が変わりました。操作をやり直してください。');
  const rest=content.slice(0,source.start)+content.slice(source.end);
  let start=at>=source.end?at-(source.end-source.start):at;
  let block=content.slice(source.start,source.end);
  const newline=content.includes('\r\n')?'\r\n':'\n';
  if(start>0&&!rest.slice(0,start).endsWith('\n')&&!block.startsWith('\n')) {block=newline+block;start+=newline.length;}
  const insertAt=at>=source.end?at-(source.end-source.start):at;
  if(rest.slice(insertAt)&&!block.endsWith('\n'))block+=newline;
  return {content:rest.slice(0,insertAt)+block+rest.slice(insertAt),start};
}

export function appendContentDiff(target:HTMLElement,before:string,after:string,title:string):void {
  const section=document.createElement('section');section.className='manuscript-change-preview';
  const heading=document.createElement('h3');heading.textContent=title;
  const columns=document.createElement('div');columns.className='selection-diff-columns';
  const lines=diffLines(before,after);
  for(const [label,side] of [['変更前','before'],['変更後','after']]) {
    const column=document.createElement('div');const name=document.createElement('strong');name.textContent=label;
    const pre=document.createElement('pre');
    for(const line of lines){if(side==='before'&&line.kind==='add'||side==='after'&&line.kind==='remove')continue;const span=document.createElement('span');span.className=`manuscript-diff-${line.kind}`;span.textContent=line.text+'\n';pre.append(span);}
    column.append(name,pre);columns.append(column);
  }
  section.append(heading,columns);target.append(section);
}
