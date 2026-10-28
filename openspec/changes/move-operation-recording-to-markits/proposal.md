# Proposal

## Why

操作記録がManual Studioに閉じており、Markits単体では使えない。記録エンジンをMarkitsへ移し、両アプリで同じ記録形式と入力処理を利用する。

## What Changes

- Markitsに対象ウィンドウ選択、操作記録、一時停止、終了、取消、操作履歴とJSON保存を追加する。
- 入力監視、意味的・画像ターゲット、対象ウィンドウ撮影をMarkitsライブラリへ移す。
- Manual Studioは共有エンジンを呼び出し、既存の起動設定、シナリオ生成、画像登録・注釈連携を維持する。
- 記録は動画ではなく、クリック・文字入力・キー・スクロールの操作データとして保存する。

## Capabilities

### New Capabilities

- `operation-recording`: Markits単体および組込み利用で共有する操作記録と保存。

### Modified Capabilities

なし。Manual Studioの既存スクリーンショット要件は維持する。

## Impact

MarkitsサブモジュールのRustライブラリ・デスクトップUI、manual-coreのデスクトップ捕捉モジュール、Manual Studioのrecorderとヘルパー起動に影響する。MarkitsからManual Studioへの逆依存は追加しない。既存JSONシナリオの形式を維持する。
