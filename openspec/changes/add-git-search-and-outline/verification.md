# Implementation verification

Verified locally on Linux, with actual `manualctl` RPCs and headless Chrome.

- Frontend and debug native build: `npm run manual:build-verification`.
- Rust core: 188 passed, 1 existing ignored test. Rust Studio: 27 passed. The core screen-capture test requires the actual display outside the filesystem sandbox.
- Unit group: passed, including literal replacement, UTF-16 ranges, overlapping/stale ranges, section moves, CRLF, images, diagrams and owner identity guards.
- New real-backend browser scenarios: selected replace review/apply/undo, all/none selection, case sensitivity, external multi-file conflict rejection, Unicode navigation; duplicate/fenced headings, up/down/drag moves, rich/source Undo; explicit Git commit, unrelated staged work, version comparison, restore/Undo, external conflict and non-Git initialization.
- Git unavailable check: status reports unavailable; ordinary manuscript reading remains usable.
- Existing regressions: runtime discovery, document tab restoration, document/image workflows, editor autosave and author settings.
- The author-settings evidence selector was made precise: a nested handler must not also match its enclosing loop.
- New P17/P18/P19 actions are registered in the UI inventory and have real-backend evidence gates in the UI check group. Runtime adapters are restricted to dynamic search results and heading controls.
- OpenSpec strict validation and `git diff --check`.

Evidence artifacts are generated under `ui-coverage-results/manuscript-tools` and `ui-coverage-results/manuscript-git`; each report is tied to the current source/build/OS identity. Other existing UI cases are not certified by these scoped reports.

Windows and macOS execution has not been tested locally. Git operations use shell-free argv and the existing cross-platform process runner; Windows suppresses a console window. No remote Git operation or automatic commit is enabled.
