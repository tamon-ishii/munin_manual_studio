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
    if !["user", "developer", "maintainer"].contains(&audience) {
        return Err("--audience must be user, developer, or maintainer".into());
    }
    let temporary = tempdir().map_err(|error| error.to_string())?;
    let selected = temporary.path().join("docs");
    fs::create_dir_all(&selected).map_err(|error| error.to_string())?;
    let mut pages = 0;
    let mut has_index = false;
    for entry in WalkDir::new(docs) {
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
            .is_some_and(|extension| extension == "md")
        {
            let content = fs::read_to_string(entry.path()).map_err(|error| error.to_string())?;
            if !included(&content, audience)? {
                continue;
            }
            pages += 1;
            if relative == Path::new("index.md") {
                has_index = true;
            }
        }
        let destination = selected.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(entry.path(), destination).map_err(|error| error.to_string())?;
    }
    if pages == 0 || !has_index {
        return Err(format!("Audience {audience} needs an included index.md"));
    }
    builder::build(&selected, generated, output, draft, Some(root))
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
}
