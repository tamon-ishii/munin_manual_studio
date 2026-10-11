# ai-image-generation Specification

## Purpose

Generate and review image assets separately from manuscript AI tasks. See [AI画像生成](../../../docs/specs/ai-image-generation.md) for configuration, records and limits.

## Requirements

### Requirement: Explicitly choose image generation providers
Manual Studio SHALL offer Agy, Codex and image API generation through an icon-labeled AI作画 action in the editor toolbar and resource library. AI settings SHALL separate manuscript and image configuration. Image connection selection SHALL persist per project, with either an independent provider or an explicit shared manuscript connection. Failures SHALL NOT automatically switch providers. Image API credentials SHALL NOT be stored in image settings or execution metadata.

#### Scenario: Generate with Codex
- **WHEN** the user chooses Codex
- **THEN** generation invokes the Codex CLI with its built-in image generation workflow without silently falling back to Agy or an API.

#### Scenario: Configure an independent image AI
- **WHEN** the user saves an image provider, model, API URL and session-only API key in AI settings
- **THEN** the manuscript AI configuration remains unchanged
- **AND** the image preference survives reopening without persisting its API key.

#### Scenario: Use the manuscript connection for images
- **WHEN** the user selects the shared manuscript connection
- **THEN** image generation follows the current manuscript Agy or Codex CLI, or its API connection and credential
- **AND** API generation uses an image model distinct from the manuscript model and the connection's images/generations endpoint
- **AND** the independent image API URL remains available when switching back.

#### Scenario: Shared manuscript AI cannot generate images
- **WHEN** the shared connection is unset or uses an unsupported CLI
- **THEN** the UI explains that an independent image AI must be configured and generation fails without falling back or changing the manuscript.

### Requirement: Report generation capability checks accurately
Manual Studio SHALL report CLI installation and supported login or connection checks, and Codex CLI image-generation feature availability. API key presence SHALL be distinct from a successful API connection. Account and model image-generation entitlement SHALL only be established by actual execution.

#### Scenario: Inspect an installed CLI
- **WHEN** the user opens AI作画 or requests a connection check
- **THEN** the available check results are shown for the selected provider without exposing credentials.

### Requirement: Persist reviewable images and generation history
Successful generation SHALL save a PNG and metadata before explicit insertion. The history SHALL survive reopening, support prompt reuse, reference-based edits and comparison of at least two images. Reference edits SHALL preserve the source and record its relationship when known. Generation failures SHALL preserve document content.

#### Scenario: Generate a reference-based revision
- **WHEN** the user requests AI editing of an existing image
- **THEN** a new candidate is saved while the source image remains unchanged
- **AND** document content changes only upon explicit insertion.

#### Scenario: Select a missing history image
- **WHEN** the user selects a saved image whose file cannot be read
- **THEN** the prompt remains reusable and a visible image loading error is shown
- **AND** the previous preview is hidden and insertion and reference editing are disabled.

#### Scenario: Change selection during preview loading
- **WHEN** the user selects another history image before the earlier preview finishes loading
- **THEN** only the latest selection can update the displayed preview and insertion target.

### Requirement: Cancel and retry independent generation attempts
Each attempt SHALL persist a unique job with running, succeeded, failed, cancelled or interrupted status. Generation SHALL have a 300-second limit. Cancellation SHALL stop CLI process trees or stop API waiting without saving an unadopted result. Failed and cancelled instructions SHALL remain reusable. Retrying SHALL create a new job. History loading SHALL classify abandoned running jobs as interrupted only after acquiring their execution lock. A saved successful result SHALL repair its job to succeeded. Active locked jobs SHALL retain running status. Restart SHALL NOT automatically replay interrupted jobs.

#### Scenario: Retry a failed request
- **WHEN** generation fails and the user retries
- **THEN** the prompt remains available and a separate attempt is recorded.

#### Scenario: Cancel an API request
- **WHEN** the user requests cancellation while awaiting an API response
- **THEN** local waiting ends and the result is not imported
- **AND** remote processing or billing cancellation is not guaranteed.

#### Scenario: Recover an abandoned attempt
- **WHEN** a running record has no active execution lock and no saved result
- **THEN** it becomes interrupted and its prompt is available for explicit retry
- **AND** a retry creates a separate job.
