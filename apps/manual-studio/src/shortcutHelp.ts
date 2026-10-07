export function showShortcutHelp(): void {
  const dialog = document.createElement('dialog'); dialog.id = 'shortcut-help-dialog';
  dialog.setAttribute('aria-labelledby', 'shortcut-help-title');
  dialog.innerHTML = '<h2 id="shortcut-help-title">キーボード操作</h2><p>macOSではCtrlの代わりにCmdを使います。</p><dl class="shortcut-list"><dt>保存</dt><dd><kbd>Ctrl + S</kbd></dd><dt>元に戻す</dt><dd><kbd>Ctrl + Z</kbd></dd><dt>やり直す</dt><dd><kbd>Ctrl + Shift + Z</kbd> / <kbd>Ctrl + Y</kbd>（Windows/Linux）</dd><dt>編集表示の切替</dt><dd><kbd>Ctrl + Shift + P</kbd></dd><dt>プレビューを再読込</dt><dd><kbd>Ctrl + Shift + R</kbd></dd><dt>AI更新の確認画面を開く</dt><dd><kbd>Ctrl + Shift + G</kbd></dd><dt>太字・斜体・リンク</dt><dd><kbd>Ctrl + B / I / K</kbd></dd></dl><p class="muted">AI更新は指示の確認後に実行します。ダイアログやAIターミナルに入力中は、文書操作のショートカットを実行しません。</p><button type="button" data-close>閉じる</button>';
  const finish = () => { dialog.close(); dialog.remove(); };
  dialog.querySelector('[data-close]')!.addEventListener('click', finish);
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  document.body.append(dialog); dialog.showModal();
}
