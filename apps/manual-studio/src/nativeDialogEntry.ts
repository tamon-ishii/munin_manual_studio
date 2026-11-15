import './style.css';
import {initializeTheme,applyTheme} from './theme';
import {createWindowChannel} from './windowChannel';
import {dialogFields,applyDialogFields,type DialogMessage,type DialogSnapshot,type DialogEvent} from './nativeDialogProtocol';

initializeTheme();
const session=new URLSearchParams(location.search).get('session');
if(session){
  const channel=await createWindowChannel<DialogMessage>(`dialog-${session}`);
  let root:HTMLDialogElement|null=null,composing=false,sequence=0,rendering=false;
  const emitEvent=(data:Omit<Extract<DialogMessage,{type:'event'}>,'sequence'>)=>channel.postMessage({...data,sequence:++sequence});
  /** Preserve control nodes, focus, selection and IME while updating the parent's live markup. */
  const reconcile=(current:Node,next:Node)=>{
    if(current instanceof Element&&next instanceof Element){
      for(const attr of [...current.attributes])if(!next.hasAttribute(attr.name))current.removeAttribute(attr.name);
      for(const attr of [...next.attributes])if(current.getAttribute(attr.name)!==attr.value)current.setAttribute(attr.name,attr.value);
    }else if(current.nodeType===Node.TEXT_NODE&&current.textContent!==next.textContent){current.textContent=next.textContent;return;}
    const children=[...next.childNodes];
    for(let index=0;index<children.length;index++){
      const incoming=children[index],id=incoming instanceof HTMLElement?incoming.dataset.dialogNode:undefined;
      let existing=current.childNodes[index];
      if(id&&(!(existing instanceof HTMLElement)||existing.dataset.dialogNode!==id)){
        const found=[...current.childNodes].find(node=>node instanceof HTMLElement&&node.dataset.dialogNode===id);
        if(found){current.insertBefore(found,existing??null);existing=found;}
      }
      if(!existing){current.appendChild(incoming.cloneNode(true));continue;}
      if(existing.nodeName!==incoming.nodeName||(id&&existing instanceof HTMLElement&&existing.dataset.dialogNode!==id)){current.replaceChild(incoming.cloneNode(true),existing);continue;}
      reconcile(existing,incoming);
    }
    while(current.childNodes.length>children.length)current.lastChild!.remove();
  };
  const render=(snapshot:DialogSnapshot)=>{
    if(composing||snapshot.ack<sequence)return;
    applyTheme(snapshot.theme,false);
    const template=document.createElement('template');template.innerHTML=snapshot.html;
    const next=template.content.querySelector('dialog');if(!next)return;
    rendering=true;
    next.classList.remove('native-dialog-source','dialog-expanded');
    for(const name of ['width','height','min-width','min-height','max-width','max-height','position','inset','top','left','right','bottom','transform','margin'])next.style.removeProperty(name);
    next.removeAttribute('open');
    const first=!root;
    if(!root){root=next;document.querySelector('#dialog-loading')?.remove();document.body.append(root);root.show();}
    else{next.setAttribute('open','');reconcile(root,next);}
    // Revisions already exclude stale edits; accepted normalization and recorded
    // shortcut keys must also update a focused control.
    applyDialogFields(root,snapshot.fields);
    if(first){const focused=snapshot.focus?[...root.querySelectorAll<HTMLElement>('[data-dialog-node]')].find(element=>element.dataset.dialogNode===snapshot.focus):null;(focused??root.querySelector<HTMLElement>('input:not([disabled]),textarea,select,button'))?.focus();}
    rendering=false;
  };
  channel.onmessage=({data})=>{if(data.type==='snapshot')render(data.snapshot);};
  const send=(event:Event,type:DialogEvent)=>{
    const target=event.target instanceof Element?event.target.closest<HTMLElement>('[data-dialog-node]'):null;
    if(!target?.dataset.dialogNode||!root)return;
    const key=event instanceof KeyboardEvent?event:undefined,modifiers=event instanceof KeyboardEvent||event instanceof MouseEvent?event:undefined;
    const drag=event instanceof DragEvent?event:undefined,bounds=target.getBoundingClientRect();
    emitEvent({type:'event',id:target.dataset.dialogNode,event:type,fields:dialogFields(root),key:key?.key,code:key?.code,ctrlKey:modifiers?.ctrlKey,altKey:modifiers?.altKey,shiftKey:modifiers?.shiftKey,metaKey:modifiers?.metaKey,xRatio:drag&&bounds.width?(drag.clientX-bounds.left)/bounds.width:undefined,yRatio:drag&&bounds.height?(drag.clientY-bounds.top)/bounds.height:undefined,dragData:drag?Object.fromEntries([...drag.dataTransfer?.types??[]].map(type=>[type,drag.dataTransfer!.getData(type)])):undefined});
  };
  document.addEventListener('compositionstart',()=>{composing=true;});
  document.addEventListener('focusin',event=>{if(!rendering)send(event,'focus');});
  document.addEventListener('focusout',event=>{if(!rendering)send(event,'blur');});
  document.addEventListener('compositionend',event=>{composing=false;send(event,'input');});
  document.addEventListener('input',event=>{if(!composing&&!(event.target instanceof HTMLInputElement&&event.target.type==='file'))send(event,'input');});
  document.addEventListener('change',event=>{
    const target=event.target;
    if(target instanceof HTMLInputElement&&target.type==='file'&&target.dataset.dialogNode){
      void(async()=>{
        const files=await Promise.all([...target.files??[]].map(async file=>({name:file.name,mime:file.type,modified:file.lastModified,data:await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);})})));
        if(root)emitEvent({type:'event',id:target.dataset.dialogNode!,event:'change',fields:dialogFields(root),files});
      })();
    }else send(event,'change');
  });
  document.addEventListener('toggle',event=>{if(event.target instanceof HTMLDetailsElement)send(event,'toggle');},true);
  let dragging=false;
  document.addEventListener('dragstart',event=>{dragging=true;event.dataTransfer?.setData('application/x-munin-dialog-drag',session);send(event,'dragstart');});
  document.addEventListener('dragover',event=>{if(dragging){event.preventDefault();send(event,'dragover');}});
  document.addEventListener('drop',event=>{if(dragging){event.preventDefault();send(event,'drop');}});
  document.addEventListener('dragend',event=>{send(event,'dragend');dragging=false;});
  // Pointer capture belongs to this webview. Relay grip drags as ordinary drag
  // events to the original controls instead of trying to capture in the owner.
  let gripDrag:{pointerId:number;x:number;y:number;source:HTMLElement;grip:HTMLElement;moved:boolean}|undefined;
  const relayDrag=(target:HTMLElement,type:'dragstart'|'dragover'|'drop'|'dragend',event:PointerEvent)=>target.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,clientX:event.clientX,clientY:event.clientY,dataTransfer:new DataTransfer()}));
  document.addEventListener('pointerdown',event=>{
    const grip=event.target instanceof Element?event.target.closest<HTMLElement>('.toolbar-setting-grip'):null;
    const source=grip?.closest<HTMLElement>('[draggable=true]');if(!grip||!source||event.button!==0)return;
    event.preventDefault();grip.setPointerCapture(event.pointerId);gripDrag={pointerId:event.pointerId,x:event.clientX,y:event.clientY,source,grip,moved:false};
  });
  document.addEventListener('pointermove',event=>{
    if(!gripDrag||event.pointerId!==gripDrag.pointerId)return;
    if(!gripDrag.moved){if(Math.hypot(event.clientX-gripDrag.x,event.clientY-gripDrag.y)<5)return;gripDrag.moved=true;relayDrag(gripDrag.source,'dragstart',event);}
    const target=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('[draggable=true]');if(target)relayDrag(target,'dragover',event);
  });
  document.addEventListener('pointerup',event=>{
    if(!gripDrag||event.pointerId!==gripDrag.pointerId)return;
    const previous=gripDrag;gripDrag=undefined;
    if(previous.moved){const target=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('[draggable=true]');if(target)relayDrag(target,'drop',event);relayDrag(previous.source,'dragend',event);}
    previous.grip.releasePointerCapture(event.pointerId);
  });
  document.addEventListener('pointercancel',event=>{if(gripDrag){relayDrag(gripDrag.source,'dragend',event);gripDrag=undefined;}});
  document.addEventListener('click',event=>{
    const target=event.target instanceof Element?event.target:null;
    const disclosure=target?.closest('summary')?.parentElement;
    if(disclosure instanceof HTMLDetailsElement&&!target?.closest('button,a,input')){
      event.preventDefault();disclosure.open=!disclosure.open;
      if(root&&disclosure.dataset.dialogNode)emitEvent({type:'event',id:disclosure.dataset.dialogNode,event:'toggle',fields:dialogFields(root)});
      return;
    }
    const button=target?.closest('button');
    if(button){
      event.preventDefault();
      if(button.type==='submit'&&button.form&&!button.form.reportValidity())return;
      // Send the button, rather than a nested icon, to its original click handler.
      if(root&&button.dataset.dialogNode)emitEvent({type:'event',id:button.dataset.dialogNode,event:'click',fields:dialogFields(root),ctrlKey:event.ctrlKey,altKey:event.altKey,shiftKey:event.shiftKey,metaKey:event.metaKey});
      const focusTarget=button.dataset.focusTarget?document.getElementById(button.dataset.focusTarget):null;
      if(focusTarget instanceof HTMLInputElement){focusTarget.dataset.recordTab='true';focusTarget.focus();}
    }else if(target?.closest('a')){event.preventDefault();send(event,'click');}
    else if(target&&!target.closest('input,select,textarea,label,summary'))send(event,'click');
  },true);
  document.addEventListener('submit',event=>{event.preventDefault();const form=event.target;if(form instanceof HTMLFormElement&&form.reportValidity()){const submit=form.querySelector<HTMLElement>('button[type=submit],button:not([type])');if(submit)submit.click();}});
  document.addEventListener('keydown',event=>{
    if(event.isComposing||composing)return;
    if(event.target instanceof HTMLInputElement&&event.target.dataset.keyRecorder){
      if(event.key==='Tab'&&event.target.dataset.keyRecorder==='shortcut'&&!event.target.dataset.recordTab)return;
      event.preventDefault();delete event.target.dataset.recordTab;send(event,'keydown');
      if(event.key==='Escape')event.target.blur();
      return;
    }
    if(event.key==='Escape'){event.preventDefault();channel.postMessage({type:'cancel'});return;}
    if(event.target instanceof Element&&event.target.matches('[role=tab]')&&['ArrowRight','ArrowLeft','Home','End'].includes(event.key)){
      event.preventDefault();const buttons=[...root?.querySelectorAll<HTMLElement>('[role=tab]')??[]];const index=buttons.indexOf(event.target as HTMLElement);
      const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
      buttons[next]?.click();buttons[next]?.focus();return;
    }
  },true);
  const {getCurrentWindow}=await import('@tauri-apps/api/window');
  await getCurrentWindow().onCloseRequested(event=>{event.preventDefault();channel.postMessage({type:'cancel'});});
  channel.postMessage({type:'ready'});
}
