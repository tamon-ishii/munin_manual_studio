# Proposal

## Why

機能ごとの追加と検査では、入口の重複、結果の扱いの違い、作業途中の状態消失を見落とす。機能を無理に削減せず、利用目的・入口・保存結果・復帰経路を対応付けた全体レビューと、未確認を合格にしない検査運用を構築する。

## What Changes

- 現在の機能を利用目的別の台帳に整理し、複数入口と共通処理、保存契約、検査シナリオを対応付ける。
- 残す・入口統合・処理統合・詳細操作へ移動・廃止検討を区別し、具体的な根拠と未確認点を記録する。機能数の削減目標を設けない。
- 全体の操作経路、失敗・キャンセル・復帰・再起動の確認手順と、ブラウザー/実バックエンド/実OSの証拠を整備する。
- 検査ケースと実画面の操作を照合するゲート、必須ケースの実行結果、意図的な故障による検査有効性確認をチェック運用へ接続する。
- 統合候補ごとのUI変更は、本レビューの結果から個別の仕様変更として切り出す。本変更で一括削除や保存形式変更は行わない。

## Capabilities

### New Capabilities

なし。機能台帳、テスト基盤、検査運用と設計文書を対象とするため `skip_specs: true`。

### Modified Capabilities

なし。既存のユーザー向け保存・採用・撮影・公開要件を維持する。統合案の採用時は対象 capability の変更を別途定義する。

## Impact

対象は docs のレビュー台帳・確認手順、scripts/check_manual_studio.mjs と関連検査、.github/workflows/build.yml。将来の統合対象は main.ts、resourceBrowser.ts、screenshotLibrary.ts、screenshotWorkflow.ts、imageGeneration.ts、selectionAi.ts。既存の resource-library / screenshot-library / manual-authoring の保存契約と矛盾する統合は行わない。現時点では計画のみで、検査基盤の実装・実行済みを意味しない。
