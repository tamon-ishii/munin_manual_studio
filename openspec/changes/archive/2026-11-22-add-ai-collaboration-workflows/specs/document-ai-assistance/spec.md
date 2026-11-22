# Spec Delta

## ADDED Requirements

### Requirement: Deterministic MarkIts annotation and UIMap consistency checks
The system SHALL inspect local PNG references (including managed capture editing sources) for embedded `markits:annotations` and `markits:uimap` metadata during manuscript checks and MCP `check-manuscript` calls. It SHALL report badge step mismatches, step order inversions, and close UIMap target label discrepancies in the following prose section as `warning` findings without blocking strict final publication. Code blocks and HTML comments SHALL be excluded from prose matching.

#### Scenario: Missing badge step explanation in prose
- **WHEN** a referenced MarkIts PNG contains badges ① and ② and the prose before the next heading or image only mentions ① (even if ② appears inside an HTML comment)
- **THEN** manuscript checks report an `annotation_step_mismatch` warning identifying missing step ②
- **AND** `passed` remains `true` when there are no broken links or missing images

#### Scenario: UIMap label drift in prose
- **WHEN** a MarkIts annotation targets a UIMap element and the following prose uses a near-matching quoted UI label instead of the exact element name
- **THEN** manuscript checks report an `annotation_target_mismatch` warning and offer navigation and AI terminal correction handoff

### Requirement: Project glossary management and AI/MCP integration
The system SHALL persist project terminology rules in `.munin/glossary.json` (preferred term, prohibited variants, category, case sensitivity, and note) and provide Settings CRUD, search, and PNG UIMap candidate import. Glossary rules SHALL generate non-blocking replacement warnings in manuscript checks, inject into AI editing/proofreading prompts, and be queryable via MCP `project-glossary`.

#### Scenario: Import UIMap candidates and detect glossary violations
- **WHEN** the user imports UI element names from project PNG UIMaps and saves prohibited variants in the glossary
- **THEN** manuscript checks flag prohibited variants outside code blocks, inline code, URLs, and preferred substrings as `glossary_violation` warnings
- **AND** selecting the replacement action replaces the matched range in the editor with Undo support

#### Scenario: Query project glossary via MCP
- **WHEN** an AI client calls MCP `project-glossary` with an optional query or category
- **THEN** the MCP server returns the matching terms from `.munin/glossary.json`

### Requirement: Editor to AI terminal handoff and inline AI notes
The system SHALL allow users to send structured context (manuscript path, line range, excerpt, image path, unsaved draft warning, and `preview-edit` guidance) from the editor, image hover overlay, or manuscript check findings into the AI terminal as either pasted input or immediate submission. The system SHALL also support lightweight inline `<!-- ai-note: ... -->` comments with insertion, listing, jump/delete, batch terminal handoff, and `unresolved_ai_note` manuscript check warnings.

#### Scenario: Paste editor context to AI terminal without auto-submit
- **WHEN** the user sends an editor passage to a connected AI terminal with immediate submission unchecked
- **THEN** the formatted context is written to the terminal without a trailing carriage return so the user can review before submitting

#### Scenario: Track and batch-handoff inline AI notes
- **WHEN** a manuscript contains `<!-- ai-note: ... -->` comments outside fenced code blocks
- **THEN** manuscript checks warn about each unresolved note and the AI notes dialog lists them for navigation, deletion, or batch handoff to the AI terminal

### Requirement: Multi-file external change review tray
The system SHALL snapshot project Markdown files when an AI terminal session connects, detect externally added, modified, or deleted Markdown files, and present a review tray allowing hunk-level adoption or reversion with SHA-256 verification. Pages with unsaved edits in the editor MUST be protected against direct overwrite from the tray.

#### Scenario: Selectively revert one hunk of an external modification
- **WHEN** an external modification changes two hunks of a saved Markdown file and the user unchecks the second hunk in the review tray before confirming
- **THEN** the system verifies the file's current SHA-256, writes the merged content preserving the original second hunk, and updates the snapshot baseline

#### Scenario: Protect unsaved editor drafts in the change tray
- **WHEN** an externally modified Markdown file also has unsaved local edits in the editor
- **THEN** the review tray displays an unsaved-edits warning and disables direct confirmation overwrite for that file
