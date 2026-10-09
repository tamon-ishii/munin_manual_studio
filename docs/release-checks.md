# リリース前の確認

`npm run manual:check` で全体を確認する。ブラウザの確認前にネイティブCLIをビルドするため、以前の実行ファイルに依存しない。

変更範囲に絞る場合は `npm run manual:check -- --group <group>` を使う。対象の一覧は `--list` を付けて確認できる。

| group | 対象 |
| --- | --- |
| unit | DOMを使わないロジック、履歴、タグ、通信、撮影セッション |
| ui | アイコン、ツールバー、保存・プレビュー状態、設定、ショートカット、初回案内、編集、MkDocs操作 |
| generation | 生成レビュー、生成履歴、部分成功、再開、実行結果、期限と再試行 |
| capture | 再撮影の画像更新と撮影UIのネイティブ呼び出しを置き換えた検証 |
| build | フロントエンドとネイティブCLIのビルド |
| native | Rustテスト |
| smoke | 編集から生成、撮影、ワークスペース、ターミナルまでの統合操作 |

`manual:check-ui`、`manual:check-generation`、`manual:check-capture`も利用できる。

## 画面の確認

UIチェックは実際のMilkdownとアプリのCSSでSVGのサイズと塗り、空の区切り線、プレビュー状態、保存失敗、設定中のショートカット抑制を検証する。明暗テーマと900px幅の画像を `/tmp/munin-ui-review/` に保存する。画像の目視確認では文字・操作ボタンの重なり、線画アイコンの視認性、狭い画面の編集領域を確認する。

生成チェックは一時プロジェクトで文章とMermaidの候補、原稿の復元、未完了だけの再実行、外部編集の保護、画像を変更しないことを確認する。撮影チェックでは一覧への独立登録、再撮影候補の比較・採用・旧版復元、長いAI指示の折りたたみとMarkItsのクロップ拡張を確認する。ネイティブ呼び出しを置き換えた操作テストは実機確認と区別する。実行記録にはAPIキーを含めない。

画面の表記変更では該当する機能テストと統合スモークの操作名を同時に更新する。ボタンを別のメニューやダイアログに移したときは、その入口を操作してから検証する。

## 実機での範囲

ブラウザテストはOSの撮影権限やMarkItsの実ウィンドウ操作を保証しない。必要に応じて `npm run manual:smoke-native` を実行し、対象OSで画面収録・撮影元選択・注釈・再撮影を確認する。macOS・Windowsの実機確認をLinux上のテスト成功で置き換えない。

LinuxのリリースCIでも単体・UI・生成・撮影・統合チェックを実行し、失敗した場合は配布ファイルの公開へ進まない。

リリース時は各マニフェストとロックファイルのアプリバージョンを揃え、タグとアプリバージョンの一致を確認する。ブランチとタグをプッシュした後、リリースCIと配布ファイルの作成状況を確認する。

## 2026-10-08の仕様再整理後の確認範囲

`npm run manual:check` は全段階を通過した。コア142件成功・X11実画面の1件は除外、Studio23件成功。別途MarkItsのRustテスト23件も成功した。OpenSpecの厳密検証とTypeScript型チェックも通過した。

Linuxのブラウザでは、AI未設定・文書未選択のアプリ登録と撮影操作をネイティブ呼び出しの代替で確認した。実際の保存APIで画像取り込み、原本保持、候補採用、複数文書の参照、旧版復元、移行、公開データからの管理情報除外を確認した。MarkItsの編集画面ロジックではクロップ拡張による画素・注釈座標の復元を確認した。

RustではStudio／MarkIts間の原本・縮小書き出し・クロップ・シーンの受け渡し、空注釈の重複完了、保存失敗時の原本と採用版保持、再撮影の部分失敗・中断・再開を確認した。これは実アプリの操作記録から公開までを同一画像で通す実機検証ではない。

Windows WebView2の巨大表示、表示倍率100／150／200%、Windows・macOS実アプリの起動引数、操作記録、MarkItsでの再編集、Studio復帰は未確認。実機確認ではAIを未設定のまま、対象アプリ登録 → 操作記録 → 一覧登録 → 注釈とクロップ保存 → 再編集してクロップ拡張 → 文書挿入 → HTML公開を同じ画像で通す。原本ハッシュが変わらず、公開ファイルに原本・シーン・操作記録が含まれないことを確認する。

## 2026-10-09のLinux実画面チェック

最新のStudioバイナリをビルドし、`npm run manual:smoke-native` をX11の実画面で実行した。テスト専用アプリで空白・特殊文字を含む引数の配列境界を確認し、Studioの入力記録ヘルパーで実際のクリックを記録した。対象ウィンドウはテストで起動したものだけを操作し、終了時に子プロセスと一時プロジェクトを削除する。

実際のMarkItsでは注釈付きPNGの保存、再起動、マークに合わせたクロップ、保存、再起動、クロップ解除を通した。640×400への寸法復元と注釈の原本座標を確認し、同じ画像を保存APIで一覧登録・候補採用・Markdown挿入し、AI未設定で実際のMkDocs HTMLを生成した。原本ハッシュが変わらず、公開PNGへ原本やシーンのメタデータが残らないことも確認した。

実行には最新の `cargo build -p manual-studio --offline` と `cargo build -p manual-core --bin manualctl --offline`、MkDocs Material、利用可能なデスクトップが必要。Linuxの起動引数・入力記録チェックには `/usr/bin/python3` のtkinterを使う。MkDocsがない場合はテストを失敗させ、HTML公開を確認したことにはしない。

Linuxでは `scripts/smoke_manual_studio_native_library.py` によりStudio本体の設定画面から起動コマンドを登録し、操作記録・撮影・画像一覧への登録・矩形注釈の追加・MarkIts再編集・Studio復帰・Markdown挿入・HTML公開を同じ画像で完了した。再編集前後の注釈データと原本ハッシュが一致した。このチェックは `npm run manual:smoke-native` のLinux実行に含まれ、設定・キャッシュ・プロジェクトを一時領域に分離する。アクセシビリティで操作対象を特定し、入力時にウィンドウを有効化してX11キー入力を送る。

追加の実行依存はシステムPythonのGI、GTK3、AT-SPI。Windows WebView2とWindows・macOSの実アプリ確認は引き続き未完了。Linuxの成功を対象OSの確認として扱わない。

### 2026-10-09 最終追加修正の再確認

- Milkdownリンク表示・編集の固定幅を縮小可能にし、長いURLを含む320／213／160 CSS pxの画面で内側の幅が収まることを確認。
- `npm run manual:check` を最新ソースで再実行し、全27段階が成功。manual-coreは142件成功・1件ignored、Studioは23件成功。
- `node scripts/test_manual_studio_capture_ui.mjs` とOpenSpec strict validationが成功。
- Windows表示の診断スクリプトは要素寸法・文字数のみを採取し、本文を含めないことと停止後に採取しないことを確認。
- Windows WebView2での表示元特定・OS表示倍率別の確認、およびWindows/macOS実アプリでのネイティブ操作確認は引き続き未実施。上記の狭い画面の結果を対象OSの実機確認に読み替えない。

### Windows/macOS向け実画面チェックの準備

`manual:smoke-native` の起動引数とクリック記録の検証からLinux限定条件を外した。Python/Tkinterの実行パスは `MANUAL_NATIVE_PYTHON` で指定できる。Windows/macOSでも同じネイティブ検証を開始できるが、Studio設定画面から公開までをAT-SPIで操作する追加チェックはLinux限定。両OSの実行結果とWebView2の表示調査は未取得。

変更後のLinux/X11で `npm run manual:smoke-native` を再実行し成功。実アプリへの引数保持・クリック記録、MarkItsのクロップ拡張、原本保持、Studioの設定から撮影・再編集・文書挿入・AI未設定のHTML公開まで通過した。

ネイティブ検証の待機処理は、MarkIts・入力記録・対象アプリの起動失敗／異常終了を即座に検知するよう修正した。存在しないテスト用Pythonを指定した異常系が即座に失敗すること、および修正後のLinux実画面で設定・撮影・再編集・公開まで成功することを確認した。OpenSpec strict validationも成功。

## 2026-10-09 クロスプラットフォームCI

実装コミット `0cc761de46df0f998b7629844a04b6bca4a3a93d` を作業ブランチへプッシュし、[Build and releaseの手動実行](https://github.com/tamon-ishii/munin_manual_studio/actions/runs/37846298547)が全体成功した。

| 構成 | Core Rust | Studio Rust | ビルド・ZIP作成 |
| --- | --- | --- | --- |
| Linux x64 | 142成功・1 ignored | 23成功 | 成功 |
| Windows x64 | 130成功 | 16成功 | 成功 |
| macOS ARM64 | 139成功 | 21成功 | 成功 |
| macOS x64 | 139成功 | 21成功 | 成功 |

各構成でパッケージ構成のPythonテスト2件も成功。OS固有テストの条件によりRustの件数は異なる。LinuxのUI・生成・撮影・統合ワークフローも成功した。4構成のZIPを検証用CI成果物として保存し、Windows ZIPをダウンロードしてCRC検査、Studio／CLIの存在、プロジェクト管理データの不在を確認した。

この実行は作業ブランチの検証であり、バージョン更新・タグ作成・公開リリース更新は行っていない。Windows WebView2の巨大表示・OS倍率別確認とWindows/macOSの実GUIでの記録／再編集の確認は引き続き未実施。CIのビルド・Rust成功はGUI実機確認の代替ではない。

## 2026-10-09 Windows実ウィンドウ検証と巨大ツールチップ修正

`windows_native_smoke` を有効にしたCIでWindows Server 2025（10.0.26100、Python/Tk 8.6）の実アプリを検証した。初回は撮影・MarkIts操作後のHTML公開でパス接頭辞の不一致を検出し、原稿と資産の正規化ルートを統一した。次の実行ではWebView2のUI要素置換による `UIA_E_ELEMENTNOTAVAILABLE` を検出し、読み取り専用の表示待機に限って10秒以内に取り直すよう修正した。通常エラーと期限到達時は元のエラーを保持し、クリック等の操作は繰り返さない。

修正コミット `610cb21` の[Windowsネイティブ検証ステップ](https://github.com/tamon-ishii/munin_manual_studio/actions/runs/37852099421)は成功した。実アプリへの空白・特殊文字の引数渡し、Studio記録ヘルパーのクリック記録、MarkItsの保存・再起動・クロップ・再起動・クロップ解除、原本と注釈座標の保持、資産採用・Markdown挿入・AI未設定のMkDocs HTML公開を確認した。このテストはStudio設定画面から全操作をWindowsで通すものではなく、WebView2のホバー／OS倍率別検証も含まない。

利用者のLinux Mint Cinnamon録画で、約12.93秒の巨大表示にエディタ全体の案内・書式・プレビューの文字と表示切替ショートカット説明が含まれることを確認した。表示切替の `[data-editor-view]` セレクターが `#panel-editor` にも一致し、パネルのtextContentをネイティブtitleへ渡していた。すべての表示切替セレクターをボタンへ限定して修正。初期表示と3表示モードでパネルにtitle／aria-pressedが付かず、ボタンだけに短いtitleと選択状態が付く回帰テストとTypeScript型チェックが成功した。修正後の利用者環境でのホバー確認は再起動後に実施する。

### 再撮影の現在タスク表示（2026-10-09）

スクリーンショット一覧の再撮影状態欄に、経過秒数、画像の順番と名前、操作番号と現在の処理を表示する。デスクトップの操作再生は各操作の開始前に進捗を書き出し、記録された待機は秒数、要素の表示・状態待ちは待機の種類を示す。撮影後は注釈・クロップ適用と候補保存を表示する。個別撮影、全体撮影、履歴からの再開、失敗分の再試行は共通の進捗表示を使用する。

完了後も成功・失敗・未完了・対象外の件数と、候補を比較して採用する案内を残す。中断要求は実際の停止と区別し、実行エラーも残す。別プロジェクトへ切り替えた後は古い処理の進捗や終了結果を表示しない。

`test_manual_studio_recapture_progress.mjs` は実行中のタスク更新、完了表示の維持、中断、プロジェクト切り替え、実行エラーを検証する。Rustの再撮影テストは撮影コールバック実行中に進捗を読み取れることと、再試行でも採用画像を保持することを検証する。今回のユーザー記録は起動・ウィンドウ選択・クリック・撮影の4操作で、明示的な長時間待機は含まれない。数分間停止して見える原因の実機特定は、追加した操作表示で停止位置を確認する必要がある。

### 2026-10-09 意味による操作録画と画像照合

`npm run manual:check` の全28段階が成功。最終ネイティブ修正後のRustチェックはmanual-core 153件成功・1件ignored、Studio 23件成功。画像の移動、倍率変更、重複候補、無特徴・不正画像、キャンセル、HiDPI座標を検証した。

実際のManual Studioを対象に、6操作を名前・種類で記録し、階層文書へ到達する再撮影を確認した。検証用の一時レシピでボタンのアクセシビリティ名を不一致にし、保存した小画像で現在位置を解決する経路も通した。入力値の反映を確認してから次の操作へ進み、追加の固定待機なしで撮影、完了表示、Studio復帰、文書挿入、MkDocs公開が成功した。原本と注釈シーンの保持は録画・再編集チェックで確認した。

画像照合はローカルのPNGテンプレート比較を使い、OCRやAIは呼ばない。LinuxはX11、macOSは画面収録とアクセシビリティ権限が必要。画像が変化した場合や複数候補の場合は停止する。Windows WebView2のホバー表示倍率別確認とmacOS実GUIの一連の操作は未確認として残す。

[最初の意味録画・画像照合版の4構成CI](https://github.com/tamon-ishii/munin_manual_studio/actions/runs/37934009951) が成功し、Windowsの実録画・MarkItsチェックも成功した。入力反映確認を含む最終版はリリースCIで再検証する。

### Windows WebView2の実画面チェック

`node scripts/test_manual_studio_webview2.mjs` はWindowsでビルドした `target/debug/manual-studio.exe` を一時プロジェクトで起動する。WebView2の接続は[Microsoftが案内するリモートデバッグ設定](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/debug-visual-studio-code)を起動したプロセスだけに渡す。DebugビルドのWindows専用起動モードが、専用ポートと一時プロファイルをWebView2の作成APIへ指定する。通常起動とReleaseビルドではこのモードを有効にしない。接続先はそのプロセスの専用ポートで、実際のTauri画面と専用原稿が開いたことを確認する。

90行のAI指示を開閉し、高さ制限とMarkdownの保持を検証する。2種類のウィンドウ寸法と3つの編集表示で、パネルにtitleがなく、表示切替ボタンの説明が短いことを検証する。OSのポインターを動かしてホバーし、実際のウィンドウ画像と `GetDpiForWindow` のDPI、WebView2の表示寸法、診断記録を `webview2-results/` に保存する。ブラウザ倍率のエミュレーションは使わない。ウィンドウが画面外に切れている場合は成功にしない。

このチェックは `windows_native_smoke=true` のCIに含む。確認済みのOS倍率は出力されたDPIから判断し、100／150／200%すべてを試したとは扱わない。追加時点ではスクリプトの構文確認のみ完了しており、Windowsでの実行結果と画像確認はまだ取得していない。

最初のCI実行ではデバッグ接続が開始せず、画像は取得できなかった。[Microsoftの説明](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5645)では、WebView2 150以降の管理者権限での起動時は環境変数の指定を無視し、作成APIによる指定を利用できる。失敗はこれと整合するため、環境変数だけに依存した起動からAPI指定へ変更した。CIのWindows実行結果が得られるまで表示確認済みとは扱わない。

### 2026-10-10 Windows確認結果の更新

`f24bdfb` の[CI](https://github.com/tamon-ishii/munin_manual_studio/actions/runs/37985959902)でWindowsの実録画・MarkItsとWebView2のチェックが成功した。取得したログ、実測96 DPIの6条件のレポート、左右比較のホバー画像を確認した。詳細は[調査記録](investigations/windows-webview2-20261010.md#dpi検証追加後の再確認)に記載する。

Windowsの150%・200%とmacOS実操作は未確認。利用者から現時点で実機環境がないと確認したため、これらを公開前の残タスクとして維持する。macOS両構成のCIビルド成功を実操作の確認に読み替えない。

同コミットのローカル `npm run manual:check` は全30段階成功。StudioのRustテストは25件、manual-coreは158件成功・1件ignored。`openspec validate separate-screenshots-from-ai-authoring --strict` も成功した。残る実機確認が完了するまで7.5・9.3・9.4は未完了のまま維持し、アーカイブ・0.6.0公開へは進まない。

上記CIは最終的にLinux、Windows、macOS ARM64、macOS x64の全4構成で成功し、配布ZIPの作成まで完了した。タグ実行ではないため公開処理はスキップされ、リリースは公開していない。

### 2026-10-10 仕様整合と配布成果物の確認

変更仕様の `manual-authoring` で、追加機能8項目が `REMOVED Requirements` の下に置かれていた見出しの不整合を修正した。3つの本体仕様について、追加・変更要件の全文一致と削除要件の不在を確認した。本体仕様の検証は3件成功し、変更仕様の厳密検証も成功した。

CIの配布ZIP全4件をダウンロードし、全エントリーのCRC、Studioとmanualctlの同梱、README、macOSアプリ構成を確認した。[ファイル一覧・サイズ・SHA-256](investigations/release-artifacts-20261010/package-verification.json)を保存した。現行バージョンが0.5.0のため、これらは0.5.0表記の検証成果物であり、0.6.0の公開配布ファイルではない。

Linuxの `manual:smoke-native` も再実行し、実アプリの引数保持・クリック録画、MarkItsのクロップ保存・再起動・拡張、不変原本、原稿挿入、AI未設定のHTML公開が成功した。最初の実行はMkDocsがPATHにないため公開段階で停止し、既存の `/tmp/munin-native-publication-venv/bin` をPATHに追加して全経路が成功した。

Linux専用の実Studio操作も含めて終了コード0を確認した。AI指示の開閉、設定画面からの操作録画、撮影一覧、MarkIts編集・再編集、再撮影の完了表示、Studioの前面復帰、Markdown挿入、AI未設定のHTML公開がすべて成功した。
