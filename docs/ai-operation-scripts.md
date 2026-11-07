# AIからMarkItsの操作記録を作る

StudioのAIターミナルから、クリック・文字入力・キー入力・スクロール・待機・撮影をJSONで記述できます。操作はStudioの既存デスクトップ実行エンジンで行い、PNGにはMarkItsの手動記録と同じ `markits:operations` を保存します。MarkItsサブモジュールへの変更は不要です。

## 使い方

通常は「対象アプリケーションの設定」で起動コマンド、引数、ワーキングフォルダ、AIへの補足情報を保存します。引数は1行に1つ、空白を含むパスも引用符なしで入力できます。設定はプロジェクトの`.munin/target-application.json`に保存されます。

「AIで雛形作成」に作成したい内容を入力すると、AIが設定済みアプリを起動し、実画面の観察、手順の検証、操作・撮影、原稿作成まで進めます。利用者は操作計画や対象ウィンドウを選ばず、最後に画像と原稿候補を確認します。操作・起動は実行ログに残り、中断できます。

以下はAIターミナルや内部ツールから利用する場合の説明です。

新しいStudioをビルドして起動し、AIターミナルを開始してください。既存セッションは再開始すると、更新した案内とJSON Schemaを取得できます。AIは `.munin/ai-terminal/guide.md`、`tools.json`、`operation-script.schema.json` を読みます。

AIへの依頼例：

> 起動中の対象アプリの設定手順を説明するマニュアルを作ってください。まず実画面を確認し、操作スクリプトを記述・検証してください。指定した作業の範囲で操作し、各手順を撮影してください。

AIが使用するツール：

| action | 処理 |
| --- | --- |
| `windows` | 対象の現在のID、正確なタイトル、位置・寸法を取得 |
| `capture` / `inspect` | 実画面とUI要素名を観察 |
| `operations-schema` | 操作スクリプトのJSON Schemaを取得 |
| `operations-validate` | 全手順の検証とMarkIts記録への変換。入力は実行しない |
| `operations-run` | 対象を操作して連続撮影。新しいディレクトリに画像と `run.json` を保存 |
| `operations-resume` | checkpointから再開。画面確認後に`retry_failed:true`を指定 |
| `operations-attach` | 入力を実行せず、既存PNGに操作記録を付けた別のPNGを保存 |
| `operations-inspect` | 手動記録を含むPNGから記録のJSONを取得 |

すべて既存の `--studio-tools REQUEST.json RESPONSE.json` のファイルAPIで利用します。実行ファイルの場所は `tools.json` の `executable` にあります。

```json
{
  "root": "PROJECT_ABSOLUTE_PATH",
  "action": "operations-run",
  "window": "WINDOW_ID_FROM_WINDOWS",
  "output": "docs/assets/settings-run-001",
  "script": {
    "version": 1,
    "window": {"title": "EXACT_OBSERVED_TITLE", "bounds": [100, 100, 900, 650]},
    "steps": [
      {"kind": "click", "target": {"role": "button", "name": "設定"}},
      {"kind": "wait", "milliseconds": 500},
      {"kind": "screenshot", "name": "settings"},
      {"kind": "click", "target": {"role": "input", "name": "表示名"}},
      {"kind": "key", "value": "Control+a"},
      {"kind": "text", "value": "サンプル"},
      {"kind": "screenshot", "name": "name-entered"}
    ]
  }
}
```

タイトル、寸法、要素名は例です。`windows` と実画面から取得した値を使用します。座標でクリックする場合は `{"kind":"click","x":120,"y":80}` とし、ウィンドウ左上からの相対ピクセルを指定します。`bounds` は観察時の画面上のx・y・幅・高さです。実行時にウィンドウが移動・拡縮した場合は相対位置を換算します。

## 保存と再利用

- 各PNGには、その撮影地点までの操作を保存します。後の手順が前の画像に混入しません。同じ実行のPNGには共通の操作グループIDを保存します。
- MarkItsでPNGを開き、既存の「再撮影」で操作を再生できます。ウィンドウを再特定する際は、保存したタイトルに一致するウィンドウが一つ必要です。
- 原稿は自動で書き換えません。AIは `captures` の画像を確認して、別途本文へ挿入します。
- 既存の出力ディレクトリ・PNGは上書きしません。失敗時は `run.json` に `ok:false` とエラーを記録し、途中の画像を残します。途中の画像だけで完了と判断しません。

## 現在の範囲

直接実行での撮影はカーソルなしです。カーソル付きの記録は `operations-attach` とMarkIts側の再生で扱えます。任意コマンドやアプリ起動をスクリプトへ埋め込むことはできません。文字入力は現在フォーカスしている入力欄へ行います。

画面到達には`{"kind":"wait_for","target":{"role":"button","name":"保存"},"state":"visible","timeout_ms":10000}`を指定できます。`hidden`は対象が消えるまで、`value`は入力値が`value`文字列に一致するまで待機します。タイムアウト・対象の重複・観察失敗で停止します。固定待機は成功確認にはなりません。

PNGには従来のMarkIts操作記録と、状態確認を含む`markits:operation_script`を保存します。`operations-inspect`の`script_only:true`で後者を取得できます。MarkItsの従来の再生は状態確認を実行しないため、条件付きの再実行にはStudioを使ってください。

## 内部の操作記録と原稿更新

AIが実画面を観察して手順を作り、ホストが検証して実行します。計画と結果は`.munin/operation-runs`に残し、取得済み画像から原稿を作る際には入力を繰り返しません。

内部APIでは実行履歴、画像と本文の対応、停止地点からの再開を保持します。再開は完了した入力を再実行しません。ただし失敗した入力が部分的に反映されている可能性があるため、無条件の自動再試行はしません。

画像差分からの更新APIは、変更画像を参照する原稿だけを候補にします。既存モザイクはAI注釈として保存し、再撮影時にも引き継ぎます。名前付き対象は新しいUIMapで解決します。画面構成が変わった場合は結果画像を確認してください。

500手順以内、待機は1回30秒・合計5分以内です。実行は既存エンジンの中断・時間制限に従いますが、OSやアクセシビリティ呼び出しの内部で停止した処理を強制復旧する仕組みではありません。

## 検証

画像差分のAI更新では、API・ローカルLLMへ変更前後の画像を添付します。CLIには画像パスとUIMapを渡し、対応する場合は読み取り専用で画像を確認します。画像を確認できないCLIはUIMapから確認できる変更に限定し、視覚上の詳細を未確認として扱います。

Rustの単体テストで記録互換性、全手順の事前検証、座標変換、PNG往復・原本保護、停止位置からの再開、中断、画像差分、モザイク保持、関連ページだけの更新候補を検証します。操作実行部分はテスト用runnerへ差し替えています。

`cargo build -p manual-core --bin manualctl` の後、`node scripts/test_manual_studio_operation_script.mjs` で実際のファイルAPIを検証できます。

開発サーバーで`node scripts/test_manual_studio_target_application.mjs`と`node scripts/test_manual_studio_rich_template.mjs`を実行すると、設定の保存・再読込、引数、簡略化した雛形作成、画像と原稿の確認・採用を検証できます。Rustテストでは起動→観察→操作・撮影→原稿候補をテスト用runnerで検証します。実アプリの操作成功を証明するものではありません。

`node scripts/test_manual_studio_operation_script_native.mjs` はテスト用アプリに実際のOS入力を送る検証です。この環境ではWindowsが対象ウィンドウの前面化を拒否し、最初の操作で停止したため、実操作から連続撮影までの完走は未確認です。前面化できるデスクトップセッションでの確認が残っています。
