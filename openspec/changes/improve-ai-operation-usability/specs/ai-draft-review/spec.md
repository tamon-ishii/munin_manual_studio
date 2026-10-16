## ADDED Requirements

### Requirement: Review full draft before adoption
The system SHALL generate full-manual candidates without modifying manuscripts. Users SHALL select pages and individual changes in a Diff, discard the candidate, or adopt only selected changes. Adoption MUST check original revisions and back up changed existing pages before writing.

#### Scenario: Reject pages and hunks
- **WHEN** a user rejects one page and one change in another page
- **THEN** rejected content stays unchanged and only approved changes are saved

#### Scenario: Stale candidate
- **WHEN** an accepted page changes after generation starts
- **THEN** adoption is rejected before any candidate page is written

#### Scenario: Cancel or discard
- **WHEN** generation is cancelled or the review is closed
- **THEN** manuscripts remain unchanged
