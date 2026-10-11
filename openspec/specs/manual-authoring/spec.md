# manual-authoring Specification

## Purpose
Enables users to edit ordinary Markdown, review scoped AI suggestions, manage reproducible screenshots, and build and preview MkDocs manuals in Munin Manual Studio.

## Requirements

### Requirement: Author without a project screen inventory
Manual Studio SHALL NOT expose a screen-list or UI Map panel, generate a project-wide UI map, import UI observations, or explore a Web application to populate such a map. Application context and workspace state SHALL omit UI map data. Fact checking and dependency evidence SHALL use current project source directly. Screenshot recording, recapture and image element metadata SHALL remain available without a project UI map.

#### Scenario: Open an existing project containing a legacy UI map
- **WHEN** a project contains a previously saved UI map
- **THEN** the application opens without exposing or loading a screen-list panel
- **AND** legacy user data is preserved while current source provides evidence for documentation checks.

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

### Requirement: Create a Plain Manual Draft
The application SHALL create a reviewable initial Markdown draft without AI task metadata and protect existing manuscripts from silent overwrite.

#### Scenario: Create the first draft
- **WHEN** the user supplies a high-level brief and requests an AI draft
- **THEN** Manual Studio creates ordinary editable Markdown and preserves existing files.

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

### Requirement: Retire AI tags while preserving legacy content
The application SHALL omit AI tag creation, task lists, approval and automatic task updates. Opening legacy Markdown SHALL expose its visible generated content as ordinary prose without changing the source file. Explicit save SHALL remove retired AI metadata while preserving visible content.

#### Scenario: Open a legacy tagged manuscript
- **WHEN** a manuscript contains retired AI task metadata and a generated answer
- **THEN** the editor displays ordinary manuscript content without task controls
- **AND** opening and previewing alone do not rewrite the file.

### Requirement: Build and Preview Manuals
The application SHALL build draft and strict MkDocs manuals containing text, Mermaid, and adopted images. Publication SHALL NOT require AI connectivity or retired AI task states. Strict checks SHALL report missing or invalid local images, broken links and missing heading anchors while preserving existing output on failure.

#### Scenario: Build a draft
- **WHEN** a user builds a draft with unresolved local references
- **THEN** the application builds using a temporary workspace without altering manuscript sources.

#### Scenario: Build a complete manual
- **WHEN** required local references and images are valid
- **THEN** the application builds the complete HTML manual into the configured output directory.
- **WHEN** a required local reference or image is missing or invalid
- **THEN** the strict build reports the affected manuscript and preserves existing output.
- **WHEN** a recapture attempt fails but a valid adopted image remains
- **THEN** the attempt appears in screenshot history without invalidating that adopted image.

#### Scenario: Preview an image asset
- **WHEN** preview requests a managed screenshot
- **THEN** the application serves its adopted published image from an allowed project asset location
- **AND** retained originals and recording data are not exposed through that reference.

### Requirement: Persist AI and Manual Settings
The application SHALL persist AI selections, models, and build parameters both per-project and across sessions.

#### Scenario: Immediate persistence on change
- **WHEN** a user selects an AI CLI, model, or document format
- **THEN** the application persists the choice to local storage and updates the project configuration file.

### Requirement: Keep Manual Studio asynchronous work bound to its owner
Manual Studio SHALL apply asynchronous results only while the document, project, generation, or capture session that initiated the work remains current.

#### Scenario: A project or document changes while work is pending
- **WHEN** a project, document, or list request completes after the user has selected a different target
- **THEN** Manual Studio does not apply the stale response to the newly selected target.

#### Scenario: A capture is cancelled or superseded
- **WHEN** capture work completes after its session has been cancelled or replaced
- **THEN** Manual Studio does not insert the returned image, save against the new target, or register a capture source for that session.

### Requirement: Provide repeatable Manual Studio workflow checks
The project SHALL provide a documented check command for Manual Studio workflow and build verification, with native GUI integration coverage described separately.

#### Scenario: Run the Manual Studio check command
- **WHEN** a developer runs `npm run manual:check`
- **THEN** the scripted workflow, browser, build, and Rust checks run and report their outcomes.

#### Scenario: Interpret UI workflow coverage
- **WHEN** a developer reviews the browser-based capture workflow checks
- **THEN** the documentation states that mocked native calls do not verify actual MarkIts Desktop editing or complete native GUI integration.

### Requirement: Separate Application and Project Settings
The application SHALL provide application settings with distinct target-application, appearance, and AI-connection sections, and a separate project settings entry for source, asset, and output directories.

#### Scenario: Configure an application without AI
- **WHEN** a user opens application settings and selects target applications
- **THEN** the application offers executable-path and argument registration without requiring AI fields.

#### Scenario: Manage project directories
- **WHEN** a user opens project settings
- **THEN** the application displays manuscript, published asset, and output directory fields
- **AND** saving them does not modify application registrations or unfinished AI settings.

### Requirement: Keep dialogs and secondary operations contained
Manual Studio SHALL constrain dialog width and height to the current viewport, allow vertical scrolling, and avoid horizontal overflow in forms. Primary screenshot operations SHALL remain visible while history and management operations are grouped in a collapsible section. Explanations SHALL be concise and avoid duplicated headings or obsolete AI capture guidance.

#### Scenario: Register several applications in a small window
- **WHEN** a user opens application registration with several profiles and long executable paths
- **THEN** form controls remain within the dialog and the save action remains reachable without horizontal scrolling.


### Requirement: Preserve multiple document tabs and image tabs
Manual Studio SHALL keep open Markdown drafts, cursor positions and undo histories when switching tabs. Closing a dirty document, changing project or closing the desktop application SHALL allow saving, discarding or cancelling without silently losing drafts. Image tabs SHALL provide a visible image viewport, fitted and actual-size views, while retaining document drafts.

#### Scenario: Switch from an unsaved document to an image
- **WHEN** a user edits a document, opens a project image and returns to the document tab
- **THEN** the image is visibly displayed while its tab is active
- **AND** the document draft and undo history remain available on return.

### Requirement: Create and insert assets from the file tree
The file tree SHALL offer Markdown and folder creation at the selected directory through a context menu. Project image files SHALL be draggable into the rich text or source editor as relative image references without copying the original asset.

#### Scenario: Create within a nested directory
- **WHEN** a user opens the context menu for a folder and creates a Markdown document or folder
- **THEN** the new item is created inside that folder and appears in the tree.

### Requirement: Choose the destination of image insertion
Image insertion SHALL offer a document and an insertion position comprising the current cursor where applicable, the document end, or a heading. Successful insertion SHALL reveal the destination editor and participate in undo, redo and save.

#### Scenario: Insert an image into another document
- **WHEN** the user chooses another document and its insertion position
- **THEN** the image reference is added to that document without discarding the previously active draft.

### Requirement: Persist toolbar preferences independently
Toolbar item visibility SHALL be configurable, persisted locally and resettable without changing document content.

#### Scenario: Customize the editing toolbar
- **WHEN** a user hides a formatting action or resets toolbar preferences
- **THEN** the toolbar updates without marking the manuscript as changed.

### Requirement: Generate and review AI artwork
Image generation SHALL follow the dedicated `ai-image-generation` specification; unified resource operations SHALL follow `resource-library`.

Manual Studio SHALL support separately configured image generation, prompt input, ongoing status, saved image preview and explicit insertion into a selected document. API keys SHALL not be persisted in project settings or generated-image metadata. API errors SHALL preserve document content.

#### Scenario: Review a generated image before insertion
- **WHEN** image generation succeeds
- **THEN** a project asset and generation metadata are saved and the preview becomes available
- **AND** the document changes only after explicit insertion.

### Requirement: Automatically save document edits with compact status
Manual Studio SHALL automatically save edited documents after an idle interval and before document operations or switching document tabs. Unsaved changes SHALL be marked with an asterisk after the tab filename. The editor SHALL omit the ordinary save button and duplicate filename header, retain save errors and conflicts visibly, and preserve edits on failed saves. Ctrl/Cmd+S SHALL allow an explicit retry.

#### Scenario: Save an idle edit
- **WHEN** a document is edited and the idle interval elapses
- **THEN** the document is saved without a button action
- **AND** its tab asterisk disappears after the save succeeds.

#### Scenario: Preserve a failed save
- **WHEN** automatic saving fails or detects an external revision conflict
- **THEN** the editor retains the draft and shows the failure
- **AND** the user can retry with Ctrl/Cmd+S.

### Requirement: Navigate publication check findings
Publication checks SHALL provide issue locations where identifiable for missing or invalid images, broken local links, and missing heading anchors. Each finding SHALL offer navigation to its source without modifying document content.

#### Scenario: Navigate a repeated broken reference
- **WHEN** the user selects a finding for a reference repeated in the same document
- **THEN** the source editor selects the occurrence identified by the finding.

### Requirement: Configure image presentation in manuscripts
Manual Studio SHALL provide image width from 1 to 100 percent of the manuscript column, left/center/right alignment and optional plain-text captions. Settings SHALL persist in Markdown using an HTML figure and survive rich editing, preview, publication and reopening. Alternative text SHALL remain separate and caption text SHALL be escaped. Settings SHALL participate in undo and save.

#### Scenario: Save an aligned image with a caption
- **WHEN** the user configures an image to 80 percent width, right alignment and a caption
- **THEN** editing and preview reflect the settings
- **AND** saving and reopening preserve the width, alignment, caption and alternative text.

### Requirement: Replace a manuscript image by resource drop
Dropping a project resource on a manuscript image SHALL replace that reference while preserving its position, caption, alternative text and presentation. Source editing SHALL use the image syntax at the cursor or selection. File contents SHALL remain unchanged, screenshot associations SHALL follow the replacement resource, and undo SHALL restore the previous reference.

#### Scenario: Replace a configured image
- **WHEN** a resource is dropped on a configured image in the rich editor
- **THEN** the reference changes without inserting a second image or overwriting either asset
- **AND** its caption and presentation remain and undo restores the previous reference.

### Requirement: Keep review and Diff results readable
Manual Studio SHALL distinguish finding categories and severity from the finding message and provide an explicit empty state for filters. The Diff view SHALL show unchanged context once in a keyboard-operable disclosure, display the selected change count, and distinguish the apply action from discard and retry.

#### Scenario: Filter without matching findings
- **WHEN** the selected finding category has no remaining findings
- **THEN** the results state that the category has no findings without hiding image verification warnings.

#### Scenario: Select a subset of candidate changes
- **WHEN** the user unchecks a change or chooses all accept or all reject
- **THEN** the selected change count updates to match the actual adoption choices
- **AND** unchanged context can be expanded without changing the adoption choices.

### Requirement: Offer screenshot insertion methods in the editor
The editor SHALL provide one screenshot insertion entry with manual capture, AI instruction and existing adopted screenshot choices. Each method SHALL preserve the captured document and cursor, preview before insertion, preserve selected prose and support Undo. Manual capture and existing image selection SHALL NOT require AI settings or AI calls.

#### Scenario: Capture manually while editing
- **WHEN** the user chooses manual capture, selects a registered app, records operations and saves the capture in MarkIts
- **THEN** the editor offers a preview and insertion at the original cursor without visiting the resource library or calling AI.

#### Scenario: Choose an existing screenshot
- **WHEN** the user chooses a saved screenshot
- **THEN** the adopted version is previewed and inserted without adopting another candidate.

#### Scenario: Cancel screenshot insertion
- **WHEN** the user cancels method selection, recording selection or candidate preview
- **THEN** the manuscript remains unchanged and previously captured resources remain available.
