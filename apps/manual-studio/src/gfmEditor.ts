import {defaultHandlers} from 'mdast-util-to-markdown';
import {remarkStringifyOptionsCtx} from '@milkdown/kit/core';
import {blockquoteSchema} from '@milkdown/kit/preset/commonmark';
import {$remark} from '@milkdown/kit/utils';
import type {Ctx} from '@milkdown/kit/ctx';
interface Ast {type:string;value?:string;children?:Ast[];muninAlert?:string;position?:{start:{offset?:number}}}
const marker=/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\n|$)/;
export const gfmAlerts=$remark('munin-gfm-alerts',()=>()=>function transform(tree:Ast,file:{value?:unknown}){
  const source=typeof file.value==='string'?file.value:'';
  function visit(node:Ast){
    if(node.type==='blockquote'){
      const first=node.children?.[0]?.children?.[0];
      const match=first?.type==='text'&&marker.exec(first.value||'');
      const offset=first?.position?.start.offset;
      if(match&&(offset===undefined||!source.slice(offset).startsWith('\\')))node.muninAlert=match[1];
    }
    node.children?.forEach(visit);
  }
  visit(tree);
});
export function configureGfmAlerts(ctx:Ctx):void{
  ctx.update(blockquoteSchema.key,previous=>ctx=>{
    const schema=previous(ctx);
    return {...schema,attrs:{...schema.attrs,muninAlert:{default:''}},
      parseMarkdown:{...schema.parseMarkdown,runner:(state,node,type)=>{state.openNode(type,{muninAlert:node.muninAlert||''}).next(node.children).closeNode();}},
      toDOM:node=>['blockquote',{'data-gfm-alert':node.attrs.muninAlert||null},0],
      toMarkdown:{...schema.toMarkdown,runner:(state,node)=>{state.openNode('blockquote',undefined,{muninAlert:node.attrs.muninAlert}).next(node.content).closeNode();}},
    };
  });
  ctx.update(remarkStringifyOptionsCtx,previous=>({...previous,handlers:{...previous.handlers,blockquote:(node,parent,state,info)=>{
    const text=(previous.handlers?.blockquote||defaultHandlers.blockquote)(node,parent,state,info);
    return node.muninAlert?text.replace(String.raw`> \[!${node.muninAlert}]`,`> [!${node.muninAlert}]`):text;
  }}}));
}

export const alertKinds=[['NOTE','Info・補足'],['TIP','ヒント'],['IMPORTANT','重要'],['WARNING','警告'],['CAUTION','注意']] as const;
export function alertMarkdown(kind:string,text='説明を入力してください。'):string{
  if(!alertKinds.some(([value])=>value===kind))throw new Error('Unknown GitHub alert');
  return `> [!${kind}]\n${text.split('\n').map(line=>`> ${line}`).join('\n')}\n\n`;
}
export function setupGfmSourceToolbar(host:HTMLElement,onInsert:(markdown:string)=>void):void{
  const label=document.createElement('label');label.className='gfm-alert-control';label.textContent='GitHub';
  const select=document.createElement('select');select.setAttribute('aria-label','GitHubアラートを挿入');
  select.add(new Option('アラートを挿入',''));
  for(const [kind,title] of alertKinds)select.add(new Option(`${title} (${kind})`,kind));
  select.addEventListener('change',()=>{if(select.value)onInsert(alertMarkdown(select.value));select.value='';});
  label.append(select);host.append(label);
}
