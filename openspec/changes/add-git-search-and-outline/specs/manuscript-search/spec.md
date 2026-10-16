# Spec Delta

## Purpose

Help authors locate text across project manuscripts and make reviewed, selective replacements while protecting unrelated text and concurrent edits.

## ADDED Requirements

### Requirement: Search project manuscripts
The application SHALL search literal text across project Markdown, support case sensitivity, and show file, line, excerpt and precise navigation. Hidden storage, dependencies, build output and paths outside the project SHALL be excluded. Limits and unreadable files SHALL be reported.

#### Scenario: Search Japanese and emoji text
- **WHEN** a match follows Japanese text or emoji
- **THEN** selecting the result highlights the exact occurrence in its manuscript.

### Requirement: Review and select replacements
Users SHALL select individual matches and review each affected manuscript's before/after content before applying. Only selected occurrences SHALL change. Invalid selections, stale revisions, and unsaved affected drafts SHALL reject application without silently losing edits.

#### Scenario: Replace a subset
- **WHEN** a user selects one of several occurrences across manuscripts
- **THEN** only that occurrence changes and unselected files and occurrences remain intact.

#### Scenario: External edit during review
- **WHEN** any affected manuscript changes before application
- **THEN** application is rejected before writing any reviewed file.

### Requirement: Undo a replacement batch
The UI SHALL offer undo of its most recent applied replacement batch. Undo SHALL verify the resulting revisions and refuse to overwrite later external or editor changes. A failed batch write SHALL attempt restoration of earlier writes and report failures.

#### Scenario: Undo across multiple manuscripts
- **WHEN** no affected file has changed after a batch and the user requests undo
- **THEN** every file in that batch returns to its pre-replacement content.
