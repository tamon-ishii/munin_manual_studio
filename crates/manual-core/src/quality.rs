use crate::{
    capture_resources,
    config::{project_page_path, project_path, read_config},
    glossary,
    task::{self, get_code_block_ranges, is_inside_ranges},
};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    ops::Range,
    path::{Path, PathBuf},
};

const CIRCLED_NUMBERS: [char; 20] = [
    '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩',
    '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳',
];

// Resolve Markdown ../ links against the project boundary, rejecting symlinks.
pub(crate) fn local_path(root: &Path, page: &Path, url: &str) -> Result<PathBuf, String> {
    let decoded = percent_encoding::percent_decode_str(url.split(['?', '#']).next().unwrap_or(url))
        .decode_utf8()
        .map_err(|e| e.to_string())?;
    let canonical = root.canonicalize().map_err(|e| e.to_string())?;
    let page = project_page_path(root, page)?;
    let mut resolved = if decoded.starts_with('/') {
        canonical.clone()
    } else {
        page.parent().ok_or("Invalid page")?.to_path_buf()
    };
    for part in Path::new(decoded.trim_start_matches('/')).components() {
        match part {
            std::path::Component::ParentDir => {
                resolved.pop();
            }
            std::path::Component::Normal(name) => resolved.push(name),
            std::path::Component::CurDir => {}
            _ => return Err("Invalid link path".into()),
        }
    }
    let rel = resolved
        .strip_prefix(&canonical)
        .map_err(|_| "リンクがプロジェクトの外を指しています。")?;
    project_path(root, &rel.to_string_lossy())
}

pub(crate) fn decode_html_attr(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn anchors(content: &str) -> BTreeSet<String> {
    let mut heading = false;
    let mut text = String::new();
    let mut found = BTreeSet::new();
    let mut counts = BTreeMap::new();
    for event in Parser::new_ext(content, Options::all()) {
        match event {
            Event::Start(Tag::Heading { id, .. }) => {
                heading = true;
                text.clear();
                if let Some(id) = id {
                    found.insert(id.to_string());
                }
            }
            Event::Text(value) | Event::Code(value) if heading => text.push_str(&value),
            Event::End(TagEnd::Heading(_)) => {
                heading = false;
                let slug: String = text
                    .to_lowercase()
                    .chars()
                    .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-' || c.is_whitespace())
                    .map(|c| if c.is_whitespace() { '-' } else { c })
                    .collect();
                let count = counts.entry(slug.clone()).or_insert(0);
                let id = if *count == 0 {
                    slug
                } else {
                    format!("{slug}-{count}")
                };
                *count += 1;
                found.insert(id);
            }
            _ => {}
        }
    }
    found
}

fn location(content: &str, start: usize, end: usize) -> Value {
    json!({
        "line": content[..start].bytes().filter(|b| *b == b'\n').count() + 1,
        "start": content[..start].encode_utf16().count(),
        "end": content[..end].encode_utf16().count(),
        "snippet": &content[start..end]
    })
}

fn issue(
    page: &str,
    kind: &str,
    severity: &str,
    message: &str,
    content: &str,
    range: Range<usize>,
    tag: Option<&str>,
    details: Option<Value>,
) -> Value {
    let mut value = location(content, range.start, range.end);
    value["page"] = json!(page);
    value["kind"] = json!(kind);
    value["severity"] = json!(severity);
    value["message"] = json!(message);
    if let Some(tag) = tag {
        value["tag"] = json!(tag);
    }
    if let Some(details) = details {
        value["details"] = details;
    }
    value
}

fn format_circled(step: u32) -> String {
    if (1..=20).contains(&step) {
        CIRCLED_NUMBERS[(step - 1) as usize].to_string()
    } else {
        format!("({step})")
    }
}

fn read_markits_metadata(root: &Path, target: &Path, bytes: &[u8]) -> (Option<Value>, Vec<markits::UiElement>) {
    let parse_pair = |raw: &[u8]| {
        let scene = markits::raster::extract_png_text_chunk(raw, "markits:annotations")
            .and_then(|text| serde_json::from_str::<Value>(&text).ok());
        let uimap = markits::raster::extract_png_uimap(raw).unwrap_or_default();
        (scene, uimap)
    };
    let (scene, uimap) = parse_pair(bytes);
    if scene.is_some() || !uimap.is_empty() {
        return (scene, uimap);
    }
    let Ok(canonical_root) = root.canonicalize() else {
        return (None, Vec::new());
    };
    let Ok(rel) = target.strip_prefix(&canonical_root) else {
        return (None, Vec::new());
    };
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    if let Ok(Some(editing)) = capture_resources::editing_source(root, &rel_str) {
        if let Ok(edit_bytes) = fs::read(editing) {
            return parse_pair(&edit_bytes);
        }
    }
    (None, Vec::new())
}

fn resolve_target_name(target: &Value, uimap: &[markits::UiElement]) -> Option<String> {
    if let Some(name) = target.as_str().map(str::trim).filter(|s| !s.is_empty()) {
        return Some(name.to_string());
    }
    let arr = target.as_array()?;
    if arr.len() != 4 {
        return None;
    }
    let (x, y, w, h) = (
        arr[0].as_f64()?,
        arr[1].as_f64()?,
        arr[2].as_f64()?,
        arr[3].as_f64()?,
    );
    let cx = x + w / 2.0;
    let cy = y + h / 2.0;
    uimap
        .iter()
        .filter(|el| {
            !el.name.trim().is_empty()
                && cx >= el.x
                && cx <= el.x + el.width
                && cy >= el.y
                && cy <= el.y + el.height
        })
        .min_by(|a, b| {
            (a.width * a.height)
                .partial_cmp(&(b.width * b.height))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|el| el.name.trim().to_string())
}

fn strip_code_fences(section: &str) -> String {
    let fences = get_code_block_ranges(section);
    let without_fences = if fences.is_empty() {
        section.to_string()
    } else {
        let mut out = String::with_capacity(section.len());
        let mut cursor = 0usize;
        for fence in fences {
            if fence.start > cursor {
                out.push_str(&section[cursor..fence.start]);
            }
            cursor = cursor.max(fence.end);
        }
        if cursor < section.len() {
            out.push_str(&section[cursor..]);
        }
        out
    };
    let comment_re = Regex::new(r"(?s)<!--.*?-->").unwrap();
    comment_re.replace_all(&without_fences, "").into_owned()
}

fn extract_text_steps(section: &str) -> (Vec<u32>, BTreeSet<u32>) {
    let plain = strip_code_fences(section);
    let mut order = Vec::new();
    let mut set = BTreeSet::new();
    let paren_re = Regex::new(r"[（(](\d{1,2})[）)]").unwrap();

    // Collect positions of both circled numbers and parenthesized numbers in order.
    let mut events: Vec<(usize, u32)> = Vec::new();
    for (byte_idx, ch) in plain.char_indices() {
        if let Some(pos) = CIRCLED_NUMBERS.iter().position(|c| *c == ch) {
            events.push((byte_idx, (pos + 1) as u32));
        }
    }
    for cap in paren_re.captures_iter(&plain) {
        if let (Some(m), Some(num)) = (cap.get(0), cap.get(1)) {
            if let Ok(step) = num.as_str().parse::<u32>() {
                if (1..=20).contains(&step) {
                    events.push((m.start(), step));
                }
            }
        }
    }
    events.sort_by_key(|(pos, _)| *pos);
    for (_, step) in events {
        if set.insert(step) {
            order.push(step);
        }
    }
    (order, set)
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut curr = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        curr[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            curr[j + 1] = (prev[j + 1] + 1).min(curr[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b.len()]
}

fn extract_quoted_ui_labels(section: &str) -> Vec<String> {
    let plain = strip_code_fences(section);
    let re = Regex::new(r"「([^「」\n]{2,40})」|\*\*([^*\n]{2,40})\*\*|`([^`\n]{2,40})`").unwrap();
    let mut labels = Vec::new();
    for cap in re.captures_iter(&plain) {
        let raw = cap
            .get(1)
            .or_else(|| cap.get(2))
            .or_else(|| cap.get(3))
            .map(|m| m.as_str().trim())
            .unwrap_or("");
        if !raw.is_empty() && !labels.iter().any(|item| item == raw) {
            labels.push(raw.to_string());
        }
    }
    labels
}

fn explanation_section<'a>(
    content: &'a str,
    image_end: usize,
    next_boundary: usize,
) -> &'a str {
    let slice = &content[image_end..next_boundary.min(content.len())];
    let heading_re = Regex::new(r"(?m)^#{1,6}\s+").unwrap();
    let fences = get_code_block_ranges(slice);
    for m in heading_re.find_iter(slice) {
        if !is_inside_ranges(&(m.start()..m.end()), &fences) {
            return &slice[..m.start()];
        }
    }
    slice
}

fn check_markits_consistency(
    root: &Path,
    page: &str,
    content: &str,
    image_entries: &[(String, PathBuf, Range<usize>)],
) -> Vec<Value> {
    let mut issues = Vec::new();
    let canonical_root = root.canonicalize().ok();

    for (idx, (_url, target, range)) in image_entries.iter().enumerate() {
        let Ok(bytes) = fs::read(target) else { continue };
        let (Some(scene), uimap) = read_markits_metadata(root, target, &bytes) else {
            continue;
        };
        let Some(annotations) = scene.get("annotations").and_then(Value::as_array) else {
            continue;
        };

        let mut image_steps = BTreeSet::new();
        let mut targets_info = Vec::new();
        let mut target_names = BTreeSet::new();
        for ann in annotations {
            let kind = ann["type"].as_str().unwrap_or("");
            let target_name = ann
                .get("target")
                .and_then(|t| resolve_target_name(t, &uimap));
            if let Some(name) = &target_name {
                if name.chars().count() >= 2 {
                    target_names.insert(name.clone());
                }
            }
            if kind == "badge" {
                if let Some(step) = ann["step"].as_u64().filter(|s| (1..=20).contains(s)) {
                    let step = step as u32;
                    image_steps.insert(step);
                    targets_info.push(json!({
                        "step": step,
                        "uimap_name": target_name
                    }));
                }
            }
        }

        let next_image_start = image_entries
            .get(idx + 1)
            .map(|(_, _, r)| r.start)
            .unwrap_or(content.len());
        let section = explanation_section(content, range.end, next_image_start);
        let rel_image = canonical_root
            .as_ref()
            .and_then(|cr| target.strip_prefix(cr).ok())
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| target.to_string_lossy().replace('\\', "/"));

        // 1. Check badge step numbers vs text references.
        let (text_order, text_steps) = extract_text_steps(section);
        let should_check_steps = image_steps.len() >= 2 || (!image_steps.is_empty() && !text_steps.is_empty());
        if should_check_steps {
            let missing_in_text: Vec<u32> = image_steps.difference(&text_steps).copied().collect();
            let missing_in_image: Vec<u32> = text_steps.difference(&image_steps).copied().collect();
            if !missing_in_text.is_empty() || !missing_in_image.is_empty() {
                let mut parts = Vec::new();
                if !missing_in_text.is_empty() {
                    let labels: Vec<String> = missing_in_text
                        .iter()
                        .map(|step| {
                            let name = targets_info
                                .iter()
                                .find(|info| info["step"].as_u64() == Some(*step as u64))
                                .and_then(|info| info["uimap_name"].as_str());
                            match name {
                                Some(n) => format!("{}（対象:「{n}」）", format_circled(*step)),
                                None => format_circled(*step),
                            }
                        })
                        .collect();
                    parts.push(format!(
                        "画像の注釈番号 {} が直後の本文に言及されていません。",
                        labels.join("・")
                    ));
                }
                if !missing_in_image.is_empty() {
                    let labels: Vec<String> = missing_in_image
                        .iter()
                        .map(|step| format_circled(*step))
                        .collect();
                    parts.push(format!(
                        "本文で参照している番号 {} が画像の注釈に見つかりません。",
                        labels.join("・")
                    ));
                }
                issues.push(issue(
                    page,
                    "annotation_step_mismatch",
                    "warning",
                    &parts.join(" "),
                    content,
                    range.clone(),
                    None,
                    Some(json!({
                        "image": rel_image,
                        "image_steps": image_steps.iter().copied().collect::<Vec<_>>(),
                        "text_steps": text_steps.iter().copied().collect::<Vec<_>>(),
                        "missing_in_text": missing_in_text,
                        "missing_in_image": missing_in_image,
                        "targets": targets_info,
                        "section_start": content[..range.end].encode_utf16().count(),
                        "section_end": content[..(range.end + section.len())].encode_utf16().count()
                    })),
                ));
            } else if text_order.windows(2).any(|w| w[0] > w[1]) {
                let seq: Vec<String> = text_order.iter().map(|s| format_circled(*s)).collect();
                issues.push(issue(
                    page,
                    "annotation_step_order",
                    "warning",
                    &format!(
                        "本文中の注釈番号の出現順が昇順になっていません（{}）。",
                        seq.join(" → ")
                    ),
                    content,
                    range.clone(),
                    None,
                    Some(json!({
                        "image": rel_image,
                        "text_order": text_order
                    })),
                ));
            }
        }

        // 2. Check UIMap element names against quoted UI labels in the explanation section.
        if !target_names.is_empty() {
            let quoted_labels = extract_quoted_ui_labels(section);
            let plain_section = strip_code_fences(section);
            for target_name in &target_names {
                if target_name.chars().count() < 3 || plain_section.contains(target_name.as_str()) {
                    continue;
                }
                let near = quoted_labels.iter().find(|label| {
                    if label.chars().count() < 2 {
                        return false;
                    }
                    let partial = (target_name.contains(label.as_str())
                        || label.contains(target_name.as_str()))
                        && label.chars().count() * 2 >= target_name.chars().count();
                    let dist = levenshtein(target_name, label);
                    let max_len = target_name.chars().count().max(label.chars().count());
                    partial || (dist > 0 && dist <= 2 && max_len >= 4)
                });
                if let Some(near_label) = near {
                    issues.push(issue(
                        page,
                        "annotation_target_mismatch",
                        "warning",
                        &format!(
                            "画像の注釈対象は「{target_name}」ですが、本文には近い表記「{near_label}」があります。UI表記を確認してください。"
                        ),
                        content,
                        range.clone(),
                        None,
                        Some(json!({
                            "image": rel_image,
                            "expected_ui": target_name,
                            "found_label": near_label,
                            "section_start": content[..range.end].encode_utf16().count(),
                            "section_end": content[..(range.end + section.len())].encode_utf16().count()
                        })),
                    ));
                }
            }
        }
    }
    issues
}

fn check_ai_notes(page: &str, content: &str) -> Vec<Value> {
    let re = Regex::new(r"(?s)<!--\s*ai-note\s*:\s*(.*?)\s*-->").unwrap();
    let fences = get_code_block_ranges(content);
    let mut issues = Vec::new();
    for cap in re.captures_iter(content) {
        let Some(full) = cap.get(0) else { continue };
        let range = full.start()..full.end();
        if is_inside_ranges(&range, &fences) {
            continue;
        }
        let note = cap
            .get(1)
            .map(|m| m.as_str().trim())
            .unwrap_or("")
            .to_string();
        issues.push(issue(
            page,
            "unresolved_ai_note",
            "warning",
            &format!(
                "未解決のAIメモが残っています: {}",
                if note.is_empty() { "（内容なし）" } else { &note }
            ),
            content,
            range,
            None,
            Some(json!({ "note": note })),
        ));
    }
    issues
}

pub fn check(root: &Path) -> Result<Value, String> {
    check_page(root, None)
}

pub fn check_page(root: &Path, target_page: Option<&str>) -> Result<Value, String> {
    let config = read_config(root);
    let files = task::collect_target_markdown_files(root, &config);
    let target_filter = target_page
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| p.replace('\\', "/"));
    let glossary_terms = glossary::load(root).map(|g| g.terms).unwrap_or_default();
    let mut issues = Vec::new();

    for (page, path) in files {
        if let Some(filter) = &target_filter {
            let docs_prefix = format!("{}/", config.docs.trim_end_matches('/'));
            let short = page.strip_prefix(&docs_prefix).unwrap_or(&page);
            if &page != filter && short != filter {
                continue;
            }
        }
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let content = crate::legacy_ai::plain_markdown(&content, Some(&root.join("manual/ai")));
        let html_links = Regex::new(r#"(?i)(href|src)\s*=\s*["']([^"']+)["']"#).unwrap();
        let links: Vec<(String, bool, Range<usize>)> =
            Parser::new_ext(&content, Options::all())
                .into_offset_iter()
                .flat_map(|(event, range)| match event {
                    Event::Start(Tag::Image { dest_url, .. }) => {
                        vec![(dest_url.to_string(), true, range)]
                    }
                    Event::Start(Tag::Link { dest_url, .. }) => {
                        vec![(dest_url.to_string(), false, range)]
                    }
                    Event::Html(html) | Event::InlineHtml(html) => html_links
                        .captures_iter(&html)
                        .map(|cap| {
                            (
                                decode_html_attr(&cap[2]),
                                cap[1].eq_ignore_ascii_case("src"),
                                range.clone(),
                            )
                        })
                        .collect(),
                    _ => vec![],
                })
                .collect();

        let mut valid_pngs: Vec<(String, PathBuf, Range<usize>)> = Vec::new();
        for (url, image, range) in links {
            if url.contains(':') || url.starts_with("//") {
                continue;
            }
            let target = if url.starts_with('#') {
                Ok(path.clone())
            } else {
                local_path(root, &path, &url)
            };
            let invalid = match target {
                Err(error) => Some(error),
                Ok(target) if !target.exists() => Some(format!("参照先がありません: {url}")),
                Ok(target) if image => {
                    if let Ok(bytes) = fs::read(&target) {
                        if target
                            .extension()
                            .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
                        {
                            if image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
                                .is_err()
                            {
                                Some(format!("PNG画像が破損しています: {url}"))
                            } else {
                                valid_pngs.push((url.clone(), target, range.clone()));
                                None
                            }
                        } else {
                            None
                        }
                    } else {
                        Some(format!("画像を読み込めません: {url}"))
                    }
                }
                Ok(target) => {
                    if let Some((_, fragment)) = url.split_once('#') {
                        if !fragment.is_empty()
                            && target.extension().is_some_and(|ext| ext == "md")
                        {
                            let value =
                                percent_encoding::percent_decode_str(fragment).decode_utf8_lossy();
                            let source = fs::read_to_string(target).map_err(|e| e.to_string())?;
                            if !anchors(&source).contains(value.as_ref()) {
                                Some(format!("見出しがありません: {url}"))
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
            };
            if let Some(message) = invalid {
                issues.push(issue(
                    &page,
                    if image { "missing_image" } else { "broken_link" },
                    "error",
                    &message,
                    &content,
                    range,
                    None,
                    None,
                ));
            }
        }

        issues.extend(check_markits_consistency(root, &page, &content, &valid_pngs));
        issues.extend(check_ai_notes(&page, &content));
        issues.extend(glossary::check_text(&page, &content, &glossary_terms));
    }

    let error_count = issues
        .iter()
        .filter(|item| item["severity"].as_str() == Some("error"))
        .count();
    let warning_count = issues.len() - error_count;
    Ok(json!({
        "passed": error_count == 0,
        "has_warnings": warning_count > 0,
        "error_count": error_count,
        "warning_count": warning_count,
        "issues": issues
    }))
}

pub fn require_ready(root: &Path) -> Result<(), String> {
    let report = check(root)?;
    if report["passed"] == false {
        return Err(format!(
            "完成版の品質チェックに失敗しました。下書きは作成できます。\n{}",
            serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_locations_handle_unicode_repeated_links_without_legacy_blockers() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs")).unwrap();
        let content = "# 😀日本語\n\n[First](missing.md)\n[Again](missing.md)\n\n```md\n![Example](missing.png)\n```\n\n<!-- ai:task id=stale kind=text prompt=\"New\" source-sha256=0000000000000000000000000000000000000000000000000000000000000000 -->\nOld answer\n<!-- /ai:task -->\n";
        fs::write(root.path().join("docs/index.md"), content).unwrap();
        let report = check(root.path()).unwrap();
        let issues = report["issues"].as_array().unwrap();
        let links: Vec<_> = issues
            .iter()
            .filter(|v| v["kind"] == "broken_link")
            .collect();
        assert_eq!(links.len(), 2);
        assert_eq!(links[0]["line"], 3);
        assert_eq!(links[1]["line"], 4);
        let start = content.find("[First]").unwrap();
        assert_eq!(links[0]["start"], content[..start].encode_utf16().count());
        assert_eq!(links[0]["snippet"], "[First](missing.md)");
        assert!(!issues.iter().any(|v| v["kind"] == "stale_answer"));
        assert!(!issues.iter().any(|v| v["kind"] == "missing_image"));
    }

    #[test]
    fn missing_images_and_links_block_final_without_legacy_tags() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs")).unwrap();
        fs::write(
            root.path().join("docs/index.md"),
            "# Home\n[Missing](no.md)\n![Image](missing.png)\n<!-- ai:task id=todo kind=text prompt=\"Write\" -->\n<!-- /ai:task -->",
        )
        .unwrap();
        let report = check(root.path()).unwrap();
        assert_eq!(report["passed"], false);
        assert_eq!(report["issues"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn internal_links_allow_parent_but_never_escape() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs/sub")).unwrap();
        let page = root.path().join("docs/sub/a.md");
        assert_eq!(
            local_path(root.path(), &page, "../b.md").unwrap(),
            root.path().canonicalize().unwrap().join("docs/b.md")
        );
        assert!(local_path(root.path(), &page, "../../../etc/passwd").is_err());
    }

    #[test]
    fn detects_markits_step_target_glossary_and_ai_note_warnings_without_blocking_build() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs/assets")).unwrap();

        let mut buf = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(200, 120)
            .write_to(&mut buf, image::ImageFormat::Png)
            .unwrap();
        let base = markits::raster::embed_png_uimap(
            &buf.into_inner(),
            &[
                markits::UiElement::new("button", "撮影するアプリを登録", 10., 10., 120., 30.),
                markits::UiElement::new("button", "保存する", 10., 50., 80., 30.),
            ],
        )
        .unwrap();
        let scene = json!({
            "annotations": [
                {"type": "badge", "target": "撮影するアプリを登録", "step": 1, "style": "step"},
                {"type": "badge", "target": "保存する", "step": 2, "style": "step"}
            ]
        });
        let annotated = crate::markits_scene::render_tracked(&scene, &base).unwrap();
        fs::write(root.path().join("docs/assets/step.png"), annotated).unwrap();

        glossary::save(
            root.path(),
            &glossary::GlossaryFile {
                version: 1,
                terms: vec![glossary::GlossaryTerm {
                    id: "folder".into(),
                    preferred: "フォルダー".into(),
                    avoid: vec!["フォルダ".into()],
                    category: "style".into(),
                    case_sensitive: false,
                    note: "長音あり".into(),
                    source: "manual".into(),
                }],
            },
        )
        .unwrap();

        let md = concat!(
            "# 使い方\n\n",
            "![操作画面](assets/step.png)\n\n",
            "1. 「撮影するアプリ登録」（①）を押してフォルダを選びます。\n",
            "<!-- ai-note: ②の説明を追記する -->\n",
            "```md\n<!-- ai-note: コード内は無視 -->\n```\n"
        );
        fs::write(root.path().join("docs/index.md"), md).unwrap();

        let report = check(root.path()).unwrap();
        assert_eq!(report["passed"], true);
        assert_eq!(report["has_warnings"], true);
        let issues = report["issues"].as_array().unwrap();
        assert!(issues.iter().any(|i| i["kind"] == "annotation_step_mismatch"
            && i["details"]["missing_in_text"] == json!([2])));
        assert!(issues.iter().any(|i| i["kind"] == "annotation_target_mismatch"
            && i["details"]["expected_ui"] == "撮影するアプリを登録"
            && i["details"]["found_label"] == "撮影するアプリ登録"));
        assert!(issues.iter().any(|i| i["kind"] == "unresolved_ai_note"
            && i["details"]["note"] == "②の説明を追記する"));
        assert_eq!(
            issues
                .iter()
                .filter(|i| i["kind"] == "unresolved_ai_note")
                .count(),
            1
        );
        assert!(issues
            .iter()
            .any(|i| i["kind"] == "glossary_violation" && i["snippet"] == "フォルダ"));
        assert!(require_ready(root.path()).is_ok());
    }
}
