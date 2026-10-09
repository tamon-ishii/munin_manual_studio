# Spec Delta

## MODIFIED Requirements

### Requirement: Strict AI Tag Syntax and Lifecycle Rules
The application and manual authoring pipeline SHALL enforce strict identifier formatting, single-responsibility separation, visible content placement, and SHA-256 state tracking for AI tags.

#### Scenario: Tag identifier formatting
- **WHEN** an `ai:task` tag is authored or parsed
- **THEN** the identifier MUST start with a lowercase letter and contain only lowercase alphanumeric characters and hyphens (`^[a-z][a-z0-9-]*$`), and MUST be globally unique across all documentation files.

#### Scenario: Single responsibility separation
- **WHEN** generating or validating assets
- **THEN** `kind=screenshot` MUST contain only raw image Markdown tags, `kind=diagram` MUST contain only raw Mermaid code blocks, and all explanatory prose or instructions MUST be placed in dedicated `kind=text` tags.

#### Scenario: Generated answer placement and tag unwrapping
- **WHEN** generating, updating, or recording an answer for an `ai:task` tag
- **THEN** the generated body MUST be placed in the visible document body enclosed between the opening `<!-- ai:generated ... -->` tag and closing `<!-- /ai:generated -->` tag, and any outer, leading, or trailing `ai:generated` or `ai:task` HTML comment tags in the answer MUST be stripped out so no text is trapped inside comments.

#### Scenario: Validation of generated markers
- **WHEN** parsing page tags in a document
- **THEN** unclosed or nested `ai:generated` markers outside code blocks MUST be detected and rejected with an error.
