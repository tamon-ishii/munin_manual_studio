use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::tempdir_in;

use super::author;
use super::config::{project_path, read_config};
use super::desktop_scenario;
use super::task::{collect_markdown_files, find_task, get_code_block_ranges, is_inside_ranges};

#[derive(Deserialize)]
struct Scenario {
    version: u32,
    #[serde(default)]
    platform: Option<String>,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    window: String,
    steps: Vec<serde_json::Value>,
}

#[derive(Deserialize, Serialize)]
pub(super) struct RunResult {
    pub captured: Vec<String>,
    pub steps: usize,
}

pub fn run(root: &Path, input: &str) -> Result<String, String> {
    run_mode(root, input, true, &[])
}

pub fn test(root: &Path, input: &str) -> Result<String, String> {
    run_mode(root, input, false, &[])
}

pub(crate) fn run_with_tasks(
    root: &Path,
    input: &str,
    selected: &[super::task::Task],
) -> Result<String, String> {
    run_mode(root, input, true, selected)
}

fn run_mode(
    root: &Path,
    input: &str,
    record: bool,
    selected: &[super::task::Task],
) -> Result<String, String> {
    let input_path = if Path::new(input).is_absolute() {
        PathBuf::from(input)
    } else {
        root.join(input)
    };
    let raw = fs::read_to_string(&input_path)
        .map_err(|error| format!("Failed to read scenario {}: {error}", input_path.display()))?;
    let scenario: Scenario =
        serde_json::from_str(&raw).map_err(|error| format!("Invalid scenario JSON: {error}"))?;
    let docs = project_path(root, &read_config(root).docs)?;
    validate_scenario_with_tasks(&scenario, &docs, selected)?;

    if record {
        for step in &scenario.steps {
            if let Some(id) = step.get("screenshot").and_then(|v| v.get("task")).and_then(serde_json::Value::as_str) {
                let task = selected.iter().find(|task| task.id == id).cloned().map(Ok).unwrap_or_else(|| super::task::find_task(&docs, id))?;
                super::task::ensure_unlocked(&task)?;
            }
        }
    }
    let temporary = tempdir_in(root).map_err(|error| error.to_string())?;
    let captured_dir = temporary.path().join("captured");
    let completed = if scenario.platform.as_deref() == Some("desktop") {
        desktop_scenario::run(root, &scenario.window, &scenario.steps, &captured_dir)?
    } else {
        let script = temporary.path().join("scenario_runner.mjs");
        fs::write(&script, include_str!("scenario_runner.mjs"))
            .map_err(|error| error.to_string())?;
        let result = super::agent::run_process(root, "node", &[
            script.to_string_lossy().into_owned(),input_path.to_string_lossy().into_owned(),captured_dir.to_string_lossy().into_owned()
        ])?;
        if !result.status.success() {
            return Err(format!(
                "Scenario failed: {}",
                String::from_utf8_lossy(&result.stderr).trim()
            ));
        }
        serde_json::from_slice::<RunResult>(&result.stdout)
            .map_err(|error| format!("Invalid scenario runner output: {error}"))?
    };
    if completed.steps != scenario.steps.len() {
        return Err("Scenario runner did not complete all steps".into());
    }
    if record {
        for task_id in &completed.captured {
            let image = captured_dir.join(format!("{task_id}.png"));
            if let Some(task) = selected.iter().find(|task| task.id == *task_id) {
                author::record_screenshot_task(root, task, &image)?;
            } else {
                author::record_screenshot(root, task_id, &image)?;
            }
        }
    }
    serde_json::to_string(&completed).map_err(|error| error.to_string())
}

fn validate_scenario(scenario: &Scenario, docs: &Path) -> Result<(), String> {
    validate_scenario_with_tasks(scenario, docs, &[])
}

fn validate_scenario_with_tasks(
    scenario: &Scenario,
    docs: &Path,
    selected: &[super::task::Task],
) -> Result<(), String> {
    if scenario.version != 1 || scenario.steps.is_empty() {
        return Err("Scenario requires version 1 and at least one step".into());
    }
    if scenario.platform.as_deref() == Some("desktop") {
        return desktop_scenario::validate_with_tasks(&scenario.steps, docs, selected);
    }
    if scenario
        .platform
        .as_deref()
        .is_some_and(|platform| platform != "web")
    {
        return Err("Scenario platform must be web or desktop".into());
    }
    if scenario.base_url.trim().is_empty() {
        return Err("Scenario requires version 1, base_url, and at least one step".into());
    }
    if !["http://", "https://", "file://"]
        .iter()
        .any(|prefix| scenario.base_url.starts_with(prefix))
    {
        return Err("Scenario base_url must use http, https, or file".into());
    }
    let id_pattern = Regex::new(r"^[a-z][a-z0-9_-]*$").unwrap();
    for (index, step) in scenario.steps.iter().enumerate() {
        let object = step
            .as_object()
            .ok_or_else(|| format!("Scenario step {} must be an object", index + 1))?;
        if object.len() != 1 {
            return Err(format!(
                "Scenario step {} must contain one action",
                index + 1
            ));
        }
        if let Some(screenshot) = object.get("screenshot") {
            let task_id = screenshot
                .get("task")
                .and_then(|value| value.as_str())
                .ok_or_else(|| format!("Scenario screenshot {} needs a task ID", index + 1))?;
            if !id_pattern.is_match(task_id) {
                return Err(format!("Invalid scenario screenshot task ID: {task_id}"));
            }
            let task = selected
                .iter()
                .find(|task| task.id == task_id)
                .cloned()
                .map(Ok)
                .unwrap_or_else(|| find_task(docs, task_id))?;
            if task.kind != "screenshot" {
                return Err(format!("Scenario task is not a screenshot: {task_id}"));
            }
            if screenshot
                .get("selector")
                .is_some_and(|value| value.as_str().is_none_or(str::is_empty))
            {
                return Err(format!(
                    "Scenario screenshot {} has an invalid selector",
                    index + 1
                ));
            }
        } else if let Some(fill) = object.get("fill") {
            if fill
                .get("selector")
                .and_then(|value| value.as_str())
                .is_none_or(str::is_empty)
                || fill.get("value").and_then(|value| value.as_str()).is_none()
            {
                return Err(format!(
                    "Scenario fill {} needs selector and value strings",
                    index + 1
                ));
            }
        } else if let Some((_, value)) = object.iter().next() {
            if !["goto", "click", "expect_visible"]
                .iter()
                .any(|key| object.contains_key(*key))
                || value.as_str().is_none_or(str::is_empty)
            {
                return Err(format!(
                    "Unsupported or invalid scenario step {}",
                    index + 1
                ));
            }
        }
    }

    Ok(())
}

pub fn save(root: &Path, input: &str, json: &str) -> Result<String, String> {
    save_with_tasks(root, input, json, &[])
}

pub(crate) fn save_with_tasks(
    root: &Path,
    input: &str,
    json: &str,
    selected: &[super::task::Task],
) -> Result<String, String> {
    if !input.starts_with("manual/scenarios/") || !input.ends_with(".json") {
        return Err("Scenario files must be under manual/scenarios/ with a .json extension".into());
    }
    let destination = project_path(root, input)?;
    let scenario: Scenario =
        serde_json::from_str(json).map_err(|error| format!("Invalid scenario JSON: {error}"))?;
    let docs = project_path(root, &read_config(root).docs)?;
    validate_scenario_with_tasks(&scenario, &docs, selected)?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let normalized: serde_json::Value =
        serde_json::from_str(json).map_err(|error| error.to_string())?;
    let formatted = serde_json::to_string_pretty(&normalized).map_err(|error| error.to_string())?;
    fs::write(&destination, formatted).map_err(|error| error.to_string())?;
    Ok(destination.display().to_string())
}

pub(crate) fn validate_json(root: &Path, json: &str) -> Result<(), String> {
    validate_json_with_tasks(root, json, &[])
}

pub(crate) fn validate_json_with_tasks(
    root: &Path,
    json: &str,
    selected: &[super::task::Task],
) -> Result<(), String> {
    let scenario: Scenario =
        serde_json::from_str(json).map_err(|error| format!("Invalid scenario JSON: {error}"))?;
    let docs = project_path(root, &read_config(root).docs)?;
    validate_scenario_with_tasks(&scenario, &docs, selected)
}

pub fn load(root: &Path, input: &str) -> Result<String, String> {
    if !input.starts_with("manual/scenarios/") || !input.ends_with(".json") {
        return Err("Scenario files must be under manual/scenarios/ with a .json extension".into());
    }
    let path = project_path(root, input)?;
    fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read scenario {}: {error}", path.display()))
}

pub(super) fn validate_capture_task(root: &Path, input: &str, id: &str) -> Result<(), String> {
    validate_capture_task_with_tasks(root, input, id, &[])
}

pub(crate) fn validate_capture_task_with_tasks(
    root: &Path,
    input: &str,
    id: &str,
    selected: &[super::task::Task],
) -> Result<(), String> {
    let raw = load(root, input)?;
    let scenario: Scenario =
        serde_json::from_str(&raw).map_err(|error| format!("Invalid scenario JSON: {error}"))?;
    let docs = project_path(root, &read_config(root).docs)?;
    validate_scenario_with_tasks(&scenario, &docs, selected)?;
    if !scenario.steps.iter().any(|step| {
        step.get("screenshot")
            .and_then(|shot| shot.get("task"))
            .and_then(serde_json::Value::as_str)
            == Some(id)
    }) {
        return Err(format!("シナリオに撮影タスク「{id}」がありません。screenshot の task に同じ ID を指定してください。"));
    }
    Ok(())
}

pub fn link(root: &Path, input: &str, page: &str) -> Result<String, String> {
    if !input.starts_with("manual/scenarios/") || !input.ends_with(".json") {
        return Err("Scenario files must be under manual/scenarios/ with a .json extension".into());
    }
    let scenario = project_path(root, input)?;
    if !scenario.is_file() {
        return Err(format!("Scenario does not exist: {input}"));
    }
    let docs = project_path(root, &read_config(root).docs)?;
    let raw = fs::read_to_string(&scenario).map_err(|error| error.to_string())?;
    let parsed: Scenario =
        serde_json::from_str(&raw).map_err(|error| format!("Invalid scenario JSON: {error}"))?;
    validate_scenario(&parsed, &docs)?;
    let page_path = project_path(&docs, page)?;
    if !page_path.is_file() || page_path.extension().is_none_or(|ext| ext != "md") {
        return Err(format!("Manual page does not exist: {page}"));
    }
    let mut content = fs::read_to_string(&page_path).map_err(|error| error.to_string())?;
    let directive = format!("<!-- ai:scenario file={input} -->");
    if !content.contains(&directive) {
        if !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&format!("\n{directive}\n"));
        fs::write(page_path, content).map_err(|error| error.to_string())?;
    }
    Ok(directive)
}

#[derive(Serialize)]
struct ScenarioCheck {
    page: String,
    file: String,
    steps: usize,
}

pub fn test_manual(root: &Path) -> Result<String, String> {
    let docs = project_path(root, &read_config(root).docs)?;
    let directive = Regex::new(r"<!--\s*ai:scenario\s+file=([^\s>]+)\s*-->").unwrap();
    let mut passed = Vec::new();
    for page in collect_markdown_files(&docs) {
        let content = fs::read_to_string(&page).map_err(|error| error.to_string())?;
        let code_blocks = get_code_block_ranges(&content);
        let page_rel = page
            .strip_prefix(&docs)
            .unwrap_or(&page)
            .to_string_lossy()
            .to_string();
        for found in directive.captures_iter(&content) {
            let full = found.get(0).unwrap();
            if is_inside_ranges(&(full.start()..full.end()), &code_blocks) {
                continue;
            }
            let file = &found[1];
            let absolute = project_path(root, file)?;
            if !absolute.is_file() {
                return Err(format!("Scenario for {page_rel} does not exist: {file}"));
            }
            let output = test(root, file)
                .map_err(|error| format!("Scenario for {page_rel} failed ({file}): {error}"))?;
            let result: RunResult =
                serde_json::from_str(&output).map_err(|error| error.to_string())?;
            passed.push(ScenarioCheck {
                page: page_rel.clone(),
                file: file.to_string(),
                steps: result.steps,
            });
        }
    }
    serde_json::to_string_pretty(&serde_json::json!({"total": passed.len(), "passed": passed}))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::save;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn invalid_scenario_is_not_saved() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("docs/index.md"), "# Guide\n").unwrap();
        let error = save(
            root,
            "manual/scenarios/broken.json",
            r#"{"version":1,"base_url":"http://localhost:3000/","steps":[{"click":""}]}"#,
        )
        .unwrap_err();
        assert!(error.contains("invalid scenario step"));
        assert!(!root.join("manual/scenarios/broken.json").exists());
    }

    #[test]
    fn desktop_scenario_can_be_saved_without_web_url() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(
            root.join("docs/index.md"),
            "<!-- ai:task id=settings-shot kind=screenshot\nSettings window\n-->\n",
        )
        .unwrap();
        let saved = save(
            root,
            "manual/scenarios/settings.json",
            r#"{"version":1,"platform":"desktop","steps":[{"window":"Settings"},{"screenshot":{"task":"settings-shot"}}]}"#,
        )
        .unwrap();
        assert_eq!(
            saved,
            root.join("manual/scenarios/settings.json")
                .canonicalize().unwrap()
                .display()
                .to_string()
        );
    }
}
