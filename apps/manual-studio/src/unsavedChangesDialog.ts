/** Resolve only after a save succeeds, a discard is chosen, or the user cancels. */
export function showUnsavedChangesDialog(page: string, save: () => Promise<void>): Promise<boolean> {
  const dialog = document.createElement('dialog');
  dialog.id = 'unsaved-changes-dialog';
  dialog.setAttribute('aria-labelledby', 'unsaved-changes-title');
  dialog.setAttribute('aria-describedby', 'unsaved-changes-message');
  dialog.innerHTML = `<h2 id="unsaved-changes-title">変更を保存しますか？</h2><p id="unsaved-changes-message"></p><p>「変更を破棄する」を選ぶと、未保存の編集内容は失われます。</p><p id="unsaved-changes-error" role="alert"></p><div class="actions"><button type="button" data-unsaved-action="cancel">キャンセル</button><button type="button" data-unsaved-action="discard">変更を破棄する</button><button type="button" class="primary" data-unsaved-action="save">保存する</button></div>`;
  dialog.querySelector('#unsaved-changes-message')!.textContent = `${page}に未保存の変更があります。`;
  document.body.append(dialog);
  dialog.showModal();
  const saveButton = dialog.querySelector<HTMLButtonElement>('[data-unsaved-action="save"]')!;
  saveButton.focus();
  return new Promise(resolve => {
    let saving = false;
    const finish = (proceed: boolean) => { dialog.close(); dialog.remove(); resolve(proceed); };
    dialog.querySelector('[data-unsaved-action="cancel"]')!.addEventListener('click', () => { if (!saving) finish(false); });
    dialog.querySelector('[data-unsaved-action="discard"]')!.addEventListener('click', () => { if (!saving) finish(true); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!saving) finish(false); });
    saveButton.addEventListener('click', async () => {
      if (saving) return;
      saving = true;
      dialog.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true; });
      saveButton.textContent = '保存中…';
      dialog.querySelector('#unsaved-changes-error')!.textContent = '';
      try { await save(); finish(true); }
      catch (error) {
        dialog.querySelector('#unsaved-changes-error')!.textContent = `保存できませんでした。編集内容は保持しています。${String(error)}`;
        saving = false;
        dialog.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = false; });
        saveButton.textContent = '保存する';
        saveButton.focus();
      }
    });
  });
}
