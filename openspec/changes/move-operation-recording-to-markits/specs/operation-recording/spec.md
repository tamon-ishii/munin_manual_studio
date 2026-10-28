# Operation recording

## Purpose

Provide portable window operation recordings through Markits, both as a standalone application and as the recording engine used by Manual Studio. Keep recorded actions usable in existing manual generation workflows.

## ADDED Requirements

### Requirement: Standalone window operation recording
Markits SHALL allow the user to choose an existing window, start recording clicks, text, keys and scrolling, pause or resume, inspect recorded operations, finish and save JSON, or cancel without saving.

#### Scenario: Record and save
- **WHEN** a user selects a window and finishes a recording in Markits
- **THEN** the user can save the operation data as JSON without installing or launching Manual Studio

#### Scenario: Pause and cancel
- **WHEN** a user pauses a recording and subsequently cancels it
- **THEN** paused input is excluded, the recorder is stopped, no recording is saved and the selected application remains open

### Requirement: Shared recording engine
Manual Studio SHALL use the Markits recording engine while preserving application launch profiles, existing window selection, scenario JSON compatibility, screenshot registration and annotation handoff.

#### Scenario: Manual Studio capture
- **WHEN** recording is started and finished from Manual Studio
- **THEN** the existing scenario, screenshot registration and Markits annotation workflow remain available using the shared input recorder

### Requirement: Target identity and resource cleanup
The recorder SHALL preserve semantic or visual click targets when available, exclude recorder controls from exported actions, and stop owned recording processes on cancel or application exit.

#### Scenario: Cancel recording an existing window
- **WHEN** a recording of an existing application window is cancelled
- **THEN** only the recording helper is stopped and the selected application remains running

#### Scenario: Unsupported recording environment
- **WHEN** recording cannot start because the input monitoring environment is unsupported or the selected window disappeared
- **THEN** the application displays an error and remains available for a new recording
