## Why

Munin Manual Studio supports both scoped in-editor AI assistance and interactive AI terminal workflows via MCP, while MarkIts embeds rich annotation and UIMap metadata inside screenshots. However, when humans and AI co-author manuals across sessions and multiple pages, three recurring friction points remain:

1. MarkIts badge numbers and UIMap element names can drift out of sync with the surrounding prose, and CLI-connected workflows cannot rely on vision review alone.
2. Handing off editor context (selected passages, images, inline TODOs) to the AI terminal requires manual retyping, and direct multi-file edits made by terminal agents lack a safe hunk-level review tray.
3. Project-wide UI labels and style terminology drift when humans and AI edit different pages without a shared glossary wired into checks, AI prompts, and MCP.

## What Changes

- **MarkIts annotation & UIMap consistency checks**: Extend `quality::check` / `quality-check` and expose MCP `check-manuscript` to detect badge step mismatches, step order inversions, and UIMap target label drift as non-blocking `warning` findings while keeping existing broken-link / missing-image checks as blocking `error` findings.
- **Editor ⇄ AI terminal handoff & inline AI notes**: Add structured context handoff from the editor, image hover controls, and manuscript check findings into the AI terminal (`sendInput` with paste-only or immediate-submit options), plus lightweight `<!-- ai-note: ... -->` comments with insertion, listing, batch handoff, and manuscript-check warnings.
- **External change review tray**: Snapshot project Markdown files when the AI terminal connects, detect external additions/modifications/deletions, and provide a multi-file hunk-level Diff tray with SHA-256 verification and dirty-draft overwrite protection.
- **Project glossary**: Persist `.munin/glossary.json`, add a Settings → Glossary tab with MarkIts UIMap candidate extraction, inject relevant glossary entries into AI editing/proofreading prompts, check prohibited variants in `quality::check` with one-click replacement, and expose MCP `project-glossary`.

## Capabilities

### New Capabilities
- None (extends existing `document-ai-assistance` capability).

### Modified Capabilities
- `document-ai-assistance`: Add MarkIts annotation/UIMap consistency checking, project glossary management and AI/MCP integration, editor-to-terminal context handoff with inline AI notes, and an external change review tray.

## Impact

- Backend (`crates/manual-core`): New `glossary.rs` and `external_changes.rs`; extended `quality.rs`, `selection_ai.rs`, `mcp.rs`, `lib.rs`, `terminal_guide.md`, and `tests/mcp_stdio.rs`.
- Frontend (`apps/manual-studio`): New `glossarySettings.ts` and `aiCollaboration.ts`; updated `main.ts`, `terminalPane.ts`, `settingsTabs.ts`, `milkdownEditor.ts`, `dialogSizing.ts`, `index.html`, and `style.css`.
- Verification & docs: Added `scripts/test_manual_studio_ai_collaboration.mjs` and updated `docs/specs/document-ai-assistance.md`.
