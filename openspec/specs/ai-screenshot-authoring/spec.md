# ai-screenshot-authoring Specification

## Purpose

自然文の撮影・注釈指示を実際のアプリ操作とスクリーンショットに変換し、原本と注釈と撮影手順を保存する。アプリ登録から候補確認までをつなぎ、同じ手順で後日再撮影できるようにする。

## Requirements

### Requirement: Application registration from instruction
The system SHALL automatically fill the target executable and launch arguments using the instruction, existing registrations and project launch documentation, reuse an existing registration when possible, and allow checking or correcting the executable and arguments before registration and launch.

#### Scenario: Reuse a registered application without AI registration
- **WHEN** the user selects a registered application for screenshot instructions
- **THEN** saved launch settings are used without an AI registration request or another registration form.

#### Scenario: Target is not registered
- **WHEN** the instruction names an unregistered app
- **THEN** one AI request investigates both the real executable path and required arguments, then presents the populated registration form for confirmation before launching

#### Scenario: Prepare launch arguments automatically
- **WHEN** project launch documentation or the screenshot instruction identifies required arguments
- **THEN** AI fills the registration arguments without manual entry, preserving arguments containing spaces as single entries
- **AND** selecting a different executable triggers AI completion before registration and launch.

### Requirement: Reviewable real screenshot recipe
The system SHALL derive navigation from observed accessibility elements, let the user review the recipe, and capture the actual selected app window. The recipe MUST reject unsupported operations and fabricated targets.

#### Scenario: Requested control cannot be observed
- **WHEN** a proposed action refers to an unobserved control
- **THEN** the action is rejected and the user can use operation recording instead

### Requirement: Reproducible annotations and adoption
The system SHALL create annotation candidates using real captured element bounds, preserve the raw screenshot and replay recipe, and offer comparison and adoption through the resource library. Subsequent recapture SHALL reuse the stored recipe and annotations without requiring AI.

#### Scenario: Number toolbar buttons
- **WHEN** the user requests numbered toolbar buttons and the buttons are present in captured metadata
- **THEN** a MarkIts candidate places numbered badges at those real elements

#### Scenario: Annotation fails after capture
- **WHEN** annotation cannot identify the requested elements
- **THEN** the captured original and replay recipe remain available for manual annotation

### Requirement: Create screenshots at the manuscript cursor
The editor SHALL offer AI instruction within the shared screenshot insertion action that captures the current document and cursor position, previews the captured candidate, and offers explicit adoption and insertion at that position. It SHALL preserve selected prose and support Undo. Cancellation or changed ownership/content SHALL leave the manuscript unchanged while retaining captured assets.

#### Scenario: Insert a screenshot while editing
- **WHEN** a user places the cursor in a manuscript, requests a screenshot and accepts its preview
- **THEN** the adopted screenshot reference is inserted at the captured position without visiting the resource library
- **AND** Undo removes the inserted reference without deleting the screenshot asset.

#### Scenario: Discard or invalidate an insertion
- **WHEN** the preview is closed or the manuscript changes before insertion
- **THEN** no screenshot reference is inserted and captured assets remain in the resource library.
