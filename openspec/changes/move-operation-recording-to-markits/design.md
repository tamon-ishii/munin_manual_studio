# Design

## Context

Manual Studio currently owns the rdev helper, event model, window capture and semantic/visual target modules. Its recorder also owns project-specific scenario registration and editor handoff. Markits is already linked into Manual Studio and has a standalone Tauri host.

## Goals / Non-Goals

Share native input recording and target capture without a reverse dependency from Markits to Manual Studio. Keep project registration and application launch profiles in the Manual Studio adapter. Recording means action data, matching the existing proposal; video encoding is outside this migration.

## Decisions

- Move window capture, capture preparation, and semantic/visual target modules into Markits. Retain compatibility re-exports in manual-core so replay and existing callers retain the same types.
- Move the event model and input helper to Markits. Both executable hosts dispatch the same helper mode. Manual Studio retains launch, scenario generation and screenshot registration; moving those would couple Markits to project management.
- Add a standalone recorder session API in Markits with explicit start, pause, history, finish and cancel operations. Store input in a helper-owned JSONL file, flush each event, and clean up helpers with RAII.
- Expose commands and a recording dialog in Markits Desktop. Keep the controls accessible while operating the target and exclude their bounds when exporting. Save operation JSON with a file dialog.

## Risks / Trade-offs

- Global input hooks require OS permissions and X11 on Linux → preserve existing errors, surface helper failure and retain cancellation.
- Native capture supports platform-specific windows → preserve implementation and compatibility re-exports; run shared module tests and both app checks.
- Refactoring resource ownership can terminate user applications → standalone sessions own only their helper; Manual Studio retains its existing launched-process ownership.

## Migration Plan

Move native modules with compatibility exports, extract input helper and events, wire both hosts, add standalone controls, then verify Rust tests and frontend builds. Retain the existing Manual Studio RPC names throughout.
