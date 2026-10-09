# Windows WebView2のホバー表示確認

対象はコミット `4fcaf0e` の実Studio、GitHub ActionsのWindowsランナー、ウィンドウ実測96 DPI（100%）。[実行記録](https://github.com/tamon-ishii/munin_manual_studio/actions/runs/37980336125)のWindowsネイティブ確認とWebView2確認が成功した。

テスト専用プロジェクトの90行のAI指示を展開・折りたたみし、原稿が変化しないことと入力欄が30vh以内であることを確認した。編集のみ・左右比較・プレビューのみの各モードで、実ポインターを編集領域と表示切替ボタンへ移動した。指定した幅1440と1000は画面に収まる幅に制限され、実際の表示領域はレポートに記録されている。

編集領域のtitleは空、表示切替ボタンのtitleは100文字未満。全6条件でページエラーなし。画像を確認して、左右比較時の編集領域ホバーに巨大表示がなく、ボタンホバーは短い一行の説明であることを確認した。

- [実測値と表示要素のレポート](windows-webview2-20261010/report.json)
- [編集領域ホバーの実画面](windows-webview2-20261010/panel-hover.png)
- [ボタンホバーの実画面](windows-webview2-20261010/button-hover.png)

Linuxで特定した原因は、ボタン用の `[data-editor-view]` セレクターが編集パネルにも一致し、パネル全文をnative titleへ設定していたこと。修正はボタンだけを対象にする。Windowsでは修正後に上記範囲で未再現と確認したもので、Windowsでの修正前の再現を主張しない。Milkdown浮動UIや独自ツールチップを原因と判断する証拠は得られていない。

150%・200%のOS表示倍率とユーザーの任意操作での長時間確認は未実施。browserのdeviceScaleFactorによる代替確認は行っていない。
