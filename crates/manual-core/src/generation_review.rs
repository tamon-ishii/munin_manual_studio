use serde_json::json;
use std::{fs, path::Path};

pub fn generate(
    root: &Path,
    page: &str,
    id: Option<&str>,
    feedback: &str,
    body: Option<&str>,
) -> Result<String, String> {
    let before = crate::editor::read(root, page)?;
    let config = crate::config::read_config(root);
    let tasks = crate::task::tasks_for_page(root, page)?;
    let stage = tempfile::tempdir().map_err(|e| e.to_string())?;
    let generated = stage.path().join("review-answers");
    let original_path = crate::editor::document_path(root, page)?;
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let relative = original_path
        .strip_prefix(&canonical_root)
        .map_err(|e| e.to_string())?;
    let staged_page = stage.path().join(relative);
    let original_docs = crate::config::project_path(root, &config.docs)?;
    let templates = if original_path.starts_with(original_docs) {
        stage.path().join(&config.docs)
    } else {
        stage.path().to_path_buf()
    };
    fs::create_dir_all(staged_page.parent().ok_or("Invalid page path")?)
        .map_err(|e| e.to_string())?;
    fs::write(&staged_page, &before.content).map_err(|e| e.to_string())?;
    let updated = if let Some(id) = id {
        let task = tasks
            .iter()
            .find(|task| task.id == id)
            .ok_or("AIタグが文書にありません。")?;
        let task_body = if let Some(b) = body.filter(|b| !b.trim().is_empty()) {
            b.to_string()
        } else {
            crate::author::generate_task_body(root, task, "", feedback)?
        };
        crate::task::update_task_in_docs(&templates, task, &task_body, None)?;
        vec![id.to_string()]
    } else {
        let report = crate::author::generate_page_at(
            root, page, "", &templates, &generated, false, true, feedback,
        )?;
        serde_json::from_value(report["updated"].clone()).map_err(|e| e.to_string())?
    };
    let content = fs::read_to_string(staged_page).map_err(|e| e.to_string())?;
    Ok(json!({"before": before, "content": content, "updated": updated}).to_string())
}
