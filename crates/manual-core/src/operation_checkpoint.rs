//! Persist one operation at a time so completed input is never replayed on resume.
use crate::scenario::RunResult;
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};

pub(crate) fn trace(output: &Path) -> Value {
    fs::read(output.join("checkpoint.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .map(|v| v["trace"].clone())
        .unwrap_or(json!([]))
}
pub(crate) fn save(output: &Path, value: &Value) -> Result<(), String> {
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new_in(output).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.persist(output.join("checkpoint.json"))
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub(crate) fn run(
    root: &Path,
    id: &str,
    steps: &[Value],
    output: &Path,
) -> Result<RunResult, String> {
    run_with(root, id, steps, output, |root, id, steps, output| {
        crate::desktop_scenario::run(root, id, steps, output)
    })
}
fn run_with(
    root: &Path,
    id: &str,
    steps: &[Value],
    output: &Path,
    mut execute: impl FnMut(&Path, &str, &[Value], &Path) -> Result<RunResult, String>,
) -> Result<RunResult, String> {
    let mut state: Value = serde_json::from_slice(
        &fs::read(output.join("checkpoint.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let start = state["next_step"].as_u64().ok_or("Invalid checkpoint")? as usize;
    if start > steps.len() {
        return Err("Invalid checkpoint position".into());
    }
    let checkpoint = crate::agent::cancellation_checkpoint(root);
    let started = Instant::now();
    for (index, step) in steps.iter().enumerate().skip(start) {
        crate::agent::check_cancelled(root, &checkpoint)?;
        if started.elapsed() > Duration::from_secs(300) {
            return Err("操作の実行時間が5分を超えました。".into());
        }
        let entry = json!({"step":index,"action":step,"status":"running"});
        let trace = state["trace"].as_array_mut().ok_or("Invalid trace")?;
        trace.retain(|item| item["step"].as_u64() != Some(index as u64));
        trace.push(entry);
        save(output, &state)?;
        crate::agent::log_exchange(
            root,
            "operation",
            "操作を実行",
            &json!({"step":index,"action":step}),
        );
        let mut single = vec![json!({"window":id})];
        if !step.get("window").is_some() {
            single.push(step.clone());
        }
        let result = execute(root, id, &single, output);
        let entry = state["trace"].as_array_mut().unwrap().last_mut().unwrap();
        match result {
            Ok(result) => {
                if result.steps != single.len() {
                    return Err("操作が完了していません。".into());
                }
                entry["status"] = json!("completed");
                entry["captures"] = json!(result.captured);
                state["next_step"] = json!(index + 1);
                save(output, &state)?;
                crate::agent::log_exchange(
                    root,
                    "operation_result",
                    "操作・状態確認が完了",
                    &json!({"step":index,"action":step}),
                );
            }
            Err(error) => {
                entry["status"] = json!("failed");
                entry["error"] = json!(error);
                save(output, &state)?;
                return Err(format!("手順{index}で停止: {error}"));
            }
        }
        if started.elapsed() > Duration::from_secs(300) {
            return Err("操作の実行時間が5分を超えました。".into());
        }
    }
    let captures = state["trace"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|entry| {
            entry["captures"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    Ok(RunResult {
        steps: steps.len(),
        captured: captures,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resume_skips_completed_input_and_retries_only_the_failed_step() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("run");
        fs::create_dir(&output).unwrap();
        save(&output, &json!({"next_step":0,"trace":[]})).unwrap();
        let steps = vec![
            json!({"window":"fixture"}),
            json!({"click":{"x":1,"y":2}}),
            json!({"text":"hello"}),
            json!({"screenshot":{"task":"shot"}}),
        ];
        let mut actions = Vec::new();
        let error = run_with(
            root.path(),
            "fixture",
            &steps,
            &output,
            |_, _, single, _| {
                let action = single
                    .last()
                    .unwrap()
                    .as_object()
                    .unwrap()
                    .keys()
                    .next()
                    .unwrap()
                    .clone();
                actions.push(action.clone());
                if action == "text" {
                    Err("fixture failure".into())
                } else {
                    Ok(RunResult {
                        steps: single.len(),
                        captured: vec![],
                    })
                }
            },
        )
        .err()
        .unwrap();
        assert!(error.contains("手順2"));
        assert_eq!(actions, vec!["window", "click", "text"]);
        let mut resumed = Vec::new();
        let result = run_with(
            root.path(),
            "fixture",
            &steps,
            &output,
            |_, _, single, _| {
                let action = single
                    .last()
                    .unwrap()
                    .as_object()
                    .unwrap()
                    .keys()
                    .next()
                    .unwrap()
                    .clone();
                resumed.push(action.clone());
                Ok(RunResult {
                    steps: single.len(),
                    captured: if action == "screenshot" {
                        vec!["shot".into()]
                    } else {
                        vec![]
                    },
                })
            },
        )
        .unwrap();
        assert_eq!(resumed, vec!["text", "screenshot"]);
        assert_eq!(result.captured, vec!["shot"]);
        assert!(trace(&output)
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["status"] == "completed"));
    }
    #[test]
    fn cancellation_does_not_execute_the_next_operation() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("run");
        fs::create_dir(&output).unwrap();
        save(&output, &json!({"next_step":0,"trace":[]})).unwrap();
        let steps = vec![json!({"window":"fixture"}), json!({"text":"must-not-run"})];
        let mut count = 0;
        assert!(run_with(
            root.path(),
            "fixture",
            &steps,
            &output,
            |_, _, single, _| {
                count += 1;
                crate::agent::cancel(root.path()).unwrap();
                Ok(RunResult {
                    steps: single.len(),
                    captured: vec![],
                })
            }
        )
        .is_err());
        assert_eq!(count, 1);
    }
}
