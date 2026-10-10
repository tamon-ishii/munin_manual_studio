# Manual Studio 仕様一覧

このディレクトリは、現在の実装に対応する機能仕様をまとめる。操作手順は [原稿・画像の編集](../manual-studio-editor-workflows.md)、要件と確認シナリオは [OpenSpec](../../openspec/specs/) を参照する。過去の設計案・調査記録・アーカイブは現行仕様と区別する。

## 機能の区分

| 区分 | 仕様 | 扱う内容 | OpenSpec |
| --- | --- | --- | --- |
| 画面・原稿編集 | [画面と操作](manual-studio-ui.md) | ツールバー、表示、設定、保存、キーボード操作 | manual-authoring |
| リソース管理 | [リソース一覧](resource-library.md) | 画像の統合表示、検索、挿入、使用箇所、差し替え | resource-library |
| 撮影管理 | [スクリーンショット管理](screenshot-library.md) | 操作記録、原本、注釈、再撮影、候補採用 | screenshot-library |
| AI作画 | [AI画像生成](ai-image-generation.md) | Agy／Codex／API、履歴、修正、比較、中断 | ai-image-generation |
| 原稿更新・公開 | [生成・撮影・公開の更新契約](generation-and-publication.md) | AI文章・Mermaid、確定保護、実行記録、ビルド | manual-authoring |

## 共通の境界

原稿の「更新」はAI文章とMermaidを対象にする。「AI作画」は独立した画像生成であり、結果を確認して明示的に挿入する。撮影・再撮影・MarkIts編集にはAI接続を要求しない。リソース一覧はこれらの画像への共通の入口で、撮影専用の版管理は撮影管理の仕様に従う。

原稿から画像参照を消しても画像資産は削除しない。元画像を使ったAI修正と通常画像のMarkIts編集は別の画像を作る。同じ参照先の画像を変更する差し替え・撮影候補の採用は、使用原稿を確認する操作として区別する。

## 保存先と所有範囲

| 保存先 | 内容 |
| --- | --- |
| 設定した画像フォルダーの `generated/` | AI生成画像のPNG |
| 設定した画像フォルダーの `edited/` | 通常画像のMarkIts編集用コピー |
| 設定した画像フォルダーの `screenshots/` | 撮影管理画像の採用PNG |
| `.munin/image-generation.json` | 作画の生成方法・モデル・API URL |
| `.munin/generated-images/` | 成功した作画のメタデータ |
| `.munin/image-jobs/` | 作画の実行状態・失敗・中断の記録 |
| `.munin/screenshots/` | 撮影原本・編集状態・版・編集セッション |
| `.munin/recaptures/` | 再撮影履歴 |
| `.munin/resource-replacements/` | 差し替え前の画像バックアップ |
| `.munin/executions/` | AI文章・Mermaid更新の実行記録 |

これらはプロジェクトに属する。プロジェクト移動時は `.munin` も保持する。APIキーを設定や実行記録へ保存しない。公開出力に `.munin` を含めない。

## 確認範囲

`npm run manual:check-ui` はブラウザー上の操作を検証する。リソース・作画の確認にはローカルAPIとテスト用画像を用いる。Rustテストはファイル保護・履歴・プロセス中断などを検証する。実際のAgy／Codexの画像生成権限とネイティブMarkItsの操作は、それぞれ実環境での確認が必要である。
