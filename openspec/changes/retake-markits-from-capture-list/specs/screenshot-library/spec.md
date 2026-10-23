# Spec Delta

## MODIFIED Requirements

### Requirement: Recapture individually or across the whole library
Manual Studio SHALL provide an individual recapture action and a whole-library recapture action. Whole-library recapture SHALL show its scope, replay saved operations sequentially, retain old sources and render revisions, and report succeeded, failed, cancelled, and skipped assets separately. No AI configuration SHALL be required.

#### Scenario: Recapture one asset
- **WHEN** a user recaptures an unprotected asset with a valid saved recording
- **THEN** its operations are replayed, a new immutable source is retained, and each derived MarkIts image is regenerated from its saved scene and crop
- **AND** the regenerated render becomes the current image at its existing output path while prior source and render revisions remain available in history.

#### Scenario: Recapture the whole library
- **WHEN** a user starts whole-library recapture
- **THEN** the confirmation lists all project screenshots and distinguishes executable recordings from skipped assets
- **AND** eligible recordings run sequentially so application focus is not shared between concurrent captures.

#### Scenario: Skip an image without a recording
- **WHEN** whole-library recapture encounters an imported image without repeatable capture instructions
- **THEN** that image is counted as skipped with an explanation and remains unchanged.

#### Scenario: Respect a protected adopted image
- **WHEN** a screenshot is explicitly protected from automatic replacement
- **THEN** whole-library recapture reports it as skipped unless the user explicitly removes that protection.

#### Scenario: Continue after a partial failure
- **WHEN** one recapture fails in a whole-library run
- **THEN** other eligible assets can complete, previously current images remain intact for the failed assets, and successful images are updated.

#### Scenario: Retry only failed recaptures
- **WHEN** a user retries the failed items in a previous recapture run
- **THEN** successful items are not captured again and retries use the recorded run conditions.

#### Scenario: Cancel and resume a run
- **WHEN** a user cancels a whole-library run
- **THEN** the active operation is stopped safely, remaining assets are recorded as unfinished, and resuming does not repeat completed captures.

#### Scenario: Transfer annotations to a changed screen
- **WHEN** a recaptured source differs in dimensions
- **THEN** the saved crop and annotation scene are proportionally mapped to the new dimensions before the current render is updated
- **AND** if the crop no longer fits the source, that image fails without changing its current render.

#### Scenario: Detect an externally changed output
- **WHEN** the adopted output was modified outside Manual Studio before a recapture finishes
- **THEN** recapture reports a failure and leaves the external file and retained source intact.

## ADDED Requirements

### Requirement: Provide a capture list as the screenshot workspace
Manual Studio SHALL label the screenshot workspace "撮影一覧" and provide its capture and managed MarkIts image actions from that list.

#### Scenario: Open the screenshot workspace
- **WHEN** a user opens the workspace previously labeled "リソース一覧"
- **THEN** its tab and heading are labeled "撮影一覧".

#### Scenario: Create and insert a MarkIts image from a capture
- **WHEN** a user chooses MarkIts editing and insertion for a capture and saves the edit
- **THEN** the crop and annotation scene are retained with the capture identity, the resulting MarkIts image is made current, and its stable document reference is inserted at the selected document cursor
- **AND** the user does not need to separately adopt the image or confirm a final screenshot dialog.

#### Scenario: Preserve the source relationship across edits
- **WHEN** a user reopens a managed MarkIts image from the capture list
- **THEN** Manual Studio supplies its retained unannotated source and restores the saved crop and annotation scene
- **AND** editing creates a new revision without modifying prior source or render revisions.
