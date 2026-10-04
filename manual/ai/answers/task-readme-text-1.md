<!-- ai:answer id=task-readme-text-1 source-sha256=938a82de0415bd7b2fcfbd4db453a3b272fc43010c721de3a0c810e0c9cad659 created-at=2026-10-04T21:20:58Z -->
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
