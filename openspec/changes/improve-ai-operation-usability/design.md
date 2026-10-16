# Design

## Context
UI draft currently invokes author::draft which writes immediately. Selection editing already has diffParts/acceptDiff. Screenshot create is sequential and retains only the raw capture on annotation failure. Reader review can submit images through HTTP but not CLI.

## Goals / Non-Goals
Candidate generation and adoption are separate RPC operations, preserving legacy CLI draft compatibility. No new provider or model capability guessing; preflight reports transport support and backend limits.

## Decisions
- Candidate CLI calls run in a detached temporary working directory, with supplied project context and Agy plan mode, so the agent cannot implicitly edit its manuscript working directory. Progress and cancellation remain scoped to the original project.
- Add draft-propose/draft-apply with original page content and revision snapshots captured before AI. Validate all accepted paths/revisions first, then back up and save; reject duplicate paths. Reuse selective Diff primitives for page/hunk review.
- Display compact persistent running status when detailed logs are hidden, with elapsed time and cancellation through the same cancellation request.
- Wrap each screenshot stage in a retry dialog retaining its inputs; completion advances state, project switches abort. Annotation failure offers retry or raw-original continuation.
- Review capability comes from current backend config via lightweight RPC, with scope-specific image counts and limits. API/local support is a submission capability, not a guarantee that the model sees images.

## Risks / Trade-offs
External AI response times remain variable; elapsed state is not a completion estimate. Multi-page writes may fail on filesystem errors after some writes; backups and atomic per-file saves protect existing files. Stage retry depends on windows remaining available; capture failure can be retried or the flow stopped.
