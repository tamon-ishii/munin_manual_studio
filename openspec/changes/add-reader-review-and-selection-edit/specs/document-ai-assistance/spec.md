# Spec Delta

## Purpose

原稿の読者が迷う点と文章の校正点をAIで確認し、実画像との説明の整合性も確かめる。指摘の根拠から該当箇所を開き、選択範囲の変更を確認して必要なものだけ採用できるようにする。

## ADDED Requirements

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
