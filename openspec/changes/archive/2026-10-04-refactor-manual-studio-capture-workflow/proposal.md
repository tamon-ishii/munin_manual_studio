# Proposal: Refactor Manual Studio Capture Workflow

## Why

Manual Studio's editing and screenshot workflows had accumulated tightly coupled UI logic. Asynchronous project, document, and generation responses could outlive the selection that started them; a screenshot handoff could likewise finish after its target changed or the user cancelled. MarkIts import and insertion also needed clear retry behavior and visible progress.

## What Changes

Extract editor history, file-tree rendering, pane resizing, transport validation, Markdown tag insertion, capture-session ownership, and MarkIts workflow sequencing into focused modules. Guard asynchronous results by their owning generation or capture session. Keep capture target and launch details with the session, make image import and document insertion retryable, and show submit errors and progress in the dialog before its actions. Hide Manual Studio only immediately before a real capture through a scoped hook, then restore it afterward.

The work adds `npm run manual:check` as the project check entry point. This verifies unit/workflow behavior, a browser smoke path, Rust tests, and build steps. Native GUI checks involving capture permissions, window selection, or editing inside MarkIts remain separate integration checks; this change does not claim full GUI integration coverage or remove AI source-preparation latency.
