# Manual Studio

ドキュメント生成専用のデスクトップアプリです。ModuleLoom本体を起動せず、Markdownの編集、撮影、シナリオ、原稿チェックを扱えます。

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

操作手順は [編集ワークフロー](../../docs/manual-studio-editor-workflows.md)、機能の契約は [現行仕様一覧](../../docs/specs/README.md) にまとめています。

配布用アプリは `npm run manual:bundle` で作成します。LinuxでDebianパッケージのみを作る場合は `npm run manual:bundle -- --bundles deb` を実行します。出力はリポジトリの `target/release/bundle/` です。RustとTauriの各OSのビルド依存が必要です。共有の解析ライブラリはアプリに組み込まれます。

ブラウザーで開発するときは `cargo build -p manual-core --bin manualctl` の後に `npm run manual:dev` を実行します。MarkIts連携を試す場合は `npm run manual:build-markits` と `cargo build --manifest-path crates/markits/apps/desktop/src-tauri/Cargo.toml` も実行し、`target/debug` を `PATH` に含めます。ブラウザー版でも実際のプロジェクトを読み書きします。

## 編集・AI支援・画像管理

原稿は通常のMarkdownとして編集し、上段の「保存」またはCtrl/Cmd+Sで保存します。待機やタブ切り替えでは自動保存しません。通常編集とソース編集、Mermaid、プレビュー、文書タブごとのUndo/Redoに対応します。外部変更との競合では編集中の内容を保持します。

「AIレビュー」で文書全体または選択範囲を確認し、「AIで修正・挿入」（選択中は「選択範囲をAIで修正」）で選択範囲の変更やカーソル位置への新規文章挿入を依頼します。変更候補はDiffで採用・見送りを選びます。AIタグ一覧・確定・一括タグ更新は廃止しています。

撮影・撮影アプリ・操作記録・注釈と履歴はMarkItsで管理します。Studioの「撮影」からMarkItsを開き、完成画像を原稿へ取り込みます。既存画像はファイルツリーから扱います。[役割と構成](../../docs/markits-ownership.md)を参照してください。

上部の「AIターミナル」ではCodex・Claude・Agyを選んで起動できます。「作業フォルダ設定」を押すと、ポップアップ内でパスの入力・選択・プロジェクトルートへの復帰ができます。初期値はプロジェクトルートです。接続・切断は1つのボタンで切り替えます。接続時にプロジェクトの`.munin/ai-terminal/`へ専用の案内とMarkItsマニュアルを生成し、初期指示としてAIに読ませます。「対象アプリを起動し、設定画面を撮影して操作箇所に番号を付け、マニュアルを書いて」のように依頼できます。生成結果は「変更を読み直す」で原稿とファイルツリーへ反映します。

同梱ツールは`--studio-tools REQUEST_JSON RESPONSE_JSON`のファイル入出力で、ウィンドウ一覧、実画面の撮影、UIMapの確認、MarkIts sceneによる注釈を提供します。単体MarkIts CLIの追加インストールは不要です。既存の`AGENTS.md`や`CLAUDE.md`は変更しません。CLIの認証とOSの画面撮影・アクセシビリティ権限は各環境で必要です。

読者・目的・操作は原稿操作の「⋯ → 執筆方針」から設定します。文章生成と画像生成の接続は「AI設定」で個別に設定できます。画像生成に文章と同じ接続を使うこともできます。「原稿チェック」ではリンクや画像の問題を確認します。HTML生成は外部連携・CLIから実行します。

## 生成に必要なツール

Markdown編集とネイティブ撮影はアプリ内で動作します。HTML出力にはPython/MkDocs、AI支援には設定したAPI・ローカルLLMまたはAI CLI、WebシナリオにはNode.js/Playwrightが必要です。デスクトップ自動操作は対象アプリがアクセシビリティ情報を公開している必要があります。

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
開発サーバーも自動で起動・終了する場合は `node scripts/smoke_manual_studio.mjs --start-server` を使います。現在のCIではLinuxでこの操作確認を実行します。

`manual:check` のブラウザースモークは開発サーバー上の動作を確認します。撮影権限、ウィンドウ選択、MarkIts Desktopの実際の編集操作を含むネイティブGUI全体は、このチェックでは検証しません。必要に応じて上記のネイティブ統合スモークをデスクトップ環境で実行してください。
実画面で確認する場合は `npm run manual:smoke-native` を実行します。先に `npm run manual:build` と `cargo build -p manual-studio -p manual-core` で `target/debug` のStudioとCLIを準備してください。専用の一時プロジェクトで、実アプリへの引数の受け渡し、操作記録、MarkIts保存・クロップ・再編集・クロップ拡張、原本ハッシュ保持、文書への画像挿入とMkDocs公開を検証します。120秒の期限を設け、テストで起動したプロセスだけを終了します。

PythonのTkinterとMkDocsが必要です。テスト用PythonはLinuxでは `/usr/bin/python3`、Windowsでは `python`、macOSでは `python3` を使用し、`MANUAL_NATIVE_PYTHON` で変更できます。macOSでは画面収録・アクセシビリティ・入力監視の権限を持つ環境で実行してください。Linux/X11ではさらにシステムPythonのGI／Gtk3／AT-SPIを使い、Studioの設定画面から操作記録・撮影一覧・MarkIts再編集・原稿保存・公開までを実画面で通します。この追加GUI確認はLinux限定です。Windows/macOS向けの実行経路を用意していますが、両OSでの成功結果はまだ取得していません。Windowsの巨大表示と倍率別の確認は [表示調査手順](../../docs/investigations/windows-long-ai-display.md) に従って別途実施します。
Linux CIではリリース用 `.deb` を作成して実際にインストールし、インストールした `/usr/bin/manual-studio` で撮影と再起動後の再撮影を確認します。検証済みパッケージはCIの `manual-studio-linux-amd64` アーティファクトから取得できます。
撮影元をAIで自動設定するとき、Manual Studio自身のウィンドウは候補から除外します。Manual Studio自体を撮影する場合は「撮影元を選ぶ」から手動で選択してください。

## 性能とキャッシュ

撮影一覧は撤去し、原稿保存・プロジェクト読み込み時に撮影一覧やサムネイルを取得しません。編集のみ表示中は自動プレビューを保留します。MarkItsの完成画像を取り込んだ場合は原稿と画像プレビューを更新します。

## 構成

- `src/documentPersistence.ts`: 文書保存の直列化と、文書・プロジェクト切り替え後の古い保存結果の除外。
- `src/editorHistory.ts`: DOMに依存しない編集履歴と選択位置。
- `src/fileTree.ts`、`src/paneResizers.ts`: ファイルツリー描画とペイン操作。
- `src/markitsImages.ts`: MarkItsの完成画像の取り込みと、プロジェクト切り替え後の応答の除外。
- `src/imageDialogs.ts`: 画像挿入先と原稿操作で共有するダイアログ。
- `src/manualTransport.ts`、`src/types.ts`: 通信応答の検証と共有データ型。
- `src/main.ts`: 画面イベントと各モジュールの接続。文書・プロジェクト・一覧の読込世代を確認し、古い応答を画面へ反映しません。
- `src-tauri/src/markits_bridge.rs`: MarkItsの起動と完成PNGの取り込み・編集。
- `crates/manual-core`: 原稿、撮影、シナリオ、生成・公開、編集API。
- `crates/analysis-core`: Python解析と依存図の共有エンジン。
- `apps/manual-studio`: 専用UIとTauriホスト。
- `crates/analysis-core`: Python解析と依存図の共有エンジン。

このStandalone projectには、ビルドに必要な共有クレートとMarkItsのソーススナップショットが含まれています。MarkItsの上流情報はルートの `UPSTREAM.md` にあります。

## 仕様と確認

[現行仕様一覧](../../docs/specs/README.md) を仕様の入口とし、[OpenSpec](../../openspec/specs/) に検証可能な要件をまとめています。過去の変更アーカイブは履歴として残します。

`npm run manual:check-generation` は読者レビュー・選択範囲編集・挿入・Diff・画像確認の連携を検証します。AI応答にはローカルのテスト用APIを使用します。選択範囲ツールバーの相談・書き直しとCtrl+F検索は`node scripts/test_manual_studio_selection_actions.mjs`、MarkItsとの画像受け渡しは`node scripts/test_manual_studio_markits_bridge.mjs`で確認します。実際のOS撮影・権限・MarkIts Desktopはネイティブ環境で別途確認してください。

### 編集画面とファイル移動

スクリーンショットとAI操作は上段に配置し、未保存状態は原稿タブの `*` で表示します。Markdownソースへの切替は原稿の操作列にあります。保存失敗時は下部の再試行を利用できます。

ツリーのファイルを右クリックして「移動してリンクを更新」、またはフォルダーへドラッグすると、移動先とリンク変更を確認できます。適用すると関連する相対参照も更新し、元データを `.munin/file-moves/` に保存します。ファイル単位・同一ファイルシステム内の移動に対応します。

撮影操作はキャンセルボタンまたはEscで中止できます。Windowsではポップアップが白い場合にもEscでメイン画面へ戻れます。

対応するMarkdown構文は [GitHub Markdown](../../docs/github-markdown.md) を参照してください。
