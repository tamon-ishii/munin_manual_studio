//! Project-wide manual structure dashboard, cross-page consistency diagnostics, and audience controls.
use crate::{
    audience, builder,
    config::{project_path, read_config},
    quality,
    task::{self, get_code_block_ranges, is_inside_ranges},
};
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write as _,
    path::Path,
};

const VALID_AUDIENCES: [&str; 3] = ["user", "developer", "maintainer"];

fn parse_page_audiences(content: &str) -> Vec<String> {
    let pattern = Regex::new(r"(?m)^<!--\s*ai:audience\s+([^>]+?)\s*-->\s*$").unwrap();
    let fences = get_code_block_ranges(content);
    let Some(cap) = pattern.captures_iter(content).find(|c| {
        let m = c.get(0).unwrap();
        !is_inside_ranges(&(m.start()..m.end()), &fences)
    }) else {
        return Vec::new();
    };
    cap[1]
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| VALID_AUDIENCES.contains(&s.as_str()))
        .collect()
}

pub fn set_page_audience(root: &Path, page: &str, audiences: &[String]) -> Result<Value, String> {
    for item in audiences {
        if !VALID_AUDIENCES.contains(&item.as_str()) {
            return Err(format!("対象読者が不正です: {item}（user / developer / maintainer）"));
        }
    }
    let config = read_config(root);
    let rel = {
        let clean = page.trim().replace('\\', "/");
        if project_path(root, &clean).is_ok_and(|p| p.is_file()) {
            clean
        } else {
            format!("{}/{}", config.docs.trim_end_matches('/'), clean)
        }
    };
    let path = project_path(root, &rel)?;
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let pattern = Regex::new(r"(?m)^<!--\s*ai:audience\s+[^>]+?\s*-->\r?\n?").unwrap();
    let stripped = pattern.replace(&content, "").into_owned();

    let mut unique = Vec::new();
    for a in audiences {
        if !unique.contains(a) {
            unique.push(a.clone());
        }
    }
    let next = if unique.is_empty() {
        stripped
    } else {
        format!("<!-- ai:audience {} -->\n{}", unique.join(", "), stripped)
    };

    let parent = path.parent().ok_or("保存先が不正です。")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(next.as_bytes()).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(&path).map_err(|e| e.to_string())?;

    Ok(json!({
        "page": rel,
        "audiences": unique,
        "content": next
    }))
}

pub fn build_for_audience(
    root: &Path,
    target_audience: &str,
    engine: &str,
    output_override: Option<&str>,
    draft: bool,
) -> Result<Value, String> {
    if !VALID_AUDIENCES.contains(&target_audience) {
        return Err("対象読者は user / developer / maintainer から選んでください。".into());
    }
    let config = read_config(root);
    let docs = project_path(root, &config.docs)?;
    let generated = root.join("manual").join("ai");
    let output_rel = output_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{}-{target_audience}", config.output.trim_end_matches('/')));
    let output = project_path(root, &output_rel)?;
    let site_engine = match engine {
        "zensical" | "build-zensical" => builder::SiteEngine::Zensical,
        _ => builder::SiteEngine::MkDocs,
    };
    let summary = audience::build_with_engine(root, &docs, &generated, &output, draft, target_audience, site_engine)?;
    Ok(json!({
        "audience": target_audience,
        "output": output_rel,
        "summary": summary
    }))
}

pub fn overview(root: &Path) -> Result<Value, String> {
    let config = read_config(root);
    let files = task::collect_target_markdown_files(root, &config);
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let quality_report = quality::check(root)?;
    let all_issues = quality_report["issues"].as_array().cloned().unwrap_or_default();

    let mut page_entries = Vec::new();
    let mut incoming_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut heading_owners: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut all_rel_pages = BTreeSet::new();
    let mut outgoing_map: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut audience_map: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for (page, path) in &files {
        let rel = path
            .canonicalize()
            .ok()
            .and_then(|p| p.strip_prefix(&canonical_root).ok().map(Path::to_path_buf))
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| page.clone());
        all_rel_pages.insert(rel.clone());
        incoming_counts.entry(rel).or_insert(0);
    }

    for (page, path) in &files {
        let Ok(content) = fs::read_to_string(path) else {
            continue;
        };
        let rel = path
            .canonicalize()
            .ok()
            .and_then(|p| p.strip_prefix(&canonical_root).ok().map(Path::to_path_buf))
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| page.clone());

        let audiences = parse_page_audiences(&content);
        audience_map.insert(rel.clone(), audiences.clone());

        let mut title = String::new();
        let mut headings = Vec::new();
        let mut in_heading: Option<HeadingLevel> = None;
        let mut heading_text = String::new();
        let mut image_count = 0usize;
        let mut outgoing = BTreeSet::new();

        for event in Parser::new_ext(&content, Options::all()) {
            match event {
                Event::Start(Tag::Heading { level, .. }) => {
                    in_heading = Some(level);
                    heading_text.clear();
                }
                Event::Text(t) | Event::Code(t) if in_heading.is_some() => {
                    heading_text.push_str(&t);
                }
                Event::End(TagEnd::Heading(_)) => {
                    if let Some(level) = in_heading.take() {
                        let cleaned = heading_text.trim().to_string();
                        if !cleaned.is_empty() {
                            if level == HeadingLevel::H1 && title.is_empty() {
                                title = cleaned.clone();
                            }
                            if matches!(level, HeadingLevel::H1 | HeadingLevel::H2) {
                                heading_owners
                                    .entry(cleaned.clone())
                                    .or_default()
                                    .push(rel.clone());
                            }
                            headings.push(json!({
                                "level": format!("{level:?}"),
                                "text": cleaned
                            }));
                        }
                    }
                }
                Event::Start(Tag::Image { .. }) => {
                    image_count += 1;
                }
                Event::Start(Tag::Link { dest_url, .. }) => {
                    let url = dest_url.as_ref();
                    if !url.contains(':') && !url.starts_with("//") && !url.starts_with('#') {
                        if let Ok(target) = quality::local_path(root, path, url) {
                            if let Ok(canon) = target.canonicalize() {
                                if let Ok(target_rel) = canon.strip_prefix(&canonical_root) {
                                    let target_str = target_rel.to_string_lossy().replace('\\', "/");
                                    if all_rel_pages.contains(&target_str) && target_str != rel {
                                        outgoing.insert(target_str);
                                    }
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        for target in &outgoing {
            *incoming_counts.entry(target.clone()).or_insert(0) += 1;
        }
        outgoing_map.insert(rel.clone(), outgoing.iter().cloned().collect());

        let page_issues: Vec<&Value> = all_issues
            .iter()
            .filter(|i| {
                let p = i["page"].as_str().unwrap_or("");
                p == page || p == rel
            })
            .collect();
        let error_count = page_issues
            .iter()
            .filter(|i| i["severity"].as_str() == Some("error"))
            .count();
        let warning_count = page_issues.len() - error_count;
        let ai_note_count = page_issues
            .iter()
            .filter(|i| i["kind"].as_str() == Some("unresolved_ai_note"))
            .count();

        page_entries.push(json!({
            "page": rel,
            "title": if title.is_empty() { page.clone() } else { title },
            "audiences": audiences,
            "char_count": content.chars().count(),
            "heading_count": headings.len(),
            "headings": headings.into_iter().take(20).collect::<Vec<_>>(),
            "image_count": image_count,
            "outgoing_links": outgoing.into_iter().collect::<Vec<_>>(),
            "error_count": error_count,
            "warning_count": warning_count,
            "ai_note_count": ai_note_count
        }));
    }

    // Attach incoming link counts & run cross-page diagnostics.
    let mut diagnostics = Vec::new();
    for entry in &mut page_entries {
        let p = entry["page"].as_str().unwrap_or("").to_string();
        let incoming = *incoming_counts.get(&p).unwrap_or(&0);
        entry["incoming_count"] = json!(incoming);
        let is_index = p.ends_with("/index.md") || p == "index.md" || p.eq_ignore_ascii_case("README.md");
        if incoming == 0 && !is_index && all_rel_pages.len() > 1 {
            diagnostics.push(json!({
                "kind": "orphan_page",
                "severity": "warning",
                "pages": [p],
                "message": format!("「{p}」は他のどのページからもリンクされていません（孤立ページ）。")
            }));
        }
    }

    for (heading, owners) in heading_owners {
        let unique: BTreeSet<String> = owners.into_iter().collect();
        if unique.len() >= 2 && heading.chars().count() >= 4 {
            let list: Vec<String> = unique.into_iter().collect();
            diagnostics.push(json!({
                "kind": "duplicate_heading",
                "severity": "info",
                "pages": list,
                "message": format!("見出し「{heading}」が複数ページ（{}）に重複しています。説明の重複やリンク統合を確認してください。", list.join(", "))
            }));
        }
    }

    // Detect audience mismatch on links (e.g. user-only page linking to developer-only page).
    for (src, targets) in &outgoing_map {
        let src_aud = audience_map.get(src).cloned().unwrap_or_default();
        if src_aud.is_empty() {
            continue;
        }
        for dst in targets {
            let dst_aud = audience_map.get(dst).cloned().unwrap_or_default();
            if !dst_aud.is_empty() && !src_aud.iter().any(|a| dst_aud.contains(a)) {
                diagnostics.push(json!({
                    "kind": "audience_link_mismatch",
                    "severity": "warning",
                    "pages": [src, dst],
                    "message": format!("読者設定の不整合: 「{src}」（{}）から「{dst}」（{}）へリンクしています。", src_aud.join("/"), dst_aud.join("/"))
                }));
            }
        }
    }

    Ok(json!({
        "total_pages": page_entries.len(),
        "total_errors": quality_report["error_count"],
        "total_warnings": quality_report["warning_count"],
        "pages": page_entries,
        "diagnostics": diagnostics
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_dashboard_diagnostics_and_updates_audience() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs")).unwrap();
        fs::write(
            root.path().join("docs/index.md"),
            "<!-- ai:audience user -->\n# ホーム\n\n[開発者ガイド](dev.md)\n",
        )
        .unwrap();
        fs::write(
            root.path().join("docs/dev.md"),
            "<!-- ai:audience developer -->\n# 開発者ガイド\n\n## 設定手順\n",
        )
        .unwrap();
        fs::write(
            root.path().join("docs/orphan.md"),
            "# 孤立ページ\n\n## 設定手順\n",
        )
        .unwrap();

        let dash = overview(root.path()).unwrap();
        assert_eq!(dash["total_pages"], 3);
        let diags = dash["diagnostics"].as_array().unwrap();
        assert!(diags.iter().any(|d| d["kind"] == "orphan_page"));
        assert!(diags.iter().any(|d| d["kind"] == "duplicate_heading"));
        assert!(diags.iter().any(|d| d["kind"] == "audience_link_mismatch"));

        let updated = set_page_audience(
            root.path(),
            "docs/orphan.md",
            &["user".into(), "developer".into()],
        )
        .unwrap();
        assert_eq!(updated["audiences"], json!(["user", "developer"]));
        let content = fs::read_to_string(root.path().join("docs/orphan.md")).unwrap();
        assert!(content.starts_with("<!-- ai:audience user, developer -->\n"));
    }
}
