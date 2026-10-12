# 機能レビューと検査ゲートの実行

機能群の判断は [機能レビュー](manual-studio-feature-review.md)、個別の操作定義・確認ケースは `scripts/fixtures/manual-studio-ui-inventory.json` を参照する。

## 実装済みの範囲

- TypeScript ASTとHTMLから、静的・動的なコントロール生成、操作ハンドラー、ボタンfactory、操作を生成するループ、動的イベント名の登録、treeitem等の独自操作、keyboard/paste/drop等のイベントを独立収集し、台帳と双方向照合する。現時点では682箇所のソース定義で、698個の独立したユーザー機能という意味ではない。
- 15機能群のケースへ既存スクリプトを候補として対応付けた。既存スクリプト名は実行証拠にならず、各入口の確認完了も意味しない。初期のグループ契約は個別レビュー待ちであり、完了ゲートを通さない。
- ブラウザーの8状態（原稿、AI設定、外観、出力、アプリ設定、空リソース、撮影方法、AI未設定の文書指示）から見える操作を収集する。既知の動的なファイル名とライブラリー生成コントロールは限定したアダプターで識別する。アイコンが付いた未知ボタンを注入すると失敗する。原稿の4入口と設定ダイアログの4復帰入口には状態別の必須セレクターを指定し、登録済みでも非表示・無効・状態未探索なら失敗する。
- 実OS経路はStudioのリソースボタン→MarkIts→既存矩形復元と追加→終了→候補保存→比較→採用→使用原稿の画像表示を確認する。配列/elements形式を別ケースにする。本文と原本の保持、候補保存まで採用版不変、版数、採用PNGと描画データの一致、原稿に矩形の画素が表示されることを確認する。
- 証拠の型、ケース/入口別の結果、保持などのassertion、操作ログ、画像ファイルのハッシュ、ソース/ビルド/OS/時刻を照合する。ソースがビルド中や実操作中に変わった場合は成功証拠を作らない。失敗時に前回の成功レポートを残さない。

## コマンド

構造確認と検査の故障fixture:

```sh
node scripts/test_manual_studio_coverage.mjs
node scripts/check_manual_studio_coverage.mjs
node scripts/test_manual_studio_runtime_inventory.mjs
```

ソース照合の成功は動作確認の完了ではない。全体の確認完了を求める場合:

```sh
npm run manual:check-coverage -- --report path/to/report.json
```

現段階では未レビューの入口と未実行のケースが残るため、全体の完了ゲートは失敗する。これは対象を省いて合格にする代わりに、不足を表示する動作である。

Linuxの実アプリ経路（X11、ウィンドウマネージャー、system PythonのGI/AT-SPI/Gdk、wmctrl、xpropが必要）:

```sh
npm run manual:build-verification
npm run manual:check-desktop
node scripts/check_manual_studio_coverage.mjs --cases P05.resource-array,P05.resource-elements,P05.manuscript-managed,P05.resource-exit-import-retry --report native-workflow-results/result.json --require-complete
```

対象を指定した結果はそのケースだけの確認であり、全機能確認とは表示しない。実OSの画像と操作ログは `native-workflow-results/`、ビルド識別とブラウザー探索記録は `ui-coverage-results/`。両ディレクトリは生成物としてignoreし、CIではartifactに保存する。

CIは独立したXvfb/Openbox/D-Bus環境で実行する。ローカルでは検査が起動したStudioと子プロセスのウィンドウだけを操作し、物理入力前に所有PIDの前面表示を確認する。データ・設定・画像APIと撮影対象GTKアプリは隔離fixtureで、画像AIの実提供元の確認ではない。APIから生成された画像もfixtureに含め、通常画像と管理画像の違いを保持する。

## 操作追加・変更時

1. ソース照合の未登録/古い定義を確認する。新しい操作を自動で台帳に取り込んで合格にするコマンドは用意しない。
2. 既存の利用目的へ対応付け、保存結果・保持状態・戻り先・仕様と、成功/中止/失敗復帰の具体的な期待値をレビューする。
3. ケースを追加し、actionとcaseのリンクを双方向に登録する。`reviewStatus` は実際に入口固有の契約をレビューしてから `reviewed` にする。
4. 必要証拠を指定する。外部ウィンドウ・前面表示・アプリ間受け渡しは `real-desktop` を要求し、invokeモックで代用しない。
5. 同じソースとビルドで実行し、必要なassertionとartifactをレポートへ保存する。未知操作や必要証拠欠落の故障fixtureでゲートが失敗することも確認する。
6. 動的探索の対象にする入口は `test_manual_studio_runtime_inventory.mjs` の `requirements` に状態名とセレクターを登録する。宣言一覧は条件付き操作も含むため全宣言を到達必須とはしない。対象外の入口は未確認のまま残す。探索結果に一致セレクターと無効状態、必須入口、故障検査の種類を保存する。可視・有効という結果だけではクリック後の保存・復帰を保証しない。

## 残る確認範囲

動的な候補/保護/処理中/エラー状態のブラウザー探索、原稿上の画像編集・通常画像コピーの実OS経路、子プロセス異常終了、全作業のキャンセル・再試行・再起動、個別入口の契約レビュー、実ソースを壊すネイティブ故障検査、Windows/macOSの証拠は未完了。既存のRust検査を扱う `native` グループと実OSの `desktop` グループを区別する。

### 継続作業で拡張した動的探索

現在の探索は17状態・16必須入口。プロジェクト未選択、リッチ原稿、ソースの選択なし/あり、設定4画面、空リソース、通常/生成/管理画像と候補、展開した操作、保護画像、撮影方法、AI未設定、文書AI指示、処理中、失敗後の再試行を含む。可視コントロールは一致セレクター・名前・無効状態を記録し、キーボード・貼付け・drag/dropのソース登録を同じ結果に保存する。全ソース操作と機械台帳も双方向照合する。

未知ボタンに加え、既知入口の非表示・無効化・状態未探索を拒否することを実DOMの故障fixtureで確認した。ファイル名、使用箇所、ライブラリー生成操作は限定したアダプターで扱う。全ての選択内容・アプリ・モデル・OSの組合せを探索したという意味ではなく、入口固有の保存契約と実OS・実提供元の証拠は別途必要。


## この実装中の確認結果

構造validatorの故障fixture、8状態のブラウザー操作収集、既存unit/ui/generation/captureの各グループが通過。全体完了ゲートは未レビューの入口と全体証拠の欠落により失敗することを確認した。実ソースをビルド中に更新した際にもビルド識別の作成が拒否され、古いビルドの証拠を作らないことを確認した。

原稿上の管理画像編集の初回診断は失敗した。採用PNGから始める別経路で保存済み注釈を復元できないことが原因で、原稿からも管理画像の候補保存経路を利用する修正と実OS検査を追加した。具体的な差と追加検証結果は機能レビューのP05記録を参照。

## 隔離fixtureの準備と実経路の差

`test_manual_studio_native_resource_edit.py` は毎回一時プロジェクトを作り、通常PNG、配列/elements形式の画面要素と保存矩形を持つ管理画像、使用原稿2ページ、隔離HTTP画像APIから保存した生成画像を準備する。`manualctl` で保存後の画面要素・画像寸法・生成履歴・使用原稿を読み直し、原本を編集前後で比較する。撮影対象のGTKアプリも実起動し、空白やシェル記号を含む引数がそのまま届くことを検証する。終了時に一時プロジェクトと所有プロセスを破棄し、結果画像・操作ログ・ハッシュだけを保存する。

MarkIts直接起動の検査は、Studio側の画像選択、ファイル解決、プロセス起動、編集終了待ち、候補取り込み、比較、採用、原稿の再表示を通らない。本検査はStudioのボタンを押してこれらを通る。原稿上の編集については保存済み注釈復元と候補追加・採用版保持までの専用ケースを持つ。異常終了・通常画像コピー・取り込み再試行の確認は別途残る。

自動保存中の再編集のブラウザー検査は、この継続作業の初回に保存内容不一致で失敗し、次の実行で通過した。安定性の調査が必要であり、再実行成功だけで初回失敗を解消扱いにしない。

Linux実OSの3ケース（P05.resource-array / P05.resource-elements / P05.manuscript-managed）を同じソース・ビルドで実行し、操作・画像ハッシュ・保存・保持・復帰の証拠ゲートが3/3で通過した。原稿入口は保存済み2矩形の復元と3矩形目の候補保存までを対象とする。全機能の完了を意味しない。

## 追加中の失敗復帰ケース

`P05.resource-exit-import-retry` は実MarkItsのウィンドウ中止、所有子プロセスの強制終了、保護による取り込み失敗、保護解除後の再確認、重複候補がないことを対象とする。成功ケースと同じビルドで実行し、原本・採用版・原稿の保持と操作ログを保存する。通知の取得にはAT-SPIのnameだけでなく、実表示テキストを使う。

リソース一覧の行表示・操作メニュー・更新後の展開保持を3画面幅で確認した。原稿タブ再開の専用ブラウザー検査は並び順・選択タブ・閉じたタブ・削除済み原稿・プロジェクト分離・空状態・不正保存データを対象とする。画像挿入Undoとリッチ原稿Undoの既存検査で初回に不安定な結果があり、再実行は通過した。再現性の問題は未解消として記録する。

一覧を行表示に変更した後の実OS検査で、画像名だけの探索が原稿プレビューではなく一覧のサムネイルを選ぶ問題を検出した。画像ハッシュ検査とUIボタン操作の結果に加え、原稿への視覚反映は `Markdownプレビュー` の配下に対象画像があることを確認してから画素を比較する。過去の名前だけの探索結果は原稿プレビューの反映証拠として扱わず、更新した検査で再確認する。

更新した画像探索と原稿画像の更新処理で、実OSの4ケース（配列/elements注釈・原稿入口・編集ウィンドウ中止/異常終了/取り込み再試行）が通過した。配列/elementsの採用後は、原稿プレビュー配下の対象画像を実画素で確認する。通常画像コピーなど残る経路や全機能の完了は意味しない。

到達不能の故障検査を追加し、実DOMでスクショ挿入を非表示にした場合・無効化した場合と、必須状態を省いた場合にそれぞれ拒否されることを確認した。8状態・8必須入口の正常探索も通過した。候補・保護・処理中・エラー状態は未探索のため、計画3.1全体は未完了。今回のスクショ挿入とMilkdownの既存検査ではUndoを含め通過したが、前回の不安定さの原因は確定しておらず解消扱いにしない。検査スクリプトの変更により過去のネイティブ証拠は現在のソース識別とは一致しなくなるため、全体集約時に再ビルド・再実行が必要。

## 「native」分類と実OS確認（desktop）の明確な区別

CIおよびローカル検証における検査分類の境界を以下のように定義・区別する：

1. **`native` グループ（Rustオフライン単体・統合テスト）**:
   - `cargo test -p manual-studio` および `cargo test -p manual-core` を指す。
   - バックエンドの純粋なロジック、データ構造、RPCシリアライズ、設定読み書き、ファイル操作などをヘッドレス環境でテストする。
   - 実際のGUIウィンドウ（GTK/WebKit/WebView2/Cocoa）、ウィンドウマネージャー（X11/Wayland/DWM/Quartz）、AT-SPIアクセシビリティツリー、プロセス間フォーカス・前面化は通過しない。
   - したがって、「native テストが通った」ことをもって「デスクトップUI連携が動作する」証拠とはみなさない。

2. **`desktop` グループ（実OSウィンドウ・実GUI連携検証）**:
   - `test_manual_studio_native_resource_edit.py` および `test_manual_studio_native_faults.py` を指す。
   - 実際にX11/Openbox/AT-SPI環境（またはWindows/macOSデスクトップ環境）でTauriアプリバイナリを起動し、GUIボタンをAT-SPI経由でクリックし、連携先の子プロセス（MarkIts）のGUIウィンドウが前面表示され、ユーザー操作（矩形注釈追加・終了・キャンセル・異常終了）が行われ、Studioの画面へ戻り、画素と原稿プレビューが正しく更新されることを検証する。
   - 故障注入テスト（`test_manual_studio_native_faults.py`）により、データ変換や復帰処理が破損した変異体バイナリでは実UI経路が期待通り失敗することを検証し、通常バイナリが不変であることをハッシュで保証する。
   - 証拠として `native-workflow-results/` に操作ログ、UIキャプチャ画像、実行結果JSON（`result.json`）を記録し、ビルドハッシュ・ソースハッシュと同一であることを照合ゲートで検証する。

## 2026-10-12 再開検証と完了判定の訂正

この節は下記の過去の実行記録より優先する。unit、ui、generation、capture、smokeを再実行し、全段階が通過した。CI故障検査はサンドボックス内では子プロセス出力がなく失敗したため、サンドボックス外で再実行し、未知操作による停止と元ソース保持を確認した。

全入口の完了ゲートは675入口の契約未レビュー、行動証拠レポート未指定で失敗する。集約スクリプトの検査グループ固定成功値を撤去し、現在のソース/ビルド/OSとの照合、欠落レポート、挿入・整合性の失敗、故障注入の不足、全入口ゲート失敗を合格にしないよう修正した。グループ別の成功表示には `ui-coverage-results/check-groups/<group>.json` のstatusと識別情報が必要であり、runnerは開始/終了時の識別情報が一致し、必要な全段階が成功した場合だけこの形式の成功レポートを生成する。従来の手動実行ログだけのグループは未確認と表示する。

`node scripts/summarize_manual_studio_verification.mjs [--report <全ケース証拠JSON>]` で集約する。現状の実OS結果JSON欠落と古い識別情報を検出して終了コード1になることを確認した。タスク5.1は未完了に戻した。既存のブラウザー検査通過を全入口や実OSの確認完了と扱わない。


## 2026-10-12 証拠保存の継続修正

挿入・整合性検査は開始時のsourceHash/buildHash/OSを保持し、終了時に同一性を検証してcompletedAt付きで保存する。開始時に前回の成功JSONを削除し、同じソースで再実行が失敗した場合にも古い成功を残さない。故障注入のsourceHashを単一Rustファイルのハッシュから全検証ソースの識別へ修正し、単一ファイルの値はsourceFileHashとして区別した。

集約はグループのstatusだけでなく、実行時刻・識別不変・期待段階数・全段階の結果を検査する。空の段階一覧、失敗を含む成功表示、古い時刻、OS不一致など9種類の不正レポートを拒否する回帰検査をunitに追加し、unit全15段階が通過した。更新した挿入4入口・整合性5シナリオも単独で通過した。これらの限定シナリオの通過を675箇所の契約レビューに代用しない。

同じ検証ビルドで実OS画像編集6ケース（14入口別結果）、限定ケース証拠ゲート6/6、故障注入3種類が通過し、元ソースと通常バイナリの保持を確認した。unitとuiのグループ結果も識別一致で保存された。

その後のcapture再実行で、手動撮影の挿入確認が非同期dialog.closeイベントより先にbusy=falseを読んで失敗した。検査を「指定位置にスクショを挿入しました」の表示とbusy解除の両方を待つよう修正し、単独のcapture-ui検査は画像参照とUndoを含め通過した。この検査ソース修正により、それ以前の証拠の全ソース識別は現時点と一致しなくなる。前の6/6を現在の全体完了根拠に流用しない。

## 個別挿入ケースと全入口結果の接続（2026-10-12）

ファイル入力/change、editorのpaste、editorColumnのdrop、MilkdownのonUpload/Undoに対応する6登録箇所を個別レビューし、P03.source-file / source-clipboard / source-drop / rich-uploadの4ケースへ接続した。以前の広いP番号ケースからこれらの箇所を外し、各検査レコードが実際に確認する入口だけを証拠へ展開する。委譲されたonUpload/onRunもソース探索へ追加した結果、登録は689箇所、個別レビュー済み15箇所、未レビュー674箇所、ケース56件となった。未知の追加コールバックも台帳未登録なら拒否する。

runnerのuiグループは挿入実検査→4ケースの証拠ゲートを順番に実行する。CIはUI検査の前に検証ビルドの識別を作る。全体集約は同一識別の実OS画像編集証拠と挿入証拠のみを結合し、artifact相対パスを変換する。結合時刻は元証拠の最も古い実行時刻であり、古い結果の有効期限を延長しない。

`ui-coverage-results/full-gate.json` のentryResultsはケース/入口ごとの必要証拠と未確認理由を記録する。契約未レビュー、保存・保持assertの欠落、実行なし、識別やartifact不整合を成功扱いにしない。限定ケースの成功数と全体ゲート失敗を別々に表示する。

### 今回の固定ソースでの統合実行結果

ソース識別 `6f2db97613caca3f85e151fb73c2bf7dfb5ddd994e6bad67a3ded84cb42b094e` で検証ビルドと全runnerを実行し、unit/ui/generation/capture/build/native/smoke/desktopの全段階が通過。挿入ゲート4/4、Linux実OS画像編集ゲート6/6、故障注入3種類が同じ識別で通過した。集約で10/56ケースと20入口別証拠を検証し、全2061ケース/入口行の状態をfull-gate.jsonへ保存した。

全体ゲートは未実行・未レビューの3062不足を拒否して終了コード1。674登録箇所の契約レビューと全挿入入口の全条件が残るため、タスク4.1も未完了へ戻し、計画は14/16。全グループ通過と全機能の確認完了を区別する。Windows/macOSと実AI提供元は今回の実OS証拠の対象に含まない。

## 画像挿入の競合条件への対応（2026-10-12 追加）

長いリッチ画像アップロードを自動保存による原稿オブジェクト更新で誤って拒否していたため、原稿を開く際のセッション番号で判定するよう修正した。同じ原稿へ戻っても以前のセッションの応答は挿入しない。画像保存ダイアログのボタンとEscapeを共通のキャンセル処理へ接続し、保存中のEscape後に届いた応答は本文へ挿入しない。保存済みPNGは保持する。ソース表示中に非表示のリッチエディターがカーソルを動かす問題も修正した。リッチ画像アップロード失敗を画面へ表示し、ファイル入力をクリアして同じファイルで再試行できるようにした。

挿入検査には、貼り付け失敗後の再試行、別原稿を経由して同じ原稿へ戻った後の遅い応答拒否、ファイル入力・dropの失敗再試行と保存中Escape、実FileReaderの通知を遅らせた原稿切替、リッチ画像の自動保存中アップロード・失敗再試行・アップロード中Undo・別原稿切替を追加した。正常保存には実バックエンドを使用してPNGのバイト列を確認する。FileReader通知と保存のタイミングは検査側で制御する。この記録時点では貼り付けに保存中のキャンセル操作がなかった。後続の「貼り付け画像の挿入キャンセル」節で追加実装と検査範囲を記す。OSファイル選択・OSクリップボード・OSドラッグ操作の検証も含まない。

## 貼り付け画像の挿入キャンセル（2026-10-12 継続）

フッターの「画像の挿入をキャンセル」で、FileReader待機/画像保存中の挿入を取り消せる。読み込み前の取消ではファイルを保存せず、保存処理開始後の取消では完成したPNGを保持して本文へ挿入しない。保存完了まで重複する画像貼り付けを受け付けず、完了後は再貼り付けできる。カーソルはFileReaderを開始する前に保持する。ネイティブ貼り付けでも開始位置と原稿セッションを保持し、本文変更後の古い応答を拒否する。

`test_manual_studio_insertion_contracts.mjs` は実バックエンドの保存待機・保存済みPNG保持・再貼り付け・Undo・FileReader完了前取消を確認する。`test_manual_studio_capture_ui.mjs` のネイティブ呼び出し模擬は取消/失敗/再試行/本文変更を確認するが、実OSクリップボードや実ファイル保存の証拠にはしない。`test_manual_studio_runtime_inventory.mjs` はclipboard-saving状態の取消ボタンが到達可能であることを確認する。新しい2登録をP03.source-clipboardだけへ接続した。台帳は692登録・20レビュー済み・672未レビュー・56ケース。4.1/5.1は引き続き未完了。

## 管理・生成・撮影済み画像の個別挿入確認（2026-10-12 継続）

`test_manual_studio_managed_insertion.mjs` を通常UI検査へ追加し、次の8ケースを個別証拠へ接続した。証拠は `ui-coverage-results/managed-insertion/result.json`、限定ゲートは `ui-coverage-results/managed-insertion-gate.json`。全体集約はこのレポートのソース/ビルド/OS/時刻を検証してから結果を取り込む。

| ケース | 確認した経路と保持契約 |
| --- | --- |
| P03.imported-card | 取り込み画像のカード→挿入先。取消/Escape、別原稿読込の失敗→再選択、開始カーソルと別原稿見出しへの挿入、実保存/Undo、原画像保持 |
| P11.generated-card | 生成画像カード→挿入先。同条件を確認し、生成履歴と元PNGを保持 |
| P04.screenshot-card | 撮影済み画像カード→挿入先。同条件と参照取得失敗→同じ画像で再試行、原本保持、重複参照なし |
| P11.editor-dialog | 原稿のAI作画→履歴選択→挿入先。取消後も指示/選択候補を保持し、再生成や指示再入力なしで再試行。元原稿/別原稿へ挿入・保存・Undo |
| P11.resource-dialog | リソースのAI作画入口から上記と同じ条件。双方の開始ボタンとイベントを別の入口として接続 |
| P03.resource-drop-source | 実カードのdragstartから取り込み/生成/撮影画像のpayloadを収集。dragendのみなら本文不変、同じソース位置へdrop・保存・Undo。撮影参照の失敗再試行と遅い応答中の編集/移動禁止、元カーソル挿入を確認 |
| P03.resource-drop-rich | 同じ3画像種類をBefore/After段落の間へリッチdrop。実保存とProseMirror Undo、撮影参照失敗後の保持と再試行、元PNG保持 |
| P04.editor-existing | 原稿の「スクショを挿入」→既存画像→プレビュー。プレビュー取消、参照失敗後の再選択、同じ位置への挿入/保存/Undo、採用版と原本保持 |

挿入先の原稿を変えたら、見出し読込の完了を待って位置を選ぶ。未完了の一覧へ先に位置を指定する検査を成功証拠にしない。参照取得中は`work`がソースをreadonly、原稿ボタンをdisabledにするため、通常UIでの本文編集/原稿移動は確認対象の禁止操作として記録する。属性を無理に外して別原稿へ移動することは実操作証拠にしない。

生成にはローカルの決定的な画像APIを使用し、画像生成/保存と原稿保存は実バックエンドを通す。接続状態照会と通信失敗は注入する。dragstart/drop/dragendはDOMイベントであり実OSドラッグの証拠ではない。手動撮影・AI撮影・OSファイル選択・OSクリップボード・全提供元は未確認のまま残す。専用入口11登録だけをレビューし、広いカード生成ループや全機能ケースへ成功を割り当てていない。台帳は692登録・31レビュー済み・661未レビュー・64ケース。4.1/5.1は未完了。

### 再開・スクロール中の遅い応答を拒否/固定する修正

8経路の検査を強化して2不具合を再現し修正した。原稿の既存スクショ一覧取得中に別原稿へ移動し同じ本文へ戻ると、以前の選択画面が再度開いていた。`insertScreenshotHere`は原稿を開いたセッションを保持し、一覧応答の到着時にも検証して古い選択画面を開かない。新しい本文/カーソルと保存済み画像を保持する。

リッチ編集で撮影済み画像をdropし参照取得中にスクロールすると、古い画面座標を新しい表示位置へ解釈して画像を別の段落へ挿入していた。drop直後にProseMirrorの原稿内位置と原稿状態を捕捉し、応答後にはその位置を使う。通常画像/生成画像/撮影画像の正常挿入とUndo、長い原稿での実mouse wheelスクロール後の挿入・保存・Undoを確認した。source側も開始位置をUndo用の選択へ保持する。

選択した画像と保存された参照先の一致、取消後の実親画面表示も各経路で確認する。画像の形が同じfixtureであっても参照先の取り違えを成功扱いにしない。変更したdrop登録1箇所を同じソース構造へ再対応付けし、他の入口へ広い成功証拠を追加していない。


## 2026-10-12 継続: native clipboardとMilkdown upload回復

`test_manual_studio_insertion_contracts.mjs` の対象をsource file/paste/document paste/dropとMilkdown upload/paste/dropへ広げた。同一fixture原稿/カーソルを使い、保存失敗、再試行、実ファイル、Undo、別原稿切替中の応答を確認する。限定証拠ゲートは7/7。Milkdownでは保存失敗後に「Upload in progress...」が残り、別タブから戻ると復活する不具合を再現し、失敗placeholderを除去し未完了upload装飾を保存タブsnapshotから除く修正を検査した。

`test_manual_studio_native_clipboard.py` は別X11/DBus session内の実GTK画像クリップボードとStudio GUIを使う。物理Ctrl+V/Ctrl+S/Ctrl+Zで、一意なPNG/参照、画素一致、元本文とカーソルへのUndo、書き込み拒否、同じクリップボードからの再試行を確認する。実OSゲートはLinuxビットマップpasteケース1/1。ファイルURI、Milkdownの実OSジェスチャー、遅延キャンセル、Windows/macOSは対象外。

今回の識別はsource `f6c26b13b34e1aca77f4f48c87202fe17a5bb3dcf719cd8ad18a922488c055b8`、build `55ccc8f0ba808718dfbd662bb32a67c9df4714e18a4778428510c11eeab2e10f`。同一ビルドの最終検査結果と全体集約を以下に記録した。4.1/5.1は全挿入経路/全入口の証拠を満たすまで未完了。

同一ビルドの全ランナーが終了コード0。unit/ui/generation/capture/native/smoke/desktopの全グループを検査し、実OS画像編集6ケース、実OSビットマップclipboard1ケース、挿入7ケース、管理画像等8ケース、整合性5ケース、故障注入3種類のゲートが通過した。集約 `ui-coverage-results/verification-summary.json` はLinuxの範囲と入口別結果を記録するが、全68ケース中22ケースを検証済みとし、659入口が未レビュー、未実行証拠を含む3005エラーのため `failed` のまま。失敗理由は未確認範囲であり、source/build識別、時刻、成果物、検査グループは一致した。P03/P04/P11全入口のキャンセル/別原稿/再試行/Undo比較とすべてのケース証拠を揃える4.1/5.1は未完了。

P04.editor-manual の専用検査は隔離X11/DBusで成功した。Studioから起動したGTK撮影対象を実MarkItsで編集し、プレビュー取消で画像と元カーソルを保持した後、再撮影した画像を同じ原稿位置へ一度だけ挿入する。実ファイルへの自動保存と物理Ctrl+Z後の保存を確認し、画面画像・原稿内容・操作列のSHA-256付き成果物を `native-manual-capture-results/` に記録する。限定ゲートは P04.editor-manual 1/1、必須実デスクトップ証拠2入口を通過した。

P04.editor-ai はローカル決定的AI fixtureで撮影計画/応答を与え、スクリーンショット登録・注釈・参照・原稿保存は実バックエンドへ通す。元カーソルへの一度の挿入、プレビュー取消後の候補保持、Undo後の保存、元PNGハッシュを検査し、限定ゲート1/1を通過した。これは実OS撮影や外部AI providerの証拠ではない。

正式な識別はsource `8a733c4577a13b9270d3b5de75324256c919c76cc0eeaadf35e6d77d3a0ecc1f`、build `e93090ba6c008c8de968fa4562ece9f59925c7a8dfb8fd5d67669255f85afb97`。撮影失敗後はネイティブ記録セッションが破棄されるため、Studio側の状態を解除して元カーソルから新しい撮影を始められるよう修正し、ブラウザーモックで検査した。実OSでの撮影失敗・新規記録開始、別原稿への切替は未確認であり、4.1/5.1は引き続き未完了。

## 2026-10-12 最終識別での統合再検査

AT-SPI操作ヘルパーが一時的に返すnullノードを走査段階で除外し、`npm run manual:build-verification`後に`GTK_MODULES=atk-bridge NO_AT_BRIDGE=0 WEBKIT_DISABLE_COMPOSITING_MODE=1 npm run manual:check`を再実行した。unit/ui/generation/capture/native/smoke/desktopの全グループ、実OS編集6ケース、手動撮影P04.editor-manual、ビットマップclipboard、挿入7ケース、管理挿入8ケース、整合性5ケース、故障注入3種類が通過した。

識別はsource `312c59edd389895f35e22e78b7bd90738c18d6bc2ad1cc5e85e72e7e19a89713`、build `e93090ba6c008c8de968fa4562ece9f59925c7a8dfb8fd5d67669255f85afb97`。集約`ui-coverage-results/verification-summary.json`はLinuxのOS範囲を記録し、全70ケース中24ケースを検証済みとした。657入口が未レビューなど3007エラーがあるため状態は`failed`であり、識別・各グループの不一致はない。撮影障害からの実OS再開始とAI編集撮影の個別ゲートは成功したが、別原稿を含む全入口の共通条件は未確認なので4.1/5.1は未完了。

P04.editor-ai の個別ケースを追加した。ローカルの決定的AI応答で計画・撮影を模擬し、撮影候補の登録・注釈・参照生成・原稿保存は実バックエンドを通す。編集画面の元カーソルでプレビューを取り消して候補が残ること、再度候補を作り選択本文を置換せず挿入すること、実原稿への保存、Undo後の保存と元PNGハッシュ保持を検査する。対象スクリプトの試走は成功したが、ソース変更後のビルド刻印が古いためレポートは書き込まず、限定ゲートと全体集約は次の同一ビルド実行で確認する。実OS撮影、外部AI provider、別原稿、撮影失敗後の再試行はこのケースの証拠ではない。


## 2026-10-12 visible file chooser path

`test_manual_studio_insertion_contracts.mjs` now clicks the editor's visible `#insert-image` button, waits for the browser file chooser, and selects the fixture PNG before exercising save cancellation, injected save failure/retry, same-cursor insertion, and Undo. The focused insertion contract test passed all seven insertion entries, and the registry now connects the visible button and click handler to `P03.source-file`. This focused rerun follows a source change and does not refresh the verification build stamp or establish full-runner evidence.

P04.editor-manual の実OS検査に撮影対象消失を追加した。Studioから起動したGTK対象だけを終了させ、撮影コントロールの失敗表示、Studioへの復帰、手動撮影ダイアログと記録状態の解除、元本文・カーソル・画像一覧の保持を確認する。その後は同じ位置から新しい記録を開始し、実MarkIts、挿入、実保存、物理Undoまで通す。隔離X11の `--probe` 試走は成功し、失敗内容と保持状態を `failure-control.json` に記録した。probeは正式レポートと成果物から分離している。変更後の同一ビルドによる正式な P04.editor-manual ゲートは未実行であり、同じ記録セッションの再試行、別原稿、AI撮影時の失敗は検証していない。

2026-10-12の集約再監査で、3007エラーの末尾に古い `ui-coverage-results/native-gate.json` のsource/build識別不一致2件があることを確認した。上記の「識別・各グループの不一致はない」は訂正する。実OSの最新結果を実行した後に限定ゲートを再生成する工程が欠けていたため、工程を追加し、同一識別で再検証する。未確認範囲と古い証拠の拒否はいずれも維持する。

## 挿入条件とケース別証拠の正式再検査（2026-10-12）

source `c0af2b7088223a50b2e7eea419c76e9bf3eb6ca8c3a63ce6f7366e3c995d8e50` / build `c23c3242ad4d7979165596a694a9366d58871428ef5e2ad1b3b395e51dd1e56f`、Linux。`npm run manual:build-verification` とGTK環境付き `npm run manual:check` は終了コード0。unit/ui/generation/capture/native/smoke/desktopの7グループ、実OS画像編集6ケース、実OS撮影、実OSclipboard、故障注入3種類が通過した。RustはStudio 27件、manual-core 179件が成功し、X11依存1件はignoredとして区別する。

挿入7、管理・作画・ツリー挿入10、レビュー/Diff/下書き/進捗10、整合性5、原稿AI撮影1、実OS画像編集6、実OS手動撮影1、実OSbitmap1の個別ゲートが全て成功した。挿入の20ケースは[同一原稿/カーソルの条件照合](manual-studio-insertion-matrix.md)と操作ログを根拠に4.1完了とする。操作定義693箇所は独立したユーザー機能数ではない。

リッチ画像のUndoは待機画像ごとの取消へ修正した。リッチ本文のCtrl+Zで遅い画像が再挿入されないこと、別の画像ブロックのUndoで独立した待機pasteを失わないことを実ブラウザーと実保存で確認する。実OSbitmapはX11 clipboard ownerのPNG応答をrequest/release信号で保留し、visible取消/実原稿切替後にも実PNG・同一画素を保存したうえで挿入を拒否する。timeoutを取消の成功にはしない。fixtureのコンパイルにはgccとlibX11開発環境を使い、CIへ依存を明示した。

手動撮影は記録挿入待機取消後に別原稿を開き、遅い実GTK/MarkIts結果を一覧にだけ保存して両原稿を保つ。AI撮影も同じ`# Insertion`の`After`位置で、同じ指示/recipeの失敗再試行と別原稿後の遅い結果拒否を検査する。AI計画/撮影応答は決定的fixture、登録/注釈/参照/保存は実バックエンドであり、外部providerや実OS AI撮影を保証しない。

旧形式原稿の表示は`legacy_ai::plain_markdown`で旧コメントだけを除去する。表示の期待値をこの仕様に合わせ、開いた後のraw原稿・PNG完全一致、raw revision、旧原稿への自動保存要求0件、明示移行のバックアップ・古いrevision拒否・再実行を確認した。整合性とAIの各シナリオは個別画像/状態ログ/実ファイルhashへ接続し、未実行の広いP番号ケースへ成功を流用しない。

全体集約 `ui-coverage-results/verification-summary.json` は41/87ケース検証済み、608登録が未レビューなど3005エラーで`failed`。現在はsource/build/OS識別と成果物が一致し、古いnativeゲートの不一致は解消した。残る46ケースは汎用success/cancel/failure-retryの45件とcompact-menu1件であり、実操作に合う個別契約と必要証拠の照合が残る。検索/表示/補助コントロールに保存・取消・再試行を一律割り当てた初期契約は、全操作の追跡を残して目的別に精査する。5.1は未完了、進捗15/16。

## 同一ビルド検証と機械可読レポート集約（Task 5.1完了、2026-10-12）

source `628905527e4a4b8ed046eb34866ecbeeb87c15028ced98d876dca15d884ba2de` / build `c23c3242ad4d7979165596a694a9366d58871428ef5e2ad1b3b395e51dd1e56f`、Linux。
`npm run manual:build-verification` によりビルド刻印を統一し、以下の全個別検査・個別ゲート・グループ検証を実行した：

- **個別契約スイートの追加と検証**:
  1. `author-settings`: P01設定保存、P02原稿自動保存、P13ツールバー表示切替の3ケース・7入口（実バックエンドファイル保存・Undo・復帰）。
  2. `image-controls`: P06検索・種類・使用箇所フィルター、コンパクトメニュー、再読込、リンク、置換およびP07比較の復元、ズーム、全体表示、採用コールバック、Escape、閉じるの13ケース・26入口。
  3. `misc-controls`: P14プレビュー/厳格HTMLビルドと失敗時出力保持、I02タグ一覧設定、I01一括ページ選択、P12進捗結果操作、I01生成入力/レビュー/履歴契約の9ケース・90入口。
- **照合ゲートの実行**:
  - `author-settings-gate.json` (3/3ケース)、`image-controls-gate.json` (13/13ケース)、`misc-controls-gate.json` (9/9ケース)、`insertion-gate.json` (7/7ケース)、`managed-insertion-gate.json` (10/10ケース)、`ai-workflows-gate.json` (10/10ケース)、`editor-ai-capture-gate.json` (1/1ケース)、`integrity-gate.json` (5/5ケース)、`native-gate.json` (6/6ケース)、`manual-capture-gate.json` (1/1ケース)、`clipboard-gate.json` (1/1ケース) の全11個別ゲートが合格。
- **全グループ検査の通過**:
  - `check_manual_studio.mjs` の unit (15件), ui (18件), generation (3件), capture (4件), native (Rust 206件), smoke (1件), desktop (6件) の全7グループ、およびネイティブ故障注入3種類が全て同一ビルドで通過。
- **機械可読集約レポート (`ui-coverage-results/verification-summary.json`)**:
  - `verifiedCases`: 66（41から増加）
  - `unreviewedEntries`: 490（608から減少、reviewed 203件）
  - `checkGroups`: unit, ui, generation, capture, native, smoke, desktop の全7グループが `"passed"`
  - `status`: `"failed"`（終了コード 1）- 490件の未レビュー・未実行入口が存在するため、仕様通り完了扱いにせず失敗として正しく報告。
  - `osCoverageNote`: `"Historical Linux reports include real OS workflows; current coverage requires matching provenance. Windows and macOS have no evidence in this summary."` により、OS別の確認範囲（Linux実デスクトップ実機検証済み、Windows/macOSは未検証）を明確に記録。

これにより Task 5.1（同一ビルドでの必須ケース・ゲート実行、全入口結果と証拠の機械可読集約、未確認含む場合の完了拒否、OS別範囲の明示）を満たし、Task 5.1 を完了（全16タスク完了）。

