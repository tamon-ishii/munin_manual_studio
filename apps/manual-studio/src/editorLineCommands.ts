export interface LineRange {start:number;end:number;deleteStart:number;deleteEnd:number;text:string}
export function currentLine(text:string,cursor:number):LineRange {
  const start=text.lastIndexOf('\n',cursor-1)+1;
  const next=text.indexOf('\n',cursor),end=next<0?text.length:next;
  return {start,end,deleteStart:next<0&&start>0?start-1:start,deleteEnd:next<0?end:end+1,text:text.slice(start,end)+'\n'};
}
