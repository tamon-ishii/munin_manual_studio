# jscpdによる重複整理

## 2026-11-15：全ダイアログの独立ウィンドウ表示

`dialogPresentation.ts` の共通入口から、デスクトップ版の静的・動的HTMLダイアログを `nativeDialogHost.ts` / `nativeDialogEntry.ts` で独立表示します。元のダイアログが入力・保存・確定処理を引き続き担当し、ウィンドウ間で操作と表示状態を同期します。設定項目や保存APIを別実装に複製していません。編集中の入力、IME、折りたたみ状態が古い更新で戻らないよう、操作の連番を表示更新に反映します。

`windowChannel.ts` は既存の推敲ウィンドウと共通のローカル通信を提供します。Rustの `open_auxiliary_window` へ、作業領域に合わせたサイズ・配置とWebView2プロファイル設定を集約しています。

実WebView2用の `scripts/test_manual_studio_dialogs_native.mjs` で、設定の独立表示、本体より大きいリサイズ、テーマ・文字サイズ・AI設定の自動保存、タブ操作、動的フォームの検証と確定、日本語変換、ファイル選択、Escとタイトルバーから閉じる操作を検証します。

追加検証で、フォーカス中の入力値の補正・ショートカット記録の表示更新、記録中のEsc/Tab、元のダイアログやその親要素を削除した場合の後始末を確認し、修正しました。Windowsでは補助ウィンドウに所有元を設定し、本体終了時に補助ウィンドウだけが残らないようにしています。本体の通常終了も実機テストの対象です。

`npm run manual:verify-dialogs` で型チェック、ビルド、実WebView2の設定・推敲テスト、ブラウザ版の表示・推敲テスト、jscpdを一括実行できます。製品コードを変更していないテスト修正時だけは `-- --skip-build` でビルドを省略できます。

## 2026-11-14：ダイアログ共通化と本番コードの追加整理

`npm run manual:duplicates` で検出後、同じ対象を `--no-gitignore` 付きでも解析し、作業中のソースを含めて前後を比較しました。解析基準（5行・50トークン）は変更していません。

| 指標 | 今回の変更前 | 今回の変更後 |
| --- | ---: | ---: |
| 重複箇所 | 71 | 66 |
| 重複行数 | 610 | 574 |
| 重複率（行） | 1.70% | 1.60% |
| TypeScriptの重複箇所 | 1 | 0 |

- `dialogPresentation.ts`：静的HTML・動的生成の全Studioダイアログに、内容別の初期サイズ・画面内への制限・手動リサイズ・明示的な最大化/復元を共通適用。テーマは共通のCSS変数を使用します。これは完全一致検出とは別に、ダイアログ調査で見つかった実装の分散を整理したものです。
- `milkdownAiTaskBlock.ts`：確定・削除・名前編集の編集可否、位置、ヘッダー取得を共通化。
- `preview.rs`：CSSと画像の公開アセット探索、および公開HTMLの通常パス/ディレクトリ形式の探索を共通化。
- `screenshots.rs`：画像の一時ファイル作成・書き込み・同期を共通化。通常更新の `persist` と原本保護の `persist_noclobber` は維持。
- `template.rs`：APIリファレンスのクラス/関数について、名前とドキュメント先頭行の書式設定を共通化。

残る66箇所にはRustのテストデータと異なる処理の類似部分も含まれます。検出除外で数値を下げる変更はしていません。

検証：`cargo test -p manual-core --lib`（219件）、TypeScript型チェック、`scripts/test_manual_studio_dialog_presentation.mjs`（静的8ダイアログ×6テーマ、動的生成、サイズ・保存失敗・採用操作）、推敲比較のブラウザテスト。前後のJSONレポートは `ui-coverage-results/jscpd-before/` と `ui-coverage-results/jscpd-after/` に保存します。

## 再実行

`npm ci` の後、`npm run manual:duplicates` で解析します。条件は `.jscpd.json`、結果は `ui-coverage-results/jscpd/jscpd-report.json` に保存します。レポートはGit管理の対象外です。

対象はManual StudioのTypeScript・TSXと、デスクトップホストおよびmanual-coreのRustです。依存ライブラリ、MarkItsサブモジュール、生成物は対象に含めません。Rustのファイル内テストは解析に含まれ、TypeScriptの独立した `*.test.ts` は除外します。

5行・50トークン以上を検出し、長いmain.tsやRustモジュールも解析できるよう、上限を20,000行・1MBに設定しています。残った重複にはテストデータや別処理の類似部分も含まれます。検出だけを理由に一括置換せず、処理の意味を確認して共通化します。

## 今回の変更

- `markits_scene.rs`：原稿のスクリーンショット更新と画像ライブラリの再撮影で重複していた注釈の拡縮を共通化。矩形、矢印、線幅、楕円、文字幅を同じ処理で更新します。
- `main.ts`：ファイル選択とドロップの画像読み込み、および保存・ブラウザー貼り付け・ネイティブ貼り付け後のソースへの挿入を共通化。挿入先の変更検知、未保存状態、履歴の記録は維持します。
- `fontSizePreference.ts`：編集とプレビューの文字サイズについて、保存・入力検証・ウィンドウ同期を共通化。保存キー、既定値、上限は個別に維持します。この組はjscpdの完全一致検出とは別に、調査中に見つかった同構造の処理です。

同じ解析条件での比較：

| 指標 | 変更前 | 変更後 |
| --- | ---: | ---: |
| 重複箇所 | 69 | 62 |
| 重複行数 | 628 | 530 |
| 重複率（行） | 1.93% | 1.63% |

共通モジュールの追加により解析ファイル数は116から118に増えています。

## 検証

- `npx tsc -p apps/manual-studio/tsconfig.json --noEmit`
- `cargo test -p manual-core --lib`（既存191件通過）
- `cargo test -p manual-core markits_scene --lib`（追加2件通過）
- `npx tsx scripts/test_manual_studio_insertion_context.ts`
- 開発サーバー起動後、`npm run manual:test-refactoring`：フォントの独立性・範囲検証・保存・別ウィンドウ同期・プレビュー反映、画像の選択・ドロップ・貼り付け・挿入先変更時の拒否をブラウザーで検証します。
- 同じサーバーで `node scripts/test_manual_studio_shared_toolbar.mjs`：ツールバー、編集モード、スクロール位置の回帰確認。

ブラウザーテストは既定で `http://127.0.0.1:5174` を使用し、`MANUAL_STUDIO_TEST_URL` で変更できます。
