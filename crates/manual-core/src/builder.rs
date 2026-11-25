use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use tempfile::{tempdir, tempdir_in};
use walkdir::WalkDir;

use super::agent::which_binary;
use super::config::{read_config, NavEntry};
use super::task::{collect_markdown_files, utc_now};

const SITE_MANIFEST: &str = ".moduleloom-site-files.json";

pub(crate) fn is_published_site(path: &Path) -> bool {
    path.join(SITE_MANIFEST).is_file()
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum SiteEngine {
    MkDocs,
    Zensical,
    SingleHtml,
}

impl SiteEngine {
    fn command(self) -> &'static str {
        match self {
            Self::MkDocs => "mkdocs",
            Self::Zensical => "zensical",
            Self::SingleHtml => "",
        }
    }
}

fn copy_public_asset(source: &Path, destination: &Path) -> Result<(), String> {
    if source.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("png")) {
        let bytes = fs::read(source).map_err(|e| e.to_string())?;
        if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            let id=crate::capture_resources::resource_id(&bytes);
            let public = crate::capture_resources::document_png(&bytes,id.as_deref())?;
            return fs::write(destination, public).map_err(|e| e.to_string());
        }
    }
    fs::copy(source, destination).map(|_| ()).map_err(|e| e.to_string())
}

fn site_relative_path(path: &str) -> Result<&Path, String> {
    let relative = Path::new(path);
    if path.is_empty()
        || !relative
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(format!("Invalid generated site path: {path}"));
    }
    Ok(relative)
}

pub fn published_entry(root: &Path, output: &str) -> Result<std::path::PathBuf, String> {
    let output = crate::config::project_path(root, output)?;
    let resolve = |relative: &str| crate::config::project_path(root, &output.join(relative).to_string_lossy());
    // A README outside the source directory is staged under _external.
    for entry in ["index.html", "_external/index.html", "_external/README.html"] {
        let page = resolve(entry)?;
        if page.is_file() { return Ok(page); }
    }
    let manifest = resolve(SITE_MANIFEST)?;
    if manifest.is_file() {
        let bytes = fs::read(manifest).map_err(|error| error.to_string())?;
        let mut files: Vec<String> = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        files.sort_by(|left, right| left.matches('/').count().cmp(&right.matches('/').count()).then(left.cmp(right)));
        for entry in files {
            let path = site_relative_path(&entry)?;
            if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("html")) && entry != "404.html" {
                let page = resolve(&entry)?;
                if page.is_file() { return Ok(page); }
            }
        }
    }
    Err("出力先に開けるHTMLがありません。先に「HTMLを作成」を実行してください。".into())
}

fn publish_site(temp_site: &Path, output_root: &Path) -> Result<(), String> {
    publish_site_inner(temp_site, output_root, false)
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    for entry in WalkDir::new(source) {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().is_symlink() {
            return Err(format!(
                "Symbolic links are not supported in manual output: {}",
                entry.path().display()
            ));
        }
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|e| e.to_string())?;
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(target).map_err(|e| e.to_string())?;
        } else {
            fs::copy(entry.path(), target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn publish_site_inner(
    temp_site: &Path,
    output_root: &Path,
    fail_after_old_rename: bool,
) -> Result<(), String> {
    if fs::symlink_metadata(output_root).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(format!(
            "Symbolic links are not supported for manual output: {}",
            output_root.display()
        ));
    }
    let parent = output_root
        .parent()
        .ok_or_else(|| "Manual output needs a parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let staging = tempdir_in(parent).map_err(|e| e.to_string())?;
    let prepared = staging.path().join("prepared");
    copy_tree(output_root, &prepared)?;
    fs::create_dir_all(&prepared).map_err(|e| e.to_string())?;

    let manifest_path = output_root.join(SITE_MANIFEST);
    let legacy_site = !manifest_path.exists()
        && fs::read_to_string(output_root.join("index.html"))
            .is_ok_and(|html| html.contains("name=\"generator\" content=\"mkdocs-"));
    let old_files: BTreeSet<String> = if manifest_path.is_file() {
        serde_json::from_slice::<Vec<String>>(&fs::read(&manifest_path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Invalid site manifest: {e}"))?
            .into_iter()
            .collect()
    } else {
        BTreeSet::new()
    };
    for path in &old_files {
        site_relative_path(path)?;
    }

    let mut new_files = BTreeSet::new();
    for entry in WalkDir::new(temp_site) {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(temp_site)
            .map_err(|e| e.to_string())?;
        let name = rel.to_string_lossy().replace('\\', "/");
        site_relative_path(&name)?;
        if name == SITE_MANIFEST {
            return Err("Generated site conflicts with the site manifest".to_string());
        }
        let dest = output_root.join(rel);
        let top_level = name.split('/').next().unwrap_or("");
        if ["ai", "brief.md", ".backup"].contains(&top_level) {
            return Err(format!(
                "Generated site conflicts with manual source data: {name}"
            ));
        }
        if dest.exists() && !old_files.contains(&name) && !legacy_site {
            return Err(format!(
                "Generated site would overwrite an unmanaged file: {}",
                dest.display()
            ));
        }
        new_files.insert(name);
    }

    for name in old_files.difference(&new_files) {
        let path = prepared.join(site_relative_path(name)?);
        if path.is_file() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    for name in &new_files {
        let rel = site_relative_path(name)?;
        let dest = prepared.join(rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(temp_site.join(rel), &dest).map_err(|e| e.to_string())?;
    }
    let manifest = serde_json::to_vec_pretty(&new_files).map_err(|e| e.to_string())?;
    fs::write(prepared.join(SITE_MANIFEST), manifest).map_err(|e| e.to_string())?;

    let old_output = staging.path().join("previous");
    let had_output = output_root.exists();
    if had_output {
        fs::rename(output_root, &old_output).map_err(|e| e.to_string())?;
    }
    let publish_result = if fail_after_old_rename {
        Err("Simulated publication failure".to_string())
    } else {
        fs::rename(&prepared, output_root).map_err(|e| e.to_string())
    };
    if let Err(error) = publish_result {
        if had_output {
            if let Err(restore) = fs::rename(&old_output, output_root) {
                let recovery = staging.keep();
                return Err(format!(
                    "{error}; failed to restore previous site: {restore}; previous site is at {}",
                    recovery.join("previous").display()
                ));
            }
        }
        return Err(error);
    }
    Ok(())
}

struct BuildPage {
    source: std::path::PathBuf,
    original: std::path::PathBuf,
    destination: std::path::PathBuf,
}

fn build_pages(templates: &Path, root: Option<&Path>) -> Result<Vec<BuildPage>, String> {
    if let Some(root) = root {
        // Windows canonical paths use the extended-length prefix. Use the same
        // root for collected pages and guarded assets before comparing paths.
        let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
        let config = read_config(&canonical_root);
        let docs = super::config::project_path(&canonical_root, &config.docs)?;
        if templates.canonicalize().map_err(|e| e.to_string())? == docs {
            return super::task::collect_target_markdown_files(&canonical_root, &config)
                .into_iter()
                .map(|(_name, source)| {
                    let destination = if let Ok(relative) = source.strip_prefix(&docs) {
                        relative.to_path_buf()
                    } else {
                        Path::new("_external").join(
                            source
                                .strip_prefix(&canonical_root)
                                .map_err(|e| e.to_string())?,
                        )
                    };
                    Ok(BuildPage {
                        original: source.clone(),
                        source,
                        destination,
                    })
                })
                .collect();
        }
        // Audience-filtered templates retain links relative to the original docs.
        return Ok(collect_markdown_files(templates)
            .into_iter()
            .map(|source| {
                let destination = source.strip_prefix(templates).unwrap().to_path_buf();
                BuildPage {
                    original: docs.join(&destination),
                    source,
                    destination,
                }
            })
            .collect());
    }
    Ok(collect_markdown_files(templates)
        .into_iter()
        .map(|source| {
            let destination = source.strip_prefix(templates).unwrap().to_path_buf();
            BuildPage {
                original: source.clone(),
                source,
                destination,
            }
        })
        .collect())
}

fn relative_link(page: &Path, destination: &Path) -> String {
    let from: Vec<_> = page
        .parent()
        .unwrap_or(Path::new(""))
        .components()
        .collect();
    let to: Vec<_> = destination.components().collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    format!(
        "{}{}",
        "../".repeat(from.len() - common),
        to[common..]
            .iter()
            .map(|part| part.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/")
    )
}

fn stage_page_links(
    root: &Path,
    page: &BuildPage,
    pages: &[BuildPage],
    body: &str,
    docs: &Path,
    referenced_assets: &mut HashSet<PathBuf>,
) -> Result<String, String> {
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let mut resolve = |url: &str| -> Result<Option<String>, String> {
        if url.is_empty()
            || url.starts_with(['#', '/'])
            || regex::Regex::new(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")
                .unwrap()
                .is_match(url)
        {
            return Ok(None);
        }
        let split = url.find(['#', '?']).unwrap_or(url.len());
        let decoded = percent_encoding::percent_decode_str(&url[..split])
            .decode_utf8()
            .map_err(|e| e.to_string())?;
        let parent = page.original.parent().ok_or("Invalid page path")?;
        let mut parts: Vec<_> = parent
            .strip_prefix(&canonical_root)
            .map_err(|e| e.to_string())?
            .components()
            .map(|part| part.as_os_str().to_os_string())
            .collect();
        for part in Path::new(decoded.as_ref()).components() {
            match part {
                Component::Normal(name) => parts.push(name.to_os_string()),
                Component::CurDir => {}
                Component::ParentDir => {
                    if parts.pop().is_none() {
                        return Err("Linked asset escapes the project".into());
                    }
                }
                _ => return Ok(None),
            }
        }
        let relative: std::path::PathBuf = parts.iter().collect();
        let source = super::config::project_path(root, &relative.to_string_lossy())?;
        if !source.is_file() {
            return Ok(None);
        }
        let destination =
            if let Some(target) = pages.iter().find(|target| target.original == source) {
                target.destination.clone()
            } else if source.extension().is_some_and(|ext| ext == "md") {
                return Ok(None);
            } else {
                if let Ok(canon) = source.canonicalize() {
                    referenced_assets.insert(canon);
                } else {
                    referenced_assets.insert(source.clone());
                }
                let destination = Path::new("_assets").join(&relative);
                let output = docs.join(&destination);
                fs::create_dir_all(output.parent().ok_or("Invalid asset path")?)
                    .map_err(|e| e.to_string())?;
                copy_public_asset(&source, &output)?;
                destination
            };
        let link = relative_link(&page.destination, &destination);
        // URL paths may contain Japanese characters, spaces, parentheses or fragments.
        let encoded: String = link
            .bytes()
            .map(|byte| {
                if byte.is_ascii_alphanumeric() || b"/-._~".contains(&byte) {
                    (byte as char).to_string()
                } else {
                    format!("%{byte:02X}")
                }
            })
            .collect();
        Ok(Some(format!("{encoded}{}", &url[split..])))
    };
    let parser = Parser::new_ext(body, Options::all());
    let definitions: Vec<_> = parser
        .reference_definitions()
        .iter()
        .map(|(_, definition)| (definition.dest.to_string(), definition.span.clone()))
        .collect();
    let destination_pattern =
        regex::Regex::new(r"(?:\]\(|\]:)\s*(?:<(?P<angle>[^>]+)>|(?P<plain>(?:\\.|[^\s)])+))")
            .unwrap();
    let html_pattern =
        regex::Regex::new(r#"(?i)\b(?:src|href)\s*=\s*["'](?P<url>[^"']+)["']"#).unwrap();
    let mut edits: Vec<(std::ops::Range<usize>, String)> = Vec::new();
    for (event, range) in parser.into_offset_iter() {
        match event {
            Event::Start(Tag::Image { dest_url, .. } | Tag::Link { dest_url, .. }) => {
                if let Some(captures) = destination_pattern
                    .captures_iter(&body[range.clone()])
                    .last()
                {
                    if let Some(new_url) = resolve(&dest_url)? {
                        let found = captures
                            .name("angle")
                            .or_else(|| captures.name("plain"))
                            .unwrap();
                        edits.push((
                            range.start + found.start()..range.start + found.end(),
                            new_url,
                        ));
                    }
                }
            }
            Event::Html(_) | Event::InlineHtml(_) => {
                if body[range.clone()].trim_start().starts_with("<!--") {
                    continue;
                }
                for captures in html_pattern.captures_iter(&body[range.clone()]) {
                    let found = captures.name("url").unwrap();
                    if let Some(new_url) = resolve(found.as_str())? {
                        edits.push((
                            range.start + found.start()..range.start + found.end(),
                            new_url,
                        ));
                    }
                }
            }
            _ => {}
        }
    }
    for (url, range) in definitions {
        if let Some(new_url) = resolve(&url)? {
            if let Some(captures) = destination_pattern.captures(&body[range.clone()]) {
                let found = captures
                    .name("angle")
                    .or_else(|| captures.name("plain"))
                    .unwrap();
                edits.push((
                    range.start + found.start()..range.start + found.end(),
                    new_url,
                ));
            }
        }
    }
    edits.sort_by_key(|(range, _)| range.start);
    edits.dedup_by(|a, b| a.0 == b.0);
    let mut result = body.to_string();
    for (range, replacement) in edits.into_iter().rev() {
        result.replace_range(range, &replacement);
    }
    Ok(result)
}

fn strip_ai_notes_outside_code(content: &str) -> String {
    let fences = crate::task::get_code_block_ranges(content);
    let re = regex::Regex::new(r"(?s)[ \t]*<!--\s*ai-note\s*:.*?-->[ \t]*\r?\n?").unwrap();
    let mut out = String::with_capacity(content.len());
    let mut last = 0usize;
    for m in re.find_iter(content) {
        if crate::task::is_inside_ranges(&(m.start()..m.end()), &fences) {
            continue;
        }
        out.push_str(&content[last..m.start()]);
        last = m.end();
    }
    out.push_str(&content[last..]);
    out
}

pub fn build(
    templates: &Path,
    generated: &Path,
    output_root: &Path,
    draft: bool,
    root: Option<&Path>,
) -> Result<String, String> {
    build_with_engine(templates, generated, output_root, draft, root, SiteEngine::MkDocs)
}

pub(crate) fn build_with_engine(
    templates: &Path,
    generated: &Path,
    output_root: &Path,
    draft: bool,
    root: Option<&Path>,
    engine: SiteEngine,
) -> Result<String, String> {
    if engine == SiteEngine::SingleHtml {
        return build_inner(templates, generated, output_root, draft, root, engine, None);
    }
    let command = site_command(root, engine);
    if engine == SiteEngine::Zensical && command.is_none() {
        return Err("Zensicalが見つかりません。Studioから参照できるPATHに zensical を追加するか、プロジェクトの .venv にインストールしてください。PATHを変更した場合はStudioを再起動してください。".into());
    }
    build_inner(templates, generated, output_root, draft, root, engine, command)
}

fn extract_h1_title(content: &str) -> Option<String> {
    let mut in_h1 = false;
    let mut text = String::new();
    for event in Parser::new_ext(content, Options::all()) {
        match event {
            Event::Start(Tag::Heading {
                level: HeadingLevel::H1,
                ..
            }) => {
                in_h1 = true;
                text.clear();
            }
            Event::Text(value) | Event::Code(value) if in_h1 => {
                text.push_str(&value);
            }
            Event::End(TagEnd::Heading(HeadingLevel::H1)) if in_h1 => {
                let cleaned = text.trim().to_string();
                if !cleaned.is_empty() {
                    return Some(cleaned);
                }
                in_h1 = false;
            }
            _ => {}
        }
    }
    None
}

fn is_image_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg"
            )
        })
}

struct ResolvedNavItem {
    page_index: usize,
    rel_posix: String,
    title: String,
    section: String,
    anchor_id: String,
}

fn nav_matches_page(entry_page: &str, dest_posix: &str, root_rel: Option<&str>) -> bool {
    let norm = entry_page.trim().replace('\\', "/");
    if norm == dest_posix {
        return true;
    }
    if let Some(rel) = root_rel {
        if norm == rel {
            return true;
        }
    }
    if let Some(stripped) = norm.strip_prefix("./") {
        if stripped == dest_posix || root_rel.is_some_and(|rel| rel == stripped) {
            return true;
        }
    }
    false
}

fn resolve_nav_items(
    pages: &[BuildPage],
    contents: &[String],
    nav_config: &[NavEntry],
    root: Option<&Path>,
) -> Vec<ResolvedNavItem> {
    let canonical_root = root.and_then(|r| r.canonicalize().ok());
    let page_meta: Vec<(String, Option<String>, String)> = pages
        .iter()
        .enumerate()
        .map(|(idx, page)| {
            let dest_posix = page.destination.to_string_lossy().replace('\\', "/");
            let root_rel = canonical_root.as_ref().and_then(|cr| {
                page.original
                    .strip_prefix(cr)
                    .ok()
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
            });
            let default_title = extract_h1_title(&contents[idx]).unwrap_or_else(|| {
                page.source
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            });
            (dest_posix, root_rel, default_title)
        })
        .collect();

    let mut ordered: Vec<ResolvedNavItem> = Vec::new();
    let mut handled: HashSet<usize> = HashSet::new();

    for entry in nav_config {
        if let Some((idx, (dest_posix, _, default_title))) =
            page_meta.iter().enumerate().find(|(idx, (dest, rel, _))| {
                !handled.contains(idx) && nav_matches_page(&entry.page, dest, rel.as_deref())
            })
        {
            handled.insert(idx);
            if entry.hidden {
                continue;
            }
            let title = if entry.title.trim().is_empty() {
                default_title.clone()
            } else {
                entry.title.trim().to_string()
            };
            ordered.push(ResolvedNavItem {
                page_index: idx,
                rel_posix: dest_posix.clone(),
                title,
                section: entry.section.trim().to_string(),
                anchor_id: format!("page-{}", ordered.len() + 1),
            });
        }
    }

    // Append remaining unlisted pages with index.md / README.md first, then alphabetical.
    let mut remaining: Vec<usize> = (0..pages.len()).filter(|i| !handled.contains(i)).collect();
    remaining.sort_by(|&a, &b| {
        let priority = |dest: &str| -> u8 {
            if dest == "index.md" {
                0
            } else if dest == "_external/README.md" || dest.eq_ignore_ascii_case("README.md") {
                1
            } else {
                2
            }
        };
        priority(&page_meta[a].0)
            .cmp(&priority(&page_meta[b].0))
            .then_with(|| page_meta[a].0.cmp(&page_meta[b].0))
    });

    for idx in remaining {
        let (dest_posix, _, default_title) = &page_meta[idx];
        ordered.push(ResolvedNavItem {
            page_index: idx,
            rel_posix: dest_posix.clone(),
            title: default_title.clone(),
            section: String::new(),
            anchor_id: format!("page-{}", ordered.len() + 1),
        });
    }

    ordered
}

fn build_nav_yaml(items: &[ResolvedNavItem]) -> String {
    let mut out = String::new();
    let mut current_section: Option<&str> = None;
    for item in items {
        if item.section.is_empty() {
            current_section = None;
            out.push_str(&format!(
                "  - {}: {}\n",
                serde_json::to_string(&item.title).unwrap(),
                serde_json::to_string(&item.rel_posix).unwrap()
            ));
        } else {
            if current_section != Some(item.section.as_str()) {
                out.push_str(&format!(
                    "  - {}:\n",
                    serde_json::to_string(&item.section).unwrap()
                ));
                current_section = Some(item.section.as_str());
            }
            out.push_str(&format!(
                "      - {}: {}\n",
                serde_json::to_string(&item.title).unwrap(),
                serde_json::to_string(&item.rel_posix).unwrap()
            ));
        }
    }
    out
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn inline_single_html_assets(html: &str, temp_docs: &Path, page_dir: &Path) -> String {
    let img_re = regex::Regex::new(r#"(?i)<img\s+[^>]*\bsrc\s*=\s*["'](?P<src>[^"']+)["'][^>]*>"#).unwrap();
    let mut out = String::with_capacity(html.len());
    let mut last = 0usize;
    for cap in img_re.captures_iter(html) {
        let m = cap.get(0).unwrap();
        out.push_str(&html[last..m.start()]);
        let src = cap.name("src").unwrap().as_str();
        let clean = src.split(['?', '#']).next().unwrap_or(src);
        let decoded = percent_encoding::percent_decode_str(clean)
            .decode_utf8()
            .map(|c| c.into_owned())
            .unwrap_or_else(|_| clean.to_string());
        let candidate = if !decoded.starts_with("data:")
            && !decoded.starts_with("http://")
            && !decoded.starts_with("https://")
        {
            let rel_path = page_dir.join(&decoded);
            if rel_path.is_file() {
                Some(rel_path)
            } else {
                let from_docs = temp_docs.join(decoded.trim_start_matches(['.', '/']));
                from_docs.is_file().then_some(from_docs)
            }
        } else {
            None
        };
        if let Some(img_path) = candidate {
            let ext = img_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let mime = match ext.as_str() {
                "png" => Some("image/png"),
                "jpg" | "jpeg" => Some("image/jpeg"),
                "gif" => Some("image/gif"),
                "webp" => Some("image/webp"),
                "svg" => Some("image/svg+xml"),
                _ => None,
            };
            if let Some(mime_type) = mime {
                if let Ok(bytes) = fs::read(&img_path) {
                    if bytes.len() <= 20_000_000 {
                        let public_bytes = if mime_type == "image/png"
                            && bytes.starts_with(b"\x89PNG\r\n\x1a\n")
                        {
                            let id = crate::capture_resources::resource_id(&bytes);
                            crate::capture_resources::document_png(&bytes, id.as_deref())
                                .unwrap_or(bytes)
                        } else {
                            bytes
                        };
                        let data_uri = format!("data:{mime_type};base64,{}", BASE64.encode(&public_bytes));
                        out.push_str(&m.as_str().replace(src, &data_uri));
                        last = m.end();
                        continue;
                    }
                }
            }
        }
        out.push_str(m.as_str());
        last = m.end();
    }
    out.push_str(&html[last..]);
    out
}

fn rewrite_single_html_links(
    html: &str,
    current_rel: &str,
    page_anchors: &BTreeMap<String, String>,
) -> String {
    let link_re = regex::Regex::new(r#"(?i)\bhref\s*=\s*"(?P<href>[^"]+)""#).unwrap();
    let current_parent = Path::new(current_rel).parent().unwrap_or(Path::new(""));
    let mut out = String::with_capacity(html.len());
    let mut last = 0usize;
    for cap in link_re.captures_iter(html) {
        let m = cap.get(0).unwrap();
        out.push_str(&html[last..m.start()]);
        let href = cap.name("href").unwrap().as_str();
        let lower = href.to_ascii_lowercase();
        if !href.starts_with('#')
            && !lower.starts_with("http://")
            && !lower.starts_with("https://")
            && !lower.starts_with("mailto:")
        {
            let clean = href.split(['?', '#']).next().unwrap_or(href);
            let decoded = percent_encoding::percent_decode_str(clean)
                .decode_utf8()
                .map(|c| c.into_owned())
                .unwrap_or_else(|_| clean.to_string());
            let mut parts: Vec<std::ffi::OsString> = current_parent
                .components()
                .filter_map(|c| match c {
                    Component::Normal(s) => Some(s.to_os_string()),
                    _ => None,
                })
                .collect();
            for part in Path::new(&decoded).components() {
                match part {
                    Component::Normal(s) => parts.push(s.to_os_string()),
                    Component::ParentDir => {
                        parts.pop();
                    }
                    Component::CurDir => {}
                    _ => {}
                }
            }
            let resolved = parts
                .iter()
                .map(|p| p.to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            if let Some(anchor) = page_anchors.get(&resolved) {
                out.push_str(&format!(r##"href="#{anchor}""##));
                last = m.end();
                continue;
            }
        }
        out.push_str(m.as_str());
        last = m.end();
    }
    out.push_str(&html[last..]);
    out
}

fn transform_mermaid_blocks(html: &str) -> (String, bool) {
    let re = regex::Regex::new(r#"(?s)<pre><code class="language-mermaid">(.*?)</code></pre>"#).unwrap();
    let mut found = false;
    let out = re
        .replace_all(html, |caps: &regex::Captures<'_>| {
            found = true;
            format!(
                "<div class=\"mermaid-diagram\"><pre class=\"mermaid\">{}</pre></div>",
                &caps[1]
            )
        })
        .into_owned();
    (out, found)
}

struct ResolvedHtmlTheme {
    preset: String,
    is_dark: bool,
    primary: String,
    accent: String,
    background: String,
    surface: String,
    text: String,
    muted: String,
    border: String,
    code_bg: String,
    toc_hover: String,
    font_family: &'static str,
    max_width: &'static str,
    mkdocs_grid_max_width: &'static str,
    content_padding: &'static str,
}

fn resolve_html_theme(style: Option<&crate::config::HtmlThemeStyle>) -> ResolvedHtmlTheme {
    let preset_key = style.map(|s| s.preset.as_str()).unwrap_or("clean-blue");
    let (mut is_dark, p, a, bg, sf, tx, default_font, default_layout) = match preset_key {
        "forest" => (false, "#285d46", "#3f8b60", "#ffffff", "#f2f5f0", "#22312b", "sans", "standard"),
        "warm-paper" => (false, "#98613e", "#c27d4a", "#faf7f2", "#f3ece1", "#3a3028", "serif", "standard"),
        "indigo-tech" => (false, "#4f46e5", "#7c3aed", "#ffffff", "#f5f7fb", "#1e293b", "sans", "wide"),
        "slate-dark" => (true, "#60a5fa", "#38bdf8", "#161b22", "#1f2630", "#e6edf3", "sans", "standard"),
        "midnight-dark" => (true, "#6ee7b7", "#34d399", "#141d19", "#1c2822", "#e7f2ec", "sans", "standard"),
        _ => (false, "#2563eb", "#0ea5e9", "#ffffff", "#f7f8fa", "#1f2937", "sans", "standard"),
    };
    let mut primary = p.to_string();
    let mut accent = a.to_string();
    let mut background = bg.to_string();
    let mut surface = sf.to_string();
    let mut text = tx.to_string();
    let mut font = default_font;
    let mut layout = default_layout;
    let mut resolved_preset = if preset_key.is_empty() { "clean-blue".to_string() } else { preset_key.to_string() };

    if let Some(s) = style {
        if s.scheme == "dark" {
            is_dark = true;
        } else if s.scheme == "light" {
            is_dark = false;
        }
        if let Some(c) = crate::config::sanitize_hex_color(&s.primary) {
            primary = c;
        }
        if let Some(c) = crate::config::sanitize_hex_color(&s.accent) {
            accent = c;
        }
        if let Some(c) = crate::config::sanitize_hex_color(&s.background) {
            background = c;
        }
        if let Some(c) = crate::config::sanitize_hex_color(&s.surface) {
            surface = c;
        }
        if let Some(c) = crate::config::sanitize_hex_color(&s.text) {
            text = c;
        }
        if matches!(s.font.as_str(), "sans" | "serif" | "mono") {
            font = match s.font.as_str() {
                "serif" => "serif",
                "mono" => "mono",
                _ => "sans",
            };
        }
        if matches!(s.layout.as_str(), "standard" | "wide" | "compact") {
            layout = match s.layout.as_str() {
                "wide" => "wide",
                "compact" => "compact",
                _ => "standard",
            };
        }
        if !s.preset.is_empty() {
            resolved_preset = s.preset.clone();
        }
    }

    let font_family = match font {
        "serif" => r#""Noto Serif JP", "Yu Mincho", "Hiragino Mincho ProN", Georgia, serif"#,
        "mono" => r#""JetBrains Mono", "Noto Sans Mono CJK JP", "Cascadia Mono", Consolas, monospace"#,
        _ => r#"-apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Meiryo", sans-serif"#,
    };
    // Single-HTML `max_width` sizes the article column alone; MkDocs/Zensical `.md-grid`
    // wraps all 3 columns (left nav ~242px + article + right TOC ~242px), so it needs
    // a correspondingly wider container to preserve a comfortable article measure.
    let (max_width, mkdocs_grid_max_width, content_padding) = match layout {
        "wide" => ("1160px", "1640px", "36px 48px 72px"),
        "compact" => ("760px", "1140px", "26px 32px 56px"),
        _ => ("920px", "1360px", "36px 44px 72px"),
    };
    let (muted, border, code_bg, toc_hover) = if is_dark {
        ("#9aa7b8", "#303a47", "#232b36", "rgba(255, 255, 255, 0.08)")
    } else {
        ("#6b7280", "#e5e7eb", "#f3f4f6", "rgba(0, 0, 0, 0.05)")
    };

    ResolvedHtmlTheme {
        preset: resolved_preset,
        is_dark,
        primary,
        accent,
        background,
        surface,
        text,
        muted: muted.to_string(),
        border: border.to_string(),
        code_bg: code_bg.to_string(),
        toc_hover: toc_hover.to_string(),
        font_family,
        max_width,
        mkdocs_grid_max_width,
        content_padding,
    }
}

fn build_mkdocs_theme_css(theme: &ResolvedHtmlTheme) -> String {
    format!(
        r#":root, [data-md-color-scheme="default"], [data-md-color-scheme="slate"] {{
  --md-primary-fg-color: {primary};
  --md-accent-fg-color: {accent};
  --md-default-bg-color: {bg};
  --md-default-fg-color: {text};
  --md-code-bg-color: {code_bg};
}}
body, input {{
  font-family: {font};
}}
.md-grid {{
  max-width: {grid_max_width};
}}
@media screen and (min-width: 76.25em) {{
  .md-sidebar--primary .md-sidebar__inner {{
    background: {surface};
    border-radius: 8px;
    padding: 0.75rem 0.6rem;
  }}
  .md-sidebar--primary .md-nav--primary .md-nav__title {{
    background: {surface};
    box-shadow: none;
  }}
}}
@media screen and (min-width: 60em) {{
  .md-sidebar--secondary .md-sidebar__inner {{
    background: {surface};
    border-radius: 8px;
    padding: 0.75rem 0.6rem;
  }}
  .md-sidebar--secondary .md-nav--secondary .md-nav__title {{
    background: {surface};
    box-shadow: none;
  }}
}}
"#,
        primary = theme.primary,
        accent = theme.accent,
        bg = theme.background,
        text = theme.text,
        code_bg = theme.code_bg,
        font = theme.font_family,
        grid_max_width = theme.mkdocs_grid_max_width,
        surface = theme.surface,
    )
}

fn render_single_html_document(
    site_name: &str,
    language: &str,
    built_at: &str,
    nav_items: &[ResolvedNavItem],
    staged_markdown: &[String],
    temp_docs: &Path,
    theme_style: Option<&crate::config::HtmlThemeStyle>,
) -> String {
    let resolved_theme = resolve_html_theme(theme_style);
    let mut page_anchors = BTreeMap::new();
    for item in nav_items {
        page_anchors.insert(item.rel_posix.clone(), item.anchor_id.clone());
    }

    let mut toc_html = String::new();
    let mut current_section: Option<&str> = None;
    for item in nav_items {
        if !item.section.is_empty() && current_section != Some(item.section.as_str()) {
            toc_html.push_str(&format!(
                "<li class=\"toc-section\">{}</li>\n",
                escape_html(&item.section)
            ));
            current_section = Some(item.section.as_str());
        } else if item.section.is_empty() {
            current_section = None;
        }
        let indent_class = if item.section.is_empty() { "" } else { " toc-nested" };
        toc_html.push_str(&format!(
            "<li class=\"toc-item{indent_class}\"><a href=\"#{}\">{}</a></li>\n",
            escape_html(&item.anchor_id),
            escape_html(&item.title)
        ));
    }

    let mut sections_html = String::new();
    let mut has_mermaid = false;
    for item in nav_items {
        let md = &staged_markdown[item.page_index];
        let mut rendered = String::new();
        pulldown_cmark::html::push_html(&mut rendered, crate::gfm::events(md).into_iter());
        let (with_mermaid, page_has_mermaid) = transform_mermaid_blocks(&rendered);
        if page_has_mermaid {
            has_mermaid = true;
        }
        let page_dir = temp_docs
            .join(&item.rel_posix)
            .parent()
            .unwrap_or(temp_docs)
            .to_path_buf();
        let with_images = inline_single_html_assets(&with_mermaid, temp_docs, &page_dir);
        let with_links = rewrite_single_html_links(&with_images, &item.rel_posix, &page_anchors);
        sections_html.push_str(&format!(
            "<article class=\"manual-page\" id=\"{}\">\n{}\n</article>\n",
            escape_html(&item.anchor_id),
            with_links
        ));
    }

    let mermaid_theme = if resolved_theme.is_dark { "dark" } else { "default" };
    let mermaid_script = if has_mermaid {
        format!(
            r#"  <script type="module">
    (async () => {{
      try {{
        const mod = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
        const mermaid = mod.default || mod;
        mermaid.initialize({{ startOnLoad: false, securityLevel: 'strict', theme: '{mermaid_theme}' }});
        await mermaid.run({{ querySelector: '.mermaid' }});
      }} catch (_offlineFallback) {{
        // Offline or blocked: keep readable <pre class="mermaid"> source block as-is.
      }}
    }})();
  </script>
"#
        )
    } else {
        String::new()
    };

    let alert_css = if resolved_theme.is_dark {
        r#"    .markdown-alert-note { border-left-color: #60a5fa; background: rgba(96, 165, 250, 0.14); }
    .markdown-alert-tip { border-left-color: #34d399; background: rgba(52, 211, 153, 0.14); }
    .markdown-alert-important { border-left-color: #a78bfa; background: rgba(167, 139, 250, 0.14); }
    .markdown-alert-warning { border-left-color: #fbbf24; background: rgba(251, 191, 36, 0.14); }
    .markdown-alert-caution { border-left-color: #f87171; background: rgba(248, 113, 113, 0.14); }"#
    } else {
        r#"    .markdown-alert-note { border-left-color: #2563eb; background: #eff6ff; }
    .markdown-alert-tip { border-left-color: #16a34a; background: #f0fdf4; }
    .markdown-alert-important { border-left-color: #7c3aed; background: #f5f3ff; }
    .markdown-alert-warning { border-left-color: #d97706; background: #fffbeb; }
    .markdown-alert-caution { border-left-color: #dc2626; background: #fef2f2; }"#
    };
    let color_scheme = if resolved_theme.is_dark { "dark" } else { "light" };
    let btn_text = if resolved_theme.is_dark { "#0f172a" } else { "#ffffff" };

    format!(
        r#"<!doctype html>
<html lang="{lang}" data-munin-theme="{theme_preset}" data-munin-scheme="{color_scheme}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="generator" content="munin-manual-studio-single-html" />
  <title>{title}</title>
  <style>
    :root {{
      color-scheme: {color_scheme};
      --bg: {bg};
      --surface: {surface};
      --text: {text};
      --muted: {muted};
      --border: {border};
      --primary: {primary};
      --accent: {accent};
      --code-bg: {code_bg};
      --toc-hover: {toc_hover};
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: {font_family};
      color: var(--text);
      background: var(--bg);
      line-height: 1.75;
    }}
    .layout {{
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
      min-height: 100vh;
    }}
    .sidebar {{
      position: sticky;
      top: 0;
      height: 100vh;
      overflow-y: auto;
      padding: 24px 18px;
      background: var(--surface);
      border-right: 1px solid var(--border);
    }}
    .site-title {{
      margin: 0 0 6px;
      font-size: 1.1rem;
      line-height: 1.35;
      color: var(--primary);
    }}
    .site-meta {{
      margin: 0 0 14px;
      font-size: 0.78rem;
      color: var(--muted);
    }}
    .print-btn {{
      width: 100%;
      margin-bottom: 16px;
      padding: 8px 12px;
      border: 1px solid var(--primary);
      border-radius: 6px;
      background: var(--primary);
      color: {btn_text};
      font-weight: 600;
      font-size: 0.88rem;
      cursor: pointer;
    }}
    .print-btn:hover {{ opacity: 0.92; }}
    .toc {{
      list-style: none;
      margin: 0;
      padding: 0;
    }}
    .toc-section {{
      margin: 14px 0 4px;
      font-size: 0.76rem;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }}
    .toc-item a {{
      display: block;
      padding: 5px 8px;
      border-radius: 5px;
      color: var(--text);
      text-decoration: none;
      font-size: 0.9rem;
    }}
    .toc-item.toc-nested a {{ padding-left: 18px; }}
    .toc-item a:hover {{ background: var(--toc-hover); color: var(--primary); }}
    .content {{
      max-width: {max_width};
      width: 100%;
      margin: 0 auto;
      padding: {content_padding};
    }}
    .manual-page + .manual-page {{
      margin-top: 52px;
      padding-top: 36px;
      border-top: 2px solid var(--border);
    }}
    h1, h2, h3, h4 {{ line-height: 1.35; margin-top: 1.5em; }}
    .manual-page > h1:first-child {{ margin-top: 0; color: var(--primary); }}
    a {{ color: var(--accent); }}
    img {{ max-width: 100%; height: auto; border-radius: 6px; border: 1px solid var(--border); }}
    figure[data-munin-image] {{ margin: 1.2em 0; }}
    figure[data-munin-image] figcaption {{ font-size: 0.86rem; color: var(--muted); margin-top: 6px; }}
    pre {{
      background: var(--code-bg);
      padding: 14px 16px;
      border-radius: 8px;
      overflow-x: auto;
      font-size: 0.88rem;
      line-height: 1.55;
    }}
    code {{
      font-family: "JetBrains Mono", "Cascadia Mono", Consolas, monospace;
      background: var(--code-bg);
      padding: 0.12em 0.35em;
      border-radius: 4px;
      font-size: 0.9em;
    }}
    pre code {{ background: transparent; padding: 0; }}
    table {{ border-collapse: collapse; width: 100%; margin: 1.2em 0; font-size: 0.92rem; }}
    th, td {{ border: 1px solid var(--border); padding: 8px 10px; text-align: left; vertical-align: top; }}
    th {{ background: var(--surface); }}
    blockquote {{
      margin: 1em 0;
      padding: 10px 14px;
      border-left: 4px solid var(--primary);
      background: var(--surface);
      border-radius: 0 6px 6px 0;
    }}
    .markdown-alert {{ border-left-width: 4px; }}
{alert_css}
    .markdown-alert-title {{ font-weight: 700; margin: 0 0 4px; }}
    .mermaid-diagram {{ margin: 1.2em 0; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); overflow-x: auto; }}
    .mermaid-diagram pre.mermaid {{ margin: 0; background: transparent; padding: 0; }}
    .mermaid-diagram svg {{ display: block; margin: 0 auto; max-width: 100%; height: auto; }}
    @media (max-width: 860px) {{
      .layout {{ grid-template-columns: 1fr; }}
      .sidebar {{ position: static; height: auto; border-right: none; border-bottom: 1px solid var(--border); }}
      .content {{ padding: 24px 18px 48px; }}
    }}
    @media print {{
      .sidebar, .print-btn {{ display: none !important; }}
      .layout {{ display: block; }}
      .content {{ max-width: none; padding: 0; }}
      .manual-page + .manual-page {{
        page-break-before: always;
        break-before: page;
        border-top: none;
        margin-top: 0;
        padding-top: 0;
      }}
      figure, table, pre, blockquote, .mermaid-diagram {{ page-break-inside: avoid; break-inside: avoid; }}
      a {{ color: inherit; text-decoration: underline; }}
    }}
  </style>
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <h1 class="site-title">{title}</h1>
      <p class="site-meta">出力日時: {built_at}</p>
      <button type="button" class="print-btn" onclick="window.print()">印刷 / PDFとして保存</button>
      <nav aria-label="目次">
        <ul class="toc">
          {toc}
        </ul>
      </nav>
    </aside>
    <main class="content">
      {sections}
    </main>
  </div>
{mermaid_script}</body>
</html>
"#,
        lang = escape_html(language),
        theme_preset = escape_html(&resolved_theme.preset),
        color_scheme = color_scheme,
        title = escape_html(site_name),
        bg = resolved_theme.background,
        surface = resolved_theme.surface,
        text = resolved_theme.text,
        muted = resolved_theme.muted,
        border = resolved_theme.border,
        primary = resolved_theme.primary,
        accent = resolved_theme.accent,
        code_bg = resolved_theme.code_bg,
        toc_hover = resolved_theme.toc_hover,
        font_family = resolved_theme.font_family,
        btn_text = btn_text,
        max_width = resolved_theme.max_width,
        content_padding = resolved_theme.content_padding,
        alert_css = alert_css,
        built_at = escape_html(built_at),
        toc = toc_html,
        sections = sections_html,
        mermaid_script = mermaid_script,
    )
}

#[cfg(test)]
pub(crate) fn build_without_mkdocs(
    templates: &Path,
    generated: &Path,
    output_root: &Path,
) -> Result<String, String> {
    build_inner(templates, generated, output_root, true, None, SiteEngine::MkDocs, None)
}

fn build_inner(
    templates: &Path,
    generated: &Path,
    output_root: &Path,
    draft: bool,
    root: Option<&Path>,
    engine: SiteEngine,
    command: Option<Vec<String>>,
) -> Result<String, String> {
    if !draft {
        if let Some(root) = root {
            crate::quality::require_ready(root)?;
        }
    }
    let published = output_root.canonicalize().unwrap_or_else(|_| output_root.to_path_buf());
    let config = root.map(read_config);
    let configured_output = root.zip(config.as_ref())
        .and_then(|(root, config)| crate::config::project_path(root, &config.output).ok());
    let root_is_source = config.as_ref().is_some_and(|config| config.docs == ".")
        && root.is_some_and(|root| root.canonicalize().ok() == templates.canonicalize().ok());
    let is_published = |path: &Path| {
        path.starts_with(&published) || configured_output.as_ref().is_some_and(|output| path.starts_with(output))
    };
    let pages: Vec<_> = build_pages(templates, root)?.into_iter()
        .filter(|page| !is_published(&page.original))
        .collect();
    let mut paths = std::collections::HashSet::new();
    for page in &pages {
        if !paths.insert(page.destination.clone()) {
            return Err(format!(
                "原稿の出力パスが重複しています: {}",
                page.destination.display()
            ));
        }
    }
    let tmp = tempdir().map_err(|e| e.to_string())?;
    let temp_root = tmp.path();
    let temp_docs = temp_root.join("docs");
    let temp_site = temp_root.join("site");
    fs::create_dir_all(&temp_docs).map_err(|e| e.to_string())?;

    let built_at = utc_now();
    let mut referenced_assets: HashSet<PathBuf> = HashSet::new();
    let mut staged_markdown: Vec<String> = Vec::with_capacity(pages.len());

    for page in &pages {
        let content = fs::read_to_string(&page.source).map_err(|e| e.to_string())?;
        let final_page = strip_ai_notes_outside_code(
            &crate::legacy_ai::plain_markdown(&content, Some(generated))
                .replace("{{BUILD_TIMESTAMP}}", &built_at),
        );
        let final_page = if let Some(root) = root {
            stage_page_links(
                root,
                page,
                &pages,
                &final_page,
                &temp_docs,
                &mut referenced_assets,
            )?
        } else {
            final_page
        };
        let dest = temp_docs.join(&page.destination);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&dest, crate::gfm::for_publication(&final_page)).map_err(|e| e.to_string())?;
        staged_markdown.push(final_page);
    }

    let crate::config::MkDocsConfig {
        site_name,
        theme: theme_name,
        language: theme_lang,
        use_directory_urls: use_dir_urls,
        nav: nav_config,
        exclude_unused_assets,
        theme_style,
    } = config.map(|config| config.mkdocs).unwrap_or_default();

    // markdown 以外の静的ファイルをコピー
    for entry in WalkDir::new(templates)
        .into_iter()
        .filter_entry(|entry| {
            if entry.file_name() == ".munin" || is_published(entry.path())
                || (entry.depth() > 0 && entry.file_type().is_dir() && is_published_site(entry.path()))
            {
                return false;
            }
            if !root_is_source || entry.depth() == 0 { return true; }
            let name = entry.file_name().to_string_lossy();
            !name.starts_with('.') && !matches!(name.as_ref(), "node_modules" | "target" | "dist" | "__pycache__" | "manual_setting.json")
        })
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            if entry.path().extension().map_or(true, |ext| ext != "md") {
                if exclude_unused_assets && root.is_some() && is_image_file(entry.path()) {
                    let canon = entry
                        .path()
                        .canonicalize()
                        .unwrap_or_else(|_| entry.path().to_path_buf());
                    if !referenced_assets.contains(&canon) {
                        continue;
                    }
                }
                let rel = entry.path().strip_prefix(templates).unwrap_or(entry.path());
                let dest = temp_docs.join(rel);
                if let Some(parent) = dest.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                copy_public_asset(entry.path(), &dest)?;
            }
        }
    }

    let legacy_assets = generated.join("assets");
    if legacy_assets.is_dir() {
        let dest_assets = temp_docs.join("assets");
        let _ = fs::create_dir_all(&dest_assets);
        for entry in WalkDir::new(&legacy_assets)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if entry.file_type().is_file() {
                if exclude_unused_assets && root.is_some() && is_image_file(entry.path()) {
                    let canon = entry
                        .path()
                        .canonicalize()
                        .unwrap_or_else(|_| entry.path().to_path_buf());
                    if !referenced_assets.contains(&canon) {
                        continue;
                    }
                }
                let rel = entry
                    .path()
                    .strip_prefix(&legacy_assets)
                    .unwrap_or(entry.path());
                let dest = dest_assets.join(rel);
                if let Some(parent) = dest.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                if !dest.exists() {
                    copy_public_asset(entry.path(), &dest)?;
                }
            }
        }
    }

    let nav_items = resolve_nav_items(&pages, &staged_markdown, &nav_config, root);

    if engine == SiteEngine::SingleHtml {
        fs::create_dir_all(&temp_site).map_err(|e| e.to_string())?;
        let single_html = render_single_html_document(
            &site_name,
            &theme_lang,
            &built_at,
            &nav_items,
            &staged_markdown,
            &temp_docs,
            theme_style.as_ref(),
        );
        fs::write(temp_site.join("index.html"), single_html).map_err(|e| e.to_string())?;
        fs::create_dir_all(output_root).map_err(|e| e.to_string())?;
        publish_site(&temp_site, output_root)?;
        return Ok(format!(
            "{}\nSingle HTML: {}",
            output_root.display(),
            output_root.join("index.html").display()
        ));
    }

    let nav_lines = build_nav_yaml(&nav_items);

    let theme = match engine {
        SiteEngine::MkDocs => format!("  name: {theme_name}\n"),
        SiteEngine::Zensical => "  variant: classic\n".into(),
        SiteEngine::SingleHtml => unreachable!(),
    };
    let (palette_yaml, extra_css_yaml) = if let Some(ref style) = theme_style {
        if !style.is_empty() {
            let resolved = resolve_html_theme(Some(style));
            let css_path = temp_docs.join("_munin_theme.css");
            fs::write(&css_path, build_mkdocs_theme_css(&resolved)).map_err(|e| e.to_string())?;
            let palette = if engine == SiteEngine::Zensical || theme_name == "material" {
                let scheme_name = if resolved.is_dark { "slate" } else { "default" };
                format!("  palette:\n    scheme: {scheme_name}\n")
            } else {
                String::new()
            };
            (palette, "extra_css:\n  - _munin_theme.css\n".to_string())
        } else {
            (String::new(), String::new())
        }
    } else {
        (String::new(), String::new())
    };
    let alert_theme = if (engine == SiteEngine::Zensical || theme_name == "material") && root.is_some_and(crate::gfm::alert_icons_enabled) {
        crate::gfm::mkdocs_alert_icons(&temp_root)?
    } else {
        String::new()
    };
    let config_yaml = format!(
        concat!(
            "site_name: {}\ntheme:\n{}  language: {}\n",
            "{}{}use_directory_urls: {}\nsite_dir: site\n{}",
            "markdown_extensions:\n",
            "  - tables\n",
            "  - footnotes\n",
            "  - admonition\n",
            "  - pymdownx.tilde\n",
            "  - pymdownx.tasklist\n",
            "  - pymdownx.magiclink\n",
            "  - pymdownx.superfences:\n",
            "      custom_fences:\n",
            "        - name: mermaid\n",
            "          class: mermaid\n",
            "          format: !!python/name:pymdownx.superfences.fence_code_format\n",
            "nav:\n{}",
        ),
        serde_json::to_string(&site_name).unwrap(),
        theme,
        theme_lang,
        palette_yaml,
        alert_theme,
        if use_dir_urls { "true" } else { "false" },
        extra_css_yaml,
        nav_lines
    );

    let temp_config = temp_root.join("mkdocs.yml");
    fs::write(&temp_config, config_yaml).map_err(|e| e.to_string())?;

    fs::create_dir_all(output_root).map_err(|e| e.to_string())?;

    if let Some(cmd_parts) = command {
        let (prog, args) = cmd_parts.split_first().unwrap();
        let mut final_args: Vec<String> = args.to_vec();
        final_args.extend([
            "build".to_string(),
            "-f".to_string(),
            temp_config.to_string_lossy().into_owned(),
        ]);
        if engine == SiteEngine::MkDocs {
            final_args.extend(["-d".to_string(), temp_site.to_string_lossy().into_owned()]);
        }

        let output = Command::new(prog)
            .args(&final_args)
            .current_dir(temp_root)
            .output()
            .map_err(|e| format!("Failed to run {}: {e}", engine.command()))?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            let out = String::from_utf8_lossy(&output.stdout);
            let msg = if !err.trim().is_empty() {
                err.trim()
            } else {
                out.trim()
            };
            let name = if engine == SiteEngine::MkDocs { "MkDocs" } else { "Zensical" };
            return Err(format!("{name} site build failed: {msg}"));
        }
        publish_site(&temp_site, output_root)?;
        Ok(format!(
            "{}\nSite: {}",
            output_root.display(),
            output_root.display()
        ))
    } else {
        Ok(format!(
            "{}\nMkDocs site build skipped: install mkdocs-material to generate HTML at {}",
            output_root.display(),
            output_root.display()
        ))
    }
}

#[cfg(test)]
mod site_tests {
    use super::*;

    #[test]
    fn published_entry_uses_the_generated_manifest_without_a_homepage() {
        let project = tempdir().unwrap();
        let output = project.path().join("site");
        fs::create_dir_all(output.join("guide")).unwrap();
        for path in ["404.html", "guide/index.html", "unmanaged.html"] {
            fs::write(output.join(path), "").unwrap();
        }
        fs::write(output.join(SITE_MANIFEST), r#"["404.html","guide/index.html"]"#).unwrap();
        assert_eq!(published_entry(project.path(), "site").unwrap(), output.join("guide/index.html").canonicalize().unwrap());
    }

    #[test]
    fn strip_ai_notes_removes_inline_notes_but_preserves_code_examples() {
        let input = "# Title\n<!-- ai-note: 開発メモ -->\n本文です。\n```md\n<!-- ai-note: 例示は残す -->\n```\n";
        let output = strip_ai_notes_outside_code(input);
        assert!(!output.contains("開発メモ"));
        assert!(output.contains("本文です。"));
        assert!(output.contains("<!-- ai-note: 例示は残す -->"));
    }

    #[test]
    fn publication_strips_edit_metadata_without_changing_the_project_asset_or_pixels() {
        let root = tempdir().unwrap();
        let source = root.path().join("editable.png");
        let output = root.path().join("public.png");
        let original = image::DynamicImage::new_rgba8(20, 16);
        let mut buffer = std::io::Cursor::new(Vec::new());
        original.write_to(&mut buffer, image::ImageFormat::Png).unwrap();
        let private = markits::raster::embed_png_text_chunk(buffer.get_ref(), "markits:base_image", "private original").unwrap();
        let private = markits::raster::embed_png_text_chunk(&private, "markits:ui_elements", "private UI map").unwrap();
        fs::write(&source, &private).unwrap();
        copy_public_asset(&source, &output).unwrap();
        let public = fs::read(&output).unwrap();
        assert_eq!(fs::read(&source).unwrap(), private);
        assert!(markits::raster::extract_png_text_chunk(&public, "markits:base_image").is_none());
        assert!(markits::raster::extract_png_text_chunk(&public, "markits:ui_elements").is_none());
        assert_eq!(image::load_from_memory(&public).unwrap().to_rgba8(), original.to_rgba8());
        let managed=crate::capture_resources::document_png(&private,Some("capture-publication")).unwrap();
        fs::write(&source,&managed).unwrap();copy_public_asset(&source,&output).unwrap();
        let published=fs::read(&output).unwrap();
        assert_eq!(crate::capture_resources::resource_id(&published).as_deref(),Some("capture-publication"));
        assert!(!crate::capture_resources::has_private_metadata(&published));
        assert_eq!(published,managed);
    }

    #[test]
    fn canonical_pages_publish_links_from_noncanonical_project_root() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().join(".");
        fs::create_dir(root.join("docs")).unwrap();
        fs::write(
            root.join("manual_setting.json"),
            r#"{"docs":"docs","targets":["docs","README.md"]}"#,
        )
        .unwrap();
        fs::write(root.join("README.md"), "# Readme").unwrap();
        fs::write(
            root.join("docs/index.md"),
            "![Shot](image.png)\n[Readme](../README.md)",
        )
        .unwrap();
        fs::write(root.join("docs/image.png"), b"fixture").unwrap();
        let pages = build_pages(&root.join("docs"), Some(&root)).unwrap();
        let page = pages
            .iter()
            .find(|page| page.destination == Path::new("index.md"))
            .unwrap();
        assert!(page.original.starts_with(root.canonicalize().unwrap()));
        let staged = tmp.path().join("staged");
        fs::create_dir(&staged).unwrap();
        let body = fs::read_to_string(&page.source).unwrap();
        let mut referenced = HashSet::new();
        let rendered = stage_page_links(&root, page, &pages, &body, &staged, &mut referenced).unwrap();
        assert!(rendered.contains("_assets/docs/image.png"));
        assert!(rendered.contains("_external/README.md"));
        assert!(!referenced.is_empty());
        assert_eq!(
            fs::read(staged.join("_assets/docs/image.png")).unwrap(),
            b"fixture"
        );
    }

    #[test]
    fn nav_uses_h1_titles_index_first_and_supports_custom_order_sections_and_hidden() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("docs/index.md"), "# はじめに\n\nトップページ\n").unwrap();
        fs::write(root.join("docs/beta.md"), "# ベータ手順\n\n内容\n").unwrap();
        fs::write(root.join("docs/alpha.md"), "# アルファ概要\n\n内容\n").unwrap();
        fs::write(root.join("docs/secret.md"), "# 下書きメモ\n\n非公開\n").unwrap();

        let pages = build_pages(&root.join("docs"), Some(root)).unwrap();
        let contents: Vec<String> = pages
            .iter()
            .map(|p| fs::read_to_string(&p.source).unwrap())
            .collect();

        // Default nav: index.md first, H1 titles automatically adopted
        let default_items = resolve_nav_items(&pages, &contents, &[], Some(root));
        assert_eq!(default_items[0].rel_posix, "index.md");
        assert_eq!(default_items[0].title, "はじめに");
        let default_yaml = build_nav_yaml(&default_items);
        assert!(default_yaml.contains("\"はじめに\": \"index.md\""));
        assert!(default_yaml.contains("\"アルファ概要\": \"alpha.md\""));

        // Custom nav: custom order, section grouping, title override, hidden exclusion
        let custom = vec![
            NavEntry {
                page: "beta.md".into(),
                title: "最初に読む手順".into(),
                section: "基本操作".into(),
                hidden: false,
            },
            NavEntry {
                page: "alpha.md".into(),
                title: String::new(),
                section: "基本操作".into(),
                hidden: false,
            },
            NavEntry {
                page: "secret.md".into(),
                title: String::new(),
                section: String::new(),
                hidden: true,
            },
        ];
        let custom_items = resolve_nav_items(&pages, &contents, &custom, Some(root));
        assert_eq!(custom_items.len(), 3);
        assert_eq!(custom_items[0].title, "最初に読む手順");
        assert_eq!(custom_items[1].title, "アルファ概要");
        assert_eq!(custom_items[2].rel_posix, "index.md");
        assert!(!custom_items.iter().any(|i| i.rel_posix == "secret.md"));
        let yaml = build_nav_yaml(&custom_items);
        assert!(yaml.contains("  - \"基本操作\":\n      - \"最初に読む手順\": \"beta.md\"\n      - \"アルファ概要\": \"alpha.md\""));
    }

    #[test]
    fn single_html_applies_custom_theme_style_and_persists_via_save_html_output() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("docs/index.md"), "# テーマ検証\n\n```mermaid\ngraph TD\n  A --> B\n```\n").unwrap();
        fs::write(
            root.join("manual_setting.json"),
            r#"{"docs":"docs","output":"site","assets":"docs/assets","mkdocs":{"site_name":"Theme Guide","theme":"material","language":"ja","use_directory_urls":false}}"#,
        )
        .unwrap();

        let save_json = serde_json::json!({
            "site_name": "Theme Guide",
            "theme_style": {
                "preset": "custom",
                "scheme": "dark",
                "primary": "#12ab34",
                "accent": "#56cd78",
                "background": "#101418",
                "surface": "#1a2028",
                "text": "#f1f5f9",
                "font": "serif",
                "layout": "wide"
            }
        })
        .to_string();
        crate::run(root, "save-html-output", &[("--output", "site"), ("--json", &save_json)]).unwrap();

        let cfg = crate::config::read_config(root);
        let style = cfg.mkdocs.theme_style.expect("theme_style should persist");
        assert_eq!(style.preset, "custom");
        assert_eq!(style.scheme, "dark");
        assert_eq!(style.primary, "#12ab34");
        assert_eq!(style.font, "serif");
        assert_eq!(style.layout, "wide");

        crate::run(root, "build-single-html", &[]).unwrap();
        let html = fs::read_to_string(root.join("site/index.html")).unwrap();
        assert!(html.contains(r#"data-munin-theme="custom""#));
        assert!(html.contains(r#"data-munin-scheme="dark""#));
        assert!(html.contains("--primary: #12ab34;"));
        assert!(html.contains("--accent: #56cd78;"));
        assert!(html.contains("--bg: #101418;"));
        assert!(html.contains("max-width: 1160px;"));
        assert!(html.contains("Noto Serif JP"));
        assert!(html.contains("theme: 'dark'"));

        // MkDocs/Zensical `.md-grid` wraps left nav + content + right TOC, so its max-width
        // must reserve room for all 3 columns instead of reusing Single-HTML's article width.
        let standard_css = build_mkdocs_theme_css(&resolve_html_theme(Some(&crate::config::HtmlThemeStyle {
            preset: "warm-paper".into(),
            ..Default::default()
        })));
        assert!(standard_css.contains("max-width: 1360px;"));
        assert!(standard_css.contains("Noto Serif JP"));
        assert!(standard_css.contains(".md-sidebar--primary .md-sidebar__inner"));
        assert!(standard_css.contains(".md-nav__title"));

        let wide_css = build_mkdocs_theme_css(&resolve_html_theme(Some(&crate::config::HtmlThemeStyle {
            preset: "indigo-tech".into(),
            ..Default::default()
        })));
        assert!(wide_css.contains("max-width: 1640px;"));

        let compact_css = build_mkdocs_theme_css(&resolve_html_theme(Some(&crate::config::HtmlThemeStyle {
            preset: "clean-blue".into(),
            layout: "compact".into(),
            ..Default::default()
        })));
        assert!(compact_css.contains("max-width: 1140px;"));
    }

    #[test]
    fn single_html_builds_offline_with_inlined_stripped_images_links_and_print_css() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs/assets")).unwrap();

        let original = image::DynamicImage::new_rgba8(12, 10);
        let mut buf = std::io::Cursor::new(Vec::new());
        original.write_to(&mut buf, image::ImageFormat::Png).unwrap();
        let private_png = markits::raster::embed_png_text_chunk(
            buf.get_ref(),
            "markits:base_image",
            "secret-original",
        )
        .unwrap();
        fs::write(root.join("docs/assets/used.png"), &private_png).unwrap();
        fs::write(root.join("docs/assets/unused.png"), &private_png).unwrap();

        fs::write(
            root.join("manual_setting.json"),
            r#"{"docs":"docs","output":"site","assets":"docs/assets","mkdocs":{"site_name":"テストマニュアル","theme":"material","language":"ja","use_directory_urls":false,"exclude_unused_assets":true}}"#,
        )
        .unwrap();
        fs::write(
            root.join("docs/index.md"),
            "# テストトップ\n\n<!-- ai-note: 公開に出ないメモ -->\n\n![画面](assets/used.png)\n\n[詳細へ](guide.md)\n",
        )
        .unwrap();
        fs::write(
            root.join("docs/guide.md"),
            "# 詳細ガイド\n\n> [!TIP]\n> 便利なヒントです。\n\n```mermaid\nflowchart LR\n  A[開始] --> B[完了]\n```\n",
        )
        .unwrap();

        let res = crate::run(root, "build-single-html", &[]).unwrap();
        assert!(res.contains("Single HTML:"));

        let html = fs::read_to_string(root.join("site/index.html")).unwrap();
        assert!(html.contains("<title>テストマニュアル</title>"));
        assert!(html.contains("テストトップ"));
        assert!(html.contains("詳細ガイド"));
        assert!(!html.contains("公開に出ないメモ"));
        assert!(html.contains("data:image/png;base64,"));
        assert!(html.contains("href=\"#page-2\""));
        assert!(html.contains("@media print"));
        assert!(html.contains("window.print()"));
        assert!(html.contains("markdown-alert-tip"));
        assert!(html.contains(r#"<pre class="mermaid">"#));
        assert!(html.contains("mermaid.run"));

        // Verify the embedded base64 PNG has private MarkIts metadata stripped
        let marker = "data:image/png;base64,";
        let start = html.find(marker).unwrap() + marker.len();
        let end = html[start..].find('"').unwrap() + start;
        let decoded = BASE64.decode(&html[start..end]).unwrap();
        assert!(markits::raster::extract_png_text_chunk(&decoded, "markits:base_image").is_none());

        // published_entry finds the generated index.html
        assert_eq!(
            published_entry(root, "site").unwrap(),
            root.join("site/index.html").canonicalize().unwrap()
        );

        // CLI build-audience works directly with --audience and --engine single-html
        fs::write(
            root.join("docs/dev.md"),
            "<!-- ai:audience developer -->\n# 開発者専用\n\n内部API説明\n",
        )
        .unwrap();
        let aud_res = crate::run(
            root,
            "build-audience",
            &[
                ("--audience", "user"),
                ("--engine", "single-html"),
                ("--draft", ""),
            ],
        )
        .unwrap();
        let aud_json: serde_json::Value = serde_json::from_str(&aud_res).unwrap();
        assert_eq!(aud_json["audience"], "user");
        let user_html = fs::read_to_string(root.join("site-user/index.html")).unwrap();
        assert!(user_html.contains("テストトップ"));
        assert!(!user_html.contains("開発者専用"));
    }

    #[test]
    fn publish_removes_only_previously_generated_files() {
        let tmp = tempdir().unwrap();
        let site = tmp.path().join("site");
        let output = tmp.path().join("output");
        fs::create_dir_all(&site).unwrap();
        fs::create_dir_all(&output).unwrap();
        fs::write(site.join("old.html"), "Old page").unwrap();
        fs::write(output.join("notes.txt"), "User note").unwrap();
        publish_site(&site, &output).unwrap();

        fs::remove_file(site.join("old.html")).unwrap();
        fs::write(site.join("new.html"), "New page").unwrap();
        publish_site(&site, &output).unwrap();

        assert!(!output.join("old.html").exists());
        assert_eq!(
            fs::read_to_string(output.join("new.html")).unwrap(),
            "New page"
        );
        assert_eq!(
            fs::read_to_string(output.join("notes.txt")).unwrap(),
            "User note"
        );
    }

    #[test]
    fn publish_rejects_unmanaged_file_collision() {
        let tmp = tempdir().unwrap();
        let site = tmp.path().join("site");
        let output = tmp.path().join("output");
        fs::create_dir_all(&site).unwrap();
        fs::create_dir_all(&output).unwrap();
        fs::write(site.join("index.html"), "Generated page").unwrap();
        fs::write(output.join("index.html"), "User page").unwrap();

        let err = publish_site(&site, &output).unwrap_err();

        assert!(err.contains("unmanaged file"));
        assert_eq!(
            fs::read_to_string(output.join("index.html")).unwrap(),
            "User page"
        );
        assert!(!output.join(SITE_MANIFEST).exists());
    }

    #[test]
    fn publish_adopts_legacy_mkdocs_site_without_removing_user_files() {
        let tmp = tempdir().unwrap();
        let site = tmp.path().join("site");
        let output = tmp.path().join("output");
        fs::create_dir_all(&site).unwrap();
        fs::create_dir_all(&output).unwrap();
        fs::write(site.join("index.html"), "New page").unwrap();
        fs::write(
            output.join("index.html"),
            "<meta name=\"generator\" content=\"mkdocs-1.6\">",
        )
        .unwrap();
        fs::write(output.join("notes.txt"), "User note").unwrap();

        publish_site(&site, &output).unwrap();

        assert_eq!(
            fs::read_to_string(output.join("index.html")).unwrap(),
            "New page"
        );
        assert_eq!(
            fs::read_to_string(output.join("notes.txt")).unwrap(),
            "User note"
        );
        assert!(output.join(SITE_MANIFEST).is_file());
    }

    #[test]
    fn publication_failure_restores_previous_site_and_user_files() {
        let tmp = tempdir().unwrap();
        let site = tmp.path().join("site");
        let output = tmp.path().join("output");
        fs::create_dir_all(&site).unwrap();
        fs::create_dir_all(&output).unwrap();
        fs::write(site.join("index.html"), "First version").unwrap();
        fs::write(output.join("notes.txt"), "User note").unwrap();
        publish_site(&site, &output).unwrap();
        let original_manifest = fs::read(output.join(SITE_MANIFEST)).unwrap();

        fs::write(site.join("index.html"), "Second version").unwrap();
        let err = publish_site_inner(&site, &output, true).unwrap_err();

        assert_eq!(err, "Simulated publication failure");
        assert_eq!(
            fs::read_to_string(output.join("index.html")).unwrap(),
            "First version"
        );
        assert_eq!(
            fs::read_to_string(output.join("notes.txt")).unwrap(),
            "User note"
        );
        assert_eq!(
            fs::read(output.join(SITE_MANIFEST)).unwrap(),
            original_manifest
        );
    }

    #[cfg(unix)]
    #[test]
    fn publication_rejects_symlinks_without_touching_their_target() {
        use std::os::unix::fs::symlink;

        let tmp = tempdir().unwrap();
        let site = tmp.path().join("site");
        let output = tmp.path().join("output");
        fs::create_dir_all(&site).unwrap();
        fs::create_dir_all(&output).unwrap();
        fs::write(site.join("index.html"), "Generated page").unwrap();
        let outside = tmp.path().join("outside.txt");
        fs::write(&outside, "Outside data").unwrap();
        symlink(&outside, output.join("link.txt")).unwrap();

        let err = publish_site(&site, &output).unwrap_err();

        assert!(err.contains("Symbolic links are not supported"));
        assert_eq!(fs::read_to_string(outside).unwrap(), "Outside data");
        assert!(!output.join(SITE_MANIFEST).exists());
    }
}

fn site_command(root: Option<&Path>, engine: SiteEngine) -> Option<Vec<String>> {
    let name = engine.command();
    root.and_then(|root| project_site_command(root, cfg!(windows), name))
        .or_else(|| which_binary(name).map(|binary| vec![binary.to_string_lossy().into_owned()]))
        .or_else(|| {
            ["python3", "python"].into_iter().find_map(|python| {
                let binary = which_binary(python)?;
                let probe = if engine == SiteEngine::MkDocs { "--version" } else { "--help" };
                Command::new(&binary).args(["-m", name, probe]).output().ok()?
                    .status.success().then(|| vec![binary.to_string_lossy().into_owned(), "-m".into(), name.into()])
            })
        })
}

fn project_site_command(root: &Path, windows: bool, name: &str) -> Option<Vec<String>> {
    let directory = root
        .join(".venv")
        .join(if windows { "Scripts" } else { "bin" });
    let executable = directory.join(if windows { format!("{name}.exe") } else { name.into() });
    executable
        .is_file()
        .then(|| vec![executable.to_string_lossy().into_owned()])
}

#[cfg(test)]
mod portability_tests {
    use super::*;
    #[test]
    fn site_builders_are_found_in_each_platform_virtual_environment() {
        for engine in [SiteEngine::MkDocs, SiteEngine::Zensical] {
            let name = engine.command();
            for (windows, directory) in [(true, "Scripts"), (false, "bin")] {
                let root = tempfile::tempdir().unwrap();
                let directory = root.path().join(".venv").join(directory);
                let path = directory.join(if windows { format!("{name}.exe") } else { name.into() });
                fs::create_dir_all(&directory).unwrap();
                fs::write(&path, []).unwrap();
                assert_eq!(project_site_command(root.path(), windows, name).unwrap()[0], path.to_string_lossy());
                assert!(project_site_command(root.path(), !windows, name).is_none());
            }
        }
    }
}
