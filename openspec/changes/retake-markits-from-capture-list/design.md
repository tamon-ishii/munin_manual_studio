# Design

## Context

The screenshot library already stores capture groups, immutable source PNGs, edit revisions, crop metadata, and MarkIts scenes in project-managed manifests. The UI combines that library with unrelated project images under the "リソース一覧" label. Recapture currently writes an unadopted candidate and does not rescale saved edits when source dimensions change.

## Goals / Non-Goals

**Goals:**
- Keep the existing managed screenshot identity and document references stable while refreshing their output pixels.
- Make editing and inserting a MarkIts result available directly from the capture list.
- Preserve prior revisions and immutable source files for history and rollback.

**Non-Goals:**
- Automatically infer semantic movement of controls inside the target application; saved marks are mapped proportionally when dimensions change.
- Change unrelated AI-generated image workflows or the Markdown reference format.

## Decisions

- Treat the existing screenshot manifest and edit revisions as the embedded relationship between a MarkIts image and its capture source. The public PNG remains pixel-only; source pixels and edit metadata remain in the managed project store.
- Recapture regenerates and adopts the new render at the existing output path. This updates all existing Markdown references without rewriting documents. Prior immutable originals and renders remain in revision history.
- Scale crop offsets, crop dimensions, and scene geometry against the old and new source dimensions. If the mapped crop is invalid, report that item as failed and do not replace its current image.
- Keep protection and output-integrity checks in the adoption path. A protected image remains skipped, and an externally modified output is never overwritten.
- Add an explicit MarkIts-edit-and-insert action. It records the selected document before opening MarkIts, adopts the saved revision with the current-revision guard, then inserts the stable screenshot reference if the project and document are still the same.

## Risks / Trade-offs

- Proportional mapping preserves relative placement but cannot detect semantic UI changes → keep previous revisions available and allow users to reopen the image in MarkIts.
- Auto-adoption can propagate a visually poor capture to documents → retain old revisions, preserve protection controls, and keep failed recaptures from changing output.
- The edit-and-insert handoff may finish after the user switches documents → bind the operation to the original project and document and skip insertion when either changed.

## Migration Plan

No project migration is required. Existing manifests already contain the source identity, crop, scene, and revisions; the UI label changes in place. Rollback consists of restoring a prior render revision through the existing history controls.
