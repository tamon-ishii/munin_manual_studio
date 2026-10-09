# Spec Delta

## Purpose

Provide a dedicated application settings area for preregistering programs and their arguments, so recording and screenshot workflows can launch the intended application independently of AI configuration and preserve the settings used by each recording.

## ADDED Requirements

### Requirement: Preregister target applications
Manual Studio SHALL provide application registration in the Project menu, available after opening a project. Manual Studio SHALL provide application settings for adding, editing, selecting, and removing launch profiles containing an executable path, an ordered argument list, and an optional display name. Users SHALL NOT be required to enter a profile identifier or a display name.

#### Scenario: Register an application before recording
- **WHEN** a user registers an executable path and arguments without a name
- **THEN** the profile is saved, identified internally, and displayed using the executable name
- **AND** the user can select it from a screenshot recording workflow without configuring AI.

#### Scenario: Preserve individual arguments
- **WHEN** a registered argument contains spaces or shell metacharacters
- **THEN** the application passes that entry as one argument without evaluating it as a shell expression.

#### Scenario: Detect an unavailable program
- **WHEN** a launch profile points to a missing executable
- **THEN** the application reports the invalid path before recording and offers a way to edit it
- **AND** saved screenshots remain available for viewing and MarkIts editing.

### Requirement: Preserve launch configuration ownership
Manual Studio SHALL persist launch profiles inside their owning project across sessions and SHALL NOT expose another project's registrations when switching projects and preserve the launch path and arguments used by each recording independently of subsequent profile edits or deletion.

#### Scenario: Edit a profile after recording
- **WHEN** a user changes the arguments of a profile previously used for a recording
- **THEN** existing recordings retain their original launch configuration
- **AND** using new configuration for an existing recording requires an explicit choice.

#### Scenario: Move a project to another device
- **WHEN** a project's recorded launch path is unavailable on the current device
- **THEN** the application allows correction of launch settings for a new run without modifying prior recording history.

#### Scenario: Switch projects
- **WHEN** a user opens another project
- **THEN** application registration and recording options show only that project's profiles.

#### Scenario: Retain existing registrations
- **WHEN** a user explicitly imports existing shared launch commands into an empty project
- **THEN** their names, paths, and ordered arguments are retained without duplicate registrations
- **AND** the original shared file is preserved and a project with registrations is not overwritten.
