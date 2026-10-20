## ADDED Requirements

### Requirement: Configure an application's working folder
Manual Studio SHALL let users set and save a working folder alongside each registered executable and its arguments. The working folder SHALL be used when testing an application launch and when recording or replaying its screenshot workflow. When the working folder is empty or omitted, Manual Studio SHALL use the project root, preserving the behavior of existing registrations and recorded scenarios.

#### Scenario: Choose a working folder for a registered application
- **WHEN** a user edits an application registration and selects a working folder
- **THEN** the folder is saved with that application's executable and arguments
- **AND** a later launch uses the selected folder as its current working directory.

#### Scenario: Keep existing registrations working
- **WHEN** Manual Studio loads a registration or recorded scenario without a working folder
- **THEN** it uses the owning project root as the working directory.

#### Scenario: Reject an unavailable working folder
- **WHEN** a configured working folder does not exist or is not a directory
- **THEN** launch fails with a clear message before recording starts
- **AND** the saved registration remains available for correction.
