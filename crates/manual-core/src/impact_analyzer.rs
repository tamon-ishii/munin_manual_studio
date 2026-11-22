//! Detect impacted manual pages and screenshots from target application Git diffs.
use crate::{
    capture_resources,
    config::read_config,
    task,
};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn run_git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .map_err(|e| format!("gitを実行できませんでした: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn extract_changed_tokens(diff_text: &str) -> BTreeSet<String> {
    let mut tokens = BTreeSet::new();
    let quoted_re = Regex::new(r#"["'「]([^"'「」\n]{2,40})["'」]"#).unwrap();
    let ident_re = Regex::new(r"\b([a-zA-Z][a-zA-Z0-9_-]{3,40})\b").unwrap();
    let stop: BTreeSet<&str> = [
        "const", "return", "function", "import", "export", "class", "async", "await", "false",
        "true", "null", "undefined", "string", "number", "boolean", "struct", "impl", "match",
        "unwrap", "Result", "Option", "String", "usize", "public", "private", "default", "value",
        "error", "index", "length", "style", "width", "height", "color", "class", "button",
    ]
    .into_iter()
    .collect();

    for line in diff_text.lines() {
        if !(line.starts_with('+') || line.starts_with('-'))
            || line.starts_with("+++")
            || line.starts_with("---")
        {
            continue;
        }
        let body = &line[1..];
        for cap in quoted_re.captures_iter(body) {
            let val = cap[1].trim();
            if val.chars().count() >= 2 && !stop.contains(val) {
                tokens.insert(val.to_string());
            }
        }
        for cap in ident_re.captures_iter(body) {
            let val = &cap[1];
            if !stop.contains(val) && (val.contains('-') || val.contains('_') || val.chars().any(|c| c.is_uppercase())) {
                tokens.insert(val.to_string());
            }
        }
        if tokens.len() >= 120 {
            break;
        }
    }
    tokens
}

pub fn analyze(
    root: &Path,
    repo_path: Option<&str>,
    base_ref: Option<&str>,
) -> Result<Value, String> {
    let repo: PathBuf = match repo_path.map(str::trim).filter(|s| !s.is_empty()) {
        Some(custom) => {
            let candidate = Path::new(custom);
            if candidate.is_absolute() {
                candidate.to_path_buf()
            } else {
                root.join(candidate)
            }
        }
        None => root.to_path_buf(),
    };
    if !repo.is_dir() {
        return Err(format!("対象リポジトリが見つかりません: {}", repo.display()));
    }
    let base = base_ref.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("HEAD~1");

    let mut changed_files = BTreeSet::new();
    let mut diff_text = String::new();

    if let Ok(names) = run_git(&repo, &["diff", "--name-only", base]) {
        for line in names.lines().map(str::trim).filter(|l| !l.is_empty()) {
            changed_files.insert(line.replace('\\', "/"));
        }
    }
    if let Ok(diff) = run_git(&repo, &["diff", "-U0", base]) {
        diff_text.push_str(&diff);
    }
    // Also include untracked / unstaged / staged working tree changes.
    if let Ok(status) = run_git(&repo, &["status", "--porcelain"]) {
        for line in status.lines() {
            if line.len() > 3 {
                changed_files.insert(line[3..].trim().trim_matches('"').replace('\\', "/"));
            }
        }
    }
    if diff_text.is_empty() {
        if let Ok(unstaged) = run_git(&repo, &["diff", "-U0"]) {
            diff_text.push_str(&unstaged);
        }
    }

    let mut tokens = extract_changed_tokens(&diff_text);
    for file in &changed_files {
        if let Some(stem) = Path::new(file).file_stem().and_then(|s| s.to_str()) {
            if stem.len() >= 3 && stem != "index" && stem != "main" && stem != "mod" && stem != "lib" {
                tokens.insert(stem.to_string());
            }
        }
    }

    // Match against registered capture resources' UIMap names.
    let mut impacted_screenshots = Vec::new();
    let mut screenshot_names_for_pages: BTreeMap<String, Vec<String>> = BTreeMap::new();
    if let Ok(resources) = capture_resources::catalog(root) {
        for resource in resources {
            let Ok(src) = capture_resources::source(root, &resource.id) else {
                continue;
            };
            let Ok(bytes) = fs::read(&src) else { continue };
            let Some(uimap) = markits::raster::extract_png_uimap(&bytes) else {
                continue;
            };
            let matched: Vec<String> = uimap
                .iter()
                .filter_map(|el| {
                    let name = el.name.trim();
                    if name.chars().count() < 2 {
                        return None;
                    }
                    tokens
                        .iter()
                        .any(|tok| tok == name || (tok.chars().count() >= 3 && name.contains(tok.as_str())))
                        .then(|| name.to_string())
                })
                .collect();
            if !matched.is_empty() {
                let paths: Vec<String> = resource.derived.iter().map(|d| d.path.clone()).collect();
                for p in &paths {
                    screenshot_names_for_pages.insert(p.clone(), matched.clone());
                }
                impacted_screenshots.push(json!({
                    "resource_id": resource.id,
                    "name": resource.name,
                    "paths": paths,
                    "matched_ui_elements": matched
                }));
            }
        }
    }

    // Match tokens & changed file names & impacted screenshots against project manuscripts.
    let config = read_config(root);
    let pages = task::collect_target_markdown_files(root, &config);
    let canonical_root = root.canonicalize().ok();
    let mut impacted_pages = Vec::new();

    for (page, path) in pages {
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let rel_page = canonical_root
            .as_ref()
            .and_then(|cr| path.canonicalize().ok().and_then(|p| p.strip_prefix(cr).ok().map(Path::to_path_buf)))
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| page.clone());

        let mut reasons = Vec::new();
        let mut matched_lines = Vec::new();
        let mut score = 0usize;

        for (img_path, ui_hits) in &screenshot_names_for_pages {
            let basename = Path::new(img_path)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(img_path);
            if content.contains(basename) {
                score += 5;
                reasons.push(format!(
                    "影響の可能性がある撮影画像（{basename} / UI要素: {}）を参照しています",
                    ui_hits.join(", ")
                ));
            }
        }

        for file in &changed_files {
            if content.contains(file.as_str()) {
                score += 4;
                reasons.push(format!("変更されたファイル `{file}` への言及があります"));
            }
        }

        let mut token_hits = Vec::new();
        for tok in &tokens {
            if tok.chars().count() < 3 {
                continue;
            }
            if let Some(pos) = content.find(tok.as_str()) {
                let line = content[..pos].bytes().filter(|b| *b == b'\n').count() + 1;
                token_hits.push(tok.clone());
                matched_lines.push(json!({ "line": line, "token": tok }));
                score += 2;
                if token_hits.len() >= 8 {
                    break;
                }
            }
        }
        if !token_hits.is_empty() {
            reasons.push(format!(
                "変更されたUI文言・識別子と一致: {}",
                token_hits.join(", ")
            ));
        }

        if score > 0 {
            impacted_pages.push(json!({
                "page": rel_page,
                "score": score,
                "reasons": reasons,
                "matched_lines": matched_lines
            }));
        }
    }

    impacted_pages.sort_by(|a, b| {
        b["score"]
            .as_u64()
            .cmp(&a["score"].as_u64())
            .then_with(|| a["page"].as_str().cmp(&b["page"].as_str()))
    });

    Ok(json!({
        "repo": repo.to_string_lossy(),
        "base_ref": base,
        "changed_files": changed_files.into_iter().take(100).collect::<Vec<_>>(),
        "extracted_tokens": tokens.into_iter().take(40).collect::<Vec<_>>(),
        "impacted_pages": impacted_pages,
        "impacted_screenshots": impacted_screenshots
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_impacted_manual_pages_from_app_git_diff() {
        let root = tempfile::tempdir().unwrap();
        let app_repo = root.path().join("app");
        fs::create_dir_all(&app_repo).unwrap();
        fs::create_dir_all(root.path().join("docs")).unwrap();

        run_git(&app_repo, &["init"]).unwrap();
        run_git(&app_repo, &["config", "user.email", "test@example.com"]).unwrap();
        run_git(&app_repo, &["config", "user.name", "Tester"]).unwrap();
        fs::write(app_repo.join("settings.ts"), "const label = \"エクスポート設定\";\n").unwrap();
        run_git(&app_repo, &["add", "."]).unwrap();
        run_git(&app_repo, &["commit", "-m", "init"]).unwrap();

        // Update label in second commit
        fs::write(
            app_repo.join("settings.ts"),
            "const label = \"HTMLエクスポート設定\";\n",
        )
        .unwrap();
        run_git(&app_repo, &["add", "."]).unwrap();
        run_git(&app_repo, &["commit", "-m", "rename export label"]).unwrap();

        fs::write(
            root.path().join("docs/export.md"),
            "# 出力\n\n「エクスポート設定」画面を開きます。\n",
        )
        .unwrap();
        fs::write(
            root.path().join("docs/unrelated.md"),
            "# はじめに\n\nアプリを起動します。\n",
        )
        .unwrap();

        let report = analyze(root.path(), Some("app"), Some("HEAD~1")).unwrap();
        let impacted = report["impacted_pages"].as_array().unwrap();
        assert_eq!(impacted.len(), 1);
        assert_eq!(impacted[0]["page"], "docs/export.md");
    }
}
