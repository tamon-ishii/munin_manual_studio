## ADDED Requirements

### Requirement: Visible AI waiting state
The system SHALL keep connection name, operation stage, elapsed time and cancellation accessible while waiting for AI. Hiding detailed logs SHALL retain a compact running status and cancellation control. Waiting messages MUST distinguish response waiting from completion and failure.

#### Scenario: Slow response
- **WHEN** no new output arrives for fifteen seconds
- **THEN** the UI shows the connection and elapsed waiting time without declaring failure

### Requirement: Image review preflight
The system SHALL disclose the configured connection's image submission capability before review starts and explain that actual image readability is confirmed only after review.

#### Scenario: CLI review
- **WHEN** a CLI connection is selected
- **THEN** review options explicitly say image consistency cannot be checked and text review remains available
