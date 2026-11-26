use regex::Regex;
use std::fs;
use std::path::Path;
use tempfile::tempdir;
use walkdir::WalkDir;

use super::builder;
use super::task::{get_code_block_ranges, is_inside_ranges};

fn included(content: &str, audience: &str) -> Result<bool, String> {
    let pattern = Regex::new(r"(?m)^<!--\s*ai:audience\s+([^>]+?)\s*-->\s*$").unwrap();
    let fences = get_code_block_ranges(content);
    let mut directives = pattern.captures_iter(content).filter(|capture| {
        let full = capture.get(0).unwrap();
        !is_inside_ranges(&(full.start()..full.end()), &fences)
    });
    let Some(first) = directives.next() else {
        return Ok(true);
    };
    if directives.next().is_some() {
        return Err("A page may have only one ai:audience directive".into());
    }
    let readers: Vec<&str> = first[1].split(',').map(str::trim).collect();
    if readers
        .iter()
        .any(|reader| !["user", "developer", "maintainer"].contains(reader))
    {
        return Err("ai:audience must use user, developer, or maintainer".into());
    }
    Ok(readers.contains(&audience))
}

pub fn build(
    root: &Path,
    docs: &Path,
    generated: &Path,
    output: &Path,
    draft: bool,
    audience: &str,
) -> Result<String, String> {
    build_with_engine(root, docs, generated, output, draft, audience, builder::SiteEngine::MkDocs)
}

pub(crate) fn build_with_engine(
    root: &Path,
    docs: &Path,
    generated: &Path,
    output: &Path,
    draft: bool,
    audience: &str,
    engine: builder::SiteEngine,
) -> Result<String, String> {
    build_with_engine_in(root, docs, generated, output, draft, audience, engine, None)
}

pub(crate) fn build_with_engine_in(
    root: &Path,
    docs: &Path,
    generated: &Path,
    output: &Path,
    draft: bool,
    audience: &str,
    engine: builder::SiteEngine,
    working_directory_override: Option<&str>,
) -> Result<String, String> {
    if !["user", "developer", "maintainer"].contains(&audience) {
        return Err("--audience must be user, developer, or maintainer".into());
    }
    let temporary = tempdir().map_err(|error| error.to_string())?;
    let selected = temporary.path().join("docs");
    fs::create_dir_all(&selected).map_err(|error| error.to_string())?;
    let mut pages = 0;
    let published = output.canonicalize().unwrap_or_else(|_| output.to_path_buf());
    let configured = crate::config::project_path(root, &crate::config::read_config(root).output).ok();
    for entry in WalkDir::new(docs).into_iter().filter_entry(|entry| {
        if entry.path().starts_with(&published)
            || configured.as_ref().is_some_and(|output| entry.path().starts_with(output))
            || (entry.depth() > 0 && entry.file_type().is_dir() && builder::is_published_site(entry.path()))
        {
            return false;
        }
        if entry.depth() == 0 {
            return true;
        }
        let name = entry.file_name().to_string_lossy();
        !name.starts_with('.')
            && !matches!(
                name.as_ref(),
                "node_modules" | "target" | "dist" | "__pycache__" | "venv" | "manual_setting.json"
            )
    }) {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(docs)
            .map_err(|error| error.to_string())?;
        if relative
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
        {
            let content = fs::read_to_string(entry.path()).map_err(|error| error.to_string())?;
            if !included(&content, audience)? {
                continue;
            }
            pages += 1;
        }
        let destination = selected.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(entry.path(), destination).map_err(|error| error.to_string())?;
    }
    if pages == 0 {
        return Err(format!("対象読者（{audience}）に含まれる原稿がありません。"));
    }
    builder::build_with_engine_in(
        &selected,
        generated,
        output,
        draft,
        Some(root),
        engine,
        working_directory_override,
    )
}

#[cfg(test)]
mod tests {
    use super::included;

    #[test]
    fn audience_directive_filters_pages() {
        assert!(included("# Shared", "developer").unwrap());
        assert!(included("<!-- ai:audience user, developer -->\n# Guide", "developer").unwrap());
        assert!(!included("<!-- ai:audience user -->\n# Guide", "maintainer").unwrap());
        assert!(included(
            "```md\n<!-- ai:audience user -->\n```\n# Shared",
            "developer"
        )
        .unwrap());
        assert!(included("<!-- ai:audience unknown -->", "user").is_err());
    }

    #[test]
    fn audience_build_succeeds_without_index_md() {
        let tmp = tempfile::tempdir().unwrap();
        let docs = tmp.path().join("docs");
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::write(
            docs.join("index.md"),
            "<!-- ai:audience developer -->\n# Dev Home\n",
        )
        .unwrap();
        std::fs::write(
            docs.join("guide.md"),
            "<!-- ai:audience user -->\n# User Guide\n",
        )
        .unwrap();
        let generated = tmp.path().join(".munin/generated");
        let out = tmp.path().join("site-user");
        super::build_with_engine(
            tmp.path(),
            &docs,
            &generated,
            &out,
            true,
            "user",
            crate::builder::SiteEngine::SingleHtml,
        )
        .unwrap();
        let html = std::fs::read_to_string(out.join("index.html")).unwrap();
        assert!(html.contains("User Guide"));
        assert!(!html.contains("Dev Home"));
    }
}
