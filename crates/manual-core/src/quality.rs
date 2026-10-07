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
pub fn check(root: &Path) -> Result<Value, String> {
    let config = read_config(root);
    let files = task::collect_target_markdown_files(root, &config);
    let mut issues = Vec::new();
    let runs = crate::workflow::history(root, None)?;
    for (page, path) in files {
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        for tag in task::parse_page_tags(&page, &content, &mut Default::default())? {
            let task = match tag {
                task::PageTag::Task { task, .. } | task::PageTag::Generated { task, .. } => task,
            };
            if task.status == "missing" {
                issues.push(json!({"page":page,"tag":task.id,"kind":"ungenerated","message":"未生成のAIタグです。"}));
            }
        }
        let html_links = regex::Regex::new(r#"(?i)(href|src)\s*=\s*["']([^"']+)["']"#).unwrap();
        let links: Vec<(String, bool)> = Parser::new_ext(&content, Options::all())
            .flat_map(|event| match event {
                Event::Start(Tag::Image { dest_url, .. }) => vec![(dest_url.to_string(), true)],
                Event::Start(Tag::Link { dest_url, .. }) => vec![(dest_url.to_string(), false)],
                Event::Html(html) | Event::InlineHtml(html) => html_links
                    .captures_iter(&html)
                    .map(|cap| (cap[2].to_owned(), cap[1].eq_ignore_ascii_case("src")))
                    .collect(),
                _ => vec![],
            })
            .collect();
        for (url, image) in links {
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
                issues.push(json!({"page":page,"kind":if image{"missing_image"}else{"broken_link"},"message":message}));
            }
        }
    }
    let mut seen = BTreeSet::new();
    for run in runs["runs"].as_array().unwrap() {
        if let Some(entries) = run["entries"].as_array() {
            for entry in entries {
                let key = (
                    run["page"].as_str().unwrap_or_default(),
                    entry["task"]["id"].as_str().unwrap_or_default(),
                );
                if !seen.insert(key) {
                    continue;
                }
                if entry["status"] == "failed" {
                    issues.push(json!({"page":key.0,"tag":key.1,"kind":"execution_failure","message":entry["error"]}));
                }
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
    fn missing_images_links_and_ungenerated_tasks_block_final() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("docs")).unwrap();
        fs::write(root.path().join("docs/index.md"),"# Home\n[Missing](no.md)\n![Image](missing.png)\n<!-- ai:task id=todo kind=text prompt=\"Write\" -->\n<!-- /ai:task -->").unwrap();
        let report = check(root.path()).unwrap();
        assert_eq!(report["passed"], false);
        assert!(report["issues"].as_array().unwrap().len() >= 3);
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
