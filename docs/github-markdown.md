# GitHub Markdown

表、タスクリスト、取り消し線、URL・メールの自動リンク、脚注をプレビューで表示できます。リッチ編集とMarkdownソースを切り替えて編集します。

GitHub形式のアラートは次のように記述します。NOTE、TIP、IMPORTANT、WARNING、CAUTIONを利用できます。

```markdown
> [!NOTE]
> 補足説明です。
```

公開時は元の原稿を保ち、作業用コピーでMkDocsのアラート形式へ変換します。GitHubのユーザー名・Issue番号・PR番号など、リポジトリ情報を必要とするリンク展開は対象外です。

構文の参照: [GFM仕様](https://github.github.com/gfm/)、[GitHubの基本的な書き方](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax)。

ツールバーの「GitHubアラート」から各アラートを挿入できます。Markdownソースでは「GitHub」の選択欄を利用します。「Info・補足」はGitHub標準のNOTEとして挿入されます。挿入後に本文を編集してください。
