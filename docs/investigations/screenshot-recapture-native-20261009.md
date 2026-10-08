# 再撮影の実機調査（2026-10-09、Linux Mint / X11）

## 確認した事実

ユーザーの実プロジェクトの進捗ログは07:31:10に開始し、07:31:15に候補の保存まで成功していた。操作は起動・ウィンドウ選択・クリック・撮影の4件。明示的な長時間待機はなかった。対象アプリが前面に残るため、Studio内の完了表示を見られない問題があった。

テスト用のプロジェクトで `/home/ishii/PycharmProjects/pymodulemgr/target/release/manual-studio` を実際に起動し、`recording-chapter/recording-section/detail.md` を開く操作を録画して撮影した。原本ではそのパス、展開されたツリー、本文「Hierarchy captured」を確認した。録画された11操作にはクリック座標、Control+a、正しいプロジェクトパスの文字列が含まれる。操作間の待機や対象要素の意味は保存されていない。

その記録を再撮影すると、操作処理とPNG保存は成功扱いになったが、原本には別プロジェクトのindex.mdが写っていた。最初の同一プロジェクトを使った試行では、撮影に伴うassets/screenshotsの追加でツリーの並びも変わっていた。プロジェクトを分離した試行でも別画面の撮影を確認しており、ファイル順の変化だけが原因とは断定しない。起動後の状態、画面遷移の待機、入力先のフォーカスも確認対象になる。「PNGを作れた」と「意図した画面を再現した」は別の判定が必要。

実機の確認ダイアログはWebKitのJavaScriptダイアログで、表示中はAT-SPIの本文が取得できない。テストでは実画面のOKボタンを押して再撮影を開始した。これを再撮影エンジンの停止と混同しない。

## 実装した復帰修正

`screenshots-recapture` の成功・失敗ともStudioを再表示する。Linux X11ではGTKのfocus要求だけで対象アプリが前面に残る場合に対応し、Studio自身のネイティブウィンドウIDを使って、分離したヘルパープロセスからアクティブ化する。WaylandのハンドルにはこのX11処理を適用しない。

実際の再撮影後、スクリーンショット一覧に成功・失敗・未完了・対象外の件数が残ること、アクティブウィンドウがMunin Manual Studioであることを確認した。この確認は、座標で録画した操作が正しい画面を再現できたという意味ではない。

## 次の記録形式

ユーザーの追加要件に沿い、座標を主識別子とする録画から、対象要素と意図を保存する録画へ変更する。

1. 録画時にクリック位置にある要素の役割、名前、利用できる安定ID、所属ウィンドウと親要素の手掛かりを取得する。取得が遅い・失敗する場合は操作記録自体を妨げず、代替情報へ移る。
2. フォルダーは「展開する」、ページは「選択する」、ボタンは「実行する」、入力欄は「値を設定する」として保存する。展開済みのフォルダーを再びクリックして閉じる動作を避ける。
3. 再生時に現在の要素を再検索し、一意な対象と期待する状態を確認して操作する。画面遷移は次の要素の出現を期限付きで待ち、最終撮影は期待するパス・見出しなどの到達条件を確認する。
4. 要素が取得できない場合に限り、ローカルOCRによる文字と周辺情報、小さな画像テンプレートの照合を利用する。候補が複数または一致度が不足する場合は停止し、違う画面のPNGを成功扱いにしない。
5. 座標は古い記録との互換情報および検証できる場合の最終手段とする。画像認識用の切り抜きは原本を変更せず、撮影レシピの補助資産として保存する。
6. 「フォルダーを展開」「detail.mdを選択」「本文の表示を待機」「画像照合を実行」など、意味を持つ現在タスクと待機状態を進捗へ出す。

意味による自動録画、OCR、画像照合、到達条件の自動取得は、この調査時点では未実装。現行の再生側にはアクセシビリティのセレクターによる操作があるため、録画側の識別情報と状態確認を接続する設計にできる。

## OS機能の候補

- Windows: UI AutomationのElementFromPointでクリック先の要素を取得する。文字画像の代替検索にWindows.Media.Ocrを検討する。OCRは文字と位置を返す機能であり、任意のアイコンやクリック意図を自動判定する機能ではない。
- macOS: AccessibilityのAXUIElementCopyElementAtPositionを要素取得に、VisionのVNRecognizeTextRequestを文字画像の代替検索に検討する。
- Linux: AT-SPIのGetAccessibleAtPointを要素取得に利用する。統一されたOS標準OCRを前提にせず、必要時にローカルOCRを追加する。画像テンプレート照合はOS共通の実装を検討する。

参考: [Windows UI Automation](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation-elementfrompoint)、[Windows OCR](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine)、[macOS Accessibility](https://developer.apple.com/documentation/applicationservices/1462077-axuielementcopyelementatposition)、[Apple Vision](https://developer.apple.com/documentation/vision/vnrecognizetextrequest)、[AT-SPI](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/method.Component.get_accessible_at_point.html)。
