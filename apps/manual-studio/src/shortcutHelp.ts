import {bindingLabel,currentBindings,shortcutCommands} from './keyboardShortcuts';
export function showShortcutHelp(): void {
 const dialog=document.createElement('dialog');dialog.id='shortcut-help-dialog';
 const title=document.createElement('h2');title.id='shortcut-help-title';title.textContent='キーボード操作';dialog.setAttribute('aria-labelledby',title.id);
 const list=document.createElement('dl');list.className='shortcut-list';const bindings=currentBindings();
 for(const command of shortcutCommands){const label=document.createElement('dt');label.textContent=command.label;const keys=document.createElement('dd');keys.textContent=bindings[command.id].map(bindingLabel).join(' / ')||'未割り当て';list.append(label,keys);}
 const note=document.createElement('p');note.textContent='上部の「設定」からキー割り当てを変更できます。';
 const close=document.createElement('button');close.textContent='閉じる';const finish=()=>{dialog.close();dialog.remove();};close.onclick=finish;dialog.addEventListener('cancel',event=>{event.preventDefault();finish();});
 dialog.append(title,list,note,close);document.body.append(dialog);dialog.showModal();
}
