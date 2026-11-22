## Context

Munin Manual Studio preserves ordinary Markdown as the source of truth and requires explicit human adoption via Diff views before mutating manuscripts. Existing infrastructure includes `quality.rs` for pre-publication checks, `markits` PNG metadata extraction (`markits:annotations` and `markits:uimap`), `capture_resources::editing_source` for managed screenshot editing PNGs, `selectableDiff.ts` for hunk-level Diff selection, and `mcp.rs` + `terminalPane.ts` for interactive CLI collaboration.

## Goals / Non-Goals

**Goals:**
- Detect MarkIts badge/UIMap vs prose drift deterministically without requiring AI connectivity or breaking strict publication gates.
- Let authors pass editor context, images, and inline `<!-- ai-note: ... -->` memos to the AI terminal safely (defaulting to paste without auto-submit).
- Track external Markdown modifications during AI terminal sessions and allow hunk-level accept/revert with SHA-256 conflict guards and dirty-tab protection.
- Share project terminology in `.munin/glossary.json` across UI management, UIMap import, quality checks, AI prompts, and MCP.

**Non-Goals:**
- Reintroducing retired `ai:task` / `ai:generated` stateful comment tags.
- Auto-modifying manuscripts or silently overwriting unsaved editor drafts.
- Blocking final HTML publication on non-fatal `warning` findings.

## Decisions

1. **Error vs Warning split in `quality.rs`**:
   - Existing `broken_link` and `missing_image` carry `severity: "error"`. `passed` and `require_ready()` remain strictly gated on `error_count == 0`.
   - New checks (`annotation_step_mismatch`, `annotation_step_order`, `annotation_target_mismatch`, `glossary_violation`, `unresolved_ai_note`) emit `severity: "warning"`. Code blocks and HTML comments are stripped before checking explanation prose so inline comments cannot mask missing steps.
2. **Glossary storage (`.munin/glossary.json`)**:
   - Follows `.munin/proofreading-skills.json` as a project-owned JSON file (max 500 terms, atomic writes via `NamedTempFile`).
   - UIMap extraction scans both registered `capture_resources` sources/editing PNGs and PNGs under `config.assets`.
   - AI prompt injection prioritizes terms matching the active manuscript context (capped at 30 terms) to prevent prompt bloat.
3. **Lightweight inline AI notes**:
   - Uses standard HTML comments `<!-- ai-note: ... -->` without closing tags or metadata attributes so Markdown remains portable and invisible in published HTML.
4. **Snapshot-based external change tray**:
   - On AI terminal connection, `external-snapshot-create` stores normalized Markdown baselines under `.munin/terminal-snapshots/` (retaining the 5 most recent sessions).
   - `external-snapshot-apply` verifies `expected_sha256` against the current disk file before applying hunk-merged content or deletion, and updates the snapshot baseline on success.
   - Frontend disables direct apply for any page that has unsaved in-editor edits.
5. **Dialog sizing & UI placement**:
   - Glossary lives in a new `用語集` tab inside `#panel-settings`.
   - Handoff (`#terminal-handoff-dialog`) and note insertion (`#ai-note-insert-dialog`) use `data-dialog-size="compact"`; AI notes manager (`#ai-notes-dialog`) and external change tray (`#external-change-tray-dialog`) are registered in `canExpandDialog`.

## Risks / Trade-offs

- **False positives on prose matching**: Restricting step checks to images with >=2 badges (or prose already using circled/parenthesized step numbers) and excluding code/URLs/preferred-substrings keeps warning noise low.
- **Native desktop rebuild**: Verified in Rust tests, Vite build, and Playwright Edge browser; native Tauri binary packaging remains a separate build step.
