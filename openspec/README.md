# OpenSpecの読み方

現行機能の入口は [仕様一覧](../docs/specs/README.md)。このディレクトリの `specs/` は要件と確認シナリオ、`changes/` は変更ごとの提案・設計・タスクを保持する。

## 現行要件

| 仕様 | 範囲 |
| --- | --- |
| [manual-authoring](specs/manual-authoring/spec.md) | 原稿編集、保存、画面、原稿ルート、フォルダー選択 |
| [application-launch-settings](specs/application-launch-settings/spec.md) | 撮影するアプリの登録とプロジェクト所有 |
| [screenshot-library](specs/screenshot-library/spec.md) | 原本・候補・再撮影・MarkIts復帰と挿入 |
| [resource-library](specs/resource-library/spec.md) | 画像の統合一覧、使用箇所、差し替え |
| [document-ai-assistance](specs/document-ai-assistance/spec.md) | 原稿レビューと範囲編集 |
| [ai-screenshot-authoring](specs/ai-screenshot-authoring/spec.md) | AIへの撮影指示 |
| [ai-image-generation](specs/ai-image-generation/spec.md) | AI作画と履歴 |

## 未アーカイブの変更計画

- `add-git-search-and-outline`: 検索・Git・見出し整理の導入記録。見出しアウトラインの画面は後から削除された。現行のUIと残存APIは [検索・Git仕様](../docs/specs/manuscript-search-and-git.md) に従う。
- `add-reader-review-and-selection-edit`: レビューと範囲編集の計画。現行要件は `specs/document-ai-assistance/` と画面仕様を参照する。
- `improve-ai-operation-usability`: AI操作の改善計画。一部の追加要件は主仕様と重複しており、そのままのアーカイブはできない。整理時には差分の再照合が必要である。

タスクの完了チェックは実施記録であり、現在も同じ画面があることの保証ではない。今回の仕様整理では計画の完了・アーカイブ状態を変更していない。`changes/archive/` とリリース時の調査・検証記録は履歴として保持する。

## 検証

`openspec validate --all --strict` で現行要件と変更計画を検証する。構文上の成功は、未アーカイブの差分が重複なく主仕様へ統合できることや、各OSの実機操作が検証済みであることを意味しない。
