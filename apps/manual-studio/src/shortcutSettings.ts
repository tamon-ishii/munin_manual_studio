import {bindingLabel,currentBindings,defaultBindings,keyStroke,saveBindings,shortcutCommands,validateBindings,type ShortcutBindings} from './keyboardShortcuts';
export function setupShortcutSettings(host: HTMLElement): void {
  let draft: ShortcutBindings = currentBindings();
  host.innerHTML = '<h2>キーボードショートカット</h2><p>初期設定はVS Code準拠です。キー欄を選んで組み合わせを押してください。2段階のキーは続けて押します（例: Ctrl+K → Ctrl+S）。空欄は未割り当てです。</p><div class="shortcut-settings-list"></div><p role="status" aria-live="polite"></p><div class="actions"><button type="button" data-reset>VS Codeの初期設定に戻す</button><button type="button" data-save>ショートカットを保存</button></div>';
  const list = host.querySelector<HTMLElement>('.shortcut-settings-list')!;
  const message = host.querySelector<HTMLElement>('[role=status]')!;
  function render(): void {
    list.replaceChildren();
    for (const command of shortcutCommands) {
      const row = document.createElement('div'); row.className = 'shortcut-setting-row';row.dataset.command=command.id;
      const label = document.createElement('span');label.textContent = command.label;
      const fields = document.createElement('div');fields.className = 'shortcut-setting-keys';
      const keys = draft[command.id];
      const addField = (index: number) => {
        const input = document.createElement('input');input.readOnly = true;input.placeholder = 'キーを押す';input.value = bindingLabel(keys[index] || '');input.setAttribute('aria-label', `${command.label}のキー ${index+1}`);
        let last = 0, prefix = '', recordTab = false;
        input.onfocus = () => {last=0;prefix='';};
        input.onkeydown = event => {
          if(event.key==='Tab'&&!recordTab)return;
          recordTab=false;
          event.preventDefault();event.stopPropagation();
          if(event.key==='Escape'){input.blur();return;}
          if(event.key==='Backspace'||event.key==='Delete'){keys[index]='';input.value='';last=0;return;}
          const stroke=keyStroke(event);if(!stroke)return;
          const now=Date.now();const sequence=last&&now-last<1500?prefix+' '+stroke:stroke;
          keys[index]=sequence;input.value=bindingLabel(sequence);prefix=stroke;last=sequence.includes(' ')?0:now;
          message.textContent='未保存の変更があります。';
        };
        const clear=document.createElement('button');clear.type='button';clear.textContent='解除';clear.setAttribute('aria-label',command.label+'のキーを解除');
        clear.onclick=()=>{keys.splice(index,1);render();message.textContent='未保存の変更があります。';};
        const record=document.createElement('button');record.type='button';record.textContent='記録';record.title='Tab・Shift+Tabも記録できます';record.onclick=()=>{input.focus();recordTab=true;message.textContent='割り当てるキーを押してください。Escで終了します。';};
        const group=document.createElement('div');group.append(input,record,clear);fields.append(group);
      };
      keys.forEach((_,index)=>addField(index));
      const add=document.createElement('button');add.type='button';add.textContent='キーを追加';add.onclick=()=>{keys.push('');render();list.querySelectorAll<HTMLInputElement>(`[data-command="${command.id}"] input`)[keys.length-1]?.focus();};
      fields.append(add);row.append(label,fields);list.append(row);
    }
  }
  host.querySelector('[data-save]')!.addEventListener('click',()=>{
    const value=structuredClone(draft);for(const command of shortcutCommands)value[command.id]=value[command.id].filter(Boolean);
    const error=validateBindings(value);if(error){message.textContent=error;return;}
    try{saveBindings(value);draft=currentBindings();render();message.textContent='保存しました。この端末で次回起動後も使えます。';}catch(error){message.textContent=`保存できませんでした: ${String(error)}`;}
  });
  host.querySelector('[data-reset]')!.addEventListener('click',()=>{draft=defaultBindings();render();message.textContent='初期設定に戻しました。「ショートカットを保存」で反映します。';});
  render();
}
