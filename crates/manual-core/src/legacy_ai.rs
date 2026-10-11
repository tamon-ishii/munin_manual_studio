//! Read-only compatibility for retired AI markup. Saving materializes visible prose.
use regex::Regex;
use std::{fs, path::Path};

pub(crate) fn plain_markdown(content: &str, generated: Option<&Path>) -> String {
    let comments = Regex::new(r"(?s)<!--\s*(?:/?ai:(?:task|generated|answer|draft|fact|depends|audience|scenario))\b.*?-->").unwrap();
    let ids = Regex::new(r#"\bid=(?:"([a-z][a-z0-9_-]*)"|'([a-z][a-z0-9_-]*)'|([a-z][a-z0-9_-]*))"#).unwrap();
    let fenced = crate::task::get_code_block_ranges(content);
    let inline = crate::task::get_inline_code_ranges(content, &fenced);
    let mut result = String::new();
    let mut cursor = 0;
    for found in comments.find_iter(content) {
        if crate::task::is_inside_ranges(&found.range(), &fenced) || crate::task::is_inside_ranges(&found.range(), &inline) { continue; }
        result.push_str(&content[cursor..found.start()]);
        // Old standalone instruction comments stored answers separately. Do not
        // insert a cached answer when an inline generated section already exists.
        let raw = found.as_str();
        if raw.starts_with("<!-- ai:task") && raw.contains('\n') && !raw.contains("prompt=") {
            if let (Some(generated), Some(cap)) = (generated, ids.captures(raw)) {
                let id = cap.get(1).or_else(||cap.get(2)).or_else(||cap.get(3)).unwrap().as_str();
                let rest = &content[found.end()..];
                let next_instruction = rest.find("<!-- ai:task").unwrap_or(rest.len());
                let following = &rest[..next_instruction];
                if !following.contains(&format!("id={id}")) && !following.contains(&format!("id=\"{id}\"")) {
                    if let Ok(answer) = fs::read_to_string(generated.join("answers").join(format!("{id}.md"))) {
                        result.push_str(&plain_markdown(&answer, None));
                    }
                }
            }
        }
        cursor = found.end();
    }
    result.push_str(&content[cursor..]);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_prose_images_and_literal_examples() {
        let source = "# Guide\n<!-- ai:task id=intro prompt=\"Write\" -->\n本文\n![画面](assets/a.png)\n<!-- /ai:task -->\n`<!-- ai:task -->`\n```md\n<!-- ai:task -->\n```\n";
        let plain = plain_markdown(source,None);
        assert!(plain.contains("本文\n![画面](assets/a.png)"));
        assert!(!plain.contains("id=intro"));
        assert!(plain.contains("`<!-- ai:task -->`"));
        assert!(plain.contains("```md\n<!-- ai:task -->"));
        assert_eq!(plain_markdown(&plain,None),plain);
    }
    #[test]
    fn retains_stale_cached_answers_without_writing_originals() {
        let root=tempfile::tempdir().unwrap();fs::create_dir(root.path().join("answers")).unwrap();
        fs::write(root.path().join("answers/intro.md"),"<!-- ai:answer id=intro source-sha256=old -->\n既存の本文\n").unwrap();
        let source="<!-- ai:task id=intro kind=text\nWrite\n-->\n";
        assert!(plain_markdown(source,Some(root.path())).contains("既存の本文"));
        assert!(fs::read_to_string(root.path().join("answers/intro.md")).unwrap().contains("ai:answer"));
    }
}
