# Proposal

## Why

Screenshot source images and MarkIts results are currently managed through a mixed resource view, and recapture leaves revised renders as candidates that must be adopted separately. A capture-first workflow should make the source-to-render relationship explicit and keep already inserted images current after recapture.

## What Changes

- Rename the resource list workspace tab and heading to the capture list.
- Make the capture list the direct entry point for editing a capture with MarkIts and inserting the resulting image into a document.
- On recapture, reuse the saved crop and annotation scene to regenerate each derived MarkIts image and update its existing output while retaining prior revisions and source images.
- Scale saved crop and annotation coordinates when the recaptured source dimensions change; leave the existing adopted image untouched if the saved crop cannot fit or the output has an external edit.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `screenshot-library`: define the capture-list workflow, direct MarkIts image insertion, and automatic refresh of derived images after recapture.

## Impact

Manual Studio workspace labels and screenshot card actions; screenshot recapture rendering and adoption in `crates/manual-core`; existing project manifests continue to store the source identity, MarkIts scene, crop, and revisions.
