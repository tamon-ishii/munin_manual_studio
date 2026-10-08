# Spec Delta

## Purpose

Manage screenshots as independent project assets with immutable full-size originals, editable MarkIts scenes, repeatable recording workflows, and document references, so users can capture and revise images without AI access or loss of the source pixels.

## ADDED Requirements

### Requirement: Provide an independent screenshot library
Manual Studio SHALL provide a project screenshot list with thumbnails, optional names, capture or edit state, and document usage. The list SHALL support capture, recording, import, MarkIts editing, document insertion, individual recapture, whole-library recapture, and history without an AI connection or a selected document.

#### Scenario: Capture with AI disabled
- **WHEN** a user with AI disabled selects a registered application and records operations for a screenshot
- **THEN** the application completes recording, capture, and MarkIts handoff without invoking an AI provider or asking for AI settings.

#### Scenario: Register before writing a document
- **WHEN** a capture or import completes with no document selected
- **THEN** the screenshot is registered in the library without requiring creation or saving of an AI task or document.

#### Scenario: Omit a screenshot name
- **WHEN** a user registers an image without a display name
- **THEN** it receives an automatic internal identity and is listed using an application name or capture date
- **AND** assigning or changing an optional name does not change references or history.

### Requirement: Preserve immutable full-size source images
Manual Studio SHALL retain the original unannotated image separately from edit state and rendered output. Annotation, cropping, exporting, saving, retrying, and recapturing SHALL NOT modify or delete an existing source image. Full-size source images and recording data SHALL NOT be included in manual HTML publication merely because an exported screenshot is referenced.

#### Scenario: Enlarge a crop after saving
- **WHEN** a user reopens a cropped screenshot and expands the crop beyond its previous boundary
- **THEN** MarkIts displays the retained original pixels and saves a new edit without modifying the source image.

#### Scenario: Move an existing annotation
- **WHEN** a user reopens an annotated screenshot and moves or removes a mark
- **THEN** the editor applies the editable scene to the unannotated source
- **AND** old baked-in marks do not remain underneath the new scene.

#### Scenario: Verify source preservation
- **WHEN** a screenshot is repeatedly edited, exported, or retried
- **THEN** the saved original's content remains byte-for-byte unchanged.

#### Scenario: Publish a cropped image
- **WHEN** a manual containing a managed screenshot is published
- **THEN** the referenced adopted render is included
- **AND** full-size originals, alternative renders, scene data, and operation recordings are excluded from the published site.

### Requirement: Reopen complete MarkIts editing state
Manual Studio SHALL reopen a screenshot from its retained source image, editable annotation state, crop state, and coordinate mapping. Finishing with no annotations SHALL be valid, and cancelling or failing an edit SHALL retain the previous adopted version.

#### Scenario: Resume an edit after restarting Studio
- **WHEN** a user selects MarkIts editing for a previously saved screenshot after restarting the applications
- **THEN** the source image, marks, crop, and their coordinate relationship are restored for modification.

#### Scenario: Finish without annotations
- **WHEN** a user completes a screenshot with an empty annotation scene
- **THEN** the image is registered with a valid empty edit state and preserved original.

#### Scenario: Cancel an edit
- **WHEN** a user cancels MarkIts editing or MarkIts exits before completing it
- **THEN** the previous adopted output remains unchanged and the retained source can be reopened.

### Requirement: Keep screenshot references independent from AI tasks
Manual Studio SHALL insert managed screenshots using ordinary Markdown images with an asset association, support multiple references to one asset, and track usage without requiring AI task tags. Updating an adopted render SHALL preserve document text and source images.

#### Scenario: Insert the same screenshot in two documents
- **WHEN** a user inserts one library screenshot into two documents
- **THEN** both references are associated with the same asset without creating duplicate captures or AI tasks.

#### Scenario: Adopt a revised image
- **WHEN** a user adopts a revised render after reviewing its document usage
- **THEN** previews and published references use the adopted render
- **AND** unrelated manuscript text is not rewritten.

#### Scenario: Remove only a document reference
- **WHEN** a user removes an image from a manuscript
- **THEN** the screenshot and its editing history remain in the library.

#### Scenario: Delete a referenced screenshot
- **WHEN** a user attempts ordinary library deletion for a referenced asset
- **THEN** the application shows affected documents and prevents deletion until references are explicitly removed.

### Requirement: Recapture individually or across the whole library
Manual Studio SHALL provide an individual recapture action and a whole-library recapture action. Whole-library recapture SHALL show its scope, replay saved operations sequentially, preserve old sources and adopted outputs, and report succeeded, failed, cancelled, and skipped assets separately. No AI configuration SHALL be required.

#### Scenario: Recapture one asset
- **WHEN** a user recaptures an asset with a valid saved recording
- **THEN** its operations are replayed, a new source is retained, and a comparison candidate is produced without overwriting the existing source or adopted output.

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

### Requirement: Commit screenshot results safely
Manual Studio SHALL durably preserve captured sources before cleaning temporary files and associate editing and recapture completion with the initiating project, asset, revision, and session. Registration and adoption SHALL be retry-safe and protect externally modified outputs.

#### Scenario: Retry completed capture registration
- **WHEN** registration is retried after a crash or an interrupted handoff
- **THEN** retained data is reused without duplicate assets or loss of the source image.

#### Scenario: Switch projects before completion
- **WHEN** a screenshot operation completes after its project or session has been superseded
- **THEN** its result is not inserted or registered in the newly selected project.

#### Scenario: Detect external output edits
- **WHEN** an adopted output was edited externally while a replacement candidate was prepared
- **THEN** adoption reports the conflict and leaves both the external file and retained source intact.

#### Scenario: Hide Studio during capture
- **WHEN** a native screenshot is about to be taken
- **THEN** Studio hides immediately before capture and the owning capture flow restores it afterward.

### Requirement: Migrate legacy screenshot tasks without data loss
Manual Studio SHALL read legacy screenshot tags and offer an explicit, repeatable migration to library assets and image references. Migration SHALL preserve image pixels, recoverable editing data, launch arguments, recording conditions, protection state, and readable history without AI execution.

#### Scenario: Migrate a legacy screenshot
- **WHEN** a user adopts migration for an existing screenshot task
- **THEN** the image becomes a library asset and the document receives an image reference while text and diagram tasks retain their content and identities.

#### Scenario: Import a flattened legacy image
- **WHEN** a legacy image has no recoverable unannotated original
- **THEN** the application explicitly identifies it as a flattened import
- **AND** it does not offer to recover removed pixels or separately edit old baked-in marks.

#### Scenario: Cancel or repeat migration
- **WHEN** migration is cancelled, fails, or is run again
- **THEN** existing documents and images are retained, backups remain available, and completed migrations are not duplicated.
