export interface ImagePresentation {src:string;alt:string;caption:string;width:number|null;align:'left'|'center'|'right';configured:boolean}
export interface DocumentImage extends ImagePresentation {start:number;end:number;raw:string}
const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export function parseFigure(value:string):ImagePresentation|undefined {
  const document=new DOMParser().parseFromString(value,'text/html');const figure=document.querySelector('figure[data-munin-image]');const image=figure?.querySelector('img');
  if(!figure||!image)return;
  const width=figure.hasAttribute('data-width')?Number(figure.getAttribute('data-width')):null;const alignment=figure.getAttribute('data-align');
  return {src:image.getAttribute('src')||'',alt:image.getAttribute('alt')||'',caption:figure.querySelector('figcaption')?.textContent||'',width:width===null?null:Number.isFinite(width)?Math.max(1,Math.min(100,width)):100,align:alignment==='left'||alignment==='right'?alignment:'center',configured:true};
}
export function renderFigure(image:ImagePresentation):string {
  if(!image.configured)return `<img src="${escape(image.src)}" alt="${escape(image.alt)}">`;
  const margin=image.align==='left'?'0 auto 0 0':image.align==='right'?'0 0 0 auto':'0 auto';
  return `<figure data-munin-image="true" ${image.width===null?'':`data-width="${image.width}" `}data-align="${image.align}" style="width:${image.width===null?'fit-content':`${image.width}%`};max-width:100%;margin:${margin};text-align:${image.align}"><img src="${escape(image.src)}" alt="${escape(image.alt)}" style="${image.width===null?'max-width:100%':'width:100%'};height:auto">${image.caption?`<figcaption>${escape(image.caption)}</figcaption>`:''}</figure>`;
}
export function documentImages(source:string):DocumentImage[] {
  const ignored:Array<[number,number]>=[];let fence:{start:number;char:string;length:number}|undefined;let offset=0;
  for(const line of source.split(/(?<=\n)/)){const match=/^ {0,3}(`{3,}|~{3,})/.exec(line);if(match){if(!fence)fence={start:offset,char:match[1][0],length:match[1].length};else if(match[1][0]===fence.char&&match[1].length>=fence.length){ignored.push([fence.start,offset+line.length]);fence=undefined;}}offset+=line.length;}
  if(fence)ignored.push([fence.start,source.length]);
  const pattern=/<figure\b[^>]*data-munin-image[^>]*>[\s\S]*?<\/figure>|!\[((?:\\.|[^\]\\])*)\]\(\s*(?:<([^>]+)>|((?:\\.|[^\s()]|\([^()]*\))+))(?:\s+"((?:\\.|[^"\\])*)")?\s*\)|<img\b[^>]*>/gi;
  const images:DocumentImage[]=[];
  for(const match of source.matchAll(pattern)){
    const start=match.index!;if(ignored.some(([a,b])=>start>=a&&start<b))continue;
    // An inline code span on the same line is an example, not an image.
    const before=source.slice(source.lastIndexOf('\n',start-1)+1,start);if((before.match(/(?<!\\)`/g)||[]).length%2)continue;
    let image=parseFigure(match[0]);
    if(!image&&match[0].startsWith('!'))image={src:(match[2]||match[3]||'').replace(/\\([()\\])/g,'$1'),alt:match[1].replace(/\\([\[\]\\])/g,'$1'),caption:match[4]||'',width:null,align:'center',configured:false};
    if(!image&&/^<img/i.test(match[0])){const img=new DOMParser().parseFromString(match[0],'text/html').querySelector('img');if(img)image={src:img.getAttribute('src')||'',alt:img.getAttribute('alt')||'',caption:img.getAttribute('title')||'',width:null,align:'center',configured:false};}
    if(image)images.push({...image,start,end:start+match[0].length,raw:match[0]});
  }
  return images;
}
export function imageAtSelection(source:string,start:number,end=start):DocumentImage|undefined {
  return documentImages(source).find(image=>start>=image.start&&start<=image.end||start<=image.start&&end>=image.end);
}
export function replaceDocumentImage(source:string,image:DocumentImage,src:string,screenshotId?:string):string {
  let raw=image.configured?renderFigure({...image,src}):/^<img/i.test(image.raw)?image.raw.replace(/\bsrc\s*=\s*(["']).*?\1/i,()=>`src="${escape(src)}"`):image.raw.replace(/(\]\(\s*)(?:<[^>]+>|(?:\\.|[^\s()]|\([^()]*\))+)/,(_match,prefix:string)=>`${prefix}<${src}>`);
  let start=image.start,end=image.end;
  const before=source.slice(0,start),after=source.slice(end);
  const wrapper=/<!--\s*screenshot:ref\s+id=[^>]+-->\s*$/.exec(before);const closing=/^\s*<!--\s*\/screenshot:ref\s*-->/.exec(after);
  if(wrapper&&closing){start=wrapper.index;end+=closing[0].length;}
  if(screenshotId){const gap=image.configured?'\n\n':'\n';raw=`<!-- screenshot:ref id=${screenshotId} -->${gap}${raw}${gap}<!-- /screenshot:ref -->`;}
  return source.slice(0,start)+raw+source.slice(end);
}
