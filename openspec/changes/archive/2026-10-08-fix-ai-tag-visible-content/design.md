# Design

## Context

See `proposal.md` for motivation. In `crates/manual-core/src/task.rs`, `update_task_in_docs` formats answers into target Markdown files as:
```markdown
<!-- ai:generated id=... kind=... created-at=... -->
{body}
<!-- /ai:generated -->
```
If `{body}` itself contains outer comment markers (e.g. `<!-- ai:generated -->...<!-- /ai:generated -->` or `<!-- ai:task ... -->`), the resulting Markdown ends up with nested comments or text inside comments, preventing the body from rendering visibly.

## Goals / Non-Goals

**Goals:**
- Provide a robust cleaner (`clean_generated_body`) in `task.rs` that strips outer, leading, and trailing `ai:generated` and `ai:task` comments recursively.
- Apply `clean_generated_body` in both `update_task_in_docs` and `save_answer`.
- Strengthen author prompt instructions in `crates/manual-core/src/author.rs` to instruct models never to output comment tags.
- Add marker validation in `task.rs` (`validate_generated_markers`) to detect unclosed or nested `ai:generated` tags outside code blocks.

**Non-Goals:**
- Modifying the outer comment tag format (`<!-- ai:generated ... -->` and `<!-- /ai:generated -->`).
- Modifying non-AI markdown comments or unrelated HTML tags.

## Decisions

### Decision: Regex-based recursive unwrapping loop in `clean_generated_body`
- **Rationale**: AI responses may wrap text in matched comment tags (`<!-- ai:generated ... -->...<!-- /ai:generated -->`), or start with a copy of the task tag (`<!-- ai:task ... -->`), or have multiple layers of tags if regenerated repeatedly. A loop applying targeted regex patterns until no outer wrappers remain handles all variations.
- **Alternatives Considered**:
  - *Simple string prefix/suffix trimming*: Rejected because tags have dynamic attributes (`id=...`, `kind=...`, `prompt-b64=...`) and arbitrary whitespace.
  - *Full HTML parser*: Overkill and may alter non-HTML Markdown syntax.

### Decision: Defense-in-depth at both prompt level and ingestion level
- **Rationale**: Updating the system prompts in `author.rs` reduces the likelihood of models producing comment wrappers, while `clean_generated_body` guarantees correctness regardless of CLI model behavior or manual edits.

### Decision: Syntax validation in `parse_page_tags`
- **Rationale**: Running `validate_generated_markers` while ignoring code blocks ensures document integrity before parsing tasks and answers.

## Risks / Trade-offs

- **[Risk]** Valid Markdown content containing examples of comment tags could be stripped.
  - **Mitigation**: `clean_generated_body` only matches leading, trailing, and full-wrapper comments; interior comments or code blocks in the body are untouched. `validate_generated_markers` explicitly ignores code blocks.
