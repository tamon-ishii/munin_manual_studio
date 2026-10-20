# Manual Studio 仕様一覧

このディレクトリは、現在の実装に対応する機能仕様をまとめる。操作手順は [原稿・画像の編集](../manual-studio-editor-workflows.md)、要件と確認シナリオは [OpenSpecの案内](../../openspec/README.md) を参照する。過去の設計案・調査記録・アーカイブは現行仕様と区別する。

## 機能の区分

| 区分 | 仕様 | 扱う内容 | OpenSpec |
| --- | --- | --- | --- |
| 画面・原稿編集 | [画面と操作](manual-studio-ui.md) | ツールバー、表示、設定、保存、キーボード操作 | manual-authoring |
| フォルダー・保存 | [フォルダーと保存先](workspace-storage.md) | 開始位置、原稿ルート、資産の保存先、旧構成との互換 | manual-authoring / screenshot-library |
| 検索・履歴 | [全文検索・置換とGit履歴](manuscript-search-and-git.md) | 選択置換、比較、原稿単位のコミットと復元 | 原稿操作API・変更計画も参照 |
| リソース管理 | [リソース一覧](resource-library.md) | 画像の統合表示、検索、挿入、使用箇所、差し替え | resource-library |
| アプリ登録 | [画面と操作](manual-studio-ui.md) / [撮影管理](screenshot-library.md) | 上部の登録入口、起動パス・作業フォルダ・引数、プロジェクト所有 | [application-launch-settings](../../openspec/specs/application-launch-settings/spec.md) |
| 撮影管理 | [スクリーンショット管理](screenshot-library.md) | 操作記録、原本、注釈、再撮影、候補採用 | screenshot-library |
| AI作画 | [AI画像生成](ai-image-generation.md) | Agy／Codex／API、履歴、修正、比較、中断 | ai-image-generation |
| 文書AI支援 | [レビュー・範囲編集・撮影指示](document-ai-assistance.md) | 読者レビュー、校正、画像整合、Diff採用、新規挿入、撮影指示 | [document-ai-assistance](../../openspec/specs/document-ai-assistance/spec.md) / [ai-screenshot-authoring](../../openspec/specs/ai-screenshot-authoring/spec.md) |
| 原稿作成・公開 | [原稿作成・公開の契約](generation-and-publication.md) | 通常Markdown、旧形式の互換、公開前チェック、ビルド | manual-authoring |

## 共通の境界

「AI文書作成」は選択範囲の変更とカーソル位置への新規挿入を候補確認後に反映する。「AIレビュー・校正」は本文を変更せず指摘を提示する。「AI作画」は独立した画像生成であり、結果を確認して明示的に挿入する。手動撮影・再撮影・MarkIts編集にはAI接続を要求しない。AIへの撮影指示と注釈候補作成は文章生成AIを利用する。リソース一覧はこれらの画像への共通の入口で、撮影専用の版管理は撮影管理の仕様に従う。

原稿から画像参照を消しても画像資産は削除しない。元画像を使ったAI修正と通常画像のMarkIts編集は別の画像を作る。同じ参照先の画像を変更する差し替え・撮影候補の採用は、使用原稿を確認する操作として区別する。

## 文書の役割

| 文書 | 用途 |
| --- | --- |
| `docs/specs/` | 現行実装に対応する機能・保存先・画面の仕様 |
| `openspec/specs/` | 機械検証可能な要件と確認シナリオ |
| `manual_doc/` | 利用者向けの操作手順 |
| `openspec/changes/` | 個別変更の提案・設計・タスク。実装済みや後から撤回した案も含む |
| リリースノート・調査・検証記録 | その時点の結果と制限。現在の画面配置の根拠にはしない |

変更計画の完了チェックだけでは、その画面が現在も存在することを意味しない。例えば見出しアウトラインは後から画面から削除されている。現行の配置は [画面と操作](manual-studio-ui.md)、原稿ルートと保存先は [フォルダーと保存先](workspace-storage.md) を参照する。

## 確認範囲

`npm run manual:check-ui` はブラウザー上の操作を検証する。リソース・作画の確認にはローカルAPIとテスト用画像を用いる。Rustテストはファイル保護・履歴・プロセス中断などを検証する。実際のAgy／Codexの画像生成権限とネイティブMarkItsの操作は、それぞれ実環境での確認が必要である。
