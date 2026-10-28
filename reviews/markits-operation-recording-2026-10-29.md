# Markits operation recording migration

The shared input helper, event model, semantic/visual target types and native window capture now live in Markits. manual-core preserves its module paths through re-exports. Manual Studio retains project-specific scenario generation, application launching, screenshot registration and annotation handoff, using the shared helper.

Markits Desktop provides an existing-window selector and floating recording controls with history, pause/resume, finish/save and cancel. Cancel and host shutdown stop only the owned helper. Saving can be retried after dismissing the file dialog. Standalone keys are restricted to the focused target window, and pointer actions use the live target bounds; exported controls are excluded.

Validation on Windows:

- `cargo test -p manual-core --lib --no-default-features`: 177 passed.
- `cargo test --manifest-path crates/markits/Cargo.toml --lib`: 74 passed, two existing browser-window tests ignored because they require specific open pages.
- `cargo test -p manual-studio recorder:: -- --test-threads=1`: 15 passed.
- `cargo check -p manual-studio`: passed, including embedded Markits Desktop.
- `cargo check --manifest-path crates/markits/Cargo.toml -p markits-desktop`: passed as a standalone workspace.
- `npm run manual:build-markits`: passed.
- `npm run manual:test-markits`: passed in headless Microsoft Edge. Covers window selection, pause/resume, JSON persistence, save-dialog cancellation and retry, cancellation, range selection with actual mouse gestures, Shift-click, same-type bulk changes, mixed-type filtering, Undo/Redo and deletion.
- `openspec validate move-operation-recording-to-markits --strict`: passed.

The recording UI browser test mocks native commands and save APIs. Actual input-hook recording against another native application and manual verification on macOS/Linux have not been performed. No video encoding was added: this migration preserves the existing operation-data recording meaning.
