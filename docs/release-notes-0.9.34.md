# Munin Manual Studio 0.9.34

- **AI協業ワークフロー＆AI協業ツール**: プロジェクト用語集（`.munin/glossary.json`・UIMap自動取込・MCP `project-glossary` / `upsert-glossary-term`）、原稿チェックの強化（MarkIts注釈番号・UIMap整合／用語集違反／未解決AIメモの検出、およびDiff確認付きの用語集一括置換）、エディタ⇄AIターミナル文脈送信、インラインAIメモ、複数ファイルの外部変更確認トレー、5タブの「AI協業ツール」（構成ダッシュボード・読者別出力・ソース事実裏取り・アプリ変更影響抽出・操作記録→手順書ドラフト・派生生成＆多言語差分同期）を追加しました。
- **HTML出力の目次制御とPython不要の単一HTML出力**: 公開目次に各ページの `# H1` 見出しと `index.md` 先頭配置を自動採用し、「AI協業ツール → 構成・読者」から並び順・セクション階層・表示名・非表示を保存できます。MkDocs・Zensicalに加え、Python不要で画像埋め込み・Mermaid図描画・PDF印刷に対応した「単一HTML」出力（CLI `manualctl build-single-html` / `manualctl build-audience --engine single-html` 含む）を追加しました。
- **未使用画像の公開除外と撮影リソースの安全整理**: HTML出力設定に「未使用の画像をHTML出力に含めない」オプションを追加しました。撮影リソース一覧Dockから未使用かつ未保護のリソースを `.munin/trash/` へ安全に退避し、ワンクリックの「整理を戻す」で元の場所へ復元できます。

配布対象は Windows x64 です。
