# manual-authoring Specification

## Purpose
Enables developers to draft, review, build, and preview MkDocs manuals inside ModuleLoom using tagged Markdown templates and locally authenticated AI CLIs.

## Requirements

### Requirement: Configure Manual Workspace
The application SHALL let users configure the manual template directory, output directory, high-level drafting brief, AI CLI, and optional model ID.

#### Scenario: Save manual settings
- **WHEN** a user saves valid project-relative paths and a drafting brief
- **THEN** ModuleLoom persists the settings for subsequent manual workspace sessions.

#### Scenario: Select an installed AI CLI
- **WHEN** a user opens the AI CLI selector
- **THEN** ModuleLoom offers Codex, Claude Code, Grok Build, and Agy and identifies which commands are available locally.

#### Scenario: Choose a model
- **WHEN** the user requests model candidates and the selected CLI exposes model discovery
- **THEN** ModuleLoom displays the candidates returned by that CLI.
- **WHEN** model discovery is unavailable or no model is specified
- **THEN** the user can enter a model ID or use the CLI default.

### Requirement: Create a Tagged Manual Draft
The application SHALL create an initial Markdown manual draft containing unique `ai:task` tags for content that needs generation.

#### Scenario: Create the first draft
- **WHEN** the user supplies a high-level brief and requests an AI draft
- **THEN** ModuleLoom creates a reviewable draft with provenance markers and does not overwrite existing templates.

### Requirement: Generate and Review Task Answers
The application SHALL scan `ai:task` tags for text, screenshot, and diagram work and track each generated answer against its instruction.

#### Scenario: Generate an answer
- **WHEN** the user requests generation for a task
- **THEN** ModuleLoom records the answer body, creation timestamp, and instruction hash.

#### Scenario: Detect changed instructions
- **WHEN** a task instruction changes after an answer was created
- **THEN** ModuleLoom marks that answer stale and strict builds reject it.

#### Scenario: Approve an answer
- **WHEN** the user approves a current answer
- **THEN** ModuleLoom records the approval timestamp and protects the approved answer from automatic regeneration.

#### Scenario: Generate a module diagram
- **WHEN** a diagram task is generated
- **THEN** ModuleLoom obtains the Mermaid graph from its analysis CLI MkDocs output and produces ONLY the pure fenced code block without captions, annotations, or attribution footers.

#### Scenario: Capture a screenshot in PyCharm
- **WHEN** a screenshot task is captured from the PyCharm plugin
- **THEN** ModuleLoom saves a PNG of its tool window as a manual asset and records ONLY the pure image Markdown (`![<id>](<path>)`) without captions, explanatory text, or attribution footers. Annotations or explanations MUST be placed in separate `kind=text` tasks.

#### Scenario: Auto-capture all screenshots
- **WHEN** the user triggers batch screenshot capture
- **THEN** ModuleLoom sequentially displays the relevant views for each screenshot task, captures the updated visual state, saves the assets, and compiles an updated draft preview without requiring manual view switching per task.

#### Scenario: Smart screenshot annotations (red circle, bounding box, arrow, and label)
- **WHEN** a screenshot task instruction or interactive feedback prompt specifies element IDs, classes, keywords, circles, arrows, or quoted text descriptions
- **THEN** ModuleLoom automatically renders a red circular or rounded rectangular highlight boundary, a directional arrow, and a styled semi-transparent speech-bubble text label positioned near the target element during capture.

### Requirement: Run Desktop Manual Scenarios
The application SHALL run desktop scenarios using accessibility selectors for controls and shall register captured PNGs against existing screenshot tasks only after every scenario step succeeds.

#### Scenario: Inspect available desktop controls
- **WHEN** a user lists accessible windows and inspects one of them
- **THEN** ModuleLoom shows its application, title, stable window query, and accessibility tree so the user can author selectors for a scenario.

#### Scenario: Interact with an accessible application
- **WHEN** a desktop scenario selects a window and uses a selector-based action or state assertion
- **THEN** ModuleLoom scopes the action to that window and reports the failing step if the control cannot be used or observed.
- **WHEN** a scenario provides a selector for text or key input
- **THEN** ModuleLoom focuses that control and sends the input to it.

#### Scenario: Capture a window or element
- **WHEN** a desktop scenario requests a screenshot for an existing `kind=screenshot` task
- **THEN** ModuleLoom captures the selected window or the element named by `selector`, applies the requested inset, and records the PNG after all steps finish successfully.
- **WHEN** the session uses a Wayland screenshot portal and no element selector is given
- **THEN** ModuleLoom asks the user to choose the window through the portal.

### Requirement: Centralized Settings Popup Modal
The application SHALL provide a unified settings popup modal accessible from the header to configure build destinations, source paths, and AI parameters.

#### Scenario: Manage directories and AI models from popup
- **WHEN** the user opens the settings popup
- **THEN** ModuleLoom displays dedicated input fields for HTML output directory (default: `manual`), Markdown source directory (default: `docs`), target project path, and AI CLI / model ID selectors.

### Requirement: Strict AI Tag Syntax and Lifecycle Rules
The application and manual authoring pipeline SHALL enforce strict identifier formatting, single-responsibility separation, visible content placement, and SHA-256 state tracking for AI tags.

#### Scenario: Tag identifier formatting
- **WHEN** an `ai:task` tag is authored or parsed
- **THEN** the identifier MUST start with a lowercase letter and contain only lowercase alphanumeric characters and hyphens (`^[a-z][a-z0-9-]*$`), and MUST be globally unique across all documentation files.

#### Scenario: Single responsibility separation
- **WHEN** generating or validating assets
- **THEN** `kind=screenshot` MUST contain only raw image Markdown tags, `kind=diagram` MUST contain only raw Mermaid code blocks, and all explanatory prose or instructions MUST be placed in dedicated `kind=text` tags.

#### Scenario: Generated answer placement and tag unwrapping
- **WHEN** generating, updating, or recording an answer for an `ai:task` tag
- **THEN** the generated body MUST be placed in the visible document body enclosed between the opening `<!-- ai:generated ... -->` tag and closing `<!-- /ai:generated -->` tag, and any outer, leading, or trailing `ai:generated` or `ai:task` HTML comment tags in the answer MUST be stripped out so no text is trapped inside comments.

#### Scenario: Validation of generated markers
- **WHEN** parsing page tags in a document
- **THEN** unclosed or nested `ai:generated` markers outside code blocks MUST be detected and rejected with an error.

### Requirement: Build and Preview Manuals
The application SHALL support draft and strict MkDocs builds and preview generated pages and images using a native management engine.

#### Scenario: Build a draft
- **WHEN** the user builds a draft with incomplete tasks
- **THEN** ModuleLoom compiles the draft using intermediate Markdown in a temporary workspace, emitting visible placeholders for missing or stale answers into the generated HTML site.

#### Scenario: Build a complete manual
- **WHEN** the user requests a strict build and every task has a current answer
- **THEN** ModuleLoom compiles the manual into the target output directory as an HTML site via an external builder command (such as MkDocs) while managing intermediate Markdown in a temporary workspace.
- **WHEN** any answer is missing or stale
- **THEN** the strict build reports the affected task and fails.

#### Scenario: Preview an image asset
- **WHEN** the preview requests a generated documentation image
- **THEN** ModuleLoom serves supported image data only from inside the generated docs directory.

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

### Requirement: Complete screenshot handoff with retry-safe capture state
Manual Studio SHALL keep a screenshot handoff associated with its original project, document, task, launch command, and launch arguments until it completes or is cancelled.

#### Scenario: Retry importing a completed MarkIts image
- **WHEN** a completed image import or document insertion must be retried
- **THEN** the workflow preserves the source until completion, avoids overwriting an existing capture, and inserts results only for the still-current session.

#### Scenario: Finish editing without adding annotations
- **WHEN** the user completes the MarkIts screenshot handoff without drawing annotations
- **THEN** Manual Studio accepts the completed image with an empty annotation list and preserves its image and UI metadata; an ordinary annotation-spec import without annotations remains invalid.

#### Scenario: Show capture submission status
- **WHEN** capture submission fails or advances through image import, document save, and capture-source registration
- **THEN** the dialog displays actionable error feedback or the current step before its final action.

#### Scenario: Hide Studio for a capture
- **WHEN** a real screenshot capture is about to occur
- **THEN** Manual Studio hides immediately before capture and is restored by the scoped capture flow afterward.

### Requirement: Provide repeatable Manual Studio workflow checks
The project SHALL provide a documented check command for Manual Studio workflow and build verification, with native GUI integration coverage described separately.

#### Scenario: Run the Manual Studio check command
- **WHEN** a developer runs `npm run manual:check`
- **THEN** the scripted workflow, browser, build, and Rust checks run and report their outcomes.

#### Scenario: Interpret UI workflow coverage
- **WHEN** a developer reviews the browser-based capture workflow checks
- **THEN** the documentation states that mocked native calls do not verify actual MarkIts Desktop editing or complete native GUI integration.
