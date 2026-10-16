# Spec Delta

## Purpose

Provide an accurate manuscript outline for navigating and reorganizing complete sections while retaining source content and the existing editing history.

## ADDED Requirements

### Requirement: Navigate manuscript headings
The outline SHALL reflect the current manuscript's top-level ATX and Setext headings and their hierarchy. Code examples and nested quoted/list headings SHALL be excluded. Selecting a heading SHALL navigate to its source occurrence, including duplicate names and Unicode content.

#### Scenario: Heading-like code example
- **WHEN** a fenced code example contains a line beginning with a heading marker
- **THEN** that line does not appear in the outline.

### Requirement: Reorder sibling sections
Users SHALL reorder sections under the same parent and heading level using drag/drop and keyboard-operable up/down controls. The entire section and its descendant headings SHALL move together. Invalid nesting, stale content and project/document switches SHALL reject the operation.

#### Scenario: Move a section containing images and diagrams
- **WHEN** a user moves a section before a sibling
- **THEN** its text, image references, metadata and code blocks move together and Undo returns the original manuscript.
