use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use regex::Regex;
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use super::agent::get_agents;
use super::builder::build;
use super::config::{has_config, project_path, read_config, DEFAULT_BRIEF};
use super::task::{
    collect_target_markdown_files, parse_page_tags, read_answer, scan_entries, tasks, utc_now,
    PageTag,
};

pub fn render_page_markdown(
    templates: &Path,
    generated: &Path,
    page_rel: &Path,
    _draft: bool,
) -> Result<String, String> {
    let page_path = if templates.join(page_rel).is_file() {
        templates.join(page_rel)
    } else if let Some(parent) = templates.parent() {
        if parent.join(page_rel).is_file() {
            parent.join(page_rel)
        } else {
            templates.join(page_rel)
        }
    } else {
        templates.join(page_rel)
    };
    if !page_path.is_file() {
        return Err(format!("Preview page is missing: {}", page_rel.display()));
    }
    let content = fs::read_to_string(&page_path).map_err(|e| e.to_string())?;
    let task_list = tasks(templates)?;
    let mut answers = HashMap::new();
    for task in &task_list {
        let answer_path = generated.join("answers").join(format!("{}.md", task.id));
        if answer_path.is_file() {
            if let Ok(ans) = read_answer(&answer_path, task) {
                answers.insert(task.id.clone(), ans);
            }
        }
    }

    let built_at = utc_now();
    let page_rel_str = page_rel.to_string_lossy().replace('\\', "/");
    let mut ids = std::collections::HashSet::new();
    let tags = parse_page_tags(&page_rel_str, &content, &mut ids)?;

    let mut result = String::new();
    let mut last_idx = 0;

    for tag in tags {
        if let PageTag::Task { range, task } = tag {
            result.push_str(&content[last_idx..range.start]);
            let task_id = &task.id;
            let kind = &task.kind;

            if let Some((created, body, approved)) = answers.get(task_id) {
                result.push_str(&super::task::render_task_block(
                    &task,
                    body,
                    created,
                    approved.as_deref(),
                ));
            } else {
                result.push_str(&format!("> **作成待ち:** `{task_id}` ({kind})"));
            }
            last_idx = range.end;
        }
    }
    result.push_str(&content[last_idx..]);

    Ok(result.replace("{{BUILD_TIMESTAMP}}", &built_at))
}

pub fn inline_html_assets(output: &Path, html_text: &str) -> String {
    let css_pattern = Regex::new(
        r#"(?i)<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["'](?P<href>[^"']+)["'][^>]*>"#,
    )
    .unwrap();

    let mut step1 = String::new();
    let mut last_idx = 0;
    for cap in css_pattern.captures_iter(html_text) {
        let m = cap.get(0).unwrap();
        step1.push_str(&html_text[last_idx..m.start()]);
        let href = cap.name("href").unwrap().as_str();
        let clean = href
            .split('?')
            .next()
            .unwrap_or(href)
            .split('#')
            .next()
            .unwrap_or(href);
        let clean_rel = clean.trim_start_matches(|c| c == '.' || c == '/');

        let mut css_path = output.join(clean_rel);
        if !css_path.is_file() {
            let name = Path::new(clean).file_name();
            if let Some(n) = name {
                for entry in WalkDir::new(output).into_iter().filter_map(|e| e.ok()) {
                    if entry.file_type().is_file() && entry.file_name() == n {
                        css_path = entry.path().to_path_buf();
                        break;
                    }
                }
            }
        }

        if css_path.is_file() {
            if let Ok(css_content) = fs::read_to_string(&css_path) {
                step1.push_str(&format!(
                    "<style>/* inlined {href} */\n{css_content}\n</style>"
                ));
                last_idx = m.end();
                continue;
            }
        }
        step1.push_str(m.as_str());
        last_idx = m.end();
    }
    step1.push_str(&html_text[last_idx..]);

    let img_pattern = Regex::new(r#"(?i)<img\s+[^>]*src=["'](?P<src>[^"']+)["'][^>]*>"#).unwrap();

    let mut step2 = String::new();
    last_idx = 0;
    for cap in img_pattern.captures_iter(&step1) {
        let m = cap.get(0).unwrap();
        step2.push_str(&step1[last_idx..m.start()]);
        let src = cap.name("src").unwrap().as_str();
        let clean = src
            .split('?')
            .next()
            .unwrap_or(src)
            .split('#')
            .next()
            .unwrap_or(src);
        let clean_rel = clean.trim_start_matches(|c| c == '.' || c == '/');

        let mut img_path = output.join(clean_rel);
        if !img_path.is_file() {
            let name = Path::new(clean).file_name();
            if let Some(n) = name {
                for entry in WalkDir::new(output).into_iter().filter_map(|e| e.ok()) {
                    if entry.file_type().is_file() && entry.file_name() == n {
                        img_path = entry.path().to_path_buf();
                        break;
                    }
                }
            }
        }

        if img_path.is_file() {
            let ext = img_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            let mime = match ext.as_str() {
                "png" => Some("image/png"),
                "jpg" | "jpeg" => Some("image/jpeg"),
                "webp" => Some("image/webp"),
                "svg" => Some("image/svg+xml"),
                _ => None,
            };
            if let Some(mime_type) = mime {
                if let Ok(metadata) = fs::metadata(&img_path) {
                    if metadata.len() < 10_000_000 {
                        if let Ok(bytes) = fs::read(&img_path) {
                            let b64 = BASE64.encode(bytes);
                            let tag = m
                                .as_str()
                                .replace(src, &format!("data:{mime_type};base64,{b64}"));
                            step2.push_str(&tag);
                            last_idx = m.end();
                            continue;
                        }
                    }
                }
            }
        }
        step2.push_str(m.as_str());
        last_idx = m.end();
    }
    step2.push_str(&step1[last_idx..]);

    let nav_script = "<script>\n\
document.addEventListener('click', function(e) {\n\
  var a = e.target.closest('a');\n\
  if (!a) return;\n\
  var href = a.getAttribute('href');\n\
  if (!href) return;\n\
  if (href.startsWith('#')) return;\n\
  e.preventDefault();\n\
  if (/^(https?:)?\\/\\//i.test(href) || href.startsWith('mailto:')) {\n\
    window.open(a.href, '_blank');\n\
  } else {\n\
    window.parent.postMessage({ type: 'moduleloom_manual_navigate', href: href }, '*');\n\
  }\n\
});\n\
</script>\n";

    if step2.contains("</body>") {
        step2.replace("</body>", &format!("{nav_script}</body>"))
    } else {
        format!("{step2}{nav_script}")
    }
}

pub fn preview_page(root: &Path, page: &str) -> Result<String, String> {
    let config = read_config(root);
    let templates = project_path(root, &config.docs)?;
    let generated = root.join("manual").join("ai");
    let target = if let Ok(tp) = project_path(&templates, page) {
        if tp.is_file() {
            tp
        } else {
            project_path(root, page)?
        }
    } else {
        project_path(root, page)?
    };
    if target.extension().map_or(true, |ext| ext != "md") || !target.is_file() {
        return Err(format!("Preview page is missing: {page}"));
    }
    render_page_markdown(&templates, &generated, Path::new(page), true)
}

pub fn preview_html(root: &Path, page: &str) -> Result<String, String> {
    let config = read_config(root);
    let templates = project_path(root, &config.docs)?;
    let generated = root.join("manual").join("ai");
    let output = project_path(root, &config.output)?;

    let mut page_rel = PathBuf::from(page);
    if page_rel.extension().map_or(false, |ext| ext == "md") {
        page_rel.set_extension("html");
    }

    let mut target = output.join(&page_rel);
    if !target.is_file() {
        if let Some(parent) = page_rel.parent() {
            let stem = page_rel.file_stem().unwrap_or_default();
            let dir_target = output.join(parent).join(stem).join("index.html");
            if dir_target.is_file() {
                target = dir_target;
            }
        }
    }

    if !target.is_file() {
        let _ = build(&templates, &generated, &output, true, Some(root));
        target = output.join(&page_rel);
        if !target.is_file() {
            if let Some(parent) = page_rel.parent() {
                let stem = page_rel.file_stem().unwrap_or_default();
                let dir_target = output.join(parent).join(stem).join("index.html");
                if dir_target.is_file() {
                    target = dir_target;
                }
            }
        }
    }

    if !target.is_file() {
        if let Ok(md_content) = preview_page(root, page) {
            let escaped = md_content
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;");
            let html_body = format!(
                "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>{}</title><style>body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 860px; margin: 30px auto; padding: 0 20px; line-height: 1.6; color: #24292f; }} pre {{ background: #f6f8fa; padding: 16px; border-radius: 6px; overflow: auto; font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace; }}</style></head><body><h2>{}</h2><pre style=\"white-space: pre-wrap;\">{}</pre></body></html>",
                page, page, escaped
            );
            return Ok(html_body);
        }
        return Err(format!(
            "HTML page is missing: {page}. Please build the manual first."
        ));
    }

    let content = fs::read_to_string(&target).map_err(|e| e.to_string())?;
    Ok(inline_html_assets(&output, &content))
}

pub fn preview_asset(root: &Path, page: &str, asset: &str) -> Result<String, String> {
    let config = read_config(root);
    let templates = project_path(root, &config.docs)?;
    let generated = root.join("manual").join("ai");
    let page_path = super::editor::document_path(root, page)?;

    let asset_path = Path::new(asset);
    if asset_path.is_absolute() {
        return Err("Preview image must be project-relative".to_string());
    }
    let asset_name = asset_path.file_name().unwrap_or_default();

    let candidate_paths = [
        page_path
            .parent()
            .map(|p| p.join(asset))
            .unwrap_or_default(),
        root.join(asset),
        templates.join("assets").join(asset_name),
        templates.join(asset),
        generated.join("assets").join(asset_name),
    ];

    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let mut image = None;
    for cand in &candidate_paths {
        let Ok(canonical) = cand.canonicalize() else {
            continue;
        };
        if canonical.starts_with(&canonical_root) && canonical.is_file() {
            image = Some(canonical);
            break;
        }
    }

    let img = image.ok_or_else(|| "Preview image is missing".to_string())?;
    let ext = img
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
    .ok_or_else(|| "Unsupported preview image".to_string())?;

    let meta = fs::metadata(&img).map_err(|e| e.to_string())?;
    if meta.len() > 10_000_000 {
        return Err("Unsupported preview image".to_string());
    }

    let bytes = fs::read(&img).map_err(|e| e.to_string())?;
    let b64 = BASE64.encode(bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

pub fn get_state(root: &Path) -> Result<serde_json::Value, String> {
    let config = read_config(root);
    let templates = project_path(root, &config.docs)?;
    let generated = root.join("manual").join("ai");
    let output = project_path(root, &config.output)?;
    let brief_path = root.join(&config.output).join("brief.md");
    let legacy_brief = root.join("manual").join("brief.md");

    let target_files = collect_target_markdown_files(root, &config);
    let mut pages: Vec<String> = target_files.into_iter().map(|(rel, _)| rel).collect();
    pages.sort();
    let project_entries: Vec<serde_json::Value> = WalkDir::new(root)
        .follow_links(false)
        .max_depth(8)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            entry.depth() == 0
                || (!matches!(
                    name.as_ref(),
                    "node_modules" | "target" | "dist" | "__pycache__"
                ) && (!entry.file_type().is_dir()
                    || !name.starts_with('.')
                    || name == ".github"))
        })
        .filter_map(Result::ok)
        .filter(|entry| entry.depth() > 0)
        .take(5000)
        .filter_map(|entry| {
            entry.path().strip_prefix(root).ok().map(|path| {
                json!({
                    "path": path.to_string_lossy().replace('\\', "/"),
                    "directory": entry.file_type().is_dir(),
                })
            })
        })
        .collect();

    let first_page = if pages.contains(&"index.md".to_string()) {
        "index.md"
    } else {
        pages.first().map(|s| s.as_str()).unwrap_or("")
    };
    let preview = if !first_page.is_empty() {
        preview_page(root, first_page).unwrap_or_default()
    } else {
        String::new()
    };

    let index_html = output.join("index.html");
    if !index_html.is_file() && templates.is_dir() && !pages.is_empty() {
        let _ = build(&templates, &generated, &output, true, Some(root));
    }

    let preview_html_content = if index_html.is_file() {
        fs::read_to_string(&index_html)
            .map(|c| inline_html_assets(&output, &c))
            .unwrap_or_default()
    } else {
        String::new()
    };

    let brief = if brief_path.is_file() {
        fs::read_to_string(&brief_path).unwrap_or_else(|_| DEFAULT_BRIEF.to_string())
    } else if legacy_brief.is_file() {
        fs::read_to_string(&legacy_brief).unwrap_or_else(|_| DEFAULT_BRIEF.to_string())
    } else {
        DEFAULT_BRIEF.to_string()
    };

    let has_cfg = has_config(root);
    let tasks = scan_entries(&templates, &generated);
    let image_link = Regex::new(r"!\[[^\]]*\]\((?P<path>[^)]+)\)").unwrap();
    let mut image_assets = HashMap::new();
    for (page, path) in collect_target_markdown_files(root, &config) {
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(tags) = parse_page_tags(&page, &content, &mut Default::default()) else {
            continue;
        };
        for tag in tags {
            if let PageTag::Generated { task, body, .. } = tag {
                if task.kind == "screenshot" {
                    if let Some(asset) = image_link
                        .captures(&body)
                        .and_then(|found| found.name("path"))
                    {
                        image_assets.insert(task.id, asset.as_str().to_string());
                    }
                }
            }
        }
    }
    let has_html = !preview_html_content.is_empty();

    Ok(json!({
        "has_config": has_cfg,
        "config": config,
        "agents": get_agents(),
        "brief": brief,
        "execution_results": crate::workflow::latest_results(root)?,
        "update_reasons": crate::workflow::update_reasons(root, &tasks)?,
        "tasks": tasks,
        "image_assets": image_assets,
        "capture_sources": super::capture_source::read(root)?,
        "ui_map": fs::read_to_string(project_path(root, "manual/ui_map.json")?).ok().and_then(|raw| serde_json::from_str::<super::uimap::UIMap>(&raw).ok()),
        "pages": pages,
        "project_entries": project_entries,
        "preview": preview,
        "preview_html": preview_html_content,
        "has_html": has_html,
    }))
}
