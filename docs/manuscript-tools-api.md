# 原稿操作API

現行の画面は [全文検索・置換とGit履歴](specs/manuscript-search-and-git.md) に従う。見出し解析APIは保持しているが、見出しアウトラインのバーは画面に表示しない。

既存の `manualctl --request` およびStudio RPCで利用する。`root` は対象プロジェクト、各操作の引数は `options.json` に指定する。

- `project-search`: `query`（空でない文字列）、`case_sensitive`（既定true）。プロジェクトのMarkdownを検索し、`documents`（本文とrevision）、`matches`（page/start/end/text/line/column/excerpt）、`skipped`、`truncated` を返す。位置はUTF-16。隠し保存領域・依存・ビルド出力・シンボリックリンクは対象外。最大2000ファイル・1000結果・一致文書本文合計3MBを超える場合は明示する。
- `editor-batch-save`: `documents: [{page, revision, content}]`。最大200原稿、本文合計3MB。すべてのrevisionを検証後に保存し、`before`（変更前）と `documents`（変更後）を返す。同じ実体の重複指定は拒否。後続の保存失敗時は、先行保存のrevisionを確認して元に戻し、復元失敗は原稿名付きで報告する。
- 置換の取り消し: `before` の本文と `documents` のrevisionを組み合わせて、再度 `editor-batch-save` を呼ぶ。後から更新された原稿があれば取り消さない。
- `editor-outline`: `content`。CommonMarkのトップレベル見出しを `headings` として返す。ATX/Setextに対応し、コードブロック・引用・リスト内の見出しは除外する。`start` / `heading_end` / `end` はUTF-16、`level` は1〜6、`parent` は親見出しの配列位置またはnull。`end` は下位見出しを含む節末尾。

## Git連携

Gitコマンドはローカル実行のみで、30秒の期限を設ける。パスはプロジェクト内のMarkdownに制限し、コミットIDは完全な16進ハッシュのみ受け付ける。

- `manuscript-git-status`: 任意の `page`。Gitの有無、リポジトリ、原稿の変更状態、コミット用の名前・メール設定の有無を返す。
- `manuscript-git-init`: `confirm: true` が必要。未管理のプロジェクトをユーザーの操作で初期化する。開くだけでは初期化しない。
- `manuscript-git-history`: `page`。その原稿の直近100コミットを返す。未コミットのリポジトリは空配列。
- `manuscript-git-version`: `page`, `commit`。指定した版の内容を返すだけでファイルを書き換えない。
- `manuscript-git-commit`: `page`, `message`, `revision`。現在の保存版を確認して、その原稿だけをコミットする。他ファイルのステージ内容は保持する。マージ競合中のコミットは拒否する。
- Gitからの復元は、UIで変更前後を確認し通常の編集・保存経路へ反映する。ブランチやインデックスを巻き戻す操作と、リモート操作は提供しない。
