/** Short decisions and small forms should not inherit the workspace dialog layout. */
export function isCompactDialog(dialog:HTMLDialogElement):boolean{
  return dialog.dataset.dialogSize==='compact'||dialog.matches([
    '[data-confirm-action]','[data-request-text]','[data-screenshot-destination]',
    '[data-image-presentation]','#unsaved-changes-dialog','#file-delete-dialog',
    '#workspace-dialog','#new-page-dialog','#new-folder-dialog',
    '#terminal-directory-dialog','#execution-failure-dialog',
  ].join(','));
}

/** Only content-heavy browser dialogs benefit from an in-page maximize control. */
export function canExpandDialog(dialog:HTMLDialogElement):boolean{
  return !isCompactDialog(dialog)&&dialog.matches([
    '[data-dialog-expandable]','#panel-settings','#panel-appearance','#panel-brief',
    '#image-save-dialog','#draft-diff-dialog','#generation-review-dialog',
    '#generation-input-dialog','#generation-history-dialog','#execution-history-dialog',
    '#capture-expectations-dialog','#save-conflict-dialog','#proofreading-dialog',
    '#selection-diff-dialog','#selection-ai-advice-dialog','#selection-ai-action-dialog',
    '#reader-review-options','.image-comparison-dialog','#markdown-table-dialog',
    '#generation-pages-dialog','#reader-review-results','[data-manuscript-search]',
    '[data-manuscript-git]','[data-ai-image]','#template-creation-dialog',
  ].join(','));
}

/** Native title bars own window controls. Keep decisions such as Cancel and Save. */
export function removeNativeWindowControls(dialog:HTMLDialogElement):void{
  dialog.querySelectorAll('button').forEach(button=>{
    if(button.hasAttribute('data-dialog-expand')||button.textContent?.trim()==='閉じる')button.remove();
  });
  dialog.querySelectorAll('.dialog-auto-header,.panel-header > .actions').forEach(element=>{
    if(!element.textContent?.trim()&&!element.children.length)element.remove();
  });
}
