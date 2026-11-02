# StudioとMarkItsの役割

撮影、撮影対象アプリ、操作記録、UI探索、再撮影、注釈と編集履歴はMarkItsが管理する。Studioは完成した画像をプロジェクトへ取り込み、原稿への挿入・参照の差し替え・表示設定を担当する。

## 現在の経路

`main.ts` → `markitsImages.ts` → Tauriの`markits_bridge.rs` → MarkIts

`markitsImages.ts`は撮影一覧のDOMや登録アプリ、AI撮影APIに依存しない。完成画像の取り込み後にプレビューを更新し、開始時とプロジェクトが違う場合は結果を原稿へ返さない。原稿への適用時には元の文書と内容も照合する。

完成PNGは`markits_bridge.rs`がプロジェクトの画像保存先へ取り込む。PNG内のMarkIts編集情報を保持するため、画像に付随する撮影原本・注釈・履歴の管理ファイルをStudio側で新たに作成しない。既存画像はファイルツリーから開く、または原稿へドラッグして挿入する。

## 撤去した構成

- 撮影一覧ドック、一覧の検索・取り込み・更新処理、非表示一覧のバックグラウンド取得。
- StudioのAI撮影画面と`screenshot-ai-*` API。
- 撮影アプリの登録・共通設定取り込み・起動確認・アプリ選択コマンド。
- `.munin/launch_commands.json`の自動読み込み・移行・書き込み。
- `.munin/capture-settings.json`とUI探索設定API。通常の原稿操作時にも読み込んでいた依存を解消。
- 使用されていない`captureSession.ts`、撮影一覧専用の`screenshotLibrary.ts`と`resourceBrowser.ts`。

共有ダイアログは撮影専用ではないため、`screenshotWorkflow.ts`から`imageDialogs.ts`へ移した。原稿編集、AI作画、文書検索などから共通利用する。

## 既存データとCLI

既存プロジェクトのPNG、設定JSON、旧撮影履歴は自動削除しない。原稿に埋め込まれた旧画像参照と公開処理の互換性に必要な`manual-core`の`screenshots`、`resources`、`capture_source`および旧シナリオ系CLIは残る。これらはStudioの撮影管理画面や新しいMarkIts取り込み経路から切り離されている。CLI廃止と旧データの移行・削除は別の変更として扱う。

## エディタの操作

ファイルツリーの検索はCtrl+F（macOSはCmd+F）で開き、Escで条件を解除して閉じる。

リッチエディタの選択範囲ツールバーの「AI操作」は、書き直し候補の作成を標準とする。指示を入力し、差分を確認して選択した変更を適用する。「書き直し方針を相談」を選ぶと、回答を見てから追加指示を付けて同じ選択範囲の書き直しへ進める。AIの応答前に原稿やプロジェクトが切り替わった場合は適用しない。

「起動済みアプリのスクリーンショットを含める」を選んだ場合は、AIが既存ウィンドウから撮影対象を選び、Studioの同梱MarkItsツールが別プロセスで撮影する。AIは撮影後のUIMapから注釈と本文を返し、StudioがMarkItsで完成PNGを描画して候補のMarkdownに含める。AIのヘッドレスCLIにはシェル実行を要求しない。原稿は差分確認まで変更せず、画像は既存の画像保存先に保存する。未起動アプリの起動や画面遷移が必要な場合はAIターミナルを利用する。

相談先のコンボボックスでCodex・Claude・Agyを選べる。AI設定の「相談先AIごとの設定」で各CLIのモデルを個別に設定し、既存の`manual_setting.json`の`cli_models`に保存する。相談から書き直しへ進んでも選んだAIを引き継ぐ。既定のAPI・ローカルLLM接続も引き続き選択できる。

文書生成・モデル確認・画像生成とその機能確認は、開いているプロジェクトフォルダを作業フォルダにする。AIターミナルも初期値はプロジェクトルートで、接続前に別の既存フォルダへ変更できる。原稿保存先のプロジェクトとCLIの作業フォルダは別々に管理し、MarkItsの事前案内は絶対パスで渡す。Windowsのnpm版Codexは、改行を含む指示を渡せるよう`codex.cmd`を介さずNodeでJSエントリーポイントを実行する。

## 検証

- `node scripts/test_manual_studio_markits_bridge.mjs`: MarkIts取り込み・編集・取消・失敗・プロジェクト切り替え。
- `node scripts/test_manual_studio_selection_actions.mjs`: 検索の開閉、撮影UIと一覧取得の撤去、選択範囲の相談と書き直し。
- `node scripts/test_manual_studio_selection_capture_native.mjs`: テスト用の実ブラウザー画面を開き、実撮影・UIMap・MarkItsの枠と番号・画像リンク付き本文候補・原稿保持を確認する。AI応答はローカルのテスト用HTTPサーバーを使う。
