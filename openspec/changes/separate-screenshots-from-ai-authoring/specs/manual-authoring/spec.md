# Spec Delta

## MODIFIED Requirements

### Requirement: Configure Manual Workspace
The application SHALL let users configure project-relative manuscript, published asset, and output directories and an optional drafting brief independently from application launch settings and AI connection settings.

#### Scenario: Save manual settings
- **WHEN** a user saves valid project-relative paths and a drafting brief
- **THEN** Manual Studio persists the settings for subsequent manual workspace sessions without changing preregistered applications or requiring an AI connection.

#### Scenario: Select an installed AI CLI
- **WHEN** a user opens the AI connection settings and requests the CLI selector
- **THEN** Manual Studio offers supported CLIs and identifies which commands are locally available.

#### Scenario: Choose a model
- **WHEN** the user requests model candidates and the selected CLI exposes model discovery
- **THEN** Manual Studio displays the candidates returned by that CLI.
- **WHEN** model discovery is unavailable or no model is specified
- **THEN** the user can enter a model ID or use the CLI default.


### Requirement: Run Desktop Manual Scenarios
The application SHALL replay recorded desktop operations and accessibility-based actions as screenshot workflows independently of AI, and SHALL register new capture candidates only after required steps and observations succeed.

#### Scenario: Inspect available desktop controls
- **WHEN** a user lists accessible windows and inspects one of them
- **THEN** Manual Studio shows application, title, stable window query, and accessibility tree for recording or authoring selectors.

#### Scenario: Interact with an accessible application
- **WHEN** a recording selects a window and uses a selector-based action or assertion
- **THEN** Manual Studio scopes the action to that window and reports a failing step.
- **WHEN** a recording provides a selector for text or key input
- **THEN** Manual Studio focuses that control and sends the input to it.

#### Scenario: Capture a window or element
- **WHEN** a recording requests a screenshot of a selected window or element
- **THEN** Manual Studio retains the source image and produces a library candidate after successful execution
- **AND** cropping is editable state rather than destructive modification of the source.
- **WHEN** the session uses a Wayland portal with no element selector
- **THEN** Manual Studio asks the user to choose the window through the portal.


### Requirement: Strict AI Tag Syntax and Lifecycle Rules
The application SHALL track AI prose and Mermaid tasks with stable, automatically managed identifiers and instruction hashes. Display names SHALL be optional and SHALL NOT be identifiers. New screenshot references SHALL be independent of AI tags.

#### Scenario: Tag identifier formatting
- **WHEN** the application creates internal identifiers for AI task metadata
- **THEN** it emits globally unique lowercase alphanumeric and hyphen identifiers starting with a lowercase letter
- **AND** this formatting is automatic rather than a required user input field.

#### Scenario: Create a task without entering an ID or name
- **WHEN** a user adds an AI task without an identifier or display name
- **THEN** the application assigns a unique internal identifier automatically and allows editing and generation without requiring either field.

#### Scenario: Read an anonymous hand-authored task
- **WHEN** a document contains an AI task with no identifier
- **THEN** the application can display it and assigns a stable identifier during explicit save or generation preparation
- **AND** preview alone does not modify the document.

#### Scenario: Preserve existing identifiers
- **WHEN** a document contains a valid existing task identifier
- **THEN** the identifier and associated history remain valid and are not exposed as required user input.

#### Scenario: Use duplicate or changed display names
- **WHEN** task names are omitted, repeated, or renamed
- **THEN** task identity, approvals, and execution history remain associated with the correct task.

#### Scenario: Single responsibility separation
- **WHEN** AI answers are generated or validated
- **THEN** prose and Mermaid are validated against their requested output forms
- **AND** screenshot pixels and editing state are managed by the screenshot library rather than generated inside an AI answer.

#### Scenario: Generated answer placement and tag unwrapping
- **WHEN** generating, updating, or recording an answer for an AI task
- **THEN** the answer is placed in the visible document body, outside metadata comments, using supported task or generated markers
- **AND** redundant outer metadata tags are stripped so visible content is not trapped inside comments.

#### Scenario: Validation of generated markers
- **WHEN** parsing page tags outside code examples
- **THEN** unclosed or nested generated markers are detected and rejected with an error.

### Requirement: Build and Preview Manuals
The application SHALL build draft and strict MkDocs manuals containing text, Mermaid, and adopted screenshot renders. Quality checks SHALL distinguish AI answer problems from screenshot reference problems and SHALL NOT require AI connectivity for publication.

#### Scenario: Build a draft
- **WHEN** a user builds a draft with incomplete AI tasks or image references
- **THEN** the application builds using a temporary workspace and visible placeholders without altering manuscript sources.

#### Scenario: Build a complete manual
- **WHEN** all required AI answers are current and referenced screenshot outputs exist
- **THEN** the application builds the complete HTML manual into the configured output directory.
- **WHEN** an answer is missing or stale, or a required image reference is missing or invalid
- **THEN** the strict build reports the affected task or screenshot and preserves existing output.
- **WHEN** a recapture attempt fails but a valid adopted image remains
- **THEN** the attempt is shown in screenshot history rather than invalidating that adopted image as an AI failure.

#### Scenario: Preview an image asset
- **WHEN** preview requests a managed screenshot
- **THEN** the application serves only its adopted published image from an allowed project asset location
- **AND** it does not expose retained originals or recording data through that reference.

## ADDED Requirements

### Requirement: Collapse AI instructions independently from visible answers
The editor SHALL display AI task instructions and detailed settings in an initially collapsed, keyboard-accessible section while continuing to display generated document content. Display names SHALL be optional, and routine headers SHALL not require visible internal IDs.

#### Scenario: Open a document with long AI instructions
- **WHEN** a user opens a document whose AI tasks contain long instructions
- **THEN** each instruction section starts collapsed with a compact type, optional name or short summary, and state
- **AND** generated prose or Mermaid content remains visible in the document.

#### Scenario: Edit and collapse an instruction
- **WHEN** a user expands a task, edits its instruction, and collapses it again
- **THEN** the instruction is preserved with normal save and Undo/Redo behavior
- **AND** expanding or collapsing alone does not mark the manuscript as changed.

#### Scenario: Expand a very long instruction
- **WHEN** a user expands or edits an instruction containing many lines or structured recording data
- **THEN** the instruction area has a bounded height with internal scrolling
- **AND** it does not grow without limit to displace the document content.

#### Scenario: Operate disclosure by keyboard
- **WHEN** a user focuses the instruction disclosure button and activates it by keyboard
- **THEN** the instruction section opens or closes and its accessible expanded state is updated.

#### Scenario: Display long help on Windows
- **WHEN** an AI instruction or application explanation is too long for a compact tooltip
- **THEN** full content is available in an explicit details area rather than an unbounded hover overlay
- **AND** hover help remains short and does not cover the document.

### Requirement: Generate and Review AI Authored Content
The application SHALL generate AI answers only for prose and Mermaid diagrams using a common input-confirmation, candidate-generation, review, adoption, approval, and history workflow. Screenshot capture and editing SHALL NOT be AI generation tasks or require AI credentials.

#### Scenario: Generate an answer
- **WHEN** a user requests generation for a prose or Mermaid task
- **THEN** Manual Studio prepares a reviewable answer and records creation time and instruction hash
- **AND** the document is not overwritten until the candidate is adopted.

#### Scenario: Detect changed instructions
- **WHEN** a task instruction changes after an answer was created
- **THEN** Manual Studio marks the answer stale and strict builds reject it.

#### Scenario: Approve an answer
- **WHEN** a user approves a current answer
- **THEN** Manual Studio records approval and protects the answer from automatic regeneration until explicitly unapproved.

#### Scenario: Generate a Mermaid diagram
- **WHEN** a user requests Mermaid output
- **THEN** the common AI workflow returns a fenced Mermaid block and validates it before adoption
- **AND** analysis output may be used as reference material without requiring every diagram to originate from an analysis CLI.

#### Scenario: Run document AI generation with image references
- **WHEN** a document contains AI prose, Mermaid tasks, and screenshot references
- **THEN** AI generation processes only prose and Mermaid tasks
- **AND** it does not recapture images, edit annotations, or roll back screenshot history.


### Requirement: Separate Application and Project Settings
The application SHALL provide application settings with distinct target-application, appearance, and AI-connection sections, and a separate project settings entry for source, asset, and output directories.

#### Scenario: Configure an application without AI
- **WHEN** a user opens application settings and selects target applications
- **THEN** the application offers executable-path and argument registration without requiring AI fields.

#### Scenario: Manage project directories
- **WHEN** a user opens project settings
- **THEN** the application displays manuscript, published asset, and output directory fields
- **AND** saving them does not modify application registrations or unfinished AI settings.


## REMOVED Requirements

### Requirement: Complete screenshot handoff with retry-safe capture state
**Reason**: Screenshot handoff is owned by the independent screenshot library rather than a document-bound AI task; the original contract required a document and task even when neither is needed.
**Migration**: Preserve retry-safe registration, empty annotations, progress feedback, source retention, scoped ownership, and Studio hide/restore under screenshot-library requirements. Existing document insertions remain readable and migrate explicitly to asset references.

### Requirement: Generate and Review Task Answers
**Reason**: The previous contract groups screenshot capture and automatic annotations with AI answers and requires analysis-CLI output for diagrams.
**Migration**: Use the shared prose/Mermaid review workflow and screenshot-library capture, recapture, and saved-scene editing. Legacy screenshot and PyCharm captures remain readable or importable without AI execution.

### Requirement: Centralized Settings Popup Modal
**Reason**: A combined modal conflates application registration, AI connection, and project paths.
**Migration**: Retain stored settings while providing distinct target-application, appearance, AI-connection, and project entries.
