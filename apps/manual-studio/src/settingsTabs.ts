type SettingsCategory = 'appearance' | 'project' | 'text-ai' | 'glossary' | 'capture' | 'html-output' | 'keyboard';
export function setupSettingsTabs(extraNodes?: { glossary?: Element[] }): (category: SettingsCategory) => void {
  const dialog = document.getElementById('panel-settings')!;
  const tabs = document.createElement('div');
  tabs.className = 'settings-category-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '設定の種類');
  const glossaryNodes = extraNodes?.glossary ?? (document.getElementById('glossary-settings') ? [document.getElementById('glossary-settings')!] : []);
  const projectNodes = [
    document.getElementById('project-general-settings'),
    document.getElementById('project-brief-settings'),
  ].filter((node): node is HTMLElement => Boolean(node));
  const categories: {id: SettingsCategory;label: string;saveMode: string;nodes: Element[]}[] = [
    {id:'appearance',label:'外観',saveMode:'即時反映・自動保存',nodes:Array.from(document.querySelectorAll('#panel-appearance > .card'))},
    {id:'project',label:'プロジェクト',saveMode:'自動保存',nodes:projectNodes},
    {id:'text-ai',label:'文章・図のAI',saveMode:'自動保存',nodes:[document.getElementById('ai-connection-type')!.closest('.card')!]},
    {id:'glossary',label:'用語集',saveMode:'操作ごとに自動保存',nodes:glossaryNodes},
    {id:'capture',label:'撮影',saveMode:'自動保存',nodes:[document.getElementById('markits-shortcut-settings')!]},
    {id:'html-output',label:'HTML出力',saveMode:'ボタンで保存',nodes:[document.getElementById('html-output-settings')!]},
    {id:'keyboard',label:'キーボード',saveMode:'ボタンで保存',nodes:[document.getElementById('keyboard-shortcut-settings')!]},
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
  for (const {id,label,saveMode,nodes} of categories) {
    const button = document.createElement('button');
    button.type = 'button';button.id = `settings-tab-${id}`;button.textContent = label;
    button.setAttribute('role','tab');button.setAttribute('aria-controls',`settings-category-${id}`);
    const panel = document.createElement('section');
    panel.id = `settings-category-${id}`;panel.className = 'settings-category-panel';
    panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',button.id);
    const modeNote = document.createElement('div');
    modeNote.className = 'settings-save-mode-bar';
    const modeBadge = document.createElement('span');
    modeBadge.className = 'settings-save-mode-badge';
    modeBadge.textContent = saveMode;
    modeNote.append(modeBadge);
    panel.append(modeNote, ...nodes);dialog.append(panel);tabs.append(button);
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
  select('appearance');
  return select;
}
