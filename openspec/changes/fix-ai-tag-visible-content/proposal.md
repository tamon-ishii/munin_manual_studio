# Proposal

## Why

When generating manual text or answering AI tasks in Munin Manual Studio, AI CLI responses or user inputs sometimes wrap the generated text inside `<!-- ai:generated -->` or `<!-- ai:task -->` comment blocks. Previously, inserting this output directly caused the generated text to remain trapped inside HTML comment markers, making it invisible in Markdown preview and rendered documents.
AI-generated content must always be placed in the visible body enclosed between the opening `<!-- ai:generated ... -->` tag and the closing `<!-- /ai:generated -->` tag, with any inadvertent outer/nested comment markers stripped out.

## What Changes

- **Unwrap AI Comments in Generated Content**: Introduce `clean_generated_body` in `manual-core` to recursively unwrap leading, trailing, and wrapping `ai:generated` and `ai:task` HTML comments from AI responses before recording answers or writing to documentation.
- **Clarify Author Prompts**: Update system prompts in `author.rs` (`generate_task` and `generate_page`) to explicitly forbid AI from wrapping responses in HTML comment markers, reinforcing that the body must be raw Markdown.
- **Validate Generated Markers**: Add strict validation during document parsing to detect unclosed or nested `ai:generated` tags and reject invalid document states.
- **Regression Testing**: Add unit tests in `manual-core` verifying that answers wrapped in comment tags are properly unwrapped into visible Markdown text.

## Capabilities

### New Capabilities
<!-- None -->

### Modified Capabilities
- `manual-authoring`: Clarify requirement for generated content placement so that answer bodies are always visible Markdown content between `<!-- ai:generated ... -->` and `<!-- /ai:generated -->` markers, without nested comment tags.

## Impact

- `crates/manual-core/src/task.rs`: `clean_generated_body`, `update_task_in_docs`, `save_answer`, and `parse_page_tags`.
- `crates/manual-core/src/author.rs`: AI generation prompts.
- `crates/manual-core/src/lib.rs`: Unit tests for unwrapping and tag validation.
