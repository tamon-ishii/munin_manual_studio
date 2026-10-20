use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::path::Path;
use std::io::Read;

pub(crate) fn application(root: &Path, options: &Value) -> Result<String, String> {
    let instruction = instruction(options)?;
    let config = crate::config::read_config(root);
    let schema = json!({"type":"object","properties":{"name":{"type":"string"},"program":{"type":"string"},"args":{"type":"array","items":{"type":"string"}},"workingDirectory":{"type":"string"}},"required":["name","program","args","workingDirectory"],"additionalProperties":false});
    let prompt=format!("Choose the target application from the screenshot instruction. Reuse an existing registration where possible. Automatically fill the executable and all launch arguments needed for the requested screen, using the instruction, existing registrations and launch_context evidence. Preserve each argument as one array entry, including spaces. Resolve project-relative file/directory arguments against project. Prefer selected_application when present and complete its arguments. Preserve its workingDirectory; when none is set, return an empty workingDirectory so the project folder remains the default. Do not invent undocumented flags; if no arguments are needed return []. Return an executable path or executable name and arguments, never a shell command. Do not use shell/interpreter commands to launch another program. Investigate the real executable path and required arguments together in this single request before returning the registration. Use executable_candidates as verified paths; when read-only tools are available, also inspect installed application entries, PATH and project launch/build files as needed. Do not defer discovery to another AI request. If investigation still cannot identify a real path, return an empty program rather than inventing one. Input JSON: {}",json!({"instruction":instruction,"applications":options["applications"],"project":root.to_string_lossy(),"os":std::env::consts::OS,"selected_application":options["selected_application"],"launch_context":launch_context(root),"executable_candidates":executable_candidates(root,instruction)}));
    let mut app = crate::agent::agent_json(root, &prompt, &schema, &config.agent, &config.model)?;
    validate_application(&app)?;
    if let Some(existing) = options["applications"].as_array().and_then(|apps| {
        apps.iter()
            .find(|item| item["program"] == app["program"] && item["args"] == app["args"])
    }) {
        if let Some(id) = existing["id"].as_str() {
            app["id"] = json!(id);
        }
        if let Some(directory) = existing.get("workingDirectory") { app["workingDirectory"] = directory.clone(); }
    }
    if app.get("workingDirectory").and_then(Value::as_str).is_none() {
        app["workingDirectory"] = json!("");
    }
    let executable =
        crate::platform::application_executable_in(root, app["program"].as_str().unwrap_or(""));
    app["available"] = json!(executable.is_ok());
    match executable {
        Ok(path) => {
            app["program"] = json!(path.to_string_lossy());
            app["reason"] = json!("");
        }
        Err(reason) => app["reason"] = json!(reason),
    }
    Ok(app.to_string())
}
/// Bounded project documentation; no environment files or external symlink targets.
fn launch_context(root: &Path) -> Vec<Value> {
    let Ok(canonical_root) = root.canonicalize() else { return Vec::new(); };
    let mut evidence = Vec::new();
    for relative in ["README.md", "README.rst", "package.json", "pyproject.toml", ".vscode/launch.json", ".vscode/tasks.json"] {
        let Ok(path) = root.join(relative).canonicalize() else { continue; };
        if !path.starts_with(&canonical_root) { continue; }
        let Ok(file) = std::fs::File::open(path) else { continue; };
        let mut bytes = Vec::new();
        if file.take(8193).read_to_end(&mut bytes).is_err() { continue; }
        let truncated = bytes.len() > 8192;
        bytes.truncate(8192);
        evidence.push(json!({"path":relative,"content":String::from_utf8_lossy(&bytes),"truncated":truncated}));
    }
    evidence
}

fn executable_candidates(root: &Path, instruction: &str) -> Vec<Value> {
    let tokens: Vec<String> = instruction.split(|c:char| !c.is_alphanumeric() && c!='-' && c!='_')
        .filter(|s| s.len()>=3).map(str::to_lowercase).collect();
    let mut directories: Vec<_> = ["target/debug", "target/release", "bin", "build", "dist"].iter().map(|p|(root.join(p),true)).collect();
    if let Some(path) = std::env::var_os("PATH") { directories.extend(std::env::split_paths(&path).map(|p|(p,false))); }
    #[cfg(target_os="macos")]
    directories.push((std::path::PathBuf::from("/Applications"),false));
    let mut candidates=Vec::new();
    let mut seen=std::collections::HashSet::new();
    for (directory,project) in directories {
        let Ok(entries)=std::fs::read_dir(directory) else {continue;};
        for entry in entries.flatten().take(4096) {
            let path=entry.path();
            let name=entry.file_name().to_string_lossy().into_owned();
            let stem=path.file_stem().unwrap_or_default().to_string_lossy().to_lowercase();
            if !project && !tokens.iter().any(|token|token.contains(&stem)||stem.contains(token)) {continue;}
            #[cfg(windows)]
            if !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("com")) {continue;}
            #[cfg(unix)]
            {use std::os::unix::fs::PermissionsExt;if path.is_file() && entry.metadata().map_or(true,|m|m.permissions().mode()&0o111==0){continue;}}
            if !path.is_file() && path.extension().is_none_or(|ext|ext!="app") {continue;}
            if let Ok(executable)=crate::platform::application_executable(&path.to_string_lossy()) {
                if seen.insert(executable.clone()) {candidates.push(json!({"name":name,"program":executable.to_string_lossy()}));}
                if candidates.len()>=64 {return candidates;}
            }
        }
    }
    candidates
}

fn validate_application(app: &Value) -> Result<(), String> {
    let program = app["program"]
        .as_str()
        .ok_or("起動パスの形式が不正です。")?;
    let name = Path::new(program)
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or(program)
        .to_lowercase();
    if [
        "sh",
        "bash",
        "zsh",
        "fish",
        "cmd",
        "powershell",
        "pwsh",
        "python",
        "python3",
        "node",
        "perl",
        "ruby",
    ]
    .contains(&name.as_str())
    {
        return Err("撮影対象のアプリ本体を指定してください。".into());
    }
    let args = app["args"]
        .as_array()
        .filter(|args| args.len() <= 32)
        .ok_or("起動引数の形式が不正です。")?;
    if args
        .iter()
        .any(|arg| arg.as_str().is_none_or(|s| s.len() > 4096))
    {
        return Err("起動引数の形式が不正です。".into());
    }
    if app.get("workingDirectory").is_some_and(|directory| directory.as_str().is_none_or(|path| path.len() > 4096 || path.contains('\0'))) {
        return Err("作業フォルダの形式が不正です。".into());
    }
    Ok(())
}
fn instruction(options: &Value) -> Result<&str, String> {
    options["instruction"]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= 20_000)
        .ok_or("撮影・注釈の指示を入力してください。".into())
}

pub(crate) fn plan(root: &Path, options: &Value) -> Result<String, String> {
    let instruction = instruction(options)?;
    let window = options["window"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("撮影するウィンドウを選択してください。")?;
    let tree = crate::desktop_scenario::inspect_window(window)?;
    let replay_window = crate::desktop_scenario::window_title(window)?;
    let app = &options["application"];
    validate_application(app)?;
    crate::platform::application_executable_in(root, app["program"].as_str().unwrap())?;
    let config = crate::config::read_config(root);
    let schema = json!({"type":"object","properties":{"steps":{"type":"array","items":{"type":"object","properties":{"action":{"type":"string","enum":["click","expect_visible","wait_ms"]},"selector":{"type":"string"},"milliseconds":{"type":"integer"}},"required":["action","selector","milliseconds"],"additionalProperties":false}},"summary":{"type":"string"},"annotate":{"type":"boolean"}},"required":["steps","summary","annotate"],"additionalProperties":false});
    let prompt=format!("Prepare minimal desktop navigation steps to reach the requested screen. Only use observed accessibility selectors from the tree. A selector MUST use role[name='exact accessible name'], for example button[name='AI設定']. Use the role and complete name exactly as shown in the tree, never a bare name, CSS id, XPath or translated label. Each step has action, selector and milliseconds. Allowed actions are click or expect_visible with an observed selector (milliseconds=0), and wait_ms with milliseconds up to 3000 (selector empty). Do not include launch/window/screenshot, coordinates, text entry, keys or destructive actions. If the screen is already visible return an empty steps array. Never invent controls. Return annotate=true only when numbering, explanations or highlighting are requested; for a plain screenshot return annotate=false. Input JSON: {}",json!({"instruction":instruction,"window":window,"accessibility":tree}));
    let result = crate::agent::agent_json(root, &prompt, &schema, &config.agent, &config.model)?;
    let mut steps = vec![
        json!({"launch":{"program":app["program"],"args":app["args"]}}),
        json!({"window":replay_window}),
    ];
    let operations = result["steps"]
        .as_array()
        .filter(|s| s.len() <= 20)
        .ok_or("撮影手順の形式が不正です。")?;
    for operation in operations {
        let action = operation["action"].as_str().ok_or("撮影手順が不正です。")?;
        let step = match action {
            "click" | "expect_visible" => {
                let selector = operation["selector"].as_str().ok_or("操作対象が不正です。")?;
                observed_selector(selector, &tree)?;
                if action == "click" {json!({"press":selector})} else {json!({"expect_visible":selector})}
            }
            "wait_ms" => {
                let duration = operation["milliseconds"].as_u64().filter(|n| *n<=3000).ok_or("待機時間が不正です。")?;
                json!({"wait_ms":duration})
            }
            _ => return Err("AIが対応外の操作を提案しました。操作記録から撮影してください。".into()),
        };
        steps.push(step);
    }
    steps.push(json!({"screenshot":{"task":"ai-capture"}}));
    let recipe = json!({"version":1,"platform":"desktop","window":replay_window,"steps":steps});
    validate_recipe(root, &recipe)?;
    Ok(json!({"recipe":recipe,"instruction":instruction,"summary":result["summary"],"annotate":result["annotate"]}).to_string())
}
fn observed_selector(selector: &str, tree: &str) -> Result<(), String> {
    let names = regex::Regex::new(r#"name\s*=\s*["']([^"']+)["']"#).unwrap();
    let name = names
        .captures(selector)
        .and_then(|c| c.get(1))
        .ok_or_else(|| format!("操作対象の形式が不正です: {selector}。button[name='画面上の名前']の形式で指定してください。"))?;
    if !tree.contains(name.as_str()) {
        return Err(
            "現在の画面で確認できない操作です。対象画面まで操作を記録してから撮影してください。"
                .into(),
        );
    }
    Ok(())
}
fn validate_recipe(root: &Path, recipe: &Value) -> Result<(), String> {
    if recipe["platform"] != "desktop" {
        return Err("デスクトップの撮影手順を指定してください。".into());
    }
    let steps = recipe["steps"]
        .as_array()
        .filter(|s| s.len() <= 24)
        .ok_or("撮影手順が不正です。")?;
    for step in steps {
        let action = step
            .as_object()
            .filter(|o| o.len() == 1)
            .and_then(|o| o.keys().next())
            .ok_or("撮影手順が不正です。")?;
        if ![
            "launch",
            "window",
            "click",
            "press",
            "expect_visible",
            "wait_ms",
            "screenshot",
        ]
        .contains(&action.as_str())
        {
            return Err("対応外の撮影操作です。".into());
        }
        if action == "launch" {
            validate_application(
                &json!({"program":step["launch"]["program"],"args":step["launch"]["args"]}),
            )?;
        }
    }
    let selected = [crate::task::Task {
        id: "ai-capture".into(),
        name: String::new(),
        kind: "screenshot".into(),
        page: String::new(),
        prompt: String::new(),
        source_sha256: String::new(),
        status: "pending".into(),
    }];
    crate::scenario::validate_json_with_tasks(root, &recipe.to_string(), &selected)
}
pub(crate) fn capture(root: &Path, options: &Value) -> Result<String, String> {
    instruction(options)?;
    let recipe = &options["recipe"];
    validate_recipe(root, recipe)?;
    let id = crate::screenshots::new_id("shot");
    let mut execution_recipe = recipe.clone();
    if let Some(window) = options["window"].as_str() {
        if crate::desktop_scenario::window_title(window)? != recipe["window"].as_str().unwrap_or("") {
            return Err("撮影対象のウィンドウが変更されました。手順を作成し直してください。".into());
        }
        execution_recipe["window"] = json!(window);
        let steps = execution_recipe["steps"].as_array_mut().ok_or("撮影手順がありません。")?;
        steps.retain(|step| step.get("launch").is_none());
        for step in steps { if step.get("window").is_some() {step["window"] = json!(window);} }
        validate_recipe(root, &execution_recipe)?;
    }
    let source = crate::scenario::capture_asset(root, &execution_recipe, &id)?;
    let data = format!("data:image/png;base64,{}", STANDARD.encode(source));
    Ok(crate::screenshots::register(
        root,
        &json!({"id":id,"source":data,"recipe":recipe,"name":options["instruction"],"adopt":false}),
    )?
    .to_string())
}
pub(crate) fn annotate(root: &Path, options: &Value) -> Result<String, String> {
    let instruction = instruction(options)?;
    let id = options["id"]
        .as_str()
        .ok_or("撮影画像を指定してください。")?;
    let shot = crate::screenshots::load(root, id)?;
    if shot.protected {
        return Err("保護を解除してから画像を編集してください。".into());
    }
    let latest = shot
        .edits
        .last()
        .map(|edit| edit.id.as_str())
        .ok_or("撮影原本がありません。")?;
    let original = crate::screenshots::image(root, id, Some(latest), true)?;
    let data = original["data"].as_str().ok_or("撮影原本がありません。")?;
    let bytes = STANDARD
        .decode(data.split_once(',').ok_or("画像データが不正です。")?.1)
        .map_err(|e| e.to_string())?;
    let elements = markits::raster::extract_png_uimap(&bytes).unwrap_or_default();
    if elements.is_empty() {
        return Err("画面要素を取得できませんでした。撮影原本と再撮影手順は保存済みです。MarkItsで注釈してください。".into());
    }
    let config = crate::config::read_config(root);
    let schema = json!({"type":"object","properties":{"marks":{"type":"array","items":{"type":"object","properties":{"element":{"type":"integer"},"type":{"type":"string","enum":["badge","callout","rounded-rect"]},"step":{"type":"integer"},"text":{"type":"string"}},"required":["element","type","step","text"],"additionalProperties":false}}},"required":["marks"],"additionalProperties":false});
    let prompt=format!("Select actual screenshot elements to annotate according to the instruction. Return 1-based element indices, badge for numbering, callout for explanations or rounded-rect for highlighting. Number badges in the requested order. Do not invent positions or controls. If an intended element is unavailable report an empty marks array. Input JSON: {}",json!({"instruction":instruction,"elements":elements}));
    let result = crate::agent::agent_json(root, &prompt, &schema, &config.agent, &config.model)?;
    let image = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    let scene = scene(&result, &elements, image.width(), image.height())?;
    let latest_shot = crate::screenshots::load(root, id)?;
    let latest_edit = latest_shot
        .edits
        .last()
        .map(|edit| edit.id.as_str())
        .ok_or("撮影原本がありません。")?;
    let current = crate::screenshots::image(root, id, Some(latest_edit), true)?;
    if current["edit"]["id"] != original["edit"]["id"] {
        return Err("撮影画像が変更されました。注釈を実行し直してください。".into());
    }
    let render = markits::raster::render_composed_png_bytes(&scene.to_string(), &bytes)
        .map_err(|e| e.to_string())?;
    Ok(crate::screenshots::register(root,&json!({"id":id,"source":data,"render":format!("data:image/png;base64,{}",STANDARD.encode(render)),"scene":scene,"ui":{"elements":elements},"expected_revision":shot.adopted,"expected_edit":original["edit"]["id"],"adopt":false}))?.to_string())
}
fn scene(
    result: &Value,
    elements: &[markits::UiElement],
    width: u32,
    height: u32,
) -> Result<Value, String> {
    let marks = result["marks"]
        .as_array()
        .filter(|m| !m.is_empty() && m.len() <= 50)
        .ok_or("注釈する画面要素を特定できませんでした。原本をMarkItsで編集できます。")?;
    let mut annotations = Vec::new();
    for mark in marks {
        let index = mark["element"]
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or("画面要素の番号が不正です。")? as usize;
        let target = elements.get(index - 1).ok_or("存在しない画面要素です。")?;
        let kind = mark["type"].as_str().ok_or("注釈の種類が不正です。")?;
        if !["badge", "callout", "rounded-rect"].contains(&kind) {
            return Err("注釈の種類が不正です。".into());
        }
        if ![target.x, target.y, target.width, target.height]
            .iter()
            .all(|n| n.is_finite())
            || target.width <= 0.0
            || target.height <= 0.0
            || target.x < 0.0
            || target.y < 0.0
            || target.x + target.width > width as f64
            || target.y + target.height > height as f64
        {
            return Err("画面要素が撮影範囲から外れています。".into());
        }
        let mut annotation = json!({"type":kind,"target":[target.x,target.y,target.width,target.height],"style":"primary"});
        if kind == "badge" {
            let step = mark["step"]
                .as_u64()
                .filter(|n| *n > 0 && *n <= 999)
                .ok_or("注釈番号が不正です。")?;
            annotation["step"] = json!(step);
            annotation["arrow"] = json!(true);
        }
        if kind == "callout" {
            annotation["text"] = mark["text"].clone();
        }
        annotations.push(annotation);
    }
    Ok(json!({"canvas":{"width":width,"height":height},"uimap":elements,"annotations":annotations}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_shell_and_unobserved_controls() {
        assert!(validate_application(&json!({"program":"bash","args":["-c","rm -rf"]})).is_err());
        assert!(observed_selector("button[name='Save']", "button Save").is_ok());
        assert!(observed_selector("button[name='Missing']", "button Save").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn validates_replay_recipe_without_desktop_access() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("docs")).unwrap();
        let valid = json!({"version":1,"platform":"desktop","window":"Fixture","steps":[{"launch":{"program":"/usr/bin/true","args":[]}},{"window":"Fixture"},{"screenshot":{"task":"ai-capture"}}]});
        assert!(validate_recipe(root.path(), &valid).is_ok());
        let mut navigated = valid.clone();
        navigated["steps"].as_array_mut().unwrap().insert(2, json!({"press":"button[name='AI設定']"}));
        assert!(validate_recipe(root.path(), &navigated).is_ok());
        let mut invalid = valid.clone();
        invalid["steps"][0] = json!({"launch":{"program":"bash","args":["-c","other"]}});
        assert!(validate_recipe(root.path(), &invalid).is_err());
        invalid = valid.clone();
        invalid["steps"][1] = json!({"key":{"selector":"button[name='Save']","keys":"Ctrl+Q"}});
        assert!(validate_recipe(root.path(), &invalid).is_err());
    }
    #[test]
    fn annotation_uses_actual_element_bounds() {
        let elements = [markits::UiElement::new(
            "button", "Save", 2.0, 3.0, 10.0, 8.0,
        )];
        let value = json!({"marks":[{"element":1,"type":"badge","step":1,"text":""}]});
        let scene = scene(&value, &elements, 30, 20).unwrap();
        assert_eq!(
            scene["annotations"][0]["target"],
            json!([2.0, 3.0, 10.0, 8.0])
        );
        assert_eq!(scene["annotations"][0]["arrow"], json!(true));
        assert!(super::scene(&value, &[], 30, 20).is_err());
    }
}
