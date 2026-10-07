# Tasks

## 1. Core Implementation

- [x] 1.1 Implement `clean_generated_body` in `crates/manual-core/src/task.rs` to strip outer, leading, and trailing `ai:generated` and `ai:task` HTML comments
- [x] 1.2 Integrate `clean_generated_body` into `update_task_in_docs` and `save_answer` in `crates/manual-core/src/task.rs`
- [x] 1.3 Add `validate_generated_markers` in `crates/manual-core/src/task.rs` to detect unclosed or nested `ai:generated` tags in Markdown files
- [x] 1.4 Update AI generation system prompts in `crates/manual-core/src/author.rs` (`generate_task` and `generate_page`) to prohibit HTML comment wrapping

## 2. Testing and Verification

- [x] 2.1 Add unit tests `test_clean_generated_body_unwraps_tags` and `test_update_task_in_docs_unwraps_wrapped_ai_answers` in `crates/manual-core/src/lib.rs` and verify with `cargo test --lib`
- [x] 2.2 Fix UI capture test in `scripts/test_manual_studio_capture_ui.mjs` to expand the instruction toolbar details element before clicking toolbar buttons
- [x] 2.3 Run full verification suite with `npm run manual:check` to ensure all Rust and browser tests pass
