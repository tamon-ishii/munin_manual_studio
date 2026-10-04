# Manual Studio

ドキュメント生成専用のデスクトップアプリです。ModuleLoom本体を起動せず、Markdownの編集、撮影、UI Map、シナリオ、HTML公開を扱えます。

## 配布版

GitHub ReleasesのZIPを展開して起動します。補助実行ファイルは移動せず、配布時の配置を保持してください。

| OS | 起動するファイル | 実行時の要件 |
| --- | --- | --- |
| Windows x64 | `manual-studio.exe` | Microsoft Edge WebView2 Runtime |
| macOS Intel / Apple Silicon | `Munin Manual Studio.app` | 撮影には画面収録、操作記録・ウィンドウ操作にはアクセシビリティの許可 |
| Linux x64 | `manual-studio` | WebKitGTK 4.1、GTK 3。操作記録はX11セッションで利用 |

macOS版はアドホック署名した `.app` で、開発者証明書による署名・公証はしていません。起動時にOSに拒否された場合は、システム設定の「プライバシーとセキュリティ」から起動を許可してください。撮影対象アプリには `.app` または実行ファイルを指定できます。

Markdown編集と撮影にはNode.jsやRust、ModuleLoom本体は不要です。HTML生成やAI生成には、下記の外部ツールが必要です。MkDocsはプロジェクトの `.venv/Scripts/mkdocs.exe`（Windows）または `.venv/bin/mkdocs`（Linux/macOS）を優先して探索します。

各OSのCIでビルドとRustテストを実行します。画面撮影・操作記録・高DPI・権限ダイアログのGUI動作は実機での確認が必要です。

## 開発環境から起動

スタンドアロンプロジェクトのルートで実行します。

```sh
python3 start_manual_studio.py
```

初回とソース変更後は自動でビルドします。強制的にビルドする場合は `python3 start_manual_studio.py --build`、開発モードは `python3 start_manual_studio.py --dev` を使います。Windowsでは `python start_manual_studio.py` を実行してください。Linux/macOS用の `./start-manual-studio.sh` も利用できます。両ランチャーはManual StudioとMarkItsのフロントエンド、`manualctl`、MarkIts Desktopを準備します。

左側のファイルツリーは上部で選んだフォルダーを起点に表示します。`target` や `node_modules` などの生成フォルダーは省きます。`docs` は原稿フォルダーの既定値で、ツリーの探索範囲を制限しません。ツリー内の Markdown ファイルを選ぶと編集できます。各 Markdown ファイルの「AI」ボタン、編集画面の「この文書をAI出力」、またはファイルツリー上の「すべての文書をAI出力」から、文章・図の生成と撮影指示を実行できます。文章の指示が複数ある場合も、文書単位でまとめて1回のAI CLI呼び出しで生成します。撮影元が未設定なら文書の撮影指示を使って自動設定し、登録済みなら同じ撮影元で撮り直します。実行前に原稿を保存してください。

配布用アプリは `npm run manual:bundle` で作成します。LinuxでDebianパッケージのみを作る場合は `npm run manual:bundle -- --bundles deb` を実行します。出力はリポジトリの `target/release/bundle/` です。RustとTauriの各OSのビルド依存が必要です。共有の解析ライブラリはアプリに組み込まれます。

ブラウザーで開発するときは `cargo build -p manual-core --bin manualctl` の後に `npm run manual:dev` を実行します。MarkIts連携を試す場合は `npm run manual:build-markits` と `cargo build --manifest-path crates/markits/apps/desktop/src-tauri/Cargo.toml` も実行し、`target/debug` を `PATH` に含めます。ブラウザー版でも実際のプロジェクトを読み書きします。

## 最初にすること

1. 対象プロジェクトのフォルダーを開きます。
2. 左側から原稿を選ぶか、＋でページを作ります。
3. Markdownを編集し、右側のプレビューを確認して保存します。Ctrl/Cmd+Sでも保存できます。

エディター上部の書式ツールバーから、見出し、太字、斜体、リンク、画像、リスト、引用、コード、表、区切り線を挿入できます。画像ボタンでは画像ファイルを選び、保存先と代替テキストを確認して原稿に挿入します。「撮影の指示」ではダイアログで指示ID、撮影対象、画面の状態、クリック・入力・選択などの撮影前操作、補足を指定してから原稿に追加します。AI指示は「AI文章の指示」「撮影の指示」「依存図の指示」から追加します。文字を選択してから太字・斜体・リンクを押すと選択範囲に適用されます。太字・斜体・リンクは Ctrl/Cmd+B・I・K でも使えます。
カーソルが `ai:generated` ブロック内にあるときは「確定」で保護印を付けられます。確定済みの文章・図は保存後の文書単位AI出力で更新されず、「確定解除」で再び更新対象になります。どちらの操作も Undo で戻せます。「生成結果を削除」ではブロック全体を削除できます。
Undo / Redo ボタンで原稿の入力とツールバーによる編集を戻したりやり直したりできます。Ctrl/Cmd+Z、Ctrl+Y、Ctrl/Cmd+Shift+Z も使えます。履歴は原稿を開き直すとリセットされます。
4. 必要なら「撮影の指示」「AI文章の指示」「依存図の指示」を原稿に追加して保存します。
5. 「画像・文章・図」で各指示を実行し、「生成・公開」で下書きビルドを確認します。
AI 出力中は実行ログウィンドウに経過時間、現在の段階、CLI が出力したイベントを表示します。閉じた後も「AI実行ログを表示」から開き直せます。完了後も次の実行までログを確認できます。

「別ウィンドウで編集」で原稿ごとの編集ウィンドウを開けます。外部エディタや別ウィンドウで変更された原稿は上書きせずエラーにします。編集中の内容をコピーしてから「読み直す」で最新の原稿を開いてください。

編集プレビューは通常のMarkdown用です。MermaidやMkDocs独自の表示はHTMLビルドで確認します。

## スクリーンショットの更新

初回だけ対象ウィンドウと除外する余白を指定して撮影します。以後は「同じ撮影元で更新」で再撮影できます。ウィンドウの識別にはタイトルを使い、再起動後の一時的なウィンドウIDは保存しません。同じタイトルの候補が複数ある場合は選び直してください。

画面を開く操作も繰り返したい場合は「撮影手順」でシナリオを保存し、対象画像の撮影手順に設定します。撮影元はプロジェクトの `manual/capture_sources.json` に保存されます。

WaylandではOSの撮影ダイアログで毎回選択が必要です。macOSでは画面収録の権限が必要です。

## UI Mapの使い方

UI Mapは画面名、ボタンや入力欄、操作対象のセレクターを一覧にした情報です。原稿の説明や撮影手順を作るときに参照します。

- 自分のHTML/TypeScriptアプリ: 「ソースから更新」で一覧を作ります。
- 起動中のWebアプリ: URLを指定して「Web画面を観測」で表示中の要素を補います。Playwrightとブラウザーが必要です。
- 外部アプリ: 観測JSONを取り込むか、デスクトップの「操作対象を調べる」でアクセシビリティ情報を確認し、撮影手順を作ります。

UI Mapだけではクリックや撮影は実行されません。手順の実行は「撮影手順」で行います。保存先は `manual/ui_map.json` です。

## 生成に必要なツール

Markdown編集とネイティブ撮影はアプリ内で動作します。HTML出力にはPython/MkDocs、AI生成には選択したAI CLI、WebシナリオにはNode.js/Playwrightが必要です。デスクトップ自動操作は対象アプリがアクセシビリティ情報を公開している必要があります。

HTML生成には `mkdocs-material` をインストールしてください。プロジェクトごとの環境を使う例:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install mkdocs-material
```

Windowsでは `.venv\Scripts\python -m pip install mkdocs-material` を実行し、その環境を有効にしてアプリを起動します。MkDocsが見つからない場合は、ビルド結果にHTML生成をスキップしたことが表示されます。

## 開発時の動作確認

`cargo test -p manual-core --offline`、`cargo test --manifest-path apps/manual-studio/src-tauri/Cargo.toml --offline`、`npm run manual:build`、`npm run manual:test-workflow` で共有エンジン、Tauri側の撮影処理、UI、MarkItsタグ追加の再試行を確認します。
まとめて順番に実行する場合は `npm run manual:check` を使います。各段階の開始・終了、実行時間、終了コードを表示し、一定時間を超えた処理は終了して後続を止めます。エディター履歴、ファイルツリー描画、Markdownタグ、MarkItsワークフロー、トランスポートのコールバック、撮影セッションの状態管理、ネイティブ呼び出しを置き換えた撮影UI回帰、フロントエンドのビルド、ブラウザーのスモーク確認、Tauri Rustテスト、`manual-core`テストを順に実行します。撮影UIのテストはMarkIts Desktop実機の起動・編集操作までは行いません。
`cargo build -p manual-core --bin manualctl` の後に `npm run manual:dev` を起動し、別のターミナルで `node scripts/smoke_manual_studio.mjs` を実行すると、Chromeで編集・プレビュー・保存・別ウィンドウの保存競合・空のプロジェクトへの切り替え・ページ作成・保存したWebシナリオからの再撮影を確認できます。
MkDocsがあればHTML出力まで、なければスキップ表示を確認します。検証用プロジェクトは一時フォルダーに作成して終了時に削除します。Google ChromeとNode.jsが必要です。
開発サーバーも自動で起動・終了する場合は `node scripts/smoke_manual_studio.mjs --start-server` を使います。CIではLinux・Windows・macOSでこの操作確認を実行します。

`manual:check` のブラウザースモークは開発サーバー上の動作を確認します。撮影権限、ウィンドウ選択、MarkIts Desktopの実際の編集操作を含むネイティブGUI全体は、このチェックでは検証しません。必要に応じて上記のネイティブ統合スモークをデスクトップ環境で実行してください。
Linux/X11でMarkItsの返却処理を実機確認する場合は `node scripts/smoke_manual_markits_native.mjs` を実行します。`target/debug/manualctl` と `target/debug/markits-desktop` を使い、専用の一時画像を編集画面へ読み込ませて「編集終了」を押し、完了マーカー、注釈の座標、UI情報を検証します。30秒の期限を設け、テストで起動したプロセスだけを終了します。原稿への挿入・再試行・キャンセルは `manual:check` の撮影UI試験で別途確認します。
Linux CIではリリース用 `.deb` を作成して実際にインストールし、インストールした `/usr/bin/manual-studio` で撮影と再起動後の再撮影を確認します。検証済みパッケージはCIの `manual-studio-linux-amd64` アーティファクトから取得できます。
撮影元をAIで自動設定するとき、Manual Studio自身のウィンドウは候補から除外します。Manual Studio自体を撮影する場合は「撮影元を選ぶ」から手動で選択してください。

## 構成

- `src/editorHistory.ts`: DOMに依存しない編集履歴と選択位置。
- `src/fileTree.ts`、`src/paneResizers.ts`: ファイルツリー描画とペイン操作。
- `src/captureSession.ts`、`src/markitsWorkflow.ts`: 撮影対象の固定、キャンセル、画像取り込みと保存順序。
- `src/manualTransport.ts`、`src/types.ts`: 通信応答の検証と共有データ型。
- `src/main.ts`: 画面イベントと各モジュールの接続。文書・プロジェクト・一覧の読込世代を確認し、古い応答を画面へ反映しません。
- `src-tauri/src/recorder.rs`: 起動アプリと記録プロセスの所有権、撮影、MarkItsとのファイル受け渡し。
- `crates/manual-core/src/capture_lifecycle.rs`: 撮影直前の準備。Tauriはこのタイミングで画面を隠し、文章生成中には実行ログを表示できます。
- `crates/manual-core`: 原稿、撮影、シナリオ、UI Map、生成・公開、編集API。
- `crates/analysis-core`: Python解析と依存図の共有エンジン。
- `apps/manual-studio`: 専用UIとTauriホスト。
- `crates/analysis-core`: Python解析と依存図の共有エンジン。

このStandalone projectには、ビルドに必要な共有クレートとMarkItsのソーススナップショットが含まれています。MarkItsの上流情報はルートの `UPSTREAM.md` にあります。
