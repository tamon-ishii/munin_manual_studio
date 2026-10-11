# Proposal

## Why
実機検査で全文下書きの直接上書き、長い応答待ち、撮影の失敗後のやり直し、画像レビュー非対応の事後通知が操作負担になった。採用前の原稿保護と処理状態・再開地点を明確にする。

## What Changes
- 全文下書きは候補のみ生成し、ページと変更箇所をDiffで選んで反映する。
- AI接続名、段階、経過時間、中断操作を待ち状態でも表示する。
- 撮影の完了済み段階と指示を保持し、失敗した段階から再試行する。
- レビュー開始前に現在の接続の画像入力対応と制限を表示する。

## Capabilities
### New Capabilities
- `ai-draft-review`: 全文下書き候補のページ別Diffと採用前の原稿保護。
### Modified Capabilities
- `document-ai-assistance`: 応答待ち表示と画像入力対応の事前表示。
- `ai-screenshot-authoring`: 完了段階を保持した失敗地点からの再試行。

## Impact
manual-coreの下書き候補・反映APIとレビュー事前確認、manual-studioのDiff・進捗・撮影フロー、回帰検査と操作ガイド。既存CLI draftは互換性のため保持する。
