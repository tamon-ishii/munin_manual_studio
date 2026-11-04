type SettingsCategory = 'keyboard' | 'capture' | 'text-ai' | 'image-ai' | 'appearance';
export function setupSettingsTabs(): (category: SettingsCategory) => void {
  const dialog = document.getElementById('panel-settings')!;
  const tabs = document.createElement('div');
  tabs.className = 'settings-category-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '設定の種類');
  const categories: {id: SettingsCategory;label: string;nodes: Element[]}[] = [
    {id:'keyboard',label:'キーボード',nodes:[document.getElementById('keyboard-shortcut-settings')!]},
    {id:'capture',label:'撮影',nodes:[document.getElementById('markits-shortcut-settings')!]},
    {id:'text-ai',label:'文章・図のAI',nodes:[document.getElementById('ai-connection-type')!.closest('.card')!]},
    {id:'image-ai',label:'画像生成AI',nodes:[document.getElementById('image-ai-settings')!]},
    {id:'appearance',label:'外観',nodes:Array.from(document.querySelectorAll('#panel-appearance > .card'))},
  ];
  const buttons = new Map<SettingsCategory, HTMLButtonElement>();
  const panels = new Map<SettingsCategory, HTMLElement>();
  const select = (category: SettingsCategory) => {
    for (const {id} of categories) {
      const active = category === id;
      buttons.get(id)!.setAttribute('aria-selected', String(active));
      buttons.get(id)!.tabIndex = active ? 0 : -1;
      panels.get(id)!.hidden = !active;
    }
    dialog.scrollTop = 0;
  };
  for (const {id,label,nodes} of categories) {
    const button = document.createElement('button');
    button.type = 'button';button.id = `settings-tab-${id}`;button.textContent = label;
    button.setAttribute('role','tab');button.setAttribute('aria-controls',`settings-category-${id}`);
    const panel = document.createElement('section');
    panel.id = `settings-category-${id}`;panel.className = 'settings-category-panel';
    panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',button.id);
    panel.append(...nodes);dialog.append(panel);tabs.append(button);
    buttons.set(id,button);panels.set(id,panel);
    button.addEventListener('click',()=>select(id));
    button.addEventListener('keydown',event=>{
      const index = categories.findIndex(category=>category.id===id);
      const next = event.key === 'ArrowRight' ? (index+1)%categories.length
        : event.key === 'ArrowLeft' ? (index+categories.length-1)%categories.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? categories.length-1 : -1;
      if(next<0)return;
      event.preventDefault();select(categories[next].id);buttons.get(categories[next].id)!.focus();
    });
  }
  dialog.querySelector('.panel-header')!.after(tabs);
  select('keyboard');
  return select;
}
