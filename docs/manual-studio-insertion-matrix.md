# 原稿への画像挿入条件の照合

機械台帳の個別ケースを原稿へ挿入する入口ごとに整理する。ボタンの生成・イベント登録は同じ操作に複数のソース定義があり、その登録数を独立した機能数にはしない。入口を開く文脈が異なるものは別ケースで確認する。

共通fixtureは `# Insertion`、`Before text.` と `After text.` の間の挿入位置、決定的PNG。ソースは文字オフセット、リッチ編集は対応する段落位置を使う。手動撮影は隔離X11の実GTK対象と実MarkItsを使う。AI応答は決定的ローカルfixtureであり、外部AI提供元の実行確認とは区別する。

各ケースの確認条件は、取消時の原稿・位置保持、別原稿への明示挿入または遅い結果の誤挿入拒否、失敗後の再試行、単一挿入、実原稿保存、Undo後の保存、元PNGまたは採用版の保持。処理中の原稿移動が通常UIで禁止される入口は、その禁止状態を検証する。同期処理には待機状態を人工的に作らず、不正入力の拒否と再試行を確認する。

| ケース | 開始する文脈 | 証拠 / ランナー | 入口固有の条件 |
| --- | --- | --- | --- |
| P03.source-file | ソースの画像選択ボタン | real-backend / insertion | ブラウザーfile chooser、保存ダイアログ取消、同じ入力で保存失敗再試行 |
| P03.source-clipboard | ソースのpaste | real-backend / insertion | FileReader前と保存中の取消、遅い結果の拒否、保存PNG保持 |
| P03.document-clipboard | 原稿全体のpaste登録 | real-backend / insertion | 原稿のpaste入口から同じ保持契約を確認 |
| P03.source-drop | ソースへの画像ファイルdrop | real-backend / insertion | drop後の保存ダイアログ、取消、保存失敗再試行 |
| P03.rich-upload | リッチ画像ブロックのupload | real-backend / insertion | 空画像ブロック、保存失敗placeholder除去、待機中Undo取消 |
| P03.rich-paste | リッチ本文への画像paste | real-backend / insertion | 待機中Undo後の画像挿入拒否、原稿切替後の遅い結果拒否 |
| P03.rich-drop | リッチ本文への画像ファイルdrop | real-backend / insertion | 同上。DOMイベントを実OSのdragとして扱わない |
| P03.imported-card | 取り込み済み画像のカード | real-backend / managed-insertion | 挿入先の閉じる/Escape、読込失敗、元原稿と別原稿の見出し |
| P03.resource-drop-source | リソースカード→ソース | real-backend / managed-insertion | 3画像種類、dragendのみの取消、参照失敗再試行、待機中の編集/移動禁止 |
| P03.resource-drop-rich | リソースカード→リッチ | real-backend / managed-insertion | 同上、待機中のスクロールで挿入位置を変えない |
| P03.tree-drop-source | ワークスペース画像ツリー→ソース | real-backend / managed-insertion | 独立dragstart、不正/別プロジェクトpayload拒否、同じ画像で再試行、別原稿 |
| P03.tree-drop-rich | ワークスペース画像ツリー→リッチ | real-backend / managed-insertion | 同上。撮影IDなしの通常画像参照を保存 |
| P03.desktop-bitmap-paste | 実OSクリップボードのCtrl+V | real-desktop / native-clipboard | 実PNGと画素、保存失敗再試行、実Ctrl+Z。応答待ちの取消/原稿切替は実X11 ownerで検査 |
| P04.editor-manual | 原稿の撮影→手動 | real-desktop / native-manual-capture | プレビュー取消、対象消失→Studio復帰→新規記録、挿入待機取消後の別原稿で一覧だけに保存 |
| P04.editor-ai | 原稿の撮影→AI | real-backend / ai-assistance | 同じ指示/recipeで撮影再試行、別原稿後の遅いlibrary応答拒否、元tab/カーソル復帰 |
| P04.editor-existing | 原稿の撮影→既存画像 | real-backend / managed-insertion | プレビュー取消、参照失敗再試行、原稿を開き直した後の古いchooser拒否 |
| P04.screenshot-card | 撮影済み画像のカード | real-backend / managed-insertion | 取消、挿入先読込/参照失敗、採用版と原本保持 |
| P11.generated-card | 生成済み画像のカード | real-backend / managed-insertion | 新規生成せず参照を挿入。取消、別原稿、履歴と元PNG保持 |
| P11.editor-dialog | 原稿からAI作画を開く | real-backend / managed-insertion | 新規生成失敗→再試行、候補/指示保持、履歴選択、取消後の再生成なし |
| P11.resource-dialog | リソースからAI作画を開く | real-backend / managed-insertion | 同じdialog操作を別起動文脈で検査 |

2026-10-12、source `c0af2b7088223a50b2e7eea419c76e9bf3eb6ca8c3a63ce6f7366e3c995d8e50` / build `c23c3242ad4d7979165596a694a9366d58871428ef5e2ad1b3b395e51dd1e56f` のLinux検証で、表の20ケースが個別ゲートを通過した。全体集約は未確認範囲を含むため`failed`であり、正式な状態は `ui-coverage-results/verification-summary.json` と個別限定ゲートで読む。実OSファイルchooser、クリップボードの全データ形式、外部AI提供元、Windows/macOSはこの表から合格と推定しない。

リッチ編集のCtrl+Zはブラウザーのキー入力で確認する。本文のUndo履歴があれば通常の履歴を戻し、履歴がなければ最新の待機画像だけを取り消す。別の画像ブロックをUndoしても独立した待機画像を失わない。実OSのキー入力は手動撮影・ビットマップクリップボードの別ランナーで確認する。

入口はファイル選択、貼り付け、ツリー/カードのdrag、撮影、作画の文脈に合わせて維持する。保存を伴う取り込み、既存PNGの参照、撮影の原本/採用版は異なる契約を保つ。共有処理の候補は開始原稿/カーソルの捕捉、原稿セッションの検証、取消後の遅い結果拒否、参照取得、保存確認、Undo。

往復・再入力・重複確認は各レポートの `steps` と `workflow` で記録する。作画の新規生成では指示入力1回、生成失敗1回と再試行1回を区別し、挿入先取消後の再生成/指示再入力0回を確認する。カードでは取消後に同じ画像を再選択する往復、原稿の既存スクショでは方法→画像→プレビューの再選択が残る。手動撮影の失敗時は記録セッションが破棄されるため、同じセッションの再試行として数えず、新しい記録開始として扱う。
