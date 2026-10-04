use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tempfile::NamedTempFile;

use super::config::{project_path, read_config};
use super::{agent, author, desktop_scenario, scenario, task, window_capture};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CaptureSource {
    Window { title: String, inset: u32 },
    Scenario { input: String },
}

fn is_manual_studio_title(title: &str) -> bool {
    title.to_ascii_lowercase().contains("manual studio")
}

pub fn targets_manual_studio(root: &Path, source: &CaptureSource) -> bool {
    match source {
        CaptureSource::Window { title, .. } => is_manual_studio_title(title),
        CaptureSource::Scenario { input } => scenario::load(root, input)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|value| {
                value
                    .get("window")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .is_some_and(|title| is_manual_studio_title(&title)),
    }
}

pub fn read(root: &Path) -> Result<BTreeMap<String, CaptureSource>, String> {
    let path = project_path(root, "manual/capture_sources.json")?;
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    serde_json::from_str(&fs::read_to_string(&path).map_err(|error| error.to_string())?)
        .map_err(|error| format!("Invalid saved capture sources: {error}"))
}

fn save(root: &Path, id: &str, source: CaptureSource) -> Result<(), String> {
    let mut sources = read(root)?;
    sources.insert(id.to_string(), source);
    write_sources(root, &sources)
}

fn write_sources(root: &Path, sources: &BTreeMap<String, CaptureSource>) -> Result<(), String> {
    let path = project_path(root, "manual/capture_sources.json")?;
    let parent = path.parent().ok_or("Invalid capture source path")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut temporary = NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    serde_json::to_writer_pretty(&mut temporary, &sources).map_err(|error| error.to_string())?;
    temporary.persist(path).map_err(|error| error.to_string())?;
    Ok(())
}

fn assignment_schema(task_ids: &[String], window_ids: &[String]) -> Value {
    let window_ids: Vec<_> = window_ids.iter().filter(|id| !id.is_empty()).collect();
    json!({
        "type": "object",
        "properties": { "assignments": {
            "type": "array",
            "items": { "type": "object", "properties": {
                "task_id": { "type": "string", "enum": task_ids },
                "window_id": { "type": "string", "enum": window_ids },
                "steps_json": { "type": "string" },
            }, "required": ["task_id", "window_id", "steps_json"], "additionalProperties": false }
        } },
        "required": ["assignments"],
        "additionalProperties": false
    })
}

pub fn auto_assign(root: &Path) -> Result<String, String> {
    auto_assign_scoped(root, None)
}

pub fn auto_assign_page(root: &Path, page: &str) -> Result<String, String> {
    auto_assign_scoped(root, Some(page))
}

fn auto_assign_scoped(root: &Path, page: Option<&str>) -> Result<String, String> {
    let config = read_config(root);
    let docs = project_path(root, &config.docs)?;
    let sources = read(root)?;
    let selected = if let Some(page) = page {
        task::tasks_for_page(root, page)?
    } else {
        task::tasks(&docs)?
    };
    let scoped_tasks: Vec<_> = selected
        .iter()
        .filter(|task| task.kind == "screenshot" && task.status != "approved")
        .cloned()
        .collect();
    let invalid_sources: Vec<_> = scoped_tasks
        .iter()
        .filter(|task| {
            sources
                .get(&task.id)
                .is_some_and(|source| targets_manual_studio(root, source))
        })
        .map(|task| task.id.clone())
        .collect();
    let tasks: Vec<_> = scoped_tasks
        .into_iter()
        .filter(|task| !sources.contains_key(&task.id))
        .collect();
    if tasks.is_empty() {
        let warnings: Vec<_> = invalid_sources.iter().map(|id| json!({
            "id": id,
            "reason": "保存済み撮影元はManual Studio自身です。明示的な撮影ではManual Studioを隠して撮影できないため、対象アプリの撮影元を選び直してください。設定は保持しました。"
        })).collect();
        return Ok(json!({ "assigned": [], "skipped": invalid_sources, "warnings": warnings, "already_set": sources.len() }).to_string());
    }
    if window_capture::is_wayland_session() {
        return Err("Waylandでは起動中のウィンドウを列挙できません。システムの撮影ダイアログから選択してください。".into());
    }

    let windows = window_capture::list_windows()?;
    let mut title_counts = BTreeMap::new();
    for window in &windows {
        *title_counts.entry(window.title.clone()).or_insert(0usize) += 1;
    }
    let candidates: Vec<_> = windows
        .into_iter()
        .filter(|window| {
            !window.title.trim().is_empty()
                && !is_manual_studio_title(&window.title)
                && title_counts.get(&window.title) == Some(&1)
        })
        .collect();
    if candidates.is_empty() {
        return Err(
            "一意に識別できるウィンドウがありません。対象アプリを開いてから実行してください。"
                .into(),
        );
    }

    let project_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("project");
    let brief = fs::read_to_string(root.join("manual/brief.md")).unwrap_or_default();
    let task_list: Vec<_> = tasks
        .iter()
        .map(|task| {
            json!({
                "id": task.id,
                "page": task.page,
                "instruction": task.prompt.chars().take(800).collect::<String>(),
            })
        })
        .collect();
    let window_list: Vec<_> = candidates
        .iter()
        .map(|window| {
            json!({
                "id": window.id,
                "title": window.title,
            })
        })
        .collect();
    let accessible_windows: Vec<Value> = desktop_scenario::list_accessible_windows()
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    let mut observations = Vec::new();
    for window in candidates.iter().take(8) {
        let matches: Vec<_> = accessible_windows
            .iter()
            .filter(|entry| {
                entry.get("title").and_then(Value::as_str) == Some(window.title.as_str())
            })
            .collect();
        if let [matched] = matches.as_slice() {
            if let Some(query) = matched.get("query").and_then(Value::as_str) {
                if let Ok(tree) = desktop_scenario::inspect_window(query) {
                    observations.push(json!({
                        "window_id": window.id,
                        "accessibility_tree": tree.chars().take(5000).collect::<String>(),
                    }));
                }
            }
        }
    }
    let prompt = format!(
        "Set up screenshot capture for this Japanese manual. For each task, choose an exact open window ID. \
         In steps_json, return a JSON array of desktop accessibility steps to navigate to the requested screen BEFORE capture. \
         Only use selectors grounded in the provided accessibility tree; when a screen cannot be reached from observed controls, use []. \
         Allowed actions: press, focus, select, scroll_into_view, expect_visible, expect_hidden, wait_ms. \
         Never use launch, fill, keyboard shortcuts, coordinate clicks, or screenshot in steps_json. \
         Omit an assignment when the target application window is missing or uncertain. \
         Do not select Manual Studio unless it is the target application. Do not execute or modify anything.\n\n\
         Project: {project_name}\nBrief: {}\nScreenshot tasks: {}\nOpen windows: {}\nObserved controls: {}",
        brief.chars().take(4000).collect::<String>(),
        json!(task_list),
        json!(window_list),
        json!(observations)
    );
    let allowed_window_ids: Vec<String> =
        candidates.iter().map(|window| window.id.clone()).collect();
    let task_ids: Vec<_> = tasks.iter().map(|task| task.id.clone()).collect();
    let schema = assignment_schema(&task_ids, &allowed_window_ids);
    let response = agent::agent_json(root, &prompt, &schema, &config.agent, &config.model)?;
    let mut output: Value = serde_json::from_str(&apply_auto_assignments(
        root,
        sources,
        &tasks,
        &candidates,
        &response,
    )?)
    .map_err(|error| error.to_string())?;
    if let Some(skipped) = output["skipped"].as_array_mut() {
        skipped.extend(invalid_sources.iter().map(|id| json!(id)));
    }
    if let Some(warnings) = output["warnings"].as_array_mut() {
        warnings.extend(invalid_sources.iter().map(|id| json!({
            "id": id,
            "reason": "保存済み撮影元はManual Studio自身です。明示的な撮影ではManual Studioを隠して撮影できないため、対象アプリの撮影元を選び直してください。設定は保持しました。"
        })));
    }
    Ok(output.to_string())
}

pub fn auto_assign_and_capture(root: &Path) -> Result<String, String> {
    let output = auto_assign(root)?;
    let mut result: Value = serde_json::from_str(&output).map_err(|error| error.to_string())?;
    let docs = project_path(root, &read_config(root).docs)?;
    let sources = read(root)?;
    let mut captured = Vec::new();
    let mut capture_errors = Vec::new();
    for task in task::tasks(&docs)? {
        if task.kind != "screenshot" || !sources.contains_key(&task.id) {
            continue;
        }
        if !["missing", "stale"].contains(&task.status.as_str()) {
            continue;
        }
        super::agent::log_progress(root, &format!("{} の画面を撮影しています", task.id));
        match recapture(root, &task.id) {
            Ok(_) => captured.push(task.id),
            Err(error) => capture_errors.push(json!({ "id": task.id, "reason": error })),
        }
    }
    result["captured"] = json!(captured);
    result["capture_errors"] = json!(capture_errors);
    Ok(result.to_string())
}

fn apply_auto_assignments(
    root: &Path,
    mut sources: BTreeMap<String, CaptureSource>,
    tasks: &[task::Task],
    windows: &[window_capture::WindowInfo],
    response: &Value,
) -> Result<String, String> {
    let assignments = response
        .get("assignments")
        .and_then(Value::as_array)
        .ok_or("AIが撮影元の一覧を返しませんでした。")?;
    let mut seen = HashSet::new();
    let mut assigned = Vec::new();
    let mut warnings = Vec::new();
    let mut pending_scenarios = Vec::new();
    let manual_studio_sources: HashSet<_> = tasks
        .iter()
        .filter(|task| {
            sources
                .get(&task.id)
                .is_some_and(|source| targets_manual_studio(root, source))
        })
        .map(|task| task.id.as_str())
        .collect();
    for task_id in &manual_studio_sources {
        warnings.push(json!({ "id": task_id, "reason": "保存済み撮影元はManual Studio自身です。明示的な撮影ではManual Studioを隠して撮影できないため、対象アプリの撮影元を選び直してください。設定は保持しました。" }));
    }
    for assignment in assignments {
        let task_id = assignment
            .get("task_id")
            .and_then(Value::as_str)
            .ok_or("AIが無効な画像タスクIDを返しました。")?;
        let window_id = assignment
            .get("window_id")
            .and_then(Value::as_str)
            .ok_or("AIが無効なウィンドウIDを返しました。")?;
        let steps_json = assignment
            .get("steps_json")
            .and_then(Value::as_str)
            .ok_or("AIが操作手順を返しませんでした。")?;
        if !tasks.iter().any(|task| task.id == task_id) || !seen.insert(task_id) {
            return Err(format!(
                "AIが無効または重複した画像タスクIDを返しました: {task_id}"
            ));
        }
        if manual_studio_sources.contains(task_id) {
            continue;
        }
        if window_id.is_empty() {
            continue;
        }
        let window = windows
            .iter()
            .find(|window| window.id == window_id)
            .ok_or_else(|| format!("AIが一覧にないウィンドウIDを返しました: {window_id}"))?;
        if is_manual_studio_title(&window.title) {
            warnings.push(json!({ "id": task_id, "reason": "Manual Studio自身はAIの自動撮影元にできません。対象アプリを開いて撮影元を選んでください。" }));
            continue;
        }
        let mut source = CaptureSource::Window {
            title: window.title.clone(),
            inset: 0,
        };
        let mut kind = "window";
        if let Ok(mut steps) = serde_json::from_str::<Vec<Value>>(steps_json) {
            let allowed = [
                "press",
                "focus",
                "select",
                "scroll_into_view",
                "expect_visible",
                "expect_hidden",
                "wait_ms",
            ];
            if !steps.is_empty()
                && steps.len() <= 12
                && steps.iter().all(|step| {
                    step.as_object().is_some_and(|object| {
                        object.len() == 1
                            && allowed.iter().any(|action| object.contains_key(*action))
                    })
                })
            {
                steps.push(json!({ "screenshot": { "task": task_id } }));
                let definition = json!({ "version": 1, "platform": "desktop", "window": window.title, "steps": steps }).to_string();
                match scenario::validate_json_with_tasks(root, &definition, tasks) {
                    Ok(()) => {
                        let path = format!("manual/scenarios/ai-{task_id}-{}-{}.json", chrono::Utc::now().timestamp_millis(), std::process::id());
                        if project_path(root, &path)?.exists() {
                            return Err(format!("撮影シナリオの保存先が既に存在します: {path}"));
                        }
                        source = CaptureSource::Scenario { input: path.clone() };
                        pending_scenarios.push((path, definition));
                        kind = "scenario";
                    }
                    Err(error) => warnings.push(json!({ "id": task_id, "reason": format!("操作手順を検証できませんでした: {error}") })),
                }
            } else if !steps.is_empty() {
                warnings.push(json!({ "id": task_id, "reason": "許可されていない操作が含まれるため、撮影元のみ設定しました" }));
            }
        } else {
            warnings.push(json!({ "id": task_id, "reason": "操作手順の形式が不正なため、撮影元のみ設定しました" }));
        }
        sources.insert(task_id.to_string(), source);
        assigned.push(json!({ "id": task_id, "title": window.title, "kind": kind }));
    }
    let skipped: Vec<_> = tasks
        .iter()
        .filter(|task| {
            !sources.contains_key(&task.id) || manual_studio_sources.contains(task.id.as_str())
        })
        .map(|task| task.id.clone())
        .collect();
    let mut saved_scenarios = Vec::new();
    for (path, definition) in pending_scenarios {
        if let Err(error) = scenario::save_with_tasks(root, &path, &definition, tasks) {
            for saved in saved_scenarios {
                let _ = fs::remove_file(root.join(saved));
            }
            return Err(error);
        }
        saved_scenarios.push(path);
    }
    if !assigned.is_empty() {
        if let Err(error) = write_sources(root, &sources) {
            for saved in saved_scenarios {
                let _ = fs::remove_file(root.join(saved));
            }
            return Err(error);
        }
    }
    Ok(json!({ "assigned": assigned, "skipped": skipped, "warnings": warnings }).to_string())
}

fn screenshot_task(root: &Path, id: &str) -> Result<(), String> {
    let docs = project_path(root, &read_config(root).docs)?;
    if task::find_task(&docs, id)?.kind != "screenshot" {
        return Err(format!("Task is not a screenshot: {id}"));
    }
    Ok(())
}

pub fn capture(root: &Path, id: &str, window_id: &str, inset: u32) -> Result<String, String> {
    let docs = project_path(root, &read_config(root).docs)?;
    let selected = task::find_task(&docs, id)?;
    capture_task(root, &selected, window_id, inset)
}

fn capture_task(
    root: &Path,
    selected: &task::Task,
    window_id: &str,
    inset: u32,
) -> Result<String, String> {
    let id = selected.id.as_str();
    if selected.kind != "screenshot" {
        return Err(format!("Task is not a screenshot: {id}"));
    }
    if inset > 64 {
        return Err("Inset cannot exceed 64 pixels".into());
    }
    // Validate the saved file before capturing so a corrupt configuration is preserved.
    read(root)?;
    let docs = project_path(root, &read_config(root).docs)?;
    let temporary = tempfile::tempdir_in(root).map_err(|error| error.to_string())?;
    let image = super::config::project_path(temporary.path(), &format!("{id}.png"))?;
    let window = window_capture::capture_window(window_id, inset, &image, true, None)?;
    author::record_screenshot_task(root, selected, &image)?;
    save(
        root,
        id,
        CaptureSource::Window {
            title: window.title.clone(),
            inset,
        },
    )?;
    serde_json::to_string(&serde_json::json!({"window": window, "image": docs.join("assets").join(format!("{id}.png"))}))
        .map_err(|error| error.to_string())
}

fn resolve_window<'a>(
    source: &CaptureSource,
    windows: &'a [window_capture::WindowInfo],
) -> Result<&'a window_capture::WindowInfo, String> {
    let CaptureSource::Window { title, .. } = source else {
        return Err("Capture source is not a window".into());
    };
    if window_capture::is_wayland_session() {
        return windows
            .iter()
            .find(|window| window.id == "portal")
            .ok_or_else(|| "Open the system screenshot chooser again".into());
    }
    let matches: Vec<_> = windows
        .iter()
        .filter(|window| window.title == *title)
        .collect();
    match matches.as_slice() {
        [window] => Ok(window),
        [] => Err(format!("保存した撮影元「{title}」が見つかりません。対象画面を開くか、「撮影元を変更」で選び直してください。")),
        _ => Err(format!("撮影元「{title}」が複数あります。「撮影元を変更」で対象を選び直してください。")),
    }
}

pub fn recapture(root: &Path, id: &str) -> Result<String, String> {
    let docs = project_path(root, &read_config(root).docs)?;
    let selected = task::find_task(&docs, id)?;
    recapture_task(root, &selected)
}

pub(crate) fn recapture_task(root: &Path, selected: &task::Task) -> Result<String, String> {
    let id = selected.id.as_str();
    if selected.kind != "screenshot" {
        return Err(format!("Task is not a screenshot: {id}"));
    }
    let source = read(root)?
        .remove(id)
        .ok_or("撮影元が未設定です。対象アプリを開き、「撮影元を選ぶ」で登録してください。Manual Studio自身は自動撮影元にできません。")?;
    match source {
        CaptureSource::Window { inset, .. } => {
            let windows = window_capture::list_windows()?;
            let window = resolve_window(&source, &windows)?;
            capture_task(root, selected, &window.id, inset)
        }
        CaptureSource::Scenario { input } => {
            scenario::validate_capture_task_with_tasks(
                root,
                &input,
                id,
                std::slice::from_ref(selected),
            )?;
            scenario::run_with_tasks(root, &input, std::slice::from_ref(selected))
        }
    }
}

pub fn save_scenario(root: &Path, id: &str, input: &str) -> Result<String, String> {
    screenshot_task(root, id)?;
    scenario::validate_capture_task(root, input, id)?;
    let source = CaptureSource::Scenario {
        input: input.to_string(),
    };
    save(root, id, source.clone())?;
    serde_json::to_string(&source).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assignment_schema_omits_empty_window_ids_rejected_by_agy() {
        let schema = assignment_schema(&["shot".into()], &["window-1".into(), String::new()]);
        let ids = schema["properties"]["assignments"]["items"]["properties"]["window_id"]["enum"]
            .as_array()
            .unwrap();
        assert_eq!(ids, &[json!("window-1")]);
    }

    #[test]
    fn auto_assignments_save_scenarios_and_preserve_existing_sources() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs")).unwrap();
        fs::write(root.path().join("docs/index.md"), "<!-- ai:task id=first-shot kind=screenshot\nFirst screen\n-->\n<!-- ai:task id=second-shot kind=screenshot\nSecond screen\n-->\n<!-- ai:task id=existing-shot kind=screenshot\nExisting screen\n-->\n").unwrap();
        save(
            root.path(),
            "existing-shot",
            CaptureSource::Window {
                title: "Old window".into(),
                inset: 4,
            },
        )
        .unwrap();
        let tasks: Vec<_> = task::tasks(&root.path().join("docs"))
            .unwrap()
            .into_iter()
            .filter(|task| task.id != "existing-shot")
            .collect();
        let windows = vec![window_capture::WindowInfo {
            id: "window-1".into(),
            title: "Target app".into(),
            x: 0,
            y: 0,
            width: 100,
            height: 80,
        }];
        let response = json!({ "assignments": [
            { "task_id": "first-shot", "window_id": "window-1", "steps_json": "[]" },
            { "task_id": "second-shot", "window_id": "window-1", "steps_json": "[{\"wait_ms\":100}]" },
        ] });
        let result: Value = serde_json::from_str(
            &apply_auto_assignments(
                root.path(),
                read(root.path()).unwrap(),
                &tasks,
                &windows,
                &response,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(result["assigned"].as_array().unwrap().len(), 2);
        let sources = read(root.path()).unwrap();
        assert_eq!(sources.len(), 3);
        assert!(
            matches!(&sources["existing-shot"], CaptureSource::Window { title, inset } if title == "Old window" && *inset == 4)
        );
        assert!(
            matches!(&sources["first-shot"], CaptureSource::Window { title, .. } if title == "Target app")
        );
        let CaptureSource::Scenario { input } = &sources["second-shot"] else {
            panic!("scenario source expected")
        };
        scenario::validate_capture_task(root.path(), input, "second-shot").unwrap();
    }

    #[test]
    fn invalid_auto_assignment_does_not_change_saved_sources() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs")).unwrap();
        fs::write(
            root.path().join("docs/index.md"),
            "<!-- ai:task id=shot kind=screenshot\nCapture\n-->\n",
        )
        .unwrap();
        save(
            root.path(),
            "existing",
            CaptureSource::Window {
                title: "Old window".into(),
                inset: 0,
            },
        )
        .unwrap();
        let original = fs::read(root.path().join("manual/capture_sources.json")).unwrap();
        let tasks = task::tasks(&root.path().join("docs")).unwrap();
        let windows = vec![window_capture::WindowInfo {
            id: "window-1".into(),
            title: "Target app".into(),
            x: 0,
            y: 0,
            width: 100,
            height: 80,
        }];
        let response = json!({ "assignments": [
            { "task_id": "shot", "window_id": "window-1", "steps_json": "[]" },
            { "task_id": "shot", "window_id": "window-1", "steps_json": "[]" },
        ] });
        assert!(apply_auto_assignments(
            root.path(),
            read(root.path()).unwrap(),
            &tasks,
            &windows,
            &response
        )
        .is_err());
        assert_eq!(
            fs::read(root.path().join("manual/capture_sources.json")).unwrap(),
            original
        );
    }

    #[test]
    fn automatic_assignment_never_persists_manual_studio_as_the_capture_target() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs")).unwrap();
        fs::write(
            root.path().join("docs/index.md"),
            "<!-- ai:task id=shot kind=screenshot\nCapture the application screen\n-->\n",
        )
        .unwrap();
        save(
            root.path(),
            "shot",
            CaptureSource::Window {
                title: "README.md — Manual Studio".into(),
                inset: 3,
            },
        )
        .unwrap();
        let saved_before = read(root.path()).unwrap();
        let tasks = task::tasks(&root.path().join("docs")).unwrap();
        let windows = vec![window_capture::WindowInfo {
            id: "studio".into(),
            title: "README.md — Manual Studio".into(),
            x: 0,
            y: 0,
            width: 1200,
            height: 800,
        }];
        let result: Value = serde_json::from_str(
            &apply_auto_assignments(
                root.path(),
                saved_before,
                &tasks,
                &windows,
                &json!({ "assignments": [{ "task_id": "shot", "window_id": "studio", "steps_json": "[]" }] }),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(result["assigned"].as_array().unwrap().is_empty());
        assert_eq!(result["skipped"], json!(["shot"]));
        assert!(result["warnings"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("Manual Studio"));
        assert!(
            matches!(read(root.path()).unwrap().get("shot"), Some(CaptureSource::Window { title, inset }) if title.contains("Manual Studio") && *inset == 3)
        );
    }

    #[test]
    fn old_manual_studio_scenarios_are_preserved_and_skipped_by_auto_assignment() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs")).unwrap();
        fs::create_dir_all(root.path().join("manual/scenarios")).unwrap();
        fs::write(
            root.path().join("docs/index.md"),
            "<!-- ai:task id=shot kind=screenshot\nCapture the application screen\n-->\n",
        )
        .unwrap();
        let scenario_path = "manual/scenarios/old.json";
        fs::write(
            root.path().join(scenario_path),
            r#"{"version":1,"platform":"desktop","window":"Manual Studio","steps":[{"screenshot":{"task":"shot"}}]}"#,
        )
        .unwrap();
        let old_source = CaptureSource::Scenario {
            input: scenario_path.into(),
        };
        assert!(targets_manual_studio(root.path(), &old_source));
        let mut original = BTreeMap::new();
        original.insert("shot".into(), old_source);
        write_sources(root.path(), &original).unwrap();
        let tasks = task::tasks(&root.path().join("docs")).unwrap();
        let windows = vec![window_capture::WindowInfo {
            id: "target".into(),
            title: "Target app".into(),
            x: 0,
            y: 0,
            width: 100,
            height: 80,
        }];
        let invalid_response = json!({ "assignments": [
            { "task_id": "shot", "window_id": "target", "steps_json": "[]" },
            { "task_id": "shot", "window_id": "target", "steps_json": "[]" }
        ] });
        assert!(apply_auto_assignments(
            root.path(),
            original.clone(),
            &tasks,
            &windows,
            &invalid_response
        )
        .is_err());
        assert!(targets_manual_studio(
            root.path(),
            read(root.path()).unwrap().get("shot").unwrap()
        ));

        let valid_response = json!({ "assignments": [
            { "task_id": "shot", "window_id": "target", "steps_json": "[]" }
        ] });
        let output: Value = serde_json::from_str(
            &apply_auto_assignments(root.path(), original, &tasks, &windows, &valid_response)
                .unwrap(),
        )
        .unwrap();
        assert!(output["assigned"].as_array().unwrap().is_empty());
        assert_eq!(output["skipped"], json!(["shot"]));
        assert!(output["warnings"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("設定は保持しました"));
        assert!(targets_manual_studio(
            root.path(),
            read(root.path()).unwrap().get("shot").unwrap()
        ));
    }

    #[test]
    fn saved_windows_survive_restart_without_reusing_native_ids() {
        let root = tempfile::tempdir().unwrap();
        save(
            root.path(),
            "shot",
            CaptureSource::Window {
                title: "Settings".into(),
                inset: 8,
            },
        )
        .unwrap();
        let sources = read(root.path()).unwrap();
        let windows = vec![window_capture::WindowInfo {
            id: "new-id".into(),
            title: "Settings".into(),
            x: 0,
            y: 0,
            width: 100,
            height: 80,
        }];
        assert_eq!(
            resolve_window(&sources["shot"], &windows).unwrap().id,
            "new-id"
        );
        let duplicate = vec![windows[0].clone(), windows[0].clone()];
        assert!(resolve_window(&sources["shot"], &duplicate).is_err());
        let other = vec![window_capture::WindowInfo {
            title: "Settings for another app".into(),
            ..windows[0].clone()
        }];
        assert!(resolve_window(&sources["shot"], &other).is_err());
    }

    #[test]
    fn scenario_sources_require_the_requested_screenshot_and_preserve_other_sources() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs")).unwrap();
        fs::write(root.path().join("docs/index.md"), "<!-- ai:task id=shot kind=screenshot\nCapture\n-->\n<!-- ai:task id=other kind=screenshot\nOther\n-->\n").unwrap();
        scenario::save(root.path(), "manual/scenarios/test.json", r#"{"version":1,"platform":"desktop","window":"Settings","steps":[{"screenshot":{"task":"shot"}}]}"#).unwrap();
        save_scenario(root.path(), "shot", "manual/scenarios/test.json").unwrap();
        let original = fs::read(root.path().join("manual/capture_sources.json")).unwrap();
        assert!(save_scenario(root.path(), "other", "manual/scenarios/test.json").is_err());
        assert_eq!(
            original,
            fs::read(root.path().join("manual/capture_sources.json")).unwrap()
        );
        save(
            root.path(),
            "other",
            CaptureSource::Window {
                title: "Other".into(),
                inset: 0,
            },
        )
        .unwrap();
        assert_eq!(read(root.path()).unwrap().len(), 2);
        fs::write(root.path().join("manual/capture_sources.json"), "broken").unwrap();
        assert!(save_scenario(root.path(), "shot", "manual/scenarios/test.json").is_err());
        assert_eq!(
            fs::read_to_string(root.path().join("manual/capture_sources.json")).unwrap(),
            "broken"
        );
    }
}
