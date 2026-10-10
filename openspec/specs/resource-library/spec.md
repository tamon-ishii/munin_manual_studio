# resource-library Specification

## Purpose

Provide a unified project resource browser for managed screenshots, generated images and other project images. See [リソース一覧](../../../docs/specs/resource-library.md) for storage and format constraints.

## Requirements

### Requirement: Browse and filter project image resources
Manual Studio SHALL display resources without requiring a selected document or AI connection. It SHALL deduplicate image paths and support text search, kind filters and saved-document usage filters. Managed imports SHALL retain screenshot management actions. Thumbnails SHALL be loaded on demand rather than included for every image in the initial catalog.

#### Scenario: Filter unused generated images
- **WHEN** the user selects generated images and unused resources
- **THEN** only generated images without saved Markdown usage are displayed.

#### Scenario: View a missing managed image
- **WHEN** metadata references a missing output
- **THEN** the resource remains listed with its missing state.

### Requirement: Navigate saved image references
Manual Studio SHALL identify local image references in saved project Markdown, including documents outside publication targets, exclude code examples, and offer source navigation to the referenced image syntax. Explicit insertion SHALL allow a destination document and position and participate in undo and save.

#### Scenario: Navigate a reference after Unicode text
- **WHEN** a resource usage follows Japanese text or emoji and the user selects it
- **THEN** the destination source editor selects the correct image reference.

### Requirement: Preserve images during editing and replacement
Editing an ordinary resource with MarkIts SHALL create a separate copy. AI reference edits SHALL create new generated assets. Replacement SHALL show affected documents, validate the previously reviewed image hash, retain a backup and preserve manuscript text. Managed screenshot outputs SHALL only be replaced through screenshot adoption.

#### Scenario: Detect an external image change
- **WHEN** the image changes after replacement review
- **THEN** replacement is rejected without overwriting the changed image.

#### Scenario: Replace an ordinary PNG
- **WHEN** replacement is confirmed and the reviewed hash still matches
- **THEN** the original is backed up and the same asset path receives the replacement
- **AND** referencing manuscripts are not rewritten.

### Requirement: Restore reviewed resource replacements
Manual Studio SHALL offer restoration of the latest recorded, unrestored replacement while preserving manuscripts and backups. It SHALL reject restoration if the current image differs from the recorded replacement or if the backup is missing or changed. Managed screenshots SHALL use screenshot adoption instead.

#### Scenario: Restore a replacement
- **WHEN** the user requests restoration and current and backup hashes match
- **THEN** the original bytes replace the current asset at its existing path
- **AND** the backup remains and the record is marked restored.

### Requirement: Drag resource images into documents
Resource thumbnails SHALL provide project-bound drag data for rich text and source editors. Drops SHALL insert relative references without copying images, preserve managed screenshot associations, and participate in undo and save. Drops across projects or without an editable document SHALL be rejected.

#### Scenario: Drop a managed screenshot
- **WHEN** the user drops a resource screenshot into an editable manuscript
- **THEN** its relative image reference and screenshot association are inserted
- **AND** undo restores the previous manuscript.
