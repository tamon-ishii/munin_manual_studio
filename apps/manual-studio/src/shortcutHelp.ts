import {bindingLabel,currentBindings,shortcutCommands} from './keyboardShortcuts';
import {featureDialog} from './imageDialogs';

export function showShortcutHelp(onOpenSettings?: () => void): void {
  const existing = document.getElementById('shortcut-help-dialog') as HTMLDialogElement | null;
  if (existing?.open) { existing.focus(); return; }
  const { dialog, body } = featureDialog('キーボード操作一覧');
  dialog.id = 'shortcut-help-dialog';
  dialog.querySelector<HTMLButtonElement>('.panel-header button')?.setAttribute('data-close', 'true');
  const list = document.createElement('dl');
  list.className = 'shortcut-list';
  const bindings = currentBindings();
  for (const command of shortcutCommands) {
    const label = document.createElement('dt');
    label.textContent = command.label;
    const keys = document.createElement('dd');
    const assigned = bindings[command.id];
    if (assigned.length) {
      assigned.forEach((stroke, index) => {
        if (index > 0) keys.append(' / ');
        const kbd = document.createElement('kbd');
        kbd.textContent = bindingLabel(stroke);
        keys.append(kbd);
      });
    } else {
      keys.textContent = '未割り当て';
    }
    list.append(label, keys);
  }
  const footer = document.createElement('div');
  footer.className = 'actions dialog-actions';
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = 'キー割り当ては設定画面から自由に変更できます。';
  body.append(list, note);
  if (onOpenSettings) {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'primary';
    editBtn.textContent = 'キー割り当てを変更…';
    editBtn.onclick = () => {
      dialog.close();
      onOpenSettings();
    };
    footer.append(editBtn);
    body.append(footer);
  }
}
