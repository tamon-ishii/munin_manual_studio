//! Compile AI-authored steps into the same recording metadata used by MarkIts.
use crate::{config::project_path, desktop_scenario, task::Task};
use markits::recording::{OperationRecording, RecordedEvent};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeSet, fs, io::Write, path::Path};

const OPERATIONS_KEY: &str = "markits:operations";

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Window {
    title: String,
    bounds: [i64; 4],
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Script {
    version: u32,
    window: Window,
    steps: Vec<Step>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Step {
    Click {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<crate::semantic_target::Target>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        x: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        y: Option<f64>,
    },
    Text {
        value: String,
    },
    Key {
        value: String,
    },
    Scroll {
        x: f64,
        y: f64,
        dx: i64,
        dy: i64,
    },
    Wait {
        milliseconds: u64,
    },
    WaitFor {
        target: crate::semantic_target::Target,
        state: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<String>,
        #[serde(default = "default_condition_timeout")]
        timeout_ms: u64,
    },
    Screenshot {
        name: String,
        #[serde(default)]
        include_cursor: bool,
    },
}

struct Plan {
    script: Script,
    recording: OperationRecording,
    captures: Vec<(String, usize)>,
}
fn default_condition_timeout() -> u64 {
    10_000
}

fn chord(value: &str) -> Result<String, String> {
    let parts: Vec<_> = value.split('+').map(str::trim).collect();
    if parts.is_empty() || parts.len() > 5 {
        return Err("Invalid key chord".into());
    }
    let mut keys = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        let lower = part.to_ascii_lowercase();
        let modifier = match lower.as_str() {
            "ctrl" | "control" => Some("Control"),
            "alt" => Some("Alt"),
            "shift" => Some("Shift"),
            "meta" | "cmd" | "win" => Some("Meta"),
            _ => None,
        };
        let key = if index + 1 < parts.len() {
            modifier
                .ok_or("Only modifiers may precede the final key")?
                .to_string()
        } else {
            if modifier.is_some() {
                return Err("A key chord needs a final non-modifier key".into());
            }
            match lower.as_str() {
                "enter" | "escape" | "tab" | "backspace" | "delete" | "space" | "up" | "down"
                | "left" | "right" => lower,
                _ if lower.len() == 1 && lower.bytes().all(|b| b.is_ascii_alphanumeric()) => lower,
                _ if lower
                    .strip_prefix('f')
                    .and_then(|n| n.parse::<u8>().ok())
                    .is_some_and(|n| (1..=12).contains(&n)) =>
                {
                    lower
                }
                _ => return Err(format!("Unsupported key: {part}")),
            }
        };
        if keys.contains(&key) {
            return Err("Duplicate modifier in key chord".into());
        }
        keys.push(key);
    }
    Ok(keys.join("+"))
}

fn point(window: &Window, x: f64, y: f64) -> Result<(f64, f64), String> {
    if !x.is_finite()
        || !y.is_finite()
        || x < 0.0
        || y < 0.0
        || x >= window.bounds[2] as f64
        || y >= window.bounds[3] as f64
    {
        return Err(
            "Coordinates must be inside the observed window (relative to its top-left)".into(),
        );
    }
    Ok((window.bounds[0] as f64 + x, window.bounds[1] as f64 + y))
}

fn compile(value: &Value) -> Result<Plan, String> {
    let mut script: Script = serde_json::from_value(value.clone())
        .map_err(|e| format!("Invalid operation script: {e}"))?;
    if script.version != 1
        || script.window.title.trim().is_empty()
        || script.window.title.len() > 4096
    {
        return Err("Specify version 1 and the exact observed window title".into());
    }
    let [x, y, width, height] = script.window.bounds;
    if width <= 0
        || height <= 0
        || width > 32768
        || height > 32768
        || x.abs_diff(0) > i32::MAX as u64
        || y.abs_diff(0) > i32::MAX as u64
    {
        return Err("Invalid observed window bounds".into());
    }
    if script.steps.is_empty() || script.steps.len() > 500 {
        return Err("Specify 1–500 operation steps".into());
    }
    let mut events = Vec::new();
    let mut captures = Vec::new();
    let mut names = BTreeSet::new();
    let mut elapsed_ms = 0_u64;
    for (index, step) in script.steps.iter_mut().enumerate() {
        let event = match step {
            Step::Click { target, x, y } => {
                let (x, y) = if let Some(target) = target.as_ref() {
                    target.validate()?;
                    if x.is_some() || y.is_some() {
                        return Err("A click must specify a named target OR coordinates".into());
                    }
                    (
                        script.window.bounds[0] as f64,
                        script.window.bounds[1] as f64,
                    )
                } else {
                    point(
                        &script.window,
                        x.ok_or("Click needs x and y or target")?,
                        y.ok_or("Click needs x and y or target")?,
                    )?
                };
                RecordedEvent::Click {
                    elapsed_ms,
                    x,
                    y,
                    target: target.clone(),
                    visual: None,
                }
            }
            Step::Text { value } => {
                if value.trim().is_empty() || value.len() > 100_000 || value.contains('\0') {
                    return Err("Invalid text input".into());
                }
                RecordedEvent::Text {
                    elapsed_ms,
                    value: value.clone(),
                }
            }
            Step::Key { value } => {
                *value = chord(value)?;
                RecordedEvent::Key {
                    elapsed_ms,
                    value: value.clone(),
                }
            }
            Step::Scroll { x, y, dx, dy } => {
                let (x, y) = point(&script.window, *x, *y)?;
                if dx.abs_diff(0) > i32::MAX as u64 || dy.abs_diff(0) > i32::MAX as u64 {
                    return Err("Invalid scroll delta".into());
                }
                RecordedEvent::Scroll {
                    elapsed_ms,
                    x,
                    y,
                    dx: *dx,
                    dy: *dy,
                }
            }
            Step::Wait { milliseconds } => {
                if *milliseconds > 30_000 {
                    return Err("Each wait must be 0–30000 ms".into());
                }
                elapsed_ms = elapsed_ms
                    .checked_add(*milliseconds)
                    .ok_or("Wait overflow")?;
                if elapsed_ms > 300_000 {
                    return Err("Total waits exceed five minutes".into());
                }
                continue;
            }
            Step::WaitFor {
                target,
                state,
                value,
                timeout_ms,
            } => {
                target.validate()?;
                if !matches!(state.as_str(), "visible" | "hidden" | "value")
                    || !(1..=30_000).contains(timeout_ms)
                    || (state == "value" && value.is_none())
                    || (state != "value" && value.is_some())
                {
                    return Err("wait_for requires visible/hidden or value with an expected string, and a 1–30000 ms timeout".into());
                }
                continue;
            }
            Step::Screenshot {
                name,
                include_cursor,
            } => {
                if name.len() > 64
                    || !name.starts_with(|c: char| c.is_ascii_lowercase())
                    || !name.bytes().all(|b| {
                        b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_'
                    })
                    || !names.insert(name.clone())
                {
                    return Err(
                        "Screenshot names must be unique lowercase identifiers (max 64 characters)"
                            .into(),
                    );
                }
                captures.push((name.clone(), index));
                RecordedEvent::Screenshot {
                    elapsed_ms,
                    include_cursor: *include_cursor,
                    pointer: None,
                }
            }
        };
        events.push(event);
    }
    if captures.is_empty() {
        return Err("At least one screenshot step is required".into());
    }
    let recording = OperationRecording {
        version: 1,
        window: script.window.title.clone(),
        bounds: script.window.bounds,
        events,
    };
    Ok(Plan {
        script,
        recording,
        captures,
    })
}

fn saved(recording: &OperationRecording) -> Value {
    // Empty native identity deliberately uses MarkIts' unique-title rebinding.
    json!({"recording":recording,"window_id":"","pid":0})
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())
}

pub(crate) fn schema() -> Value {
    serde_json::from_str(include_str!("operation_script.schema.json"))
        .expect("bundled operation script schema")
}

pub(crate) fn execute(root: &Path, action: &str, request: &Value) -> Result<Value, String> {
    if action == "operations-schema" {
        return Ok(
            json!({"schema":schema(),"coordinate_space":"window-relative pixels","execution":"operations-run; or operations-attach then MarkIts recapture","max_steps":500}),
        );
    }
    if action == "operations-inspect" {
        let path = project_path(root, request["image"].as_str().ok_or("image is required")?)?;
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        if request["script_only"] == true {
            let raw = markits::raster::read_png_text_chunk(&bytes, "markits:operation_script")
                .map_err(|e| e.to_string())?
                .ok_or("This PNG has no condition-aware Studio script")?;
            return serde_json::from_str(&raw).map_err(|e| e.to_string());
        }
        let raw = markits::raster::read_png_text_chunk(&bytes, OPERATIONS_KEY)
            .map_err(|e| e.to_string())?
            .ok_or("No MarkIts recording in this PNG")?;
        return serde_json::from_str(&raw).map_err(|e| e.to_string());
    }
    let plan = compile(
        request
            .get("script")
            .ok_or("script is required; use operations-schema first")?,
    )?;
    match action {
        "operations-validate" => Ok(
            json!({"valid":true,"script":plan.script,"saved_recording":saved(&plan.recording),"captures":plan.captures.iter().map(|(name,_)|name).collect::<Vec<_>>()}),
        ),
        "operations-attach" => {
            let input = project_path(root, request["image"].as_str().ok_or("image is required")?)?;
            let output = project_path(
                root,
                request["output"].as_str().ok_or("output is required")?,
            )?;
            if output.extension().and_then(|e| e.to_str()) != Some("png") {
                return Err("Output must be a PNG".into());
            }
            let bytes = fs::read(input).map_err(|e| e.to_string())?;
            image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
                .map_err(|e| e.to_string())?;
            let bytes = markits::raster::embed_png_text_chunk(
                &bytes,
                OPERATIONS_KEY,
                &saved(&plan.recording).to_string(),
            )
            .map_err(|e| e.to_string())?;
            let bytes = markits::raster::embed_png_text_chunk(
                &bytes,
                "markits:operation_group",
                &crate::screenshots::new_id("script"),
            )
            .map_err(|e| e.to_string())?;
            let bytes = markits::raster::embed_png_text_chunk(
                &bytes,
                "markits:operation_script",
                &serde_json::to_string(&plan.script).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            write_new(&output, &bytes)?;
            Ok(
                json!({"output":request["output"],"captures":plan.captures.len(),"replay":"Open this PNG in MarkIts and use recapture"}),
            )
        }
        "operations-run" | "operations-resume" => {
            let mut request = request.clone();
            if action == "operations-resume" {
                request["resume"] = json!(true);
            }
            run(root, &request, &plan)
        }
        _ => Err(format!("Unknown operation script action: {action}")),
    }
}

fn runtime_steps(
    plan: &Plan,
    window: &markits::window_capture::WindowInfo,
) -> Result<Vec<Value>, String> {
    let coordinates = |x: f64, y: f64| -> Result<(i64, i64), String> {
        // The desktop runner accepts window-relative coordinates; it adds the
        // current screen origin itself, including negative-origin monitors.
        let x = (x / plan.script.window.bounds[2] as f64 * window.width as f64)
            .round()
            .clamp(0.0, window.width.saturating_sub(1) as f64) as i64;
        let y = (y / plan.script.window.bounds[3] as f64 * window.height as f64)
            .round()
            .clamp(0.0, window.height.saturating_sub(1) as f64) as i64;
        Ok((x, y))
    };
    let mut steps = vec![json!({"window":window.id})];
    for step in &plan.script.steps {
        steps.push(match step {
            Step::Click {target:Some(target),..} => json!({"click":{"target":target}}),
            Step::Click {x:Some(x),y:Some(y),..} => {let (x,y) = coordinates(*x,*y)?;json!({"click":{"x":x,"y":y}})},
            Step::Click {..} => return Err("Invalid click".into()),
            Step::Text {value} => json!({"text":value}),
            Step::Key {value} => json!({"key":value}),
            Step::Scroll {x,y,dx,dy} => {let (x,y) = coordinates(*x,*y)?;json!({"scroll":{"x":x,"y":y,"dx":dx,"dy":dy}})},
            Step::Wait {milliseconds} => json!({"wait_ms":milliseconds}),
            Step::WaitFor {target,state,value,timeout_ms} => json!({"wait_target":{"target":target,"state":state,"value":value,"timeout_ms":timeout_ms}}),
            Step::Screenshot {name,include_cursor} => {
                if *include_cursor {return Err("Direct execution currently captures without the cursor; use include_cursor:false or MarkIts playback".into());}
                json!({"screenshot":{"task":name}})
            }
        });
    }
    Ok(steps)
}

fn run(root: &Path, request: &Value, plan: &Plan) -> Result<Value, String> {
    let id = request["window"]
        .as_str()
        .ok_or("Choose a current window ID from windows first")?;
    let window = markits::window_capture::list_windows()?
        .into_iter()
        .find(|window| window.id == id)
        .ok_or("Target window no longer exists")?;
    if window.title != plan.script.window.title {
        return Err("The window title differs from the observed script target".into());
    }
    run_with(
        root,
        request,
        plan,
        &window,
        crate::operation_checkpoint::run,
    )
}

fn run_with(
    root: &Path,
    request: &Value,
    plan: &Plan,
    window: &markits::window_capture::WindowInfo,
    runner: impl FnOnce(&Path, &str, &[Value], &Path) -> Result<crate::scenario::RunResult, String>,
) -> Result<Value, String> {
    let steps = runtime_steps(plan, &window)?;
    let tasks: Vec<_> = plan
        .captures
        .iter()
        .map(|(id, _)| Task {
            id: id.clone(),
            name: String::new(),
            kind: "screenshot".into(),
            page: String::new(),
            prompt: String::new(),
            source_sha256: String::new(),
            status: "pending".into(),
        })
        .collect();
    desktop_scenario::validate_with_tasks(&steps, root, &tasks)?;
    let relative = request["output"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("output must name a new run directory")?;
    let output = project_path(root, relative)?;
    let _lock = crate::workflow::resource_lock(root, ".munin/operation-script")?;
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if request["resume"] == true {
        let previous: Value = serde_json::from_slice(
            &fs::read(output.join("checkpoint.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        if request["retry_failed"] != true {
            return Err(
                "対象の状態を確認してから、失敗した手順の再実行を指定してください。".into(),
            );
        }
        let done = previous["next_step"]
            .as_u64()
            .ok_or("Invalid checkpoint")?
            .saturating_sub(1) as usize;
        let current = serde_json::to_value(&plan.script).map_err(|e| e.to_string())?;
        let old = previous["script"]["steps"]
            .as_array()
            .ok_or("Invalid stored script")?;
        let new = current["steps"].as_array().unwrap();
        if done > old.len()
            || done > new.len()
            || old[..done] != new[..done]
            || previous["script"]["window"]["bounds"] != current["window"]["bounds"]
        {
            return Err(
                "完了した操作や観察時の座標は変更できません。新しい実行として開始してください。"
                    .into(),
            );
        }
        let mut previous = previous;
        previous["script"] = current;
        crate::operation_checkpoint::save(&output, &previous)?;
    } else {
        fs::create_dir(&output).map_err(|e| format!("Choose a new output directory: {e}"))?;
        fs::write(
            output.join("checkpoint.json"),
            json!({"script":plan.script,"next_step":0,"trace":[]}).to_string(),
        )
        .map_err(|e| e.to_string())?;
    }
    fs::write(output.join("run.json"),json!({"ok":false,"status":"running","run":format!("{relative}/run.json"),"window":window.id,"script":plan.script,"captures":[],"error":"処理が中断された可能性があります。対象の状態を確認して再開してください。"}).to_string()).map_err(|e|e.to_string())?;
    let completed = (|| {
        let result = runner(root, &window.id, &steps, &output)?;
        if result.steps != steps.len() {
            return Err("The operation runner did not complete every step".into());
        }
        let mut captures = Vec::new();
        let group = crate::screenshots::new_id("script");
        for (name, index) in &plan.captures {
            if !result.captured.contains(name) {
                return Err(format!("Screenshot was not produced: {name}"));
            }
            let prefix = Script {
                steps: plan.script.steps[..=*index].to_vec(),
                ..plan.script.clone()
            };
            let prefix = compile(&serde_json::to_value(prefix).map_err(|e| e.to_string())?)?;
            let path = output.join(format!("{name}.png"));
            let bytes = fs::read(&path).map_err(|e| e.to_string())?;
            let bytes = markits::raster::embed_png_text_chunk(
                &bytes,
                OPERATIONS_KEY,
                &saved(&prefix.recording).to_string(),
            )
            .map_err(|e| e.to_string())?;
            let bytes = markits::raster::embed_png_text_chunk(
                &bytes,
                "markits:operation_script",
                &serde_json::to_string(&prefix.script).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let bytes =
                markits::raster::embed_png_text_chunk(&bytes, "markits:operation_group", &group)
                    .map_err(|e| e.to_string())?;
            fs::write(path, bytes).map_err(|e| e.to_string())?;
            captures
                .push(json!({"name":name,"step":index+1,"image":format!("{relative}/{name}.png")}));
        }
        Ok(
            json!({"ok":true,"window":window.id,"run":format!("{relative}/run.json"),"script":plan.script,"steps":plan.script.steps.len(),"captures":captures,"trace":crate::operation_checkpoint::trace(&output)}),
        )
    })();
    let manifest = match completed {
        Ok(manifest) => manifest,
        Err(error) => {
            let partial:Vec<_>=plan.captures.iter().filter(|(name,_)|output.join(format!("{name}.png")).is_file()).map(|(name,index)|json!({"name":name,"step":index+1,"image":format!("{relative}/{name}.png")})).collect();
            let failure = json!({"ok":false,"window":window.id,"run":format!("{relative}/run.json"),"error":error,"script":plan.script,"captures":partial,"trace":crate::operation_checkpoint::trace(&output)});
            fs::write(output.join("run.json"), failure.to_string()).map_err(|e| e.to_string())?;
            if request["return_failure"] == true {
                return Ok(failure);
            }
            return Err(format!("{error}; partial results: {relative}/run.json"));
        }
    };
    fs::write(
        output.join("run.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script() -> Value {
        json!({"version":1,"window":{"title":"Fixture","bounds":[100,200,800,600]},"steps":[
            {"kind":"click","target":{"role":"button","name":"Open"}},
            {"kind":"text","value":"Sample"},
            {"kind":"key","value":"Ctrl+a"},
            {"kind":"wait","milliseconds":500},
            {"kind":"screenshot","name":"step-one"},
            {"kind":"click","x":40,"y":50},
            {"kind":"screenshot","name":"step-two"}
        ]})
    }

    #[test]
    fn compiles_to_native_markits_recording_and_keeps_waits() {
        let plan = compile(&script()).unwrap();
        assert_eq!(plan.captures.len(), 2);
        let stored = saved(&plan.recording);
        let native: OperationRecording =
            serde_json::from_value(stored["recording"].clone()).unwrap();
        assert_eq!(native.events.len(), 6);
        assert!(matches!(&native.events[2], RecordedEvent::Key {value,..} if value == "Control+a"));
        assert!(matches!(
            native.events[3],
            RecordedEvent::Screenshot {
                elapsed_ms: 500,
                ..
            }
        ));
        assert!(matches!(
            native.events[4],
            RecordedEvent::Click {
                x: 140.0,
                y: 250.0,
                ..
            }
        ));
        assert_eq!(stored["window_id"], "");
        assert_eq!(stored["pid"], 0);
    }

    #[test]
    fn resume_rejects_completed_edits_and_condition_script_roundtrips() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("run");
        fs::create_dir(&output).unwrap();
        let mut original = script();
        original["steps"].as_array_mut().unwrap().insert(1,json!({"kind":"wait_for","target":{"role":"button","name":"Open"},"state":"visible","timeout_ms":1000}));
        let original = compile(&original).unwrap();
        crate::operation_checkpoint::save(
            &output,
            &json!({"script":original.script,"next_step":2,"trace":[]}),
        )
        .unwrap();
        let window = markits::window_capture::WindowInfo {
            id: "fixture".into(),
            title: "Fixture".into(),
            x: 100,
            y: 200,
            width: 800,
            height: 600,
        };
        let mut edited = serde_json::to_value(&original.script).unwrap();
        edited["steps"][0]["target"]["name"] = json!("Other");
        let edited = compile(&edited).unwrap();
        assert!(run_with(
            root.path(),
            &json!({"output":"run","resume":true,"retry_failed":true}),
            &edited,
            &window,
            |_, _, _, _| panic!("must not replay changed completed input")
        )
        .is_err());
        image::DynamicImage::new_rgb8(20, 10)
            .save(root.path().join("source.png"))
            .unwrap();
        execute(
            root.path(),
            "operations-attach",
            &json!({"script":original.script,"image":"source.png","output":"with-conditions.png"}),
        )
        .unwrap();
        let inspected = execute(
            root.path(),
            "operations-inspect",
            &json!({"image":"with-conditions.png","script_only":true}),
        )
        .unwrap();
        assert_eq!(inspected["steps"][1]["kind"], "wait_for");
        for bad in [
            json!({"kind":"wait_for","target":{"role":"button","name":"Open"},"state":"value"}),
            json!({"kind":"wait_for","target":{"role":"button","name":"Open"},"state":"visible","timeout_ms":30001}),
        ] {
            let mut value = script();
            value["steps"].as_array_mut().unwrap().push(bad);
            assert!(compile(&value).is_err());
        }
    }

    #[test]
    fn validates_every_step_before_execution_or_output_creation() {
        let root = tempfile::tempdir().unwrap();
        for invalid in [
            json!({"kind":"launch","program":"anything"}),
            json!({"kind":"click","target":{"role":"button","name":"Open"},"x":1,"y":1}),
            json!({"kind":"click","x":800,"y":0}),
            json!({"kind":"key","value":"Control+Unknown"}),
            json!({"kind":"key","value":"a+enter"}),
            json!({"kind":"key","value":"Control+Control+a"}),
            json!({"kind":"wait","milliseconds":30001}),
            json!({"kind":"text","value":""}),
            json!({"kind":"screenshot","name":"../escape"}),
            json!({"kind":"screenshot","name":"step-one"}),
        ] {
            let mut bad = script();
            bad["steps"].as_array_mut().unwrap().push(invalid);
            let result = execute(
                root.path(),
                "operations-run",
                &json!({"script":bad,"window":"nonexistent","output":"must-not-exist"}),
            );
            assert!(result.is_err());
            assert!(!root.path().join("must-not-exist").exists());
        }
    }

    #[test]
    fn runtime_coordinates_remain_relative_when_window_moves_or_resizes() {
        let plan = compile(&script()).unwrap();
        let window = markits::window_capture::WindowInfo {
            id: "0x123".into(),
            title: "Fixture".into(),
            x: -1920,
            y: 300,
            width: 1600,
            height: 1200,
        };
        let steps = runtime_steps(&plan, &window).unwrap();
        assert_eq!(steps[6], json!({"click":{"x":80,"y":100}}));
        let tasks = plan
            .captures
            .iter()
            .map(|(id, _)| Task {
                id: id.clone(),
                name: String::new(),
                kind: "screenshot".into(),
                page: String::new(),
                prompt: String::new(),
                source_sha256: String::new(),
                status: "pending".into(),
            })
            .collect::<Vec<_>>();
        let root = tempfile::tempdir().unwrap();
        desktop_scenario::validate_with_tasks(&steps, root.path(), &tasks).unwrap();
        let mut cursor = script();
        cursor["steps"][4]["include_cursor"] = json!(true);
        assert!(runtime_steps(&compile(&cursor).unwrap(), &window).is_err());
    }

    #[test]
    fn attach_and_inspect_roundtrip_preserves_pixels_and_original_and_rejects_overwrite() {
        let root = tempfile::tempdir().unwrap();
        image::DynamicImage::new_rgb8(20, 10)
            .save(root.path().join("source.png"))
            .unwrap();
        let original = fs::read(root.path().join("source.png")).unwrap();
        let request = json!({"script":script(),"image":"source.png","output":"assets/replay.png"});
        execute(root.path(), "operations-attach", &request).unwrap();
        let bytes = fs::read(root.path().join("assets/replay.png")).unwrap();
        assert_eq!(
            image::load_from_memory(&bytes).unwrap().to_rgba8(),
            image::load_from_memory(&original).unwrap().to_rgba8()
        );
        assert_eq!(fs::read(root.path().join("source.png")).unwrap(), original);
        let inspected = execute(
            root.path(),
            "operations-inspect",
            &json!({"image":"assets/replay.png"}),
        )
        .unwrap();
        assert_eq!(inspected, saved(&compile(&script()).unwrap().recording));
        assert!(execute(root.path(), "operations-attach", &request).is_err());
        assert_eq!(
            fs::read(root.path().join("assets/replay.png")).unwrap(),
            bytes
        );
        assert!(execute(
            root.path(),
            "operations-inspect",
            &json!({"image":"../outside.png"})
        )
        .is_err());
        assert_eq!(schema()["properties"]["version"]["const"], 1);
    }

    #[test]
    fn runner_outputs_have_per_capture_recordings_and_do_not_overwrite_existing_runs() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("index.md"), "Original manuscript").unwrap();
        let plan = compile(&script()).unwrap();
        let window = markits::window_capture::WindowInfo {
            id: "0x123".into(),
            title: "Fixture".into(),
            x: 100,
            y: 200,
            width: 800,
            height: 600,
        };
        let request = json!({"output":"assets/run-one"});
        let result = run_with(
            root.path(),
            &request,
            &plan,
            &window,
            |_, id, steps, output| {
                assert_eq!(id, "0x123");
                for (name, _) in &plan.captures {
                    image::DynamicImage::new_rgb8(20, 10)
                        .save(output.join(format!("{name}.png")))
                        .unwrap();
                }
                Ok(crate::scenario::RunResult {
                    steps: steps.len(),
                    captured: vec!["step-one".into(), "step-two".into()],
                })
            },
        )
        .unwrap();
        assert_eq!(result["captures"].as_array().unwrap().len(), 2);
        for (index, name) in ["step-one", "step-two"].iter().enumerate() {
            let recording = execute(
                root.path(),
                "operations-inspect",
                &json!({"image":format!("assets/run-one/{name}.png")}),
            )
            .unwrap();
            let native: OperationRecording =
                serde_json::from_value(recording["recording"].clone()).unwrap();
            assert_eq!(
                native
                    .events
                    .iter()
                    .filter(|event| matches!(event, RecordedEvent::Screenshot { .. }))
                    .count(),
                index + 1
            );
        }
        assert!(
            run_with(root.path(), &request, &plan, &window, |_, _, _, _| panic!(
                "existing directory must prevent input"
            ))
            .is_err()
        );
        assert_eq!(
            fs::read_to_string(root.path().join("index.md")).unwrap(),
            "Original manuscript"
        );
    }

    #[test]
    fn execution_and_metadata_failures_keep_partial_results_and_failure_manifests() {
        let root = tempfile::tempdir().unwrap();
        let plan = compile(&script()).unwrap();
        let window = markits::window_capture::WindowInfo {
            id: "0x123".into(),
            title: "Fixture".into(),
            x: 100,
            y: 200,
            width: 800,
            height: 600,
        };
        for (directory, fail_input) in [("input-failure", true), ("missing-capture", false)] {
            let result = run_with(
                root.path(),
                &json!({"output":directory}),
                &plan,
                &window,
                |_, _, steps, output| {
                    image::DynamicImage::new_rgb8(20, 10)
                        .save(output.join("step-one.png"))
                        .unwrap();
                    if fail_input {
                        Err("fixture input failed".into())
                    } else {
                        Ok(crate::scenario::RunResult {
                            steps: steps.len(),
                            captured: vec!["step-one".into()],
                        })
                    }
                },
            );
            assert!(result.unwrap_err().contains("run.json"));
            let manifest: Value = serde_json::from_slice(
                &fs::read(root.path().join(directory).join("run.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(manifest["ok"], false);
            assert!(root.path().join(directory).join("step-one.png").is_file());
            assert!(!root.path().join(directory).join("step-two.png").exists());
        }
    }
}
