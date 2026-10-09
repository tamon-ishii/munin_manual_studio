# Windows WebView2のホバー表示確認

対象はコミット `4fcaf0e` の実Studio、GitHub ActionsのWindowsランナー、ウィンドウ実測96 DPI（100%）。[実行記録](https://github.com/tamon-ishii/munin_manual_studio/actions/runs/37980336125)のWindowsネイティブ確認とWebView2確認が成功した。

テスト専用プロジェクトの90行のAI指示を展開・折りたたみし、原稿が変化しないことと入力欄が30vh以内であることを確認した。編集のみ・左右比較・プレビューのみの各モードで、実ポインターを編集領域と表示切替ボタンへ移動した。指定した幅1440と1000は画面に収まる幅に制限され、実際の表示領域はレポートに記録されている。

編集領域のtitleは空、表示切替ボタンのtitleは100文字未満。全6条件でページエラーなし。画像を確認して、左右比較時の編集領域ホバーに巨大表示がなく、ボタンホバーは短い一行の説明であることを確認した。

- [実測値と表示要素のレポート](windows-webview2-20261010/report.json)
- [編集領域ホバーの実画面](windows-webview2-20261010/panel-hover.png)
- [ボタンホバーの実画面](windows-webview2-20261010/button-hover.png)

Linuxで特定した原因は、ボタン用の `[data-editor-view]` セレクターが編集パネルにも一致し、パネル全文をnative titleへ設定していたこと。修正はボタンだけを対象にする。Windowsでは修正後に上記範囲で未再現と確認したもので、Windowsでの修正前の再現を主張しない。Milkdown浮動UIや独自ツールチップを原因と判断する証拠は得られていない。

150%・200%のOS表示倍率とユーザーの任意操作での長時間確認は未実施。browserのdeviceScaleFactorによる代替確認は行っていない。

## 残る倍率の実機確認

Windowsの表示設定で倍率を変更してから、ビルド済みのDebugアプリに対してPowerShellで実行する。各倍率の画像とレポートは別フォルダーへ保存する。実ウィンドウのDPIが期待値と異なる場合はテストを失敗させる。

```powershell
# OSの表示倍率を150%へ変更した後
$env:MANUAL_WEBVIEW2_EXPECTED_DPI = '144'
$env:MANUAL_WEBVIEW2_RESULTS = 'webview2-results/150'
node scripts/test_manual_studio_webview2.mjs

# OSの表示倍率を200%へ変更した後
$env:MANUAL_WEBVIEW2_EXPECTED_DPI = '192'
$env:MANUAL_WEBVIEW2_RESULTS = 'webview2-results/200'
node scripts/test_manual_studio_webview2.mjs
```

この設定はOSの倍率を変更しない。倍率の変更自体は[Windowsの表示設定](https://support.microsoft.com/en-gb/windows/hardware/display-graphics/change-your-screen-resolution-and-layout-in-windows)で行う。実行前に `npm run manual:build` と `cargo build --locked -p manual-core -p manual-studio` が必要。

## DPI検証追加後の再確認

コミット `f24bdfb` の[CI実行](https://github.com/tamon-ishii/munin_manual_studio/actions/runs/37985959902)からWindowsのログ・画像・レポートを取得した。Windowsの録画・MarkItsチェックと実WebView2チェックは成功。レポートの全6条件は96 DPIで、実ビューポートは1008×681または984×661、ページエラーは0件だった。984×661の左右比較の画像を確認し、パネルホバーに巨大表示がなく、ボタンホバーの説明が一行であることを再確認した。

ネイティブログでは、空白・特殊文字を含む起動引数、クリック録画、MarkItsのクロップ保存・再起動・クロップ拡張、不変原本、Markdown挿入、AI未設定のHTML出力が成功した。期待DPIを指定しない通常CIの結果であり、150%・200%での成功を示すものではない。
