# Spec Delta

## Purpose

Provide recoverable manuscript versions through existing local Git history, with explicit commits and reviewed restoration that protects unrelated project work.

## ADDED Requirements

### Requirement: Inspect local manuscript history
The application SHALL report Git availability and repository state, and list commits affecting the selected manuscript. Git operations SHALL remain local and reject paths outside the selected project.

#### Scenario: Project without Git
- **WHEN** Git is unavailable or the project is not in a repository
- **THEN** the UI explains the missing setup and ordinary editing remains available.

#### Scenario: Select a historical version
- **WHEN** the user selects a manuscript commit
- **THEN** the UI displays the historical content against the current manuscript without altering files.

### Requirement: Commit selected manuscripts explicitly
The application SHALL commit the saved selected manuscript with an explicit message. Unrelated files and staged changes SHALL remain excluded and preserved. Missing identity, no changes, and merge conflicts SHALL produce actionable failures.

#### Scenario: Preserve unrelated staged work
- **WHEN** the user commits a changed manuscript while another file is staged
- **THEN** only the selected manuscript enters the new commit and the other staged change remains staged.

### Requirement: Restore reviewed Git content
Restoration SHALL require confirmation, reject stale document/project ownership and external revision changes, and use the normal editor save and Undo flow. It SHALL NOT reset branches, replace the index, or execute remote commands.

#### Scenario: Undo a restore
- **WHEN** the user restores a reviewed version and then invokes Undo
- **THEN** the previous manuscript content returns, including images and Markdown metadata.

#### Scenario: Manuscript changes during review
- **WHEN** the manuscript changes after a historical version is reviewed
- **THEN** restoration is rejected and the current edits remain intact.
