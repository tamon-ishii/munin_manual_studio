//! GFM rendering shared by preview and publication preparation.
use pulldown_cmark::{CowStr, Event, LinkType, Options, Parser, Tag, TagEnd};
use std::sync::LazyLock;

pub fn options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_GFM
}
static LINKS: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
    r"(?i)(?:https?://|www\.)[^\s<]+|(?:(?:mailto|xmpp):)?[a-z0-9._+\-]+@[a-z0-9_\-]+(?:\.[a-z0-9_\-]+)+\.?"
).unwrap()
});
static ENTITY: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"&[a-zA-Z0-9]+;$").unwrap());
static RAW_TAG: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)^\s*</?(?:title|textarea|style|xmp|iframe|noembed|noframes|script|plaintext)(?:\s|>|/)").unwrap()
});
fn owned(value: &str) -> CowStr<'static> {
    value.to_string().into()
}
fn trim_url(mut value: &str) -> &str {
    loop {
        let before = value;
        value = value.trim_end_matches(['?', '!', '.', ',', ':', '*', '_', '~']);
        if value.ends_with(')') {
            let opens = value.bytes().filter(|c| *c == b'(').count();
            let mut closes = value.bytes().filter(|c| *c == b')').count();
            while value.ends_with(')') && closes > opens {
                value = &value[..value.len() - 1];
                closes -= 1;
            }
        }
        if let Some(entity) = ENTITY.find(value) {
            value = &value[..entity.start()];
        }
        if before == value {
            break;
        }
    }
    value
}
fn destination(label: &str) -> Option<String> {
    let lower = label.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("www.") {
        let host = label
            .split_once("://")
            .map(|(_, value)| value)
            .unwrap_or(label)
            .split(['/', ':', '?', '#'])
            .next()?;
        let segments: Vec<_> = host.split('.').collect();
        if segments.len() < 2
            || segments.iter().any(|part| {
                part.is_empty()
                    || !part
                        .chars()
                        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
            })
            || segments.iter().rev().take(2).any(|part| part.contains('_'))
        {
            return None;
        }
        return Some(if lower.starts_with("www.") {
            format!("http://{label}")
        } else {
            label.into()
        });
    }
    if label.ends_with(['-', '_']) {
        return None;
    }
    Some(
        if lower.starts_with("mailto:") || lower.starts_with("xmpp:") {
            label.into()
        } else {
            format!("mailto:{label}")
        },
    )
}
fn text_links<'a>(text: CowStr<'a>) -> Vec<Event<'a>> {
    let mut result = Vec::new();
    let mut last = 0;
    for candidate in LINKS.find_iter(&text) {
        let raw = candidate.as_str();
        let lower = raw.to_ascii_lowercase();
        let url = ["http://", "https://", "www."]
            .iter()
            .any(|prefix| lower.starts_with(prefix));
        if url
            && text[..candidate.start()]
                .chars()
                .last()
                .is_some_and(|c| !c.is_whitespace() && !matches!(c, '*' | '_' | '~' | '('))
        {
            continue;
        }
        let label = if url {
            trim_url(raw)
        } else {
            raw.trim_end_matches('.')
        };
        let Some(dest) = destination(label) else {
            continue;
        };
        if candidate.start() > last {
            result.push(Event::Text(owned(&text[last..candidate.start()])));
        }
        result.push(Event::Start(Tag::Link {
            link_type: LinkType::Autolink,
            dest_url: dest.into(),
            title: "".into(),
            id: "".into(),
        }));
        result.push(Event::Text(owned(label)));
        result.push(Event::End(TagEnd::Link));
        last = candidate.start() + label.len();
    }
    if result.is_empty() {
        return vec![Event::Text(text)];
    }
    if last < text.len() {
        result.push(Event::Text(owned(&text[last..])));
    }
    result
}
pub fn events(content: &str) -> Vec<Event<'_>> {
    let mut result = Vec::new();
    let mut blocked = 0;
    for event in Parser::new_ext(content, options()) {
        match &event {
            Event::Start(Tag::CodeBlock(_) | Tag::Link { .. } | Tag::Image { .. }) => blocked += 1,
            Event::End(TagEnd::CodeBlock | TagEnd::Link | TagEnd::Image) => blocked -= 1,
            _ => {}
        }
        match event {
            Event::Text(text) if blocked == 0 => result.extend(text_links(text)),
            Event::Html(text) | Event::InlineHtml(text) if RAW_TAG.is_match(&text) => {
                result.push(Event::Text(text))
            }
            other => result.push(other),
        }
    }
    result
}

/// GitHub alert markers remain unchanged on disk. Only the temporary MkDocs
/// input uses admonitions, which Python-Markdown can render with Material styling.
pub fn for_publication(content: &str) -> String {
    let mut edits = Vec::new();
    let mut nested = 0;
    for (event, range) in Parser::new_ext(content, options()).into_offset_iter() {
        match event {
            Event::Start(Tag::BlockQuote(Some(kind))) if nested == 0 => {
                let original = &content[range.clone()];
                let label = format!("{kind:?}");
                let kind = match label.as_str() {
                    "Caution" => "danger".into(),
                    other => other.to_ascii_lowercase(),
                };
                let indent = content[..range.start].rsplit('\n').next().unwrap_or("");
                let indent = if indent.chars().all(|c| c == ' ') {
                    indent
                } else {
                    ""
                };
                let mut replacement = format!("!!! {kind} \"{label}\"\n");
                for line in original.lines().skip(1) {
                    let stripped = line.strip_prefix(indent).unwrap_or(line).trim_start();
                    let stripped = stripped
                        .strip_prefix('>')
                        .unwrap_or(stripped)
                        .strip_prefix(' ')
                        .unwrap_or_else(|| stripped.strip_prefix('>').unwrap_or(stripped));
                    replacement.push_str(&format!("{indent}    {stripped}\n"));
                }
                edits.push((range, replacement));
                nested += 1;
            }
            Event::Start(Tag::BlockQuote(_)) => nested += 1,
            Event::End(TagEnd::BlockQuote(_)) => nested -= 1,
            _ => {}
        }
    }
    let mut result = content.to_string();
    for (range, replacement) in edits.into_iter().rev() {
        result.replace_range(range, &replacement);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn html(text: &str) -> String {
        let mut html = String::new();
        pulldown_cmark::html::push_html(&mut html, events(text).into_iter());
        html
    }
    #[test]
    fn gfm_links_skip_code_and_existing_links_and_trim_punctuation() {
        let value = html("Visit https://example.com/path(foo)). www.example.org, me+tag@example.com.\n\n`https://code.example.com` [https://label.example.com](https://target.example.com)\n\n```text\nwww.code.example.com\n```");
        assert!(value.contains("href=\"https://example.com/path(foo)\""));
        assert!(value.contains("href=\"http://www.example.org\""));
        assert!(value.contains("href=\"mailto:me+tag@example.com\""));
        assert!(!value.contains("href=\"https://code.example.com\""));
        assert!(!value.contains("href=\"https://label.example.com\""));
        assert!(!value.contains("href=\"http://www.code.example.com\""));
    }
    #[test]
    fn tables_tasks_strikes_footnotes_and_alerts() {
        let value = html("| Left | Right |\n| :--- | ---: |\n| one | two |\n\n- [x] Done\n- [ ] Todo\n\n~~old~~\n\n> [!WARNING]\n> **Danger**\n\nFootnote[^1]\n\n[^1]: Details\n");
        for expected in [
            "<table>",
            "checked=",
            "<del>old</del>",
            "markdown-alert-warning",
            "<strong>Danger</strong>",
            "footnote",
        ] {
            assert!(value.contains(expected), "{expected}: {value}");
        }
    }
    #[test]
    fn publication_converts_alerts_and_preserves_code_and_original_source() {
        let source =
            "> [!TIP]\n> Use **care**.\n>\n> - A\n> - B\n\n```md\n> [!WARNING]\n> literal\n```\n";
        let output = for_publication(source);
        assert!(
            output.starts_with("!!! tip \"Tip\"\n    Use **care**.\n"),
            "{output}"
        );
        assert!(output.contains("    - A\n    - B"));
        assert!(output.contains("```md\n> [!WARNING]\n> literal\n```"));
        assert!(source.starts_with("> [!TIP]"));
    }
}
