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

export function mergeDocumentChanges(base: string, local: string, stored: string): string | null {
  base = base.replace(/\r\n/g, '\n');
  stored = stored.replace(/\r\n/g, '\n');
  if (local === base || local === stored) return stored;
  if (stored === base) return local;
  function changes(after: string) {
    let start = 0;
    return diffParts(base, after).flatMap(part => {
      const end = start + part.before.length;
      const change = {start, end, lines: part.after};
      start = end;
      return part.kind === 'change' ? [change] : [];
    });
  }
  const edits = [...changes(local), ...changes(stored)].sort((a, b) => a.start - b.start || a.end - b.end);
  const lines = base.split('\n');
  const merged: string[][] = [];
  let previous: (typeof edits)[number] | undefined;
  for (const edit of edits) {
    if (previous && previous.start === edit.start && previous.end === edit.end &&
        previous.lines.length === edit.lines.length && previous.lines.every((line, index) => line === edit.lines[index])) continue;
    if (previous && (edit.start < previous.end ||
        (edit.start === previous.end && (edit.start === edit.end || previous.start === previous.end)))) return null;
    merged.push(lines.slice(previous?.end ?? 0, edit.start), edit.lines);
    previous = edit;
  }
  merged.push(lines.slice(previous?.end ?? 0));
  return merged.flat().join('\n');
}
