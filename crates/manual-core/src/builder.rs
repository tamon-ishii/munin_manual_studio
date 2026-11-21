use std::collections::{BTreeSet};
use std::fs;
use std::path::{Component, Path};
use std::process::Command;
use tempfile::{tempdir, tempdir_in};
use walkdir::WalkDir;

use super::agent::which_binary;
use super::config::read_config;
use super::task::{collect_markdown_files, utc_now};

const SITE_MANIFEST: &str = ".moduleloom-site-files.json";

pub(crate) fn is_published_site(path: &Path) -> bool {
    path.join(SITE_MANIFEST).is_file()
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum SiteEngine {
    MkDocs,
    Zensical,
}

impl SiteEngine {
    fn command(self) -> &'static str {
        match self {
            Self::MkDocs => "mkdocs",
            Self::Zensical => "zensical",
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
) -> Result<String, String> {
    use pulldown_cmark::{Event, Options, Parser, Tag};
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let resolve = |url: &str| -> Result<Option<String>, String> {
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
    let command = site_command(root, engine);
    if engine == SiteEngine::Zensical && command.is_none() {
        return Err("Zensicalが見つかりません。Studioから参照できるPATHに zensical を追加するか、プロジェクトの .venv にインストールしてください。PATHを変更した場合はStudioを再起動してください。".into());
    }
    build_inner(templates, generated, output_root, draft, root, engine, command)
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

    for page in &pages {
        let content = fs::read_to_string(&page.source).map_err(|e| e.to_string())?;
        let final_page = crate::legacy_ai::plain_markdown(&content, Some(generated))
            .replace("{{BUILD_TIMESTAMP}}", &built_at);
        let final_page = if let Some(root) = root {
            stage_page_links(root, page, &pages, &final_page, &temp_docs)?
        } else {
            final_page
        };
        let dest = temp_docs.join(&page.destination);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&dest, crate::gfm::for_publication(&final_page)).map_err(|e| e.to_string())?;
    }

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

    let crate::config::MkDocsConfig {
        site_name,
        theme: theme_name,
        language: theme_lang,
        use_directory_urls: use_dir_urls,
    } = config.map(|config| config.mkdocs).unwrap_or_default();

    let mut nav_lines = String::new();
    for page in &pages {
        let rel_posix = page.destination.to_string_lossy().replace('\\', "/");
        let stem = page
            .source
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy();
        nav_lines.push_str(&format!(
            "  - {}: {}\n",
            serde_json::to_string(&stem).unwrap(),
            serde_json::to_string(&rel_posix).unwrap()
        ));
    }

    let theme = match engine {
        SiteEngine::MkDocs => format!("  name: {theme_name}\n"),
        SiteEngine::Zensical => "  variant: classic\n".into(),
    };
    let alert_theme = if (engine == SiteEngine::Zensical || theme_name == "material") && root.is_some_and(crate::gfm::alert_icons_enabled) {
        crate::gfm::mkdocs_alert_icons(&temp_root)?
    } else {
        String::new()
    };
    let config_yaml = format!(
        concat!(
            "site_name: {}\ntheme:\n{}  language: {}\n",
            "{}use_directory_urls: {}\nsite_dir: site\n",
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
        alert_theme,
        if use_dir_urls { "true" } else { "false" },
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
        let rendered = stage_page_links(&root, page, &pages, &body, &staged).unwrap();
        assert!(rendered.contains("_assets/docs/image.png"));
        assert!(rendered.contains("_external/README.md"));
        assert_eq!(
            fs::read(staged.join("_assets/docs/image.png")).unwrap(),
            b"fixture"
        );
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
