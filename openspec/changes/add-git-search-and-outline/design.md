# Design

## Context

See proposal.md. manual-core exposes string RPC actions and revision-checked editor saves. The UI keeps source and Milkdown synchronized, with per-tab Undo and owner checks. Git is used elsewhere through subprocesses but manuscript history has no UI. The file tree searches filenames only.

## Goals / Non-Goals

**Goals:** Reuse Git as persistent history, provide reviewed multi-file changes, and preserve editor and project ownership.

**Non-Goals:** Remote Git operations, destructive checkout/reset, automatic commits by default, independent manuscript history storage, regular-expression search, and cross-parent heading reparenting.

## Decisions

- Add focused Rust modules for Git and manuscript tools; keep the existing RPC transport. Execute Git with argument arrays, validated hashes and canonical project-relative manuscript paths. Explicit per-file commits exclude unrelated index entries. Repository initialization is a user-invoked UI action; opening a project never initializes it.
- Search literal text in bounded project Markdown, excluding hidden storage and build/dependency directories. Return document revisions/content and UTF-16 match positions so source selection matches the browser, while making limits and read failures visible.
- A revision-checked batch-save API acquires canonical page locks in deterministic order, validates every file before writing, and rolls back earlier writes on failure. Search maintains the latest batch's before/after revisions in UI memory for guarded undo; Git remains the persistent restoration mechanism.
- Add feature-specific UI modules through existing editor and tree entry points. Before writing, save the active draft and reject affected dirty cached tabs. Refresh/invalidate affected cached documents while retaining unrelated drafts. Async results capture the project and document owner.
- Parse headings with the existing CommonMark parser in manual-core, using source ranges to retain exact Markdown. Reorder only siblings under the same parent, keeping complete subtrees and using one normal editor transaction for Undo. Navigation uses the existing source navigation route.
- Keep manual Git checkpoints as the default unless the user requests automatic commits. Restore a historical version through a reviewed content replacement, normal save and editor Undo; never invoke Git reset/checkout on the working tree.
- Reviewed restores, batch refreshes and section moves reveal the source editor before applying one edit. This preserves exact Markdown (including comments, image metadata and whitespace) instead of reserializing the entire manuscript through the rich editor; the source Undo history also records edits emitted by rich editing.

## Risks / Trade-offs

- Git availability/identity → show actionable setup state without blocking ordinary editing.
- Existing staged work or conflicts → commit only the selected file, reject unmerged state, and regression-test index preservation.
- Filesystem failures during batch saves → validate first, retain originals, perform guarded rollback and report any incomplete restoration.
- Large projects → bound documents/results/bytes and expose truncation; selected known results remain reviewable.
- CommonMark section moves → use parser offsets and sibling constraints; test fences, Setext, duplicates, CRLF, Unicode and final sections without a newline.

## Migration Plan

No manuscript or storage migration. New UI controls and RPC actions are additive. Removing them leaves normal Markdown and Git repositories intact.
