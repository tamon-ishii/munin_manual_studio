## ADDED Requirements

### Requirement: Retry failed screenshot stage
The system SHALL retain the instruction, registered application and completed screenshot stages when a stage fails. Users SHALL retry the failed stage or stop without restarting completed work. Retained state MUST be scoped to its project and recipe. Successful capture MUST be reused when only annotation failed.

#### Scenario: Annotation retry
- **WHEN** annotation fails after capture and the user retries
- **THEN** only annotation is requested again using the saved capture and instruction

#### Scenario: Recipe or capture retry
- **WHEN** recipe generation or capture fails
- **THEN** retry resumes that stage without repeating successful application registration or recipe generation
