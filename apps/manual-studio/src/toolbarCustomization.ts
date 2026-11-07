import {uiIcon} from './uiIcons';

const storageKey='manual-studio-toolbar-hidden';
const orderKey='manual-studio-toolbar-order';
interface Control {element:HTMLElement;key:string;label:string;}
const legacyLabels:Record<string,string>={'表を作成・編集':'表','リンクを挿入':'リンク','画像を挿入':'画像','??':'数式'};

export function setupToolbarCustomization():void {
  const list=document.getElementById('toolbar-customization-list')!;
  const hidden=new Set<string>();let order:string[]=[];
  try{const value:unknown=JSON.parse(localStorage.getItem(storageKey)||'[]');if(Array.isArray(value))for(const key of value)if(typeof key==='string')hidden.add(legacyLabels[key]||key);}catch{/* optional preferences */}
  try{const value:unknown=JSON.parse(localStorage.getItem(orderKey)||'[]');if(Array.isArray(value))order=[...new Set(value.filter((key):key is string=>typeof key==='string'))];}catch{/* optional preferences */}
  const note=document.createElement('p');note.className='toolbar-customization-help';note.textContent='左のチェックで移動する項目を複数選択し、つまみをドラッグして並べ替えます。右の「表示」で表示・非表示を切り替えます。';
  const selectionStatus=document.createElement('p');selectionStatus.className='toolbar-customization-help';selectionStatus.role='status';
  list.before(note,selectionStatus);
  const selected=new Set<string>();let dragging:string[]=[],anchor='';
  const showSelection=()=>{selectionStatus.textContent=selected.size?`${selected.size}件を移動対象に選択中`:'移動対象は選択されていません';for(const row of list.querySelectorAll<HTMLElement>('[data-toolbar-setting]')){const active=selected.has(row.dataset.toolbarSetting!);row.dataset.selected=String(active);const checkbox=row.querySelector<HTMLInputElement>('.toolbar-setting-select');if(checkbox)checkbox.checked=active;}};
  const clearDrag=()=>{dragging=[];for(const row of list.querySelectorAll<HTMLElement>('[data-toolbar-setting]')){delete row.dataset.dropPosition;delete row.dataset.dragging;}};
  const saveOrder=(keys:string[])=>{order=keys;localStorage.setItem(orderKey,JSON.stringify(order));update();};
  const beginDrag=(key:string)=>{if(!selected.has(key)){selected.clear();selected.add(key);}dragging=ordered(controls()).filter(control=>selected.has(control.key)).map(control=>control.key);showSelection();for(const source of list.querySelectorAll<HTMLElement>('[data-toolbar-setting]'))if(dragging.includes(source.dataset.toolbarSetting!))source.dataset.dragging='true';};
  const markDrop=(row:HTMLElement|undefined,y:number)=>{for(const other of list.querySelectorAll<HTMLElement>('[data-drop-position]'))delete other.dataset.dropPosition;if(row&&!dragging.includes(row.dataset.toolbarSetting!))row.dataset.dropPosition=y<row.getBoundingClientRect().top+row.offsetHeight/2?'before':'after';};
  const dropAt=(key:string,after:boolean)=>{const moving=[...dragging];clearDrag();if(!moving.length||moving.includes(key))return;const keys=ordered(controls()).map(control=>control.key).filter(value=>!moving.includes(value));const at=keys.indexOf(key);if(at<0)return;keys.splice(at+(after?1:0),0,...moving);saveOrder(keys);};
  let inventory='';
  function controls():Control[]{
    return Array.from(document.querySelectorAll<HTMLElement>('.milkdown-top-bar .top-bar-inner > [data-toolbar-key]')).map(element=>({element,key:element.dataset.toolbarKey!,label:element.dataset.toolbarLabel||''})).filter(item=>!!item.label);
  }
  function ordered(items:Control[]):Control[]{
    const defaults=[...items].sort((a,b)=>Number(a.element.dataset.toolbarPosition)-Number(b.element.dataset.toolbarPosition));
    const rank=new Map(order.map((key,index)=>[key,index]));
    return defaults.sort((a,b)=>(rank.get(a.key)??order.length+Number(a.element.dataset.toolbarPosition))-(rank.get(b.key)??order.length+Number(b.element.dataset.toolbarPosition)));
  }
  function arrange(items:Control[]):void{
    const bar=items[0]?.element.parentElement;if(!bar)return;
    const custom=order.length>0;
    const nodes=custom?items.map(item=>item.element):Array.from(bar.children).filter((node):node is HTMLElement=>node instanceof HTMLElement).sort((a,b)=>Number(a.dataset.toolbarPosition)-Number(b.dataset.toolbarPosition));
    for(let index=0;index<nodes.length;index++){const node=nodes[index];if(bar.children[index]!==node)bar.insertBefore(node,bar.children[index]||null);}
    const shownDividers=new Set<HTMLElement>();let previousVisible=false,pending:HTMLElement|undefined;
    if(!custom)for(const node of nodes){if(node.classList.contains('top-bar-divider'))pending=node;else if(node.dataset.toolbarKey&&node.dataset.toolbarHidden!=='true'){if(previousVisible&&pending)shownDividers.add(pending);previousVisible=true;pending=undefined;}}
    for(const divider of bar.querySelectorAll<HTMLElement>(':scope > .top-bar-divider')){
      const value=String(!shownDividers.has(divider));if(divider.dataset.toolbarHidden!==value)divider.dataset.toolbarHidden=value;
    }
  }
  function update():void{
    const items=ordered(controls());
    for(const item of items){const value=String(hidden.has(item.label));if(item.element.dataset.toolbarHidden!==value)item.element.dataset.toolbarHidden=value;}
    // Retain the same preference on the legacy source fallback, without listing
    // its duplicate controls as if they were buttons in the active toolbar.
    for(const element of document.querySelectorAll<HTMLElement>('.formatting-toolbar button')){
      const raw=(element.getAttribute('aria-label')||element.title||'').replace(/\s*\([^)]*\)/g,'').trim();
      const label=element.dataset.format==='heading'?'見出し':legacyLabels[raw]||raw;
      const value=String(hidden.has(label));if(element.dataset.toolbarHidden!==value)element.dataset.toolbarHidden=value;
    }
    arrange(items);
    const signature=JSON.stringify(items.map(item=>[item.key,item.label,hidden.has(item.label)]));if(signature===inventory)return;inventory=signature;list.replaceChildren();
    items.forEach((item,index)=>{
      const row=document.createElement('div');row.className='toolbar-setting-row';row.dataset.toolbarSetting=item.key;
      row.draggable=true;
      const select=document.createElement('input');select.type='checkbox';select.className='toolbar-setting-select';select.setAttribute('aria-label',`${item.label}を移動対象に選択`);select.onchange=()=>{if(select.checked)selected.add(item.key);else selected.delete(item.key);anchor=item.key;showSelection();};
      const grip=document.createElement('button');grip.type='button';grip.className='toolbar-setting-grip';grip.textContent='⠿';grip.title='選択した項目をまとめてドラッグ';grip.setAttribute('aria-label',`${item.label}をドラッグして移動`);grip.onclick=event=>{event.preventDefault();event.stopPropagation();};
      // Pointer capture works in desktop WebViews even when native file-drop
      // handling intercepts HTML drag events.
      let pointer:{id:number;x:number;y:number;moving:boolean}|undefined;
      grip.onpointerdown=event=>{if(event.button!==0)return;event.preventDefault();event.stopPropagation();pointer={id:event.pointerId,x:event.clientX,y:event.clientY,moving:false};grip.setPointerCapture(event.pointerId);};
      grip.onpointermove=event=>{if(!pointer||event.pointerId!==pointer.id)return;if(!pointer.moving){if(Math.hypot(event.clientX-pointer.x,event.clientY-pointer.y)<5)return;pointer.moving=true;beginDrag(item.key);}const target=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('[data-toolbar-setting]');markDrop(target&&list.contains(target)?target:undefined,event.clientY);const scroller=list.closest<HTMLElement>('.settings-category-panel');if(scroller){const box=scroller.getBoundingClientRect();if(event.clientY<box.top+32)scroller.scrollTop-=12;else if(event.clientY>box.bottom-32)scroller.scrollTop+=12;}};
      grip.onpointerup=event=>{if(!pointer||event.pointerId!==pointer.id)return;const moving=pointer.moving;pointer=undefined;if(!moving)return;const target=list.querySelector<HTMLElement>('[data-drop-position]');if(target)dropAt(target.dataset.toolbarSetting!,target.dataset.dropPosition==='after');else clearDrag();};
      grip.onpointercancel=grip.onlostpointercapture=()=>{pointer=undefined;clearDrag();};grip.onkeydown=event=>{if(event.key==='Escape'){pointer=undefined;clearDrag();}};
      const label=document.createElement('div');label.className='toolbar-setting';
      const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=!hidden.has(item.label);checkbox.setAttribute('aria-label',`${item.label}を表示`);
      checkbox.onchange=()=>{if(checkbox.checked)hidden.delete(item.label);else hidden.add(item.label);localStorage.setItem(storageKey,JSON.stringify([...hidden]));update();};
      const icon=document.createElement('span');icon.className='toolbar-setting-icon';icon.setAttribute('aria-hidden','true');const svg=item.element.querySelector('svg');icon.innerHTML=svg?svg.outerHTML.replace(/>\s+</g,'><'):uiIcon(item.key==='heading-selector'?'heading':'more');
      const text=document.createElement('span');text.textContent=item.label;label.append(icon,text);
      const visibility=document.createElement('label');visibility.className='toolbar-setting-visibility';visibility.append(checkbox,document.createTextNode('表示'));
      const moves=document.createElement('div');moves.className='toolbar-setting-moves';
      for(const [offset,title,iconName]of [[-1,'前へ','back'],[1,'後ろへ','forward']]as const){const button=document.createElement('button');button.type='button';button.title=`${item.label}を${title}`;button.setAttribute('aria-label',button.title);button.innerHTML=uiIcon(iconName);button.disabled=index+offset<0||index+offset>=items.length;button.onclick=()=>{const keys=items.map(control=>control.key);[keys[index],keys[index+offset]]=[keys[index+offset],keys[index]];order=keys;localStorage.setItem(orderKey,JSON.stringify(order));update();list.querySelector<HTMLButtonElement>(`[data-toolbar-setting="${item.key}"] button[title="${button.title}"]`)?.focus();};moves.append(button);}
      row.append(select,grip,label,visibility,moves);
      row.onclick=event=>{if((event.target as HTMLElement).closest('input,button,label'))return;if(event.shiftKey&&anchor){const start=items.findIndex(control=>control.key===anchor);if(start>=0)for(const control of items.slice(Math.min(start,index),Math.max(start,index)+1))selected.add(control.key);}else if(event.ctrlKey||event.metaKey){if(selected.has(item.key))selected.delete(item.key);else selected.add(item.key);}else{selected.clear();selected.add(item.key);}anchor=item.key;showSelection();};
      let interactive=false;row.onpointerdown=event=>{interactive=!!(event.target as HTMLElement).closest('input,button,label');};
      row.ondragstart=event=>{if(interactive||!event.dataTransfer){event.preventDefault();return;}beginDrag(item.key);event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',dragging.join(','));};
      row.ondragover=event=>{if(!dragging.length)return;event.preventDefault();event.dataTransfer!.dropEffect='move';markDrop(row,event.clientY);};
      row.ondrop=event=>{if(!dragging.length)return;event.preventDefault();dropAt(item.key,event.clientY>=row.getBoundingClientRect().top+row.offsetHeight/2);};
      row.ondragend=clearDrag;
      list.append(row);
    });
    showSelection();
  }
  new MutationObserver(update).observe(document.getElementById('milkdown-editor')!,{childList:true,subtree:true,attributes:true,attributeFilter:['data-toolbar-key','data-toolbar-label']});
  document.getElementById('reset-toolbar-customization')!.onclick=()=>{hidden.clear();order=[];selected.clear();clearDrag();localStorage.removeItem(storageKey);localStorage.removeItem(orderKey);inventory='';update();};
  update();
}
