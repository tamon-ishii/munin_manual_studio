<!-- ai:answer id=task-readme-text-2 source-sha256=336efd1e81f44a7e66b2f8b3f13b6c117ca937127fe7a61241d692a19f82ad92 created-at=2026-10-04T21:20:58Z -->
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
