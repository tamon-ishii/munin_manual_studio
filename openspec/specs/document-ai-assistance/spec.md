# document-ai-assistance Specification

## Purpose

原稿の読者が迷う点と文章の校正点をAIで確認し、実画像との説明の整合性も確かめる。指摘の根拠から該当箇所を開き、選択範囲の変更を確認して必要なものだけ採用できるようにする。

## Requirements

### Requirement: Reader and proofreading review
The system SHALL review the current document or a selected range using an editable reader and purpose, categorizing actionable findings as reader, proofreading, or image consistency without changing the manuscript.

#### Scenario: Review a selected passage
- **WHEN** the user selects a passage and chooses selection review
- **THEN** findings refer only to that passage and retain exact positions in the complete manuscript

#### Scenario: Review the current document
- **WHEN** the user requests a document review
- **THEN** findings include an exact quote, reason, optional suggestion, and severity

### Requirement: Evidence based image consistency
The system SHALL compare accessible local manuscript images using actual image inputs and SHALL distinguish checked images from unavailable or unreadable images. Image findings MUST require evidence that the corresponding image was supplied and checked.

#### Scenario: Image input is unsupported
- **WHEN** image submission fails or the selected connection cannot accept images
- **THEN** text review continues with an explicit warning and images remain unverified

#### Scenario: Image references in code examples
- **WHEN** a code example contains image markup
- **THEN** that example does not cause an image attachment

### Requirement: Exact actionable anchors
The system SHALL locate findings by exact quotes and occurrence counts, support jumping to the passage, dismissing a finding, and preparing a scoped correction. It MUST reject invalid anchors and prohibit applying results to another or modified document.

#### Scenario: Repeated Unicode quotes
- **WHEN** a finding quotes the second occurrence after non-BMP characters
- **THEN** navigation selects precisely the second occurrence

### Requirement: Selective AI editing
The system SHALL generate text only for the selected range, or new text at the cursor when there is no selection, and show changes in a Diff view before applying. Users MUST be able to adopt or reject each change, retry with feedback, or discard the candidate. Only adopted changes SHALL affect the manuscript and participate in Undo and saving.

#### Scenario: Insert new manuscript text
- **WHEN** the user requests new text without selecting an existing range
- **THEN** the candidate appears in the Diff view and accepted content is inserted at the captured cursor position with Undo support

#### Scenario: Accept some changes
- **WHEN** the user rejects one changed hunk and adopts another
- **THEN** only the adopted hunk changes and all surrounding content remains intact

### Requirement: Asynchronous manuscript protection
The system MUST retain the manuscript on cancellation, generation failure, discarded changes, or a stale result. Review and editing SHALL use the existing scoped AI settings and cancellation controls.

#### Scenario: Manuscript changes while a review is pending
- **WHEN** the active page or content changes before the response arrives
- **THEN** the result cannot modify or navigate the new manuscript

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

### Requirement: Procedural drafts from MarkIts recordings
The system SHALL extract operation scripts, recorded operations, annotations, or UIMap labels from a project PNG or capture resource to generate a procedural Markdown draft (optionally AI-refined) and expose it via UI Diff insertion and MCP `draft-from-recording`.

#### Scenario: Generate procedural draft from recorded operation script
- **WHEN** the user selects a PNG containing `markits:operation_script` and generates a procedural draft
- **THEN** the system produces a numbered Japanese Markdown draft with relative image links and opens a Diff preview before inserting into the active manuscript

### Requirement: Source-grounded fact checking and application diff impact analysis
The system SHALL verify inline code tokens, paths, and quoted UI labels in ordinary Markdown against source files and MarkIts UIMaps (`fact-check-manuscript`), and SHALL analyze target repository Git diffs to identify impacted manual pages and screenshots (`analyze-app-impact`).

#### Scenario: Distinguish supported and unverified manuscript claims
- **WHEN** a manuscript mentions both an existing CLI flag and a nonexistent UI label
- **THEN** fact checking marks the flag as `supported` with file/line evidence and the nonexistent label as `unverified` with navigation and AI investigation handoff

#### Scenario: Identify pages impacted by an application Git diff
- **WHEN** a target application commit changes a UI label referenced by one manual page
- **THEN** impact analysis lists that page and matching screenshots with reasons and update handoff controls

### Requirement: Project structure dashboard, audience management, derivative drafts, and differential translation sync
The system SHALL provide a project-wide dashboard (`project-overview`) reporting page metrics, orphan pages, duplicate headings, and `ai:audience` management/builds, alongside derivative document generation (`faq`, `release-notes`, `quickstart`) and Git-diff-based translation synchronization (`translation-diff-plan`).

#### Scenario: Manage page audiences and detect cross-page issues
- **WHEN** the user opens the dashboard on a project containing an orphan page and mismatched audience links
- **THEN** the dashboard reports both diagnostics and persists updated `ai:audience` directives on save

#### Scenario: Extract minimal translation diff plan
- **WHEN** a source-language page has a Git diff since the selected base ref
- **THEN** translation sync extracts only the changed diff and headings for targeted updates without rewriting untouched translated sections
