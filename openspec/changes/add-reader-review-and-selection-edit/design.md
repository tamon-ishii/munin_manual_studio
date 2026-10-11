# Design

## Context

See proposal.md for scope. The Studio uses a textarea and Milkdown with owner-aware saving; manual-core provides scoped AI JSON calls and screenshot resources retain raw/edit/adopted versions and replay recipes. Existing in-progress implementations require integration verification.

## Goals / Non-Goals

Goals: preserve exact editing boundaries, provide truthful image coverage, and reuse native capture and MarkIts replay. Non-goals: inventing screenshots, automatically publishing changes, or replacing source link/image validation.

## Decisions

- Validate document revision and exact quote/occurrence server-side; translate anchors to UTF-16 for browser selections. Recheck owner and content at every asynchronous adoption boundary instead of applying fuzzy matches.
- Use manuscript AI settings for review/edit/annotation. Send local PNG/JPEG/WebP pixels only for API connections that can accept image inputs; constrain size/count, explicitly fall back to text review and unverified image status on unsupported input. No network fetching of external image URLs.
- Group adjacent line additions/deletions as selectable Diff hunks. Compose accepted and original hunks, validate Mermaid syntax, then use one editor transaction and normal save. Rich edits use the original ProseMirror selection snapshot.
- Split native screenshot instruction into application proposal, user registration/launch, observed-window planning, recipe confirmation, capture, and annotation. Persist raw capture before annotation and register annotation as an unadopted version. AI selects real element indices; the application resolves geometry.
- Tests use a local fake compatible AI HTTP service plus real manual-core actions and browser workflows. Native desktop capture has a platform/display requirement; tests separately verify recipe validation, bounds, persistence and frontend flow with mocked native commands.

## Risks / Trade-offs

- Unsupported image models → retry text-only, display each unverified image.
- Ambiguous or changed manuscript → reject invalid anchors and stale operations.
- Partial rich selections → verify surrounding marks and Undo with browser workflows.
- Missing accessibility metadata → retain raw image and replay recipe, offer MarkIts editing.
- Application launch side effects → show editable executable/arguments before launch; recipe supports observed controls and constrained operations.

## Migration Plan

Add commands and editor/resource entry points without overwriting stored manuscripts or screenshot versions. Keep generated edits and annotation candidates unapplied until accepted. A rollback removes the entry points; original manuscript and image assets remain usable.
