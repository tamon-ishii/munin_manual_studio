use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, path::Path};

#[derive(Default, Deserialize)]
pub struct GenerationOptions {
    pub ids: Option<Vec<String>>,
    pub revision: Option<String>,
}

pub fn selected_tasks(
    root: &Path,
    page: &str,
    id: Option<&str>,
    options: &GenerationOptions,
) -> Result<Vec<crate::task::Task>, String> {
    let tasks: Vec<_> = crate::task::tasks_for_page(root, page)?
        .into_iter()
        .filter(|task| task.kind == "text" || task.kind == "diagram")
        .collect();
    if let Some(ids) = &options.ids {
        if ids.is_empty() {
            return Err("生成するAIタグを選んでください。".into());
        }
        let unique: std::collections::HashSet<_> = ids.iter().collect();
        if unique.len() != ids.len() {
            return Err("生成対象のIDが重複しています。".into());
        }
        for selected in ids {
            if !tasks
                .iter()
                .any(|task| &task.id == selected && task.status != "approved")
            {
                return Err(format!("生成対象が存在しないか確定済みです: {selected}"));
            }
        }
    }
    if let Some(id) = id {
        if !tasks
            .iter()
            .any(|task| task.id == id && task.status != "approved")
        {
            return Err(format!("生成対象が存在しないか確定済みです: {id}"));
        }
    }
    Ok(tasks
        .into_iter()
        .filter(|task| {
            task.status != "approved"
                && id.map_or(true, |id| task.id == id)
                && options
                    .ids
                    .as_ref()
                    .map_or(true, |ids| ids.contains(&task.id))
        })
        .collect())
}

pub fn input(
    root: &Path,
    page: &str,
    id: Option<&str>,
    feedback: &str,
    options: &GenerationOptions,
) -> Result<Value, String> {
    let before = crate::editor::read(root, page)?;
    if options
        .revision
        .as_ref()
        .is_some_and(|revision| revision != &before.revision)
    {
        return Err("入力確認後に原稿が更新されました。入力を確認し直してください。".into());
    }
    let tasks = selected_tasks(root, page, id, options)?;
    let config = crate::config::read_config(root);
    let mut requests = Vec::new();
    if let Some(id) = id {
        if let Some(task) = tasks
            .iter()
            .find(|task| task.id == id && (task.kind == "text" || task.kind == "diagram"))
        {
            let (prompt, schema) = crate::author::task_request(root, task, feedback)?;
            requests.push(json!({"ids":[id], "prompt":prompt, "schema":schema}));
        }
    } else {
        let text_tasks: Vec<_> = tasks.iter().collect();
        if !text_tasks.is_empty() {
            let (prompt, schema) =
                crate::author::page_text_request(root, page, &text_tasks, feedback)?;
            requests.push(json!({"ids":text_tasks.iter().map(|task| &task.id).collect::<Vec<_>>(), "prompt":prompt, "schema":schema}));
        }
    }
    Ok(
        json!({"page":page, "revision":before.revision, "existing_content":before.content,
        "tasks":tasks, "requests":requests, "references":[page], "feedback":feedback,
        "connection_type":config.connection_type, "agent":config.agent, "model":config.model,
        "source_note":"CLIは実行時に必要なソースを選んで参照します。API接続には、下記の依頼文と既存本文を渡します。"}),
    )
}

pub fn generate_with_options(
    root: &Path,
    page: &str,
    id: Option<&str>,
    feedback: &str,
    body: Option<&str>,
    bodies: Option<HashMap<String, String>>,
    options: &GenerationOptions,
) -> Result<String, String> {
    let checkpoint = crate::agent::cancellation_checkpoint(root);
    let before = crate::editor::read(root, page)?;
    let config = crate::config::read_config(root);
    let request_input = input(root, page, id, feedback, options)?;
    let tasks = selected_tasks(root, page, id, options)?;
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
            crate::author::checked_generated_body(root, b, Some(&task.id))?
        } else {
            crate::author::generate_task_body(root, task, "", feedback)?
        };
        if task.kind == "diagram" {
            crate::author::validate_mermaid_body(&task_body)?;
        }
        crate::task::update_task_in_docs(&templates, task, &task_body, None)?;
        vec![id.to_string()]
    } else if let Some(bodies_map) = bodies.filter(|m| !m.is_empty()) {
        let mut updated_ids = Vec::new();
        for task in &tasks {
            if task.status != "approved" {
                if let Some(task_body) = bodies_map.get(&task.id) {
                    if !task_body.trim().is_empty() {
                        let checked =
                            crate::author::checked_generated_body(root, task_body, Some(&task.id))?;
                        if task.kind == "diagram" {
                            crate::author::validate_mermaid_body(&checked)?;
                        }
                        crate::task::update_task_in_docs(&templates, task, &checked, None)?;
                        updated_ids.push(task.id.clone());
                    }
                }
            }
        }
        updated_ids
    } else {
        let report = crate::author::generate_page_at_selected(
            root,
            page,
            "",
            &templates,
            &generated,
            false,
            true,
            feedback,
            options.ids.as_deref(),
        )?;
        serde_json::from_value(report["updated"].clone()).map_err(|e| e.to_string())?
    };
    crate::agent::check_cancelled(root, &checkpoint)?;
    let content = fs::read_to_string(staged_page).map_err(|e| e.to_string())?;
    let candidate = json!({"before": before, "content": content, "updated": updated});
    let history_id = save_history(root, &request_input, &candidate)?;
    Ok(
        json!({"before": before, "content": content, "updated": updated, "history_id":history_id})
            .to_string(),
    )
}

fn history_dir(root: &Path) -> Result<std::path::PathBuf, String> {
    let directory = crate::config::project_path(root, ".munin/generation-history")?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("migration.lock"))
        .map_err(|e| e.to_string())?;
    lock.lock().map_err(|e| e.to_string())?;
    let legacy = crate::config::project_path(root, "manual/ai/history")?;
    if legacy.is_dir() {
        for item in fs::read_dir(&legacy).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            if !item.file_type().map_err(|e| e.to_string())?.is_file() {
                continue;
            }
            let bytes = fs::read(item.path()).map_err(|e| e.to_string())?;
            let Ok(entry) = serde_json::from_slice::<HistoryEntry>(&bytes) else {
                continue;
            };
            if entry.id.is_empty()
                || !entry.id.chars().all(|c| c.is_ascii_digit() || c == '-')
                || item.file_name().to_string_lossy() != format!("{}.json", entry.id)
            {
                continue;
            }
            let destination = crate::config::project_path(
                root,
                &format!(
                    ".munin/generation-history/{}",
                    item.file_name().to_string_lossy()
                ),
            )?;
            if destination.exists() {
                if fs::read(&destination).map_err(|e| e.to_string())? != bytes {
                    return Err("生成履歴の移行先に同じIDの異なる履歴があります。".into());
                }
                fs::remove_file(item.path()).map_err(|e| e.to_string())?;
            } else {
                fs::rename(item.path(), destination).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(directory)
}

#[derive(Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: String,
    pub created_at: String,
    pub input: Value,
    pub candidate: Value,
}

fn save_history(root: &Path, input: &Value, candidate: &Value) -> Result<String, String> {
    let directory = history_dir(root)?;
    fs::create_dir_all(&directory).map_err(|e| format!("生成履歴を保存できません: {e}"))?;
    let id = format!(
        "{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos(),
        std::process::id()
    );
    let entry = HistoryEntry {
        id: id.clone(),
        created_at: crate::task::utc_now(),
        input: input.clone(),
        candidate: candidate.clone(),
    };
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join(format!("{id}.json")))
        .map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, &entry)
        .map_err(|e| format!("生成履歴を保存できません: {e}"))?;
    Ok(id)
}

pub fn history(root: &Path, page: &str) -> Result<Value, String> {
    crate::editor::read(root, page)?;
    let directory = history_dir(root)?;
    if !directory.exists() {
        return Ok(json!({"entries":[]}));
    }
    let mut entries = Vec::new();
    for item in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        if !item.file_type().map_err(|e| e.to_string())?.is_file()
            || item.path().extension().and_then(|e| e.to_str()) != Some("json")
        {
            continue;
        }
        let Ok(entry) = serde_json::from_slice::<HistoryEntry>(
            &fs::read(item.path()).map_err(|e| e.to_string())?,
        ) else {
            continue;
        };
        if entry.input["page"] == page {
            entries.push(json!({"id":entry.id, "created_at":entry.created_at, "agent":entry.input["agent"], "model":entry.input["model"], "connection_type":entry.input["connection_type"], "ids":entry.candidate["updated"], "feedback":entry.input["feedback"]}));
        }
    }
    entries.sort_by(|a, b| b["id"].as_str().cmp(&a["id"].as_str()));
    entries.truncate(50);
    Ok(json!({"entries":entries}))
}

pub fn history_entry(root: &Path, id: &str) -> Result<Value, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit() || c == '-') {
        return Err("生成履歴IDが不正です。".into());
    }
    history_dir(root)?;
    let path = crate::config::project_path(root, &format!(".munin/generation-history/{id}.json"))?;
    let entry: HistoryEntry = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    serde_json::to_value(entry).map_err(|e| e.to_string())
}
