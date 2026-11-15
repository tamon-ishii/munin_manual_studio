import {diffParts} from './selectableDiff';
export interface ComparisonBlock {changed:boolean;columns:string[][]}
/** Align versions on shared original ranges, including insertions and deletions. */
export function comparisonBlocks(original:string,versions:string[]):ComparisonBlock[]{
  const base=original.split('\n');
  const changes=versions.map(version=>{
    let offset=0;
    return diffParts(original,version).flatMap(part=>{
      const start=offset;offset+=part.before.length;
      return part.kind==='change'?[{start,end:offset,lines:part.after}]:[];
    });
  });
  const ranges:Array<{start:number;end:number}>=[];
  for(const change of changes.flat().sort((a,b)=>a.start-b.start||a.end-b.end)){
    const last=ranges.at(-1);
    if(last&&change.start<=last.end)last.end=Math.max(last.end,change.end);
    else ranges.push({start:change.start,end:change.end});
  }
  const blocks:ComparisonBlock[]=[];let offset=0;
  const same=(start:number,end:number)=>{if(end>start)blocks.push({changed:false,columns:Array.from({length:versions.length+1},()=>base.slice(start,end))});};
  for(const range of ranges){
    same(offset,range.start);
    const columns=[base.slice(range.start,range.end),...changes.map(edits=>{
      let cursor=range.start;const lines:string[]=[];
      for(const edit of edits){
        if(edit.start<range.start||edit.end>range.end)continue;
        lines.push(...base.slice(cursor,edit.start),...edit.lines);cursor=edit.end;
      }
      lines.push(...base.slice(cursor,range.end));return lines;
    })];
    blocks.push({changed:true,columns});offset=range.end;
  }
  same(offset,base.length);return blocks;
}
