## 1. Backend Implementation (`crates/manual-core`)

- [x] 1.1 Implement project glossary persistence, validation, UIMap candidate extraction, prompt section builder, and text checking in `crates/manual-core/src/glossary.rs`.
- [x] 1.2 Extend `crates/manual-core/src/quality.rs` with `severity` (`error`/`warning`), `check_page`, MarkIts annotation/UIMap consistency checks (stripping code fences and HTML comments), `unresolved_ai_note` detection, and glossary violation checks.
- [x] 1.3 Implement external Markdown snapshot tracking, diffing, SHA-256-guarded hunk application, and cleanup in `crates/manual-core/src/external_changes.rs`.
- [x] 1.4 Inject glossary rules into `crates/manual-core/src/selection_ai.rs` generation and proofreading prompts.
- [x] 1.5 Add MCP tools `project-glossary` and `check-manuscript` in `crates/manual-core/src/mcp.rs`, update `crates/manual-core/src/terminal_guide.md`, and wire RPC handlers in `crates/manual-core/src/lib.rs`.

## 2. Frontend Implementation (`apps/manual-studio`)

- [x] 2.1 Implement Settings → Glossary tab (`apps/manual-studio/src/glossarySettings.ts` and `settingsTabs.ts`) with CRUD, filtering, and UIMap candidate import.
- [x] 2.2 Add `sendInput(text, submit)` to `apps/manual-studio/src/terminalPane.ts` and implement editor-to-terminal handoff, inline `<!-- ai-note: ... -->` insertion/management, and multi-file external change tray in `apps/manual-studio/src/aiCollaboration.ts`.
- [x] 2.3 Wire image hover AI handoff (`milkdownEditor.ts`), enhanced manuscript check UI (filters, one-click glossary replace, AI terminal correction handoff), snapshot polling, dialog sizing (`dialogSizing.ts`), HTML controls (`index.html`), and theme styles (`style.css`).
- [x] 2.4 Update current specification documentation in `docs/specs/document-ai-assistance.md`.

## 3. Verification

- [x] 3.1 Verify Rust unit tests (`glossary`, `external_changes`, `quality`, `selection_ai`, `terminal_tools`, `lib::tests::test_ai_collaboration_rpc_round_trip`) and MCP stdio integration tests (`tests/mcp_stdio.rs`).
- [x] 3.2 Verify TypeScript type check (`tsc --noEmit`) and Vite production bundle build.
- [x] 3.3 Verify real-browser E2E flows in Playwright (Edge) with both existing `scripts/test_manual_studio_selection_actions.mjs` and new `scripts/test_manual_studio_ai_collaboration.mjs`.
