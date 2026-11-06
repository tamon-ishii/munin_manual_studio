# jscpdによる重複整理

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
