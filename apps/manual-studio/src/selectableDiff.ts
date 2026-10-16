import {diffLines} from './generationReview';
export interface DiffPart { kind:'same'|'change'; before:string[]; after:string[]; }
export function diffParts(before:string,after:string):DiffPart[]{
  const parts:DiffPart[]=[];
  for(const line of diffLines(before,after)){
    const kind=line.kind==='same'?'same':'change';
    let part=parts.at(-1);if(!part||part.kind!==kind){part={kind,before:[],after:[]};parts.push(part);}
    if(line.kind!=='add')part.before.push(line.text);
    if(line.kind!=='remove')part.after.push(line.text);
  }
  return parts;
}
export function acceptDiff(parts:DiffPart[],accepted:Set<number>):string{
  return parts.flatMap((part,index)=>part.kind==='same'||!accepted.has(index)?part.before:part.after).join('\n');
}
