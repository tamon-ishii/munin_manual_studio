// Keep the iframe document alive while editing. Navigating srcdoc for every
// keystroke clears its rendered surface, theme and decoded images.
const sources=new WeakMap<Node,string>();
function source(node:Node):string{return `${node.nodeType}:${node.nodeType===Node.ELEMENT_NODE?(node as Element).outerHTML:node.nodeValue||''}`;}
export function rememberPreviewContent(document:Document):void{
  for(const node of document.body.childNodes)if(!sources.has(node))sources.set(node,source(node));
}
export function rememberPreviewReplacement(original:Node,replacement:Node):void{sources.set(replacement,sources.get(original)??source(original));}
export function updatePreviewContent(document:Document,html:string):void{
  const next=new DOMParser().parseFromString(html,'text/html');
  const existing=new Map<string,Node[]>();
  for(const node of document.body.childNodes){const key=sources.get(node)??source(node);const nodes=existing.get(key)||[];nodes.push(node);existing.set(key,nodes);}
  let cursor=document.body.firstChild;
  for(const node of next.body.childNodes){
    const key=source(node),retained=existing.get(key)?.shift();
    const replacement=retained||document.importNode(node,true);sources.set(replacement,key);
    if(replacement===cursor)cursor=cursor.nextSibling;else document.body.insertBefore(replacement,cursor);
  }
  while(cursor){const next=cursor.nextSibling;cursor.remove();cursor=next;}
}
