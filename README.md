# Munin Manual Studio

AIと連携してマニュアル・ドキュメントを作成するMarkdownエディターです。文章の変更は候補を確認してから反映し、スクリーンショットは原本と撮影手順を保持して更新できます。

<br />

<!-- screenshot:ref id=shot-504cd8b1-b9ac-4197-ac1d-15cbd8f4e15c -->

![スクリーンショット](docs/assets/screenshots/shot-504cd8b1-b9ac-4197-ac1d-15cbd8f4e15c.png)

<!-- /screenshot:ref -->

<br />

## 主な機能

* Markdownの通常編集・ソース編集、Mermaid、プレビュー、自動保存。
* 読者目線のレビューと校正。実画像と説明の整合性も確認し、未確認の画像は区別します。
* 選択範囲へのAI編集とカーソル位置への文章挿入。Diffで変更ごとに採用・見送りを選べます。
* 自然文から対象アプリの登録・実画面の撮影・注釈候補作成。保存した手順による再撮影はAIなしで実行できます。
* リソース一覧で通常画像・撮影画像・AI作画を管理し、確認して文書へ挿入。
* 原稿チェックでリンク・見出し参照・画像の問題を確認。HTML出力は外部連携・CLIから実行。

## クイックスタート

### 前提条件

* **Markdown編集・手動撮影**: アプリ単体で利用でき、Node.js/Rustや外部AI設定は不要です。
* **HTML出力**: Python環境および `mkdocs-material` が必要です（`.venv` 内の実行ファイルを優先探索）。
* **AI機能（レビュー・文書作成・AI撮影）**: 「AI設定」にて外部APIやローカルLLMの設定が必要です。
* **OS固有の権限・要件**:
  * macOS: 画面収録、アクセシビリティの権限許可
  * Linux: WebKitGTK 4.1、GTK 3（操作記録はX11環境）
  * Windows: Microsoft Edge WebView2 Runtime
  * ※ 開発環境から起動する場合は Python 3 が必要です（初回起動時や変更時に自動ビルド）。

### 起動手順

リポジトリルートで以下のコマンドを実行して起動します。

```sh
python3 start_manual_studio.py
```

※ Windows環境では `python start_manual_studio.py`、Linux/macOS環境では `./start-manual-studio.sh` も利用できます。

### 基本操作手順

1. **原稿の準備**: 対象プロジェクトのフォルダーを開き、原稿を選択または新規作成します。
2. **編集**: 原稿を編集します。変更内容は自動保存されるほか、Ctrl/Cmd+S でも手動保存できます。
3. **AI支援の利用（任意）**: 必要に応じて「AI設定」を設定し、「AIレビュー・校正」や「AI文書作成」を実行します。
4. **画像の挿入**: 「リソース一覧」で画像を準備（手動撮影・AI撮影・AI作画・通常画像）し、候補を確認して原稿へ挿入します。
5. **確認**: 「原稿チェック」でリンクや画像を確認します。HTMLの生成・公開は外部連携またはCLIで行います。

文章生成AIと画像生成AIは個別に設定でき、同じ接続を使うこともできます。編集・手動撮影・再撮影・MarkIts編集・公開にAI設定は不要です。

起動・開発・配布については [アプリのREADME](apps/manual-studio/README.md)、操作手順は [編集ワークフロー](docs/manual-studio-editor-workflows.md)、現行仕様は [仕様一覧](docs/specs/README.md) を参照してください。
