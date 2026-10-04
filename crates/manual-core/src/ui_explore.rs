use serde::Deserialize;
use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::tempdir_in;

use super::uimap;

#[derive(Deserialize)]
struct ExploreResult {
    source: String,
    views: Vec<uimap::UIView>,
}

pub fn explore(root: &Path, url: &str, max_pages: usize) -> Result<String, String> {
    if max_pages == 0 || max_pages > 30 {
        return Err("--max-pages must be between 1 and 30".into());
    }
    if !(url.starts_with("http://") || url.starts_with("https://") || url.starts_with("file://")) {
        return Err("UI exploration requires an http, https, or file URL".into());
    }
    let temporary = tempdir_in(root).map_err(|error| error.to_string())?;
    let script = temporary.path().join("explore_runner.mjs");
    let observation = temporary.path().join("observation.json");
    fs::write(&script, include_str!("explore_runner.mjs")).map_err(|error| error.to_string())?;
    let output = Command::new("node")
        .arg(&script)
        .arg(url)
        .arg(max_pages.to_string())
        .arg(&observation)
        .current_dir(root)
        .output()
        .map_err(|error| format!("Failed to start UI explorer: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "UI exploration failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let content = fs::read_to_string(&observation).map_err(|error| error.to_string())?;
    let result: ExploreResult = serde_json::from_str(&content)
        .map_err(|error| format!("Invalid UI exploration result: {error}"))?;
    if result.source != url || result.views.is_empty() {
        return Err("UI exploration returned no views".into());
    }
    let map = uimap::import_ui_observation(root, &observation)?;
    serde_json::to_string_pretty(&map).map_err(|error| error.to_string())
}
