const storageKey='manual-studio-toolbar-hidden';
export function setupToolbarCustomization():void {
  const list=document.getElementById('toolbar-customization-list')!;
  const hidden=new Set<string>();try{for(const key of JSON.parse(localStorage.getItem(storageKey)||'[]'))if(typeof key==='string')hidden.add(key);}catch{/* optional preferences */}
  let inventory='';
  function controls():Array<{element:HTMLElement;key:string}>{
    return [...document.querySelectorAll<HTMLElement>('.formatting-toolbar button,.milkdown-top-bar .top-bar-item,.milkdown-top-bar .top-bar-heading-selector')].map(element=>{
      let key=element.getAttribute('aria-label')||element.title||element.textContent?.trim()||'';
      key=key.replace(/\s*\([^)]*\)/g,'').trim();
      if(element.matches('.top-bar-heading-selector')||element.dataset.format==='heading')key='見出し';
      if(element.id==='undo-edit'||/undo|元に戻す/i.test(key))key='元に戻す';if(element.id==='redo-edit'||/redo|やり直す/i.test(key))key='やり直す';
      return {element,key};
    }).filter(item=>Boolean(item.key));
  }
  function update(){
    const items=controls();for(const item of items)item.element.dataset.toolbarHidden=String(hidden.has(item.key));
    const keys=[...new Set(items.map(item=>item.key))].sort((a,b)=>a.localeCompare(b,'ja'));const next=JSON.stringify(keys);if(next===inventory)return;inventory=next;list.replaceChildren();
    for(const key of keys){const label=document.createElement('label');label.className='toolbar-setting';const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=!hidden.has(key);checkbox.onchange=()=>{if(checkbox.checked)hidden.delete(key);else hidden.add(key);localStorage.setItem(storageKey,JSON.stringify([...hidden]));update();};label.append(checkbox,document.createTextNode(key));list.append(label);}
  }
  new MutationObserver(update).observe(document.getElementById('milkdown-editor')!,{childList:true,subtree:true});
  document.getElementById('reset-toolbar-customization')!.onclick=()=>{hidden.clear();localStorage.removeItem(storageKey);inventory='';update();};
  update();
}
