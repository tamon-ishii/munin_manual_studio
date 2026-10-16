# Tasks

## 1. Manuscript tools backend

- [x] 1.1 Implement bounded literal project search, UTF-16 navigation, revision-checked batch save/undo, and CommonMark outline parsing; verify Rust tests for Unicode, excluded paths, stale revisions, duplicate aliases, rollback and heading syntax, and document the RPCs.

## 2. Search and outline UI

- [x] 2.1 Add search results, selected replacement preview/apply/undo and owner-safe document refresh; verify real-backend browser selective changes, external conflicts, project switches and preserved drafts; document the user flow.
- [x] 2.2 Add live outline navigation, sibling drag/drop and keyboard-operable section moves through normal editor Undo; verify fences, duplicate headings, Unicode, Setext, images, rich/source editing and Undo; document constraints.

## 3. Git integration

- [x] 3.1 Implement local Git status/init/history/content/explicit per-manuscript commit with validated paths and bounded execution; verify temporary-repository tests including missing setup, empty history, history selection, unusual filenames and preservation of unrelated staged work; document RPC behavior.
- [x] 3.2 Add Git setup/state/history, reviewed restoration and manual checkpoint UI; verify browser commit/history/restore/Undo, changed owner/revision rejection and non-Git editing; document setup and recovery.

## 4. Integration

- [x] 4.1 Integrate new regression checks and UI coverage inventory, run frontend and native builds, relevant existing editor/search-adjacent suites, core and Studio tests, and strict OpenSpec validation; record the final results and any platform limits.
