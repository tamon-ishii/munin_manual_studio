//! Deterministic fact verification for ordinary Markdown against source code and MarkIts UIMaps.
use crate::{
    capture_resources,
    config::{project_path, read_config},
    task::{get_code_block_ranges, is_inside_ranges},
};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
use walkdir::WalkDir;

const MAX_SOURCE_FILES: usize = 600;
const MAX_SOURCE_FILE_BYTES: usize = 256 * 1024;

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | ".munin" | "node_modules" | "target" | "dist" | "site" | "manual" | "__pycache__" | ".venv" | "ui-coverage-results" | "release"
    )
}

fn is_source_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "rs" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "go" | "java"
                    | "kt" | "cs" | "cpp" | "c" | "h" | "html" | "css" | "json" | "toml" | "yaml"
                    | "yml" | "sh" | "ps1"
            )
        })
}

struct SourceIndex {
    files: Vec<(String, String)>,
    uimap_names: BTreeMap<String, Vec<String>>,
}

fn build_source_index(root: &Path, source_dir: Option<&str>) -> Result<SourceIndex, String> {
    let base: PathBuf = match source_dir.map(str::trim).filter(|s| !s.is_empty()) {
        Some(custom) => {
            let p = Path::new(custom);
            if p.is_absolute() {
                p.to_path_buf()
            } else {
                root.join(p)
            }
        }
        None => root.to_path_buf(),
    };
    if !base.is_dir() {
        return Err(format!("照合元フォルダーが見つかりません: {}", base.display()));
    }

    let mut files = Vec::new();
    for entry in WalkDir::new(&base)
        .into_iter()
        .filter_entry(|e| {
            !(e.depth() > 0
                && e.file_type().is_dir()
                && e.file_name()
                    .to_str()
                    .is_some_and(should_skip_dir))
        })
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() || !is_source_ext(entry.path()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() as usize > MAX_SOURCE_FILE_BYTES {
            continue;
        }
        let Ok(content) = fs::read_to_string(entry.path()) else {
            continue;
        };
        let rel = entry
            .path()
            .strip_prefix(&base)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        files.push((rel, content));
        if files.len() >= MAX_SOURCE_FILES {
            break;
        }
    }

    let mut uimap_names: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut record_uimap = |png: &Path, label: String| {
        let Ok(bytes) = fs::read(png) else { return };
        let Some(elements) = markits::raster::extract_png_uimap(&bytes) else {
            return;
        };
        for el in elements {
            let name = el.name.trim();
            if name.chars().count() >= 2 {
                let entry = uimap_names.entry(name.to_string()).or_default();
                if !entry.contains(&label) {
                    entry.push(label.clone());
                }
            }
        }
    };

    if let Ok(resources) = capture_resources::catalog(root) {
        for r in resources {
            if let Ok(src) = capture_resources::source(root, &r.id) {
                record_uimap(&src, r.name.clone());
            }
        }
    }
    let config = read_config(root);
    if let Ok(assets) = project_path(root, &config.assets) {
        if assets.is_dir() {
            for entry in WalkDir::new(assets).max_depth(4).into_iter().filter_map(Result::ok) {
                if entry.file_type().is_file()
                    && entry
                        .path()
                        .extension()
                        .is_some_and(|e| e.eq_ignore_ascii_case("png"))
                {
                    let label = entry
                        .path()
                        .strip_prefix(root)
                        .unwrap_or(entry.path())
                        .to_string_lossy()
                        .replace('\\', "/");
                    record_uimap(entry.path(), label);
                }
            }
        }
    }

    Ok(SourceIndex { files, uimap_names })
}

struct ClaimCandidate {
    kind: &'static str,
    text: String,
    line: usize,
    start: usize,
    end: usize,
}

fn extract_claims(content: &str) -> Vec<ClaimCandidate> {
    let fences = get_code_block_ranges(content);
    let comment_re = Regex::new(r"(?s)<!--.*?-->").unwrap();
    let comment_ranges: Vec<std::ops::Range<usize>> =
        comment_re.find_iter(content).map(|m| m.range()).collect();

    let code_re = Regex::new(r"`([^`\n]{2,64})`").unwrap();
    let ui_re = Regex::new(r"「([^「」\n]{2,36})」").unwrap();
    let mut claims = Vec::new();
    let mut seen = BTreeSet::new();

    for cap in code_re.captures_iter(content) {
        let Some(full) = cap.get(0) else { continue };
        let Some(inner) = cap.get(1) else { continue };
        let range = full.start()..full.end();
        if is_inside_ranges(&range, &fences) || is_inside_ranges(&range, &comment_ranges) {
            continue;
        }
        let text = inner.as_str().trim();
        // Focus on flags, commands, config keys, filenames, or paths.
        let verifiable = text.starts_with("--")
            || text.contains('/')
            || text.contains('.')
            || text.contains('_')
            || text.contains('-');
        if !verifiable || text.contains(' ') && !text.starts_with("--") {
            continue;
        }
        if !seen.insert(("code", text.to_string())) {
            continue;
        }
        let line = content[..full.start()].bytes().filter(|b| *b == b'\n').count() + 1;
        claims.push(ClaimCandidate {
            kind: "code_token",
            text: text.to_string(),
            line,
            start: content[..full.start()].encode_utf16().count(),
            end: content[..full.end()].encode_utf16().count(),
        });
    }

    for cap in ui_re.captures_iter(content) {
        let Some(full) = cap.get(0) else { continue };
        let Some(inner) = cap.get(1) else { continue };
        let range = full.start()..full.end();
        if is_inside_ranges(&range, &fences) || is_inside_ranges(&range, &comment_ranges) {
            continue;
        }
        let text = inner.as_str().trim();
        if text.chars().count() < 2 || text.contains('。') || text.contains('、') {
            continue;
        }
        if !seen.insert(("ui", text.to_string())) {
            continue;
        }
        let line = content[..full.start()].bytes().filter(|b| *b == b'\n').count() + 1;
        claims.push(ClaimCandidate {
            kind: "ui_label",
            text: text.to_string(),
            line,
            start: content[..full.start()].encode_utf16().count(),
            end: content[..full.end()].encode_utf16().count(),
        });
    }

    claims.sort_by_key(|c| c.start);
    claims.truncate(120);
    claims
}

pub fn audit_manuscript(
    root: &Path,
    page: &str,
    source_dir: Option<&str>,
) -> Result<Value, String> {
    let config = read_config(root);
    let normalized_page = {
        let clean = page.trim().replace('\\', "/");
        if project_path(root, &clean).is_ok_and(|p| p.is_file()) {
            clean
        } else {
            format!("{}/{}", config.docs.trim_end_matches('/'), clean)
        }
    };
    let page_path = project_path(root, &normalized_page)?;
    let content = fs::read_to_string(&page_path)
        .map_err(|e| format!("原稿を読み込めません ({normalized_page}): {e}"))?;
    let index = build_source_index(root, source_dir)?;
    let claims = extract_claims(&content);

    let mut supported_count = 0usize;
    let mut unverified_count = 0usize;
    let mut findings = Vec::new();

    for claim in claims {
        let mut evidence: Option<Value> = None;

        // 1. Check UIMap first for UI labels
        if let Some(images) = index.uimap_names.get(&claim.text) {
            evidence = Some(json!({
                "source_type": "uimap",
                "location": images.first().cloned().unwrap_or_default(),
                "excerpt": format!("UIMap要素: {}", claim.text)
            }));
        }

        // 2. Check existing file path directly
        if evidence.is_none() && (claim.text.contains('/') || claim.text.contains('.')) {
            if project_path(root, &claim.text).is_ok_and(|p| p.exists()) {
                evidence = Some(json!({
                    "source_type": "file_path",
                    "location": claim.text,
                    "excerpt": "プロジェクト内に実在するパス"
                }));
            }
        }

        // 3. Search source files
        if evidence.is_none() {
            for (file, body) in &index.files {
                if let Some(pos) = body.find(&claim.text) {
                    let line_no = body[..pos].bytes().filter(|b| *b == b'\n').count() + 1;
                    let line_text = body.lines().nth(line_no - 1).unwrap_or("").trim();
                    let snippet: String = line_text.chars().take(120).collect();
                    evidence = Some(json!({
                        "source_type": "source",
                        "location": format!("{file}:{line_no}"),
                        "excerpt": snippet
                    }));
                    break;
                }
            }
        }

        let verdict = if evidence.is_some() {
            supported_count += 1;
            "supported"
        } else {
            unverified_count += 1;
            "unverified"
        };

        findings.push(json!({
            "kind": claim.kind,
            "claim": claim.text,
            "verdict": verdict,
            "line": claim.line,
            "start": claim.start,
            "end": claim.end,
            "evidence": evidence
        }));
    }

    let hint = if index.files.is_empty() {
        Some("照合元フォルダー内にソースファイルが見つかりませんでした。マニュアル専用サブフォルダーを開いている場合は、「照合元ソースフォルダー」に対象アプリのリポジトリを指定してください。")
    } else {
        None
    };

    Ok(json!({
        "page": normalized_page,
        "indexed_source_files": index.files.len(),
        "indexed_uimap_labels": index.uimap_names.len(),
        "supported": supported_count,
        "unverified": unverified_count,
        "hint": hint,
        "findings": findings
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audits_manuscript_claims_against_source_and_uimap() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs/assets")).unwrap();
        fs::create_dir_all(root.path().join("src")).unwrap();
        fs::write(
            root.path().join("src/cli.rs"),
            "const FLAG: &str = \"--studio-tools\";\nconst BTN: &str = \"HTMLを作成\";\n",
        )
        .unwrap();
        let mut buf = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(80, 60)
            .write_to(&mut buf, image::ImageFormat::Png)
            .unwrap();
        let png = markits::raster::embed_png_uimap(
            &buf.into_inner(),
            &[markits::UiElement::new("button", "撮影を開始", 5., 5., 50., 20.)],
        )
        .unwrap();
        fs::write(root.path().join("docs/assets/ui.png"), png).unwrap();

        fs::write(
            root.path().join("docs/guide.md"),
            "# ガイド\n\n`--studio-tools` と「HTMLを作成」および「撮影を開始」を使います。「存在しないボタン」は嘘です。\n",
        )
        .unwrap();

        let report = audit_manuscript(root.path(), "guide.md", None).unwrap();
        assert_eq!(report["supported"], 3);
        assert_eq!(report["unverified"], 1);
        let findings = report["findings"].as_array().unwrap();
        assert!(findings
            .iter()
            .any(|f| f["claim"] == "--studio-tools" && f["verdict"] == "supported"));
        assert!(findings
            .iter()
            .any(|f| f["claim"] == "撮影を開始" && f["evidence"]["source_type"] == "uimap"));
        assert!(findings
            .iter()
            .any(|f| f["claim"] == "存在しないボタン" && f["verdict"] == "unverified"));
    }
}
