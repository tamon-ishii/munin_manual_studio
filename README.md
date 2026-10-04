# Munin Manual Studio

Munin Manual StudioはAIとの連携を目指したマークダウンエディタです。

- AIにマニュアルを書かせたいけど、書き直してほしくない場所まで書き換えてしまう
- スクリーンショットを自動で更新してほしい
- APIドキュメントをもっと楽に作りたい

これらの困ったを解決します。

![image-20261005-081514](assets/image-20261005-081514.png)

<!-- ai:task id=task-readme-text-1 kind=text
Readme.mdの続きを書いてください
-->

<!-- ai:generated id=task-readme-text-1 kind=text created-at=2026-10-04T21:56:03Z source-sha256=938a82de0415bd7b2fcfbd4db453a3b272fc43010c721de3a0c810e0c9cad659 prompt-b64=UmVhZG1lLm1k44Gu57aa44GN44KS5pu444GE44Gm44GP44Gg44GV44GE -->
## 主な機能

- **Markdownエディタとリアルタイムプレビュー**: 入力中のプレビュー表示やスクロール同期に対応し、書式ツールバーや元に戻す（Undo）・やり直す（Redo）操作を備えています。<!-- ai:fact {"claim":"書式ツールバーにUndoやRedo、各種書式ボタンが用意されている","file":"apps/manual-studio/index.html","contains":"<button type=\"button\" id=\"undo-edit\" title=\"元に戻す (Ctrl/Cmd+Z)\" aria-label=\"元に戻す\" disabled>↶ Undo</button>"} -->
- **AI指示（AIタグ）による部分生成と保護**: 原稿内に「AI文章の指示」「撮影の指示」「依存図の指示」を挿入でき、確定した生成結果を保護しながら対象箇所のみを安全に更新できます。<!-- ai:fact {"claim":"AI指示の追加メニューにAI文章・撮影・依存図の指示がある","file":"apps/manual-studio/index.html","contains":"<button type=\"button\" data-insert=\"text\">AI文章の指示</button><button type=\"button\" data-insert=\"screenshot\">撮影の指示</button><button type=\"button\" data-insert=\"diagram\">依存図の指示</button>"} -->
- **アプリ操作の記録とスクリーンショット更新**: アプリ起動コマンドと操作手順を記録し、MarkItsと連携して注釈付けや再撮影を効率化します。<!-- ai:fact {"claim":"撮影AIタグダイアログでアプリ起動と操作記録、MarkItsでの注釈に対応している","file":"apps/manual-studio/index.html","contains":"<h2>アプリを操作して撮影AIタグを作成</h2>"} -->
- **画面一覧（UI Map）の管理**: ソースコードからの解析やWeb画面の探索、デスクトップ観測JSONの取り込みにより、マニュアル作成に必要なUI要素を可視化・整理します。<!-- ai:fact {"claim":"UI Mapパネルでコードからの画面一覧作成やWeb探索、観測JSON取り込みを扱える","file":"apps/manual-studio/index.html","contains":"<button id=\"map-refresh\" class=\"primary\">コードから画面一覧を作る</button>"} -->
- **下書き生成とHTMLマニュアル公開**: AIエージェント（Codex、Claude Code、Grok Build、Agy）を利用した原稿下書きの作成や、MkDocs Materialを利用したマニュアルのビルド・公開に対応しています。<!-- ai:fact {"claim":"AI設定・出力パネルでAIエージェントの選択や下書き・完成版ビルドが行える","file":"apps/manual-studio/index.html","contains":"<select id=\"ai-agent\"><option value=\"codex\">Codex</option><option value=\"claude\">Claude Code</option><option value=\"grok\">Grok Build</option><option value=\"agy\">Agy</option></select>"} -->

## クイックスタート

開発環境から起動する場合は以下のスクリプトを実行します。

```sh
python3 start_manual_studio.py
```
<!-- ai:fact {"claim":"開発環境からの起動コマンドは python3 start_manual_studio.py","file":"apps/manual-studio/README.md","contains":"python3 start_manual_studio.py"} -->

1. ワークスペースとして対象プロジェクトのフォルダーを開きます。
2. 左側のファイルツリーから原稿ファイルを選択するか、「＋ MD」ボタンで新しいページを作成します。
3. 原稿を編集し、「この文書のAIタグを更新」または「すべての文書をAI出力」からAI生成や撮影指示を実行します。<!-- ai:fact {"claim":"文書単位の更新ボタン名は「この文書のAIタグを更新」、全体実行ボタン名は「すべての文書をAI出力」","file":"apps/manual-studio/index.html","contains":"<button id=\"generate-page\" title=\"この文書のAI指示を実行し、文章・図・撮影結果を更新\">この文書のAIタグを更新</button>"} -->
4. 必要に応じて「下書きビルド」や「完成版ビルド」を実行してHTMLマニュアルを確認します。<!-- ai:fact {"claim":"下書きビルドと完成版ビルドのボタンがある","file":"apps/manual-studio/index.html","contains":"<button id=\"build-draft\" class=\"primary\">下書きビルド</button><button id=\"build-final\">完成版ビルド</button>"} -->
<!-- /ai:generated -->

<!-- ai:generated id=task-readme-text-1 kind=text created-at=2026-10-04T21:52:43Z source-sha256=938a82de0415bd7b2fcfbd4db453a3b272fc43010c721de3a0c810e0c9cad659 prompt-b64=UmVhZG1lLm1k44Gu57aa44GN44KS5pu444GE44Gm44GP44Gg44GV44GE -->
## 主な機能

- **Markdownエディタとリアルタイムプレビュー**: 入力中のプレビュー表示やスクロール同期に対応し、書式ツールバーや元に戻す（Undo）・やり直す（Redo）操作を備えています。<!-- ai:fact {"claim":"書式ツールバーにUndoやRedo、各種書式ボタンが用意されている","file":"apps/manual-studio/index.html","contains":"<button type=\"button\" id=\"undo-edit\" title=\"元に戻す (Ctrl/Cmd+Z)\" aria-label=\"元に戻す\" disabled>↶ Undo</button>"} -->
- **AI指示（AIタグ）による部分生成と保護**: 原稿内に「AI文章の指示」「撮影の指示」「依存図の指示」を挿入でき、確定した生成結果を保護しながら対象箇所のみを安全に更新できます。<!-- ai:fact {"claim":"AI指示の追加メニューにAI文章・撮影・依存図の指示がある","file":"apps/manual-studio/index.html","contains":"<button type=\"button\" data-insert=\"text\">AI文章の指示</button><button type=\"button\" data-insert=\"screenshot\">撮影の指示</button><button type=\"button\" data-insert=\"diagram\">依存図の指示</button>"} -->
- **アプリ操作の記録とスクリーンショット更新**: アプリ起動コマンドと操作手順を記録し、MarkItsと連携して注釈付けや再撮影を効率化します。<!-- ai:fact {"claim":"撮影AIタグダイアログでアプリ起動と操作記録、MarkItsでの注釈に対応している","file":"apps/manual-studio/index.html","contains":"<h2>アプリを操作して撮影AIタグを作成</h2>"} -->
- **画面一覧（UI Map）の管理**: ソースコードからの解析やWeb画面の探索、デスクトップ観測JSONの取り込みにより、マニュアル作成に必要なUI要素を可視化・整理します。<!-- ai:fact {"claim":"UI Mapパネルでコードからの画面一覧作成やWeb探索、観測JSON取り込みを扱える","file":"apps/manual-studio/index.html","contains":"<button id=\"map-refresh\" class=\"primary\">コードから画面一覧を作る</button>"} -->
- **下書き生成とHTMLマニュアル公開**: AIエージェント（Codex、Claude Code、Grok Build、Agy）を利用した原稿下書きの作成や、MkDocs Materialを利用したマニュアルのビルド・公開に対応しています。<!-- ai:fact {"claim":"AI設定・出力パネルでAIエージェントの選択や下書き・完成版ビルドが行える","file":"apps/manual-studio/index.html","contains":"<select id=\"ai-agent\"><option value=\"codex\">Codex</option><option value=\"claude\">Claude Code</option><option value=\"grok\">Grok Build</option><option value=\"agy\">Agy</option></select>"} -->

## クイックスタート

開発環境から起動する場合は以下のスクリプトを実行します。

```sh
python3 start_manual_studio.py
```
<!-- ai:fact {"claim":"開発環境からの起動コマンドは python3 start_manual_studio.py","file":"apps/manual-studio/README.md","contains":"python3 start_manual_studio.py"} -->

1. ワークスペースとして対象プロジェクトのフォルダーを開きます。
2. 左側のファイルツリーから原稿ファイルを選択するか、「＋ MD」ボタンで新しいページを作成します。
3. 原稿を編集し、「この文書のAIタグを更新」または「すべての文書をAI出力」からAI生成や撮影指示を実行します。<!-- ai:fact {"claim":"文書単位の更新ボタン名は「この文書のAIタグを更新」、全体実行ボタン名は「すべての文書をAI出力」","file":"apps/manual-studio/index.html","contains":"<button id=\"generate-page\" title=\"この文書のAI指示を実行し、文章・図・撮影結果を更新\">この文書のAIタグを更新</button>"} -->
4. 必要に応じて「下書きビルド」や「完成版ビルド」を実行してHTMLマニュアルを確認します。<!-- ai:fact {"claim":"下書きビルドと完成版ビルドのボタンがある","file":"apps/manual-studio/index.html","contains":"<button id=\"build-draft\" class=\"primary\">下書きビルド</button><button id=\"build-final\">完成版ビルド</button>"} -->
<!-- /ai:generated -->

<!-- ai:generated id=task-readme-text-1 kind=text created-at=2026-10-04T21:20:58Z source-sha256=938a82de0415bd7b2fcfbd4db453a3b272fc43010c721de3a0c810e0c9cad659 prompt-b64=UmVhZG1lLm1k44Gu57aa44GN44KS5pu444GE44Gm44GP44Gg44GV44GE -->
## 主な機能

- **Markdownエディタとリアルタイムプレビュー**: 入力中のプレビュー表示やスクロール同期に対応し、書式ツールバーや元に戻す（Undo）・やり直す（Redo）操作を備えています。<!-- ai:fact {"claim":"書式ツールバーにUndoやRedo、各種書式ボタンが用意されている","file":"apps/manual-studio/index.html","contains":"<button type=\"button\" id=\"undo-edit\" title=\"元に戻す (Ctrl/Cmd+Z)\" aria-label=\"元に戻す\" disabled>↶ Undo</button>"} -->
- **AI指示（AIタグ）による部分生成と保護**: 原稿内に「AI文章の指示」「撮影の指示」「依存図の指示」を挿入でき、確定した生成結果を保護しながら対象箇所のみを安全に更新できます。<!-- ai:fact {"claim":"AI指示の追加メニューにAI文章・撮影・依存図の指示がある","file":"apps/manual-studio/index.html","contains":"<button type=\"button\" data-insert=\"text\">AI文章の指示</button><button type=\"button\" data-insert=\"screenshot\">撮影の指示</button><button type=\"button\" data-insert=\"diagram\">依存図の指示</button>"} -->
- **アプリ操作の記録とスクリーンショット更新**: アプリ起動コマンドと操作手順を記録し、MarkItsと連携して注釈付けや再撮影を効率化します。<!-- ai:fact {"claim":"撮影AIタグダイアログでアプリ起動と操作記録、MarkItsでの注釈に対応している","file":"apps/manual-studio/index.html","contains":"<h2>アプリを操作して撮影AIタグを作成</h2>"} -->
- **画面一覧（UI Map）の管理**: ソースコードからの解析やWeb画面の探索、デスクトップ観測JSONの取り込みにより、マニュアル作成に必要なUI要素を可視化・整理します。<!-- ai:fact {"claim":"UI Mapパネルでコードからの画面一覧作成やWeb探索、観測JSON取り込みを扱える","file":"apps/manual-studio/index.html","contains":"<button id=\"map-refresh\" class=\"primary\">コードから画面一覧を作る</button>"} -->
- **下書き生成とHTMLマニュアル公開**: AIエージェント（Codex、Claude Code、Grok Build、Agy）を利用した原稿下書きの作成や、MkDocs Materialを利用したマニュアルのビルド・公開に対応しています。<!-- ai:fact {"claim":"AI設定・出力パネルでAIエージェントの選択や下書き・完成版ビルドが行える","file":"apps/manual-studio/index.html","contains":"<select id=\"ai-agent\"><option value=\"codex\">Codex</option><option value=\"claude\">Claude Code</option><option value=\"grok\">Grok Build</option><option value=\"agy\">Agy</option></select>"} -->

## クイックスタート

開発環境から起動する場合は以下のスクリプトを実行します。

```sh
python3 start_manual_studio.py
```
<!-- ai:fact {"claim":"開発環境からの起動コマンドは python3 start_manual_studio.py","file":"apps/manual-studio/README.md","contains":"python3 start_manual_studio.py"} -->

1. ワークスペースとして対象プロジェクトのフォルダーを開きます。
2. 左側のファイルツリーから原稿ファイルを選択するか、「＋ MD」ボタンで新しいページを作成します。
3. 原稿を編集し、「この文書のAIタグを更新」または「すべての文書をAI出力」からAI生成や撮影指示を実行します。<!-- ai:fact {"claim":"文書単位の更新ボタン名は「この文書のAIタグを更新」、全体実行ボタン名は「すべての文書をAI出力」","file":"apps/manual-studio/index.html","contains":"<button id=\"generate-page\" title=\"この文書のAI指示を実行し、文章・図・撮影結果を更新\">この文書のAIタグを更新</button>"} -->
4. 必要に応じて「下書きビルド」や「完成版ビルド」を実行してHTMLマニュアルを確認します。<!-- ai:fact {"claim":"下書きビルドと完成版ビルドのボタンがある","file":"apps/manual-studio/index.html","contains":"<button id=\"build-draft\" class=\"primary\">下書きビルド</button><button id=\"build-final\">完成版ビルド</button>"} -->
<!-- /ai:generated -->

<!-- ai:generated id=task-readme-text-1 kind=text created-at=2026-10-04T13:10:51Z source-sha256=938a82de0415bd7b2fcfbd4db453a3b272fc43010c721de3a0c810e0c9cad659 prompt-b64=UmVhZG1lLm1k44Gu57aa44GN44KS5pu444GE44Gm44GP44Gg44GV44GE -->
## 主な機能

- **Markdownエディタとリアルタイムプレビュー**: 入力中のプレビュー表示やスクロール同期に対応し、書式ツールバーや元に戻す（Undo）・やり直す（Redo）操作を備えています。<!-- ai:fact {"claim":"書式ツールバーにUndoやRedo、各種書式ボタンが用意されている","file":"apps/manual-studio/index.html","contains":"<button type=\"button\" id=\"undo-edit\" title=\"元に戻す (Ctrl/Cmd+Z)\" aria-label=\"元に戻す\" disabled>↶ Undo</button>"} -->
- **AI指示（AIタグ）による部分生成と保護**: 原稿内に「AI文章の指示」「撮影の指示」「依存図の指示」を挿入でき、確定した生成結果を保護しながら対象箇所のみを安全に更新できます。<!-- ai:fact {"claim":"AI指示の追加メニューにAI文章・撮影・依存図の指示がある","file":"apps/manual-studio/index.html","contains":"<button type=\"button\" data-insert=\"text\">AI文章の指示</button><button type=\"button\" data-insert=\"screenshot\">撮影の指示</button><button type=\"button\" data-insert=\"diagram\">依存図の指示</button>"} -->
- **アプリ操作の記録とスクリーンショット更新**: アプリ起動コマンドと操作手順を記録し、MarkItsと連携して注釈付けや再撮影を効率化します。<!-- ai:fact {"claim":"撮影AIタグダイアログでアプリ起動と操作記録、MarkItsでの注釈に対応している","file":"apps/manual-studio/index.html","contains":"<h2>アプリを操作して撮影AIタグを作成</h2>"} -->
- **画面一覧（UI Map）の管理**: ソースコードからの解析やWeb画面の探索、デスクトップ観測JSONの取り込みにより、マニュアル作成に必要なUI要素を可視化・整理します。<!-- ai:fact {"claim":"UI Mapパネルでコードからの画面一覧作成やWeb探索、観測JSON取り込みを扱える","file":"apps/manual-studio/index.html","contains":"<button id=\"map-refresh\" class=\"primary\">コードから画面一覧を作る</button>"} -->
- **下書き生成とHTMLマニュアル公開**: AIエージェント（Codex、Claude Code、Grok Build、Agy）を利用した原稿下書きの作成や、MkDocs Materialを利用したマニュアルのビルド・公開に対応しています。<!-- ai:fact {"claim":"AI設定・出力パネルでAIエージェントの選択や下書き・完成版ビルドが行える","file":"apps/manual-studio/index.html","contains":"<select id=\"ai-agent\"><option value=\"codex\">Codex</option><option value=\"claude\">Claude Code</option><option value=\"grok\">Grok Build</option><option value=\"agy\">Agy</option></select>"} -->

## クイックスタート

開発環境から起動する場合は以下のスクリプトを実行します。

```sh
python3 start_manual_studio.py
```
<!-- ai:fact {"claim":"開発環境からの起動コマンドは python3 start_manual_studio.py","file":"apps/manual-studio/README.md","contains":"python3 start_manual_studio.py"} -->

1. ワークスペースとして対象プロジェクトのフォルダーを開きます。
2. 左側のファイルツリーから原稿ファイルを選択するか、「＋ MD」ボタンで新しいページを作成します。
3. 原稿を編集し、「この文書のAIタグを更新」または「すべての文書をAI出力」からAI生成や撮影指示を実行します。<!-- ai:fact {"claim":"文書単位の更新ボタン名は「この文書のAIタグを更新」、全体実行ボタン名は「すべての文書をAI出力」","file":"apps/manual-studio/index.html","contains":"<button id=\"generate-page\" title=\"この文書のAI指示を実行し、文章・図・撮影結果を更新\">この文書のAIタグを更新</button>"} -->
4. 必要に応じて「下書きビルド」や「完成版ビルド」を実行してHTMLマニュアルを確認します。<!-- ai:fact {"claim":"下書きビルドと完成版ビルドのボタンがある","file":"apps/manual-studio/index.html","contains":"<button id=\"build-draft\" class=\"primary\">下書きビルド</button><button id=\"build-final\">完成版ビルド</button>"} -->
<!-- /ai:generated -->

<!-- ai:generated id=task-readme-text-1 kind=text created-at=2026-10-04T13:07:11Z source-sha256=938a82de0415bd7b2fcfbd4db453a3b272fc43010c721de3a0c810e0c9cad659 prompt-b64=UmVhZG1lLm1k44Gu57aa44GN44KS5pu444GE44Gm44GP44Gg44GV44GE approved-at=2026-10-04T21:24:10Z -->
## 主な機能

- **Markdownエディタとリアルタイムプレビュー**: 入力中のプレビュー表示やスクロール同期に対応し、書式ツールバーや元に戻す（Undo）・やり直す（Redo）操作を備えています。<!-- ai:fact {"claim":"書式ツールバーにUndoやRedo、各種書式ボタンが用意されている","file":"apps/manual-studio/index.html","contains":"<button type=\"button\" id=\"undo-edit\" title=\"元に戻す (Ctrl/Cmd+Z)\" aria-label=\"元に戻す\" disabled>↶ Undo</button>"} -->
- **AI指示（AIタグ）による部分生成と保護**: 原稿内に「AI文章の指示」「撮影の指示」「依存図の指示」を挿入でき、確定した生成結果を保護しながら対象箇所のみを安全に更新できます。<!-- ai:fact {"claim":"AI指示の追加メニューにAI文章・撮影・依存図の指示がある","file":"apps/manual-studio/index.html","contains":"<button type=\"button\" data-insert=\"text\">AI文章の指示</button><button type=\"button\" data-insert=\"screenshot\">撮影の指示</button><button type=\"button\" data-insert=\"diagram\">依存図の指示</button>"} -->
- **アプリ操作の記録とスクリーンショット更新**: アプリ起動コマンドと操作手順を記録し、MarkItsと連携して注釈付けや再撮影を効率化します。<!-- ai:fact {"claim":"撮影AIタグダイアログでアプリ起動と操作記録、MarkItsでの注釈に対応している","file":"apps/manual-studio/index.html","contains":"<h2>アプリを操作して撮影AIタグを作成</h2>"} -->
- **画面一覧（UI Map）の管理**: ソースコードからの解析やWeb画面の探索、デスクトップ観測JSONの取り込みにより、マニュアル作成に必要なUI要素を可視化・整理します。<!-- ai:fact {"claim":"UI Mapパネルでコードからの画面一覧作成やWeb探索、観測JSON取り込みを扱える","file":"apps/manual-studio/index.html","contains":"<button id=\"map-refresh\" class=\"primary\">コードから画面一覧を作る</button>"} -->
- **下書き生成とHTMLマニュアル公開**: AIエージェント（Codex、Claude Code、Grok Build、Agy）を利用した原稿下書きの作成や、MkDocs Materialを利用したマニュアルのビルド・公開に対応しています。<!-- ai:fact {"claim":"AI設定・出力パネルでAIエージェントの選択や下書き・完成版ビルドが行える","file":"apps/manual-studio/index.html","contains":"<select id=\"ai-agent\"><option value=\"codex\">Codex</option><option value=\"claude\">Claude Code</option><option value=\"grok\">Grok Build</option><option value=\"agy\">Agy</option></select>"} -->

## クイックスタート

開発環境から起動する場合は以下のスクリプトを実行します。

```sh
python3 start_manual_studio.py
```
<!-- ai:fact {"claim":"開発環境からの起動コマンドは python3 start_manual_studio.py","file":"apps/manual-studio/README.md","contains":"python3 start_manual_studio.py"} -->

1. ワークスペースとして対象プロジェクトのフォルダーを開きます。
2. 左側のファイルツリーから原稿ファイルを選択するか、「＋ MD」ボタンで新しいページを作成します。
3. 原稿を編集し、「この文書のAIタグを更新」または「すべての文書をAI出力」からAI生成や撮影指示を実行します。<!-- ai:fact {"claim":"文書単位の更新ボタン名は「この文書のAIタグを更新」、全体実行ボタン名は「すべての文書をAI出力」","file":"apps/manual-studio/index.html","contains":"<button id=\"generate-page\" title=\"この文書のAI指示を実行し、文章・図・撮影結果を更新\">この文書のAIタグを更新</button>"} -->
4. 必要に応じて「下書きビルド」や「完成版ビルド」を実行してHTMLマニュアルを確認します。<!-- ai:fact {"claim":"下書きビルドと完成版ビルドのボタンがある","file":"apps/manual-studio/index.html","contains":"<button id=\"build-draft\" class=\"primary\">下書きビルド</button><button id=\"build-final\">完成版ビルド</button>"} -->
<!-- /ai:generated -->



<!-- ai:task id=task-readme-text-2 kind=text
AIタグの簡易マニュアルを書いてください
-->

<!-- ai:generated id=task-readme-text-2 kind=text created-at=2026-10-04T21:56:03Z source-sha256=336efd1e81f44a7e66b2f8b3f13b6c117ca937127fe7a61241d692a19f82ad92 prompt-b64=QUnjgr/jgrDjga7nsKHmmJPjg57jg4vjg6XjgqLjg6vjgpLmm7jjgYTjgabjgY/jgaDjgZXjgYQ= -->
## AIタグ簡易マニュアル

AIタグは、Markdown原稿内にAIへの指示と生成結果を記述するための特殊なHTMLコメント形式の記法です。原稿全体を一括で書き換えることなく、指定箇所のみを安全に生成・更新できます。

### 1. AI指示タグ（ai:task）の記法

原稿内で生成させたい場所に以下のような形式で指示を配置します。

```markdown
<!-- ai:task id=<一意のID> kind=<text|screenshot|diagram>
<指示内容やプロンプト>
-->
```
<!-- ai:fact {"claim":"AIタスク記法は id と kind（screenshot|diagram|text）および指示文で構成される","file":"crates/manual-core/src/lib.rs","contains":"<!-- ai:task id=<一意のID> kind=<screenshot|diagram|text>"} -->

- **id**: 文書およびプロジェクト全体で一意となる識別子です（例: `task-readme-text-1`）。
- **kind**: 指示の種類を以下の3つから指定します。
  - `text`: 説明文や手順などのテキスト生成
  - `screenshot`: アプリケーションの画面撮影と画像配置
  - `diagram`: 構成図や依存関係図（Mermaid形式など）の生成

エディタのツールバーにある「AI指示を追加」メニューから、「AI文章の指示」「撮影の指示」「依存図の指示」を選ぶことで自動挿入できます。<!-- ai:fact {"claim":"AI指示の追加メニューにAI文章・撮影・依存図の指示がある","file":"apps/manual-studio/index.html","contains":"<button type=\"button\" data-insert=\"text\">AI文章の指示</button><button type=\"button\" data-insert=\"screenshot\">撮影の指示</button><button type=\"button\" data-insert=\"diagram\">依存図の指示</button>"} -->

### 2. 生成結果（ai:generated）と本文

AI実行または撮影を行うと、指示タグの直後に `ai:generated` タグで囲まれた本文が出力されます。

```markdown
<!-- ai:generated id=<ID> kind=<kind> ... -->
ここに生成されたMarkdown本文や画像リンクが配置されます。
<!-- /ai:generated -->
```

生成された本文はコメントの外側（通常のMarkdown）として出力されるため、エディタのリアルタイムプレビューや公開用HTMLでもそのまま表示されます。

### 3. AIタグの実行と保護

- **実行**: エディタ上部の「この文書のAIタグを更新」を押すと、原稿内の未確定なAIタグが一括で処理されます。<!-- ai:fact {"claim":"文書のAIタグ更新ボタン名は「この文書のAIタグを更新」","file":"apps/manual-studio/index.html","contains":"<button id=\"generate-page\" title=\"この文書のAI指示を実行し、文章・図・撮影結果を更新\">この文書のAIタグを更新</button>"} -->
- **確定と保護**: 生成結果を維持したい場合は、「AIタグ一覧」パネルや右側のAIタグペインから「確定」を行います。<!-- ai:fact {"claim":"AIタグ一覧で確定と確定解除を切り替えられる","file":"apps/manual-studio/src/main.ts","contains":"${task.status === \"approved\" ? \"確定解除\" : \"確定\"}"} -->
  - `approved`（確定済み）状態のタグは、以降のAI更新処理で自動上書きされなくなります。
  - 再生成したい場合は「確定解除」を押してから再度更新を実行します。
- **指示の編集**: プロンプトを変更して再保存すると、生成状態が更新待ち（stale）となり、次回実行時に新しい指示内容で再生成されます。<!-- ai:fact {"claim":"タスクステータスには未作成・更新待ち・準備完了・確定済みが存在する","file":"apps/manual-studio/src/main.ts","contains":"const statusLabel: Record<string, string> = { missing: \"未作成\", stale: \"更新待ち\", current: \"準備完了\", approved: \"確定済み\" };"} -->
<!-- /ai:generated -->

<!-- ai:generated id=task-readme-text-2 kind=text created-at=2026-10-04T21:52:43Z source-sha256=336efd1e81f44a7e66b2f8b3f13b6c117ca937127fe7a61241d692a19f82ad92 prompt-b64=QUnjgr/jgrDjga7nsKHmmJPjg57jg4vjg6XjgqLjg6vjgpLmm7jjgYTjgabjgY/jgaDjgZXjgYQ= -->
## AIタグ簡易マニュアル

AIタグは、Markdown原稿内にAIへの指示と生成結果を記述するための特殊なHTMLコメント形式の記法です。原稿全体を一括で書き換えることなく、指定箇所のみを安全に生成・更新できます。

### 1. AI指示タグ（ai:task）の記法

原稿内で生成させたい場所に以下のような形式で指示を配置します。

```markdown
<!-- ai:task id=<一意のID> kind=<text|screenshot|diagram>
<指示内容やプロンプト>
-->
```
<!-- ai:fact {"claim":"AIタスク記法は id と kind（screenshot|diagram|text）および指示文で構成される","file":"crates/manual-core/src/lib.rs","contains":"<!-- ai:task id=<一意のID> kind=<screenshot|diagram|text>"} -->

- **id**: 文書およびプロジェクト全体で一意となる識別子です（例: `task-readme-text-1`）。
- **kind**: 指示の種類を以下の3つから指定します。
  - `text`: 説明文や手順などのテキスト生成
  - `screenshot`: アプリケーションの画面撮影と画像配置
  - `diagram`: 構成図や依存関係図（Mermaid形式など）の生成

エディタのツールバーにある「AI指示を追加」メニューから、「AI文章の指示」「撮影の指示」「依存図の指示」を選ぶことで自動挿入できます。<!-- ai:fact {"claim":"AI指示の追加メニューにAI文章・撮影・依存図の指示がある","file":"apps/manual-studio/index.html","contains":"<button type=\"button\" data-insert=\"text\">AI文章の指示</button><button type=\"button\" data-insert=\"screenshot\">撮影の指示</button><button type=\"button\" data-insert=\"diagram\">依存図の指示</button>"} -->

### 2. 生成結果（ai:generated）と本文

AI実行または撮影を行うと、指示タグの直後に `ai:generated` タグで囲まれた本文が出力されます。

```markdown
<!-- ai:generated id=<ID> kind=<kind> ... -->
ここに生成されたMarkdown本文や画像リンクが配置されます。
<!-- /ai:generated -->
```

生成された本文はコメントの外側（通常のMarkdown）として出力されるため、エディタのリアルタイムプレビューや公開用HTMLでもそのまま表示されます。

### 3. AIタグの実行と保護

- **実行**: エディタ上部の「この文書のAIタグを更新」を押すと、原稿内の未確定なAIタグが一括で処理されます。<!-- ai:fact {"claim":"文書のAIタグ更新ボタン名は「この文書のAIタグを更新」","file":"apps/manual-studio/index.html","contains":"<button id=\"generate-page\" title=\"この文書のAI指示を実行し、文章・図・撮影結果を更新\">この文書のAIタグを更新</button>"} -->
- **確定と保護**: 生成結果を維持したい場合は、「AIタグ一覧」パネルや右側のAIタグペインから「確定」を行います。<!-- ai:fact {"claim":"AIタグ一覧で確定と確定解除を切り替えられる","file":"apps/manual-studio/src/main.ts","contains":"${task.status === \"approved\" ? \"確定解除\" : \"確定\"}"} -->
  - `approved`（確定済み）状態のタグは、以降のAI更新処理で自動上書きされなくなります。
  - 再生成したい場合は「確定解除」を押してから再度更新を実行します。
- **指示の編集**: プロンプトを変更して再保存すると、生成状態が更新待ち（stale）となり、次回実行時に新しい指示内容で再生成されます。<!-- ai:fact {"claim":"タスクステータスには未作成・更新待ち・準備完了・確定済みが存在する","file":"apps/manual-studio/src/main.ts","contains":"const statusLabel: Record<string, string> = { missing: \"未作成\", stale: \"更新待ち\", current: \"準備完了\", approved: \"確定済み\" };"} -->
<!-- /ai:generated -->

<!-- ai:generated id=task-readme-text-2 kind=text created-at=2026-10-04T21:20:58Z source-sha256=336efd1e81f44a7e66b2f8b3f13b6c117ca937127fe7a61241d692a19f82ad92 prompt-b64=QUnjgr/jgrDjga7nsKHmmJPjg57jg4vjg6XjgqLjg6vjgpLmm7jjgYTjgabjgY/jgaDjgZXjgYQ= -->
## AIタグ簡易マニュアル

AIタグは、Markdown原稿内にAIへの指示と生成結果を記述するための特殊なHTMLコメント形式の記法です。原稿全体を一括で書き換えることなく、指定箇所のみを安全に生成・更新できます。

### 1. AI指示タグ（ai:task）の記法

原稿内で生成させたい場所に以下のような形式で指示を配置します。

```markdown
<!-- ai:task id=<一意のID> kind=<text|screenshot|diagram>
<指示内容やプロンプト>
-->
```
<!-- ai:fact {"claim":"AIタスク記法は id と kind（screenshot|diagram|text）および指示文で構成される","file":"crates/manual-core/src/lib.rs","contains":"<!-- ai:task id=<一意のID> kind=<screenshot|diagram|text>"} -->

- **id**: 文書およびプロジェクト全体で一意となる識別子です（例: `task-readme-text-1`）。
- **kind**: 指示の種類を以下の3つから指定します。
  - `text`: 説明文や手順などのテキスト生成
  - `screenshot`: アプリケーションの画面撮影と画像配置
  - `diagram`: 構成図や依存関係図（Mermaid形式など）の生成

エディタのツールバーにある「AI指示を追加」メニューから、「AI文章の指示」「撮影の指示」「依存図の指示」を選ぶことで自動挿入できます。<!-- ai:fact {"claim":"AI指示の追加メニューにAI文章・撮影・依存図の指示がある","file":"apps/manual-studio/index.html","contains":"<button type=\"button\" data-insert=\"text\">AI文章の指示</button><button type=\"button\" data-insert=\"screenshot\">撮影の指示</button><button type=\"button\" data-insert=\"diagram\">依存図の指示</button>"} -->

### 2. 生成結果（ai:generated）と本文

AI実行または撮影を行うと、指示タグの直後に `ai:generated` タグで囲まれた本文が出力されます。

```markdown
<!-- ai:generated id=<ID> kind=<kind> ... -->
ここに生成されたMarkdown本文や画像リンクが配置されます。
<!-- /ai:generated -->
```

生成された本文はコメントの外側（通常のMarkdown）として出力されるため、エディタのリアルタイムプレビューや公開用HTMLでもそのまま表示されます。

### 3. AIタグの実行と保護

- **実行**: エディタ上部の「この文書のAIタグを更新」を押すと、原稿内の未確定なAIタグが一括で処理されます。<!-- ai:fact {"claim":"文書のAIタグ更新ボタン名は「この文書のAIタグを更新」","file":"apps/manual-studio/index.html","contains":"<button id=\"generate-page\" title=\"この文書のAI指示を実行し、文章・図・撮影結果を更新\">この文書のAIタグを更新</button>"} -->
- **確定と保護**: 生成結果を維持したい場合は、「AIタグ一覧」パネルや右側のAIタグペインから「確定」を行います。<!-- ai:fact {"claim":"AIタグ一覧で確定と確定解除を切り替えられる","file":"apps/manual-studio/src/main.ts","contains":"${task.status === \"approved\" ? \"確定解除\" : \"確定\"}"} -->
  - `approved`（確定済み）状態のタグは、以降のAI更新処理で自動上書きされなくなります。
  - 再生成したい場合は「確定解除」を押してから再度更新を実行します。
- **指示の編集**: プロンプトを変更して再保存すると、生成状態が更新待ち（stale）となり、次回実行時に新しい指示内容で再生成されます。<!-- ai:fact {"claim":"タスクステータスには未作成・更新待ち・準備完了・確定済みが存在する","file":"apps/manual-studio/src/main.ts","contains":"const statusLabel: Record<string, string> = { missing: \"未作成\", stale: \"更新待ち\", current: \"準備完了\", approved: \"確定済み\" };"} -->
<!-- /ai:generated -->

<!-- ai:generated id=task-readme-text-2 kind=text created-at=2026-10-04T13:10:51Z source-sha256=336efd1e81f44a7e66b2f8b3f13b6c117ca937127fe7a61241d692a19f82ad92 prompt-b64=QUnjgr/jgrDjga7nsKHmmJPjg57jg4vjg6XjgqLjg6vjgpLmm7jjgYTjgabjgY/jgaDjgZXjgYQ= approved-at=2026-10-04T13:11:18Z -->
## AIタグ簡易マニュアル

AIタグは、Markdown原稿内にAIへの指示と生成結果を記述するための特殊なHTMLコメント形式の記法です。原稿全体を一括で書き換えることなく、指定箇所のみを安全に生成・更新できます。

### 1. AI指示タグ（ai:task）の記法

原稿内で生成させたい場所に以下のような形式で指示を配置します。

```markdown
<!-- ai:task id=<一意のID> kind=<text|screenshot|diagram>
<指示内容やプロンプト>
-->
```
<!-- ai:fact {"claim":"AIタスク記法は id と kind（screenshot|diagram|text）および指示文で構成される","file":"crates/manual-core/src/lib.rs","contains":"<!-- ai:task id=<一意のID> kind=<screenshot|diagram|text>"} -->

- **id**: 文書およびプロジェクト全体で一意となる識別子です（例: `task-readme-text-1`）。
- **kind**: 指示の種類を以下の3つから指定します。
  - `text`: 説明文や手順などのテキスト生成
  - `screenshot`: アプリケーションの画面撮影と画像配置
  - `diagram`: 構成図や依存関係図（Mermaid形式など）の生成

エディタのツールバーにある「AI指示を追加」メニューから、「AI文章の指示」「撮影の指示」「依存図の指示」を選ぶことで自動挿入できます。<!-- ai:fact {"claim":"AI指示の追加メニューにAI文章・撮影・依存図の指示がある","file":"apps/manual-studio/index.html","contains":"<button type=\"button\" data-insert=\"text\">AI文章の指示</button><button type=\"button\" data-insert=\"screenshot\">撮影の指示</button><button type=\"button\" data-insert=\"diagram\">依存図の指示</button>"} -->

### 2. 生成結果（ai:generated）と本文

AI実行または撮影を行うと、指示タグの直後に `ai:generated` タグで囲まれた本文が出力されます。

```markdown
<!-- ai:generated id=<ID> kind=<kind> ... -->
ここに生成されたMarkdown本文や画像リンクが配置されます。
<!-- /ai:generated -->
```

生成された本文はコメントの外側（通常のMarkdown）として出力されるため、エディタのリアルタイムプレビューや公開用HTMLでもそのまま表示されます。

### 3. AIタグの実行と保護

- **実行**: エディタ上部の「この文書のAIタグを更新」を押すと、原稿内の未確定なAIタグが一括で処理されます。<!-- ai:fact {"claim":"文書のAIタグ更新ボタン名は「この文書のAIタグを更新」","file":"apps/manual-studio/index.html","contains":"<button id=\"generate-page\" title=\"この文書のAI指示を実行し、文章・図・撮影結果を更新\">この文書のAIタグを更新</button>"} -->
- **確定と保護**: 生成結果を維持したい場合は、「AIタグ一覧」パネルや右側のAIタグペインから「確定」を行います。<!-- ai:fact {"claim":"AIタグ一覧で確定と確定解除を切り替えられる","file":"apps/manual-studio/src/main.ts","contains":"${task.status === \"approved\" ? \"確定解除\" : \"確定\"}"} -->
  - `approved`（確定済み）状態のタグは、以降のAI更新処理で自動上書きされなくなります。
  - 再生成したい場合は「確定解除」を押してから再度更新を実行します。
- **指示の編集**: プロンプトを変更して再保存すると、生成状態が更新待ち（stale）となり、次回実行時に新しい指示内容で再生成されます。<!-- ai:fact {"claim":"タスクステータスには未作成・更新待ち・準備完了・確定済みが存在する","file":"apps/manual-studio/src/main.ts","contains":"const statusLabel: Record<string, string> = { missing: \"未作成\", stale: \"更新待ち\", current: \"準備完了\", approved: \"確定済み\" };"} -->
<!-- /ai:generated -->
