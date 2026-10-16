use crate::{
    config::{project_page_path, project_path, read_config},
    task,
};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};
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
pub(crate) fn decode_html_attr(value:&str)->String {
    value.replace("&quot;","\"").replace("&#39;","'").replace("&lt;","<").replace("&gt;",">").replace("&amp;","&")
}
fn anchors(content: &str) -> BTreeSet<String> {
    let mut heading = false;
    let mut text = String::new();
    let mut found = BTreeSet::new();
    let mut counts = std::collections::BTreeMap::new();
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
    json!({"line":content[..start].bytes().filter(|b| *b == b'\n').count()+1,
        "start":content[..start].encode_utf16().count(), "end":content[..end].encode_utf16().count(),
        "snippet":&content[start..end]})
}
fn issue(page: &str, kind: &str, message: &str, content: &str, range: std::ops::Range<usize>, tag: Option<&str>) -> Value {
    let mut value=location(content,range.start,range.end);
    value["page"]=json!(page); value["kind"]=json!(kind); value["message"]=json!(message);
    if let Some(tag)=tag { value["tag"]=json!(tag); } value
}
pub fn check(root: &Path) -> Result<Value, String> {
    let config = read_config(root);
    let files = task::collect_target_markdown_files(root, &config);
    let mut issues = Vec::new();

    for (page, path) in files {
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let content = crate::legacy_ai::plain_markdown(&content, Some(&root.join("manual/ai")));
        let html_links = regex::Regex::new(r#"(?i)(href|src)\s*=\s*["']([^"']+)["']"#).unwrap();
        let links: Vec<(String, bool, std::ops::Range<usize>)> = Parser::new_ext(&content, Options::all()).into_offset_iter()
            .flat_map(|(event, range)| match event {
                Event::Start(Tag::Image { dest_url, .. }) => vec![(dest_url.to_string(), true, range)],
                Event::Start(Tag::Link { dest_url, .. }) => vec![(dest_url.to_string(), false, range)],
                Event::Html(html) | Event::InlineHtml(html) => html_links
                    .captures_iter(&html)
                    .map(|cap| (decode_html_attr(&cap[2]), cap[1].eq_ignore_ascii_case("src"), range.clone()))
                    .collect(),
                _ => vec![],
            })
            .collect();
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
                        if target.extension().is_some_and(|ext| ext == "png")
                            && image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
                                .is_err()
                        {
                            Some(format!("PNG画像が破損しています: {url}"))
                        } else {
                            None
                        }
                    } else {
                        Some(format!("画像を読み込めません: {url}"))
                    }
                }
                Ok(target) => {
                    if let Some((_, fragment)) = url.split_once('#') {
                        if !fragment.is_empty() && target.extension().is_some_and(|ext| ext == "md")
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
                issues.push(issue(&page,if image{"missing_image"}else{"broken_link"}, &message,&content,range,None));
            }
        }
    }
    Ok(json!({"passed":issues.is_empty(),"issues":issues}))
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
        let root=tempfile::tempdir().unwrap();fs::create_dir_all(root.path().join("docs")).unwrap();
        let content="# 😀日本語\n\n[First](missing.md)\n[Again](missing.md)\n\n```md\n![Example](missing.png)\n```\n\n<!-- ai:task id=stale kind=text prompt=\"New\" source-sha256=0000000000000000000000000000000000000000000000000000000000000000 -->\nOld answer\n<!-- /ai:task -->\n";
        fs::write(root.path().join("docs/index.md"),content).unwrap();let report=check(root.path()).unwrap();let issues=report["issues"].as_array().unwrap();
        let links:Vec<_>=issues.iter().filter(|v|v["kind"]=="broken_link").collect();assert_eq!(links.len(),2);assert_eq!(links[0]["line"],3);assert_eq!(links[1]["line"],4);
        let start=content.find("[First]").unwrap();assert_eq!(links[0]["start"],content[..start].encode_utf16().count());assert_eq!(links[0]["snippet"],"[First](missing.md)");
        assert!(!issues.iter().any(|v|v["kind"]=="stale_answer"));assert!(!issues.iter().any(|v|v["kind"]=="missing_image"));
    }
    #[test]
    fn missing_images_and_links_block_final_without_legacy_tags() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("docs")).unwrap();
        fs::write(root.path().join("docs/index.md"),"# Home\n[Missing](no.md)\n![Image](missing.png)\n<!-- ai:task id=todo kind=text prompt=\"Write\" -->\n<!-- /ai:task -->").unwrap();
        let report = check(root.path()).unwrap();
        assert_eq!(report["passed"], false);
        assert_eq!(report["issues"].as_array().unwrap().len(),2);
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
}
