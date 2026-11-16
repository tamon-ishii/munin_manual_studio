# Spec Delta

## MODIFIED Requirements

### Requirement: Provide an independent screenshot library
Manual Studio SHALL provide a project-owned 撮影リソース一覧 Dock with thumbnails, optional names, capture state and document usage. Capture SHALL register the metadata-bearing MarkIts result without inserting it into Markdown. Resource registration, editing, generation and recapture SHALL work without AI configuration or a selected document; only insertion requires an editable document.

#### Scenario: Capture with AI disabled
- **WHEN** a user with AI disabled starts a capture
- **THEN** MarkIts completes recording and capture without invoking AI or asking for AI settings.

#### Scenario: Register before writing a document
- **WHEN** a capture or import completes with no document selected
- **THEN** the metadata-bearing result is durably registered in the resource Dock without creating or saving a document.

#### Scenario: Omit a screenshot name
- **WHEN** a user registers an image without a display name
- **THEN** it receives an automatic internal identity and is listed using an application name or capture date
- **AND** assigning or changing an optional name does not change references or history.

#### Scenario: Capture from an open manuscript
- **WHEN** capture completes while a manuscript is open
- **THEN** the resource becomes available in the Dock and the manuscript remains unchanged until explicit insertion.

### Requirement: Return from MarkIts without full-library work before insertion preview
After MarkIts completion and durable registration, Studio SHALL restore its window and show the completed resource without waiting for a full-library scan. Capture SHALL NOT automatically open insertion preview or alter the manuscript. Explicit generation and insertion SHALL retain project and document ownership checks, cancellation and retry.

#### Scenario: Finish a manual capture for insertion
- **WHEN** MarkIts saves a manual capture started from the manuscript editor
- **THEN** Studio restores its window and exposes the saved resource in the Dock
- **AND** the user can separately generate and insert a document image without redoing capture.

### Requirement: Preserve PNG pixels without recompressing public renders
Generating a document PNG SHALL retain its rendered pixel chunks without recompression while removing private MarkIts metadata and embedding only the capture resource ID as application metadata. The metadata-bearing source and editable state SHALL remain separately available in project-private storage.

#### Scenario: Export an annotated image
- **WHEN** a PNG containing private source-image metadata is registered and a document image is generated
- **THEN** the document PNG has identical decoded rendered pixels and its only application metadata is the capture resource ID
- **AND** the retained original is unchanged.

### Requirement: Recapture individually or across the whole library
Manual Studio SHALL provide an individual resource recapture action that updates compatible derived document images and a whole-library recapture action. Whole-library recapture SHALL show its scope, replay saved operations sequentially, preserve old sources and adopted outputs, and report succeeded, failed, cancelled, and skipped assets separately. No AI configuration SHALL be required.

#### Scenario: Recapture one asset
- **WHEN** a user recaptures an asset with a valid saved recording
- **THEN** MarkIts replays its saved operation metadata, a new private source is retained, and compatible document outputs are updated at their existing paths; uncertain annotation or crop alignment is held for comparison without changing the adopted output.

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
- **THEN** other eligible assets can complete, previously adopted images remain intact, and successful candidates remain available for review.

#### Scenario: Retry only failed recaptures
- **WHEN** a user retries the failed items in a previous recapture run
- **THEN** successful items are not captured again and retries use the recorded run conditions.

#### Scenario: Cancel and resume a run
- **WHEN** a user cancels a whole-library run
- **THEN** the active operation is stopped safely, remaining assets are recorded as unfinished, and resuming does not repeat completed captures.

#### Scenario: Transfer annotations to a changed screen
- **WHEN** a recaptured source differs in dimensions or element positions
- **THEN** inherited annotations are presented for verification before adopting the candidate
- **AND** the application does not claim that the old annotations are correctly aligned without verification.

### Requirement: Branch editable screenshots from one capture
Manual Studio SHALL allow copying a selected screenshot revision as a separate library item with its immutable full-size original, editable annotations, crop, UI metadata, and capture recipe retained. The copy SHALL have independent identity, published output, edit history, adoption, and document references.

#### Scenario: Create multiple annotations from one screenshot
- **WHEN** a user copies a selected revision and edits its annotations or expands its crop in MarkIts
- **THEN** the copy can use the full-size original and editable scene
- **AND** the source screenshot, its annotations, and its document references remain unchanged.

#### Scenario: Remove the source after copying
- **WHEN** an unreferenced source screenshot is deleted
- **THEN** its copies remain viewable and reeditable with their retained original pixels.

#### Scenario: Recapture a shared source once
- **WHEN** one capture has three independent annotation images and a user recaptures any of them or the whole library
- **THEN** the application captures that source once and applies each annotation image's own scene and crop to the same new original
- **AND** successful captures are reused when resuming or retrying rendering within the same run
- **AND** protected variants remain unchanged and individual resource recapture updates compatible variants, uncertain alignment requires explicit adoption, and whole-library candidates retain explicit adoption for each variant.

## ADDED Requirements

### Requirement: Identify document images by capture resource metadata
Each generated PNG SHALL carry an opaque stable capture resource ID. Studio SHALL resolve its source from that ID without requiring an adjacent Markdown comment. Multiple derived images SHALL retain their independent edit state and paths while referencing the same capture resource. Unknown IDs SHALL NOT trigger replay or arbitrary source selection.

#### Scenario: Copy or rename a document image
- **WHEN** a generated PNG is copied or renamed within the project with its metadata intact
- **THEN** Studio identifies its capture resource from the embedded ID and tracks saved Markdown usage at its current path.

#### Scenario: Missing resource identity
- **WHEN** a PNG has no resource ID or the ID cannot be resolved within the project
- **THEN** it remains viewable but source-based recapture is unavailable with an explanation.

### Requirement: Recapture resources and update their derived images
Resource recapture SHALL replay operations stored in the private MarkIts metadata through MarkIts. Successful recapture SHALL regenerate linked document images with their individual edit state and existing paths, preserve their resource ID and refresh previews. Old originals SHALL remain retained. Uncertain annotation alignment SHALL require comparison before adoption.

#### Scenario: Update two documents from one resource
- **WHEN** successful resource recapture produces compatible output used by images in two documents
- **THEN** all linked outputs update and previews refresh without changing Markdown text, captions or paths.

#### Scenario: Changed screen dimensions
- **WHEN** a new capture makes saved annotation or crop alignment uncertain
- **THEN** the affected output remains unchanged until its candidate is reviewed and adopted.

#### Scenario: Capture fails or is cancelled
- **WHEN** replay, rendering or validation fails or the user cancels
- **THEN** no incomplete replacement is adopted, previous images remain usable and Studio returns from capture mode.

#### Scenario: No recorded operations
- **WHEN** a resource has no replayable operation metadata
- **THEN** recapture is unavailable with a reason and the resource remains usable for generation and insertion.

#### Scenario: Externally edited output
- **WHEN** an output changes externally before its update is committed
- **THEN** replacement is rejected for that output and the conflict is reported without overwriting the external edit.

### Requirement: Convert existing metadata-bearing document images safely
Studio SHALL offer explicit registration and conversion of existing metadata-bearing MarkIts PNGs into private resources and ID-only document images. Conversion SHALL preserve rendered pixels, Markdown references and recoverable editing data, retain a backup and avoid duplicate registration on retry. Failed or cancelled conversion SHALL retain the original image.

#### Scenario: Convert an existing manuscript image
- **WHEN** the user converts a referenced MarkIts PNG
- **THEN** its private metadata is retained in a resource and the referenced PNG contains the same rendered pixels with only the resource ID as application metadata.

#### Scenario: Retry conversion
- **WHEN** conversion is interrupted and repeated
- **THEN** the existing registration and backup are reused without duplicating the resource or losing the original.
