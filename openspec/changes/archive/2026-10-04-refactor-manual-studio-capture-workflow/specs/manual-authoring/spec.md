# manual-authoring Specification

## ADDED Requirements

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
