use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use xa11y::{App, AppExt, Element, Key, Locator, Point, Rect, Selector};

use super::scenario::RunResult;
use super::task::find_task;
use super::window_capture::{self, WindowInfo};

fn nonempty(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.trim().is_empty())
}

fn retry_unavailable_ui_element<T>(
    timeout: Duration,
    mut read: impl FnMut(Duration) -> Result<T, String>,
) -> Result<T, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let result = read(deadline.saturating_duration_since(Instant::now()));
        match result {
            // UIA_E_ELEMENTNOTAVAILABLE: a WebView2 node was replaced while
            // resolving the locator. Re-resolve only this read-only operation.
            Err(error) if error.contains("Platform error (-2147220991):")
                && Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(100).min(
                        deadline.saturating_duration_since(Instant::now()),
                    ));
                }
            result => return result,
        }
    }
}

fn key_for(name: &str) -> Option<Key> {
    match name.to_ascii_lowercase().as_str() {
        "enter" | "return" => Some(Key::Enter),
        "escape" | "esc" => Some(Key::Escape),
        "tab" => Some(Key::Tab),
        "space" => Some(Key::Space),
        "backspace" => Some(Key::Backspace),
        "delete" => Some(Key::Delete),
        "up" => Some(Key::ArrowUp),
        "down" => Some(Key::ArrowDown),
        "left" => Some(Key::ArrowLeft),
        "right" => Some(Key::ArrowRight),
        "ctrl" | "control" => Some(Key::Ctrl),
        "alt" => Some(Key::Alt),
        "shift" => Some(Key::Shift),
        "meta" | "cmd" | "command" | "win" => Some(Key::Meta),
        _ if name.len() > 1 && name.starts_with(['f', 'F']) => name[1..]
            .parse::<u8>()
            .ok()
            .filter(|number| (1..=12).contains(number))
            .map(Key::F),
        _ if name.chars().count() == 1 => {
            Some(Key::Char(name.chars().next().unwrap().to_ascii_lowercase()))
        }
        _ => None,
    }
}

fn parse_keys(value: &str) -> Result<Vec<Key>, String> {
    let keys: Vec<Key> = value
        .split('+')
        .map(|part| key_for(part.trim()).ok_or_else(|| format!("Unsupported key: {part}")))
        .collect::<Result<_, _>>()?;
    if keys[..keys.len() - 1]
        .iter()
        .any(|key| !matches!(key, Key::Ctrl | Key::Alt | Key::Shift | Key::Meta))
    {
        return Err("Only modifiers may precede the final key".into());
    }
    Ok(keys)
}

pub fn validate(steps: &[Value], docs: &Path) -> Result<(), String> {
    validate_with_tasks(steps, docs, &[])
}

pub(crate) fn validate_with_tasks(
    steps: &[Value],
    docs: &Path,
    selected: &[super::task::Task],
) -> Result<(), String> {
    for (index, step) in steps.iter().enumerate() {
        let number = index + 1;
        let object = step
            .as_object()
            .ok_or_else(|| format!("Desktop scenario step {number} must be an object"))?;
        if object.len() != 1 {
            return Err(format!(
                "Desktop scenario step {number} must contain one action"
            ));
        }
        let (action, value) = object.iter().next().unwrap();
        match action.as_str() {
            "launch" => {
                let program = value
                    .get("program")
                    .and_then(nonempty)
                    .ok_or_else(|| format!("Launch step {number} needs a program"))?;
                if program.contains('\0')
                    || value.get("args").is_some_and(|args| {
                        args.as_array()
                            .is_none_or(|items| items.iter().any(|item| item.as_str().is_none()))
                    })
                {
                    return Err(format!("Launch step {number} has invalid arguments"));
                }
            }
            "window" | "expect_window" => {
                if nonempty(value).is_none() {
                    return Err(format!("Step {number} needs nonempty {action} text"));
                }
            }
            "press" | "focus" | "toggle" | "select" | "scroll_into_view" | "expect_visible"
            | "expect_hidden" | "expect_enabled" | "expect_disabled" | "expect_focused" => {
                let selector =
                    nonempty(value).ok_or_else(|| format!("Step {number} needs a selector"))?;
                Selector::parse(selector).map_err(|error| format!("Step {number}: {error}"))?;
            }
            "fill_target" => {
                serde_json::from_value::<super::semantic_target::Target>(value["target"].clone())
                    .map_err(|error| error.to_string())?.validate()?;
                if value["value"].as_str().is_none() { return Err("入力欄の値は文字列で指定してください。".into()); }
                if let Some(visual) = value.get("visual") {
                    serde_json::from_value::<super::visual_target::Target>(visual.clone())
                        .map_err(|error| error.to_string())?.decode()?;
                }
            }
            "fill" | "expect_value" => {
                if value.get("value").and_then(Value::as_str).is_none() {
                    return Err(format!("{action} step {number} needs selector and value"));
                }
                let selector = value
                    .get("selector")
                    .and_then(nonempty)
                    .ok_or_else(|| format!("{action} step {number} needs selector and value"))?;
                Selector::parse(selector).map_err(|error| format!("Step {number}: {error}"))?;
            }
            "text" => {
                if nonempty(value).is_none() {
                    let selector = value.get("selector").and_then(nonempty).ok_or_else(|| {
                        format!("Text step {number} needs text or a selector and value")
                    })?;
                    if value.get("value").and_then(nonempty).is_none() {
                        return Err(format!("Text step {number} needs nonempty value"));
                    }
                    Selector::parse(selector).map_err(|error| format!("Step {number}: {error}"))?;
                }
            }
            "key" => {
                let keys = if let Some(keys) = nonempty(value) {
                    keys
                } else {
                    let selector = value.get("selector").and_then(nonempty).ok_or_else(|| {
                        format!("Key step {number} needs keys or a selector and keys")
                    })?;
                    Selector::parse(selector).map_err(|error| format!("Step {number}: {error}"))?;
                    value
                        .get("keys")
                        .and_then(nonempty)
                        .ok_or_else(|| format!("Key step {number} needs nonempty keys"))?
                };
                parse_keys(keys)?;
            }
            "scroll" => {
                if value
                    .get("x")
                    .and_then(Value::as_u64)
                    .is_none_or(|x| x > i32::MAX as u64)
                    || value
                        .get("y")
                        .and_then(Value::as_u64)
                        .is_none_or(|y| y > i32::MAX as u64)
                    || value.get("dx").and_then(Value::as_i64).is_none()
                    || value.get("dy").and_then(Value::as_i64).is_none()
                {
                    return Err(format!("Scroll step {number} needs valid x, y, dx, and dy"));
                }
            }
            "click" => {
                if value.get("target").is_some() || value.get("visual").is_some() {
                    if value.get("x").is_some() || value.get("y").is_some() {
                        return Err(format!("Click step {number} cannot combine a target and coordinates"));
                    }
                    if let Some(target) = value.get("target") {
                        serde_json::from_value::<super::semantic_target::Target>(target.clone())
                            .map_err(|error| error.to_string())?.validate()?;
                    }
                    if let Some(visual) = value.get("visual") {
                        serde_json::from_value::<super::visual_target::Target>(visual.clone())
                            .map_err(|error| error.to_string())?.decode()?;
                    }
                    continue;
                }
                if value
                    .get("x")
                    .and_then(Value::as_u64)
                    .is_none_or(|x| x > i32::MAX as u64)
                    || value
                        .get("y")
                        .and_then(Value::as_u64)
                        .is_none_or(|y| y > i32::MAX as u64)
                {
                    return Err(format!(
                        "Click step {number} needs nonnegative x and y coordinates"
                    ));
                }
            }
            "expect_targets" => {
                let targets = value.as_array().filter(|targets| !targets.is_empty() && targets.len() <= 10)
                    .ok_or("到達確認の対象は1〜10件必要です。")?;
                for target in targets {
                    serde_json::from_value::<super::semantic_target::Target>(target.clone())
                        .map_err(|error| error.to_string())?.validate()?;
                }
            }
            "wait_ms" => {
                if value.as_u64().is_none_or(|ms| ms > 30_000) {
                    return Err(format!("Wait step {number} must be 0–30000 ms"));
                }
            }
            "screenshot" => {
                let task_id = value
                    .get("task")
                    .and_then(nonempty)
                    .ok_or_else(|| format!("Screenshot step {number} needs a task ID"))?;
                if !task_id
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_lowercase())
                    || !task_id.chars().all(|c| {
                        c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_'
                    })
                {
                    return Err(format!("Invalid screenshot task ID: {task_id}"));
                }
                if selected
                    .iter()
                    .find(|task| task.id == task_id)
                    .cloned()
                    .map(Ok)
                    .unwrap_or_else(|| find_task(docs, task_id))?
                    .kind
                    != "screenshot"
                {
                    return Err(format!("Scenario task is not a screenshot: {task_id}"));
                }
                if value
                    .get("inset")
                    .is_some_and(|inset| inset.as_u64().is_none_or(|n| n > 64))
                {
                    return Err(format!(
                        "Screenshot step {number} inset must be 0–64 pixels"
                    ));
                }
                if let Some(selector) = value.get("selector") {
                    let selector = nonempty(selector)
                        .ok_or_else(|| format!("Screenshot step {number} has an empty selector"))?;
                    Selector::parse(selector).map_err(|error| format!("Step {number}: {error}"))?;
                }
            }
            _ => {
                return Err(format!(
                    "Unsupported desktop scenario step {number}: {action}"
                ))
            }
        }
    }
    Ok(())
}

fn find_window(query: &str) -> Result<WindowInfo, String> {
    let windows = window_capture::list_windows()?;
    let exact: Vec<_> = windows
        .iter()
        .filter(|window| window.id == query || window.title.eq_ignore_ascii_case(query))
        .collect();
    let matches: Vec<_> = if exact.is_empty() {
        windows
            .iter()
            .filter(|window| window.title.to_lowercase().contains(&query.to_lowercase()))
            .collect()
    } else {
        exact
    };
    match matches.as_slice() {
        [window] => Ok((*window).clone()),
        [] => Err(format!("Window not found: {query}")),
        _ => Err(format!(
            "Window name is ambiguous: {query}; use the full title or window ID"
        )),
    }
}

fn process_belongs_to(mut pid: u32, launched: u32) -> bool {
    for _ in 0..64 {
        if pid == launched { return true; }
        #[cfg(target_os = "linux")]
        {
            let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else { return false; };
            let Some(fields) = stat.rsplit_once(") ").map(|(_, rest)| rest) else { return false; };
            let Some(parent) = fields.split_whitespace().nth(1).and_then(|value| value.parse::<u32>().ok()) else { return false; };
            if parent == 0 || parent == pid { return false; }
            pid = parent;
        }
        #[cfg(not(target_os = "linux"))]
        { return false; }
    }
    false
}

fn select_launched_window(query: &str, windows: &[WindowInfo], owners: &[(String, u32)], launched: u32) -> Result<WindowInfo, String> {
    let eligible: Vec<_> = windows.iter().filter(|window| owners.iter().any(|(id, pid)| id == &window.id && process_belongs_to(*pid, launched))).collect();
    let exact: Vec<_> = eligible.iter().copied().filter(|window| window.id == query || window.title.eq_ignore_ascii_case(query)).collect();
    let matches = if exact.is_empty() { eligible.into_iter().filter(|window| window.title.to_lowercase().contains(&query.to_lowercase())).collect() } else { exact };
    match matches.as_slice() {
        [window] => Ok((*window).clone()),
        [] => Err(format!("Window not found: {query} (launched process {launched})")),
        _ => Err(format!("Window name is ambiguous in launched process: {query}")),
    }
}

fn wait_launched_window(query: &str, pid: u32) -> Result<WindowInfo, String> {
    let until = Instant::now() + Duration::from_secs(15);
    loop {
        let result = select_launched_window(query, &window_capture::list_windows()?, &window_capture::window_process_ids()?, pid);
        match result {
            Ok(window) => return Ok(window),
            Err(error) if Instant::now() >= until || !error.starts_with("Window not found:") => return Err(error),
            Err(_) => thread::sleep(Duration::from_millis(200)),
        }
    }
}

fn wait_window(query: &str) -> Result<WindowInfo, String> {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        match find_window(query) {
            Ok(window) => return Ok(window),
            Err(error) if Instant::now() >= until => return Err(error),
            Err(error) if !error.starts_with("Window not found:") => return Err(error),
            Err(_) => thread::sleep(Duration::from_millis(250)),
        }
    }
}

enum LocatedWindow {
    Native(WindowInfo),
    Accessible(Element),
}

fn wait_any_window(query: &str) -> Result<LocatedWindow, String> {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        if !window_capture::is_wayland_session() || query == "portal" {
            match find_window(query) {
                Ok(window) => return Ok(LocatedWindow::Native(window)),
                Err(error) if error.starts_with("Window name is ambiguous:") => return Err(error),
                Err(_) => {}
            }
        }
        match a11y_window(query) {
            Ok(window) => return Ok(LocatedWindow::Accessible(window)),
            Err(error) if error.starts_with("Accessibility window name is ambiguous:") => {
                return Err(error)
            }
            Err(error) if Instant::now() >= until => return Err(error),
            Err(_) => thread::sleep(Duration::from_millis(250)),
        }
    }
}

fn a11y_window(query: &str) -> Result<Element, String> {
    let scoped = query
        .strip_prefix("pid:")
        .and_then(|rest| rest.split_once(':'))
        .and_then(|(pid, id)| pid.parse::<u32>().ok().map(|pid| (pid, id)));
    let app_scoped = query
        .strip_prefix("app:")
        .and_then(|rest| rest.split_once("::"));
    let mut exact = Vec::new();
    let mut partial = Vec::new();
    for app in App::list().map_err(|error| error.to_string())? {
        if scoped.is_some_and(|(pid, _)| app.pid.is_some_and(|actual| actual != pid)) { continue; }
        // An unrelated app may close while the desktop is being enumerated.
        let Ok(windows) = app.windows() else { continue };
        for window in windows {
            let name = window.name.as_deref().unwrap_or("");
            let pid = window.pid.or(app.pid);
            let matched = if let Some((expected_app, expected_title)) = app_scoped {
                app.name.eq_ignore_ascii_case(expected_app)
                    && name.eq_ignore_ascii_case(expected_title)
            } else if let Some((expected_pid, id)) = scoped {
                pid == Some(expected_pid)
                    && (window.stable_id.as_deref() == Some(id) || name.eq_ignore_ascii_case(id))
            } else {
                window.stable_id.as_deref() == Some(query) || name.eq_ignore_ascii_case(query)
            };
            if matched {
                exact.push(window);
            } else if scoped.is_none()
                && app_scoped.is_none()
                && name.to_lowercase().contains(&query.to_lowercase())
            {
                partial.push(window);
            }
        }
    }
    let matches = if exact.is_empty() { partial } else { exact };
    match matches.as_slice() {
        [window] => Ok(window.clone()),
        [] => Err(format!("Accessibility window not found: {query}")),
        _ => Err(format!("Accessibility window name is ambiguous: {query}")),
    }
}

#[derive(Serialize)]
struct AccessibleWindowInfo {
    id: String,
    query: String,
    title: String,
    app: String,
    pid: Option<u32>,
}

pub(super) fn list_accessible_windows() -> Result<String, String> {
    let mut found = Vec::new();
    for app in App::list().map_err(|error| error.to_string())? {
        let Ok(windows) = app.windows() else { continue };
        for window in windows {
            let title = window.name.as_deref().unwrap_or("").trim();
            if title.is_empty() {
                continue;
            }
            let pid = window.pid.or(app.pid);
            let id = window.stable_id.as_deref().unwrap_or(title);
            found.push(AccessibleWindowInfo {
                id: pid.map_or_else(|| id.to_string(), |pid| format!("pid:{pid}:{id}")),
                query: format!("app:{}::{title}", app.name),
                title: title.to_string(),
                app: app.name.clone(),
                pid,
            });
        }
    }
    found.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    serde_json::to_string(&found).map_err(|error| error.to_string())
}

pub(super) fn inspect_window(query: &str) -> Result<String, String> {
    if query.trim().is_empty() {
        return Err("inspect-window requires --window".into());
    }
    a11y_window(query)?
        .dump(Some(5))
        .map_err(|error| error.to_string())
}

struct SelectedWindow {
    query: String,
    native_id: Option<String>,
    accessible: Option<Element>,
}

impl SelectedWindow {
    fn new(query: &str) -> Self {
        Self {
            query: query.to_string(),
            native_id: None,
            accessible: None,
        }
    }

    fn accessible(&self) -> Result<Element, String> {
        if let Some(window) = &self.accessible {
            if window.children().is_ok() {
                return Ok(window.clone());
            }
        }
        selected_a11y_window(&self.query)
    }

    fn native(&self) -> Result<WindowInfo, String> {
        if let Some(id) = &self.native_id {
            if let Ok(window) = find_window(id) {
                return Ok(window);
            }
        }
        find_window(&self.query)
    }

    fn wait_native(&self) -> Result<WindowInfo, String> {
        if let Ok(window) = self.native() {
            return Ok(window);
        }
        wait_window(&self.query)
    }

    fn bounds_for_input(&self) -> Result<Rect, String> {
        #[cfg(target_os = "linux")]
        if !window_capture::is_wayland_session() {
            if let Ok(window) = self.native() {
                return Ok(Rect {
                    x: window.x,
                    y: window.y,
                    width: window.width,
                    height: window.height,
                });
            }
        }

        if let Ok(window) = self.accessible() {
            return window
                .bounds
                .ok_or("Selected window has no accessibility bounds".into());
        }

        let window = self.wait_native()?;
        Ok(Rect {
            x: window.x,
            y: window.y,
            width: window.width,
            height: window.height,
        })
    }
}

fn selected_a11y_window(selected: &str) -> Result<Element, String> {
    if selected.is_empty() {
        return Err("Select a window before interacting with it".into());
    }
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        match a11y_window(selected) {
            Ok(window) => return Ok(window),
            Err(error) if Instant::now() >= until => return Err(error),
            Err(error) if !error.starts_with("Accessibility window not found:") => {
                return Err(error)
            }
            Err(_) => thread::sleep(Duration::from_millis(250)),
        }
    }
}

fn locator(window: &Element, selector: &str) -> Locator {
    Locator::new(
        window.provider().clone(),
        Some(window.data().clone()),
        selector,
    )
}

fn wait_click_target(
    selected: &SelectedWindow, target: Option<&super::semantic_target::Target>,
    visual: Option<&super::visual_target::Target>, root: &Path, checkpoint: &str,
    started: Instant, timeout: Duration,
) -> Result<(markits::ui_elements::DetectedUiElement, Vec<markits::ui_elements::DetectedUiElement>), String> {
    let name = target.map(|target| target.name.as_str()).unwrap_or("画像の対象");
    super::agent::log_progress(root, &format!("「{name}」の表示を待機（最大10秒）"));
    let deadline = Instant::now() + Duration::from_secs(10);
    let check = || {
        super::agent::check_cancelled(root, checkpoint)?;
        if started.elapsed() >= timeout { return Err("撮影手順が制限時間を超えました。".to_string()); }
        if Instant::now() >= deadline { return Err(format!("クリック対象が見つかりません：{name}")); }
        Ok(())
    };
    loop {
        check()?;
        let window = selected.native()?;
        let elements = match super::semantic_target::observe_window(&window.id) {
            Ok(elements) => elements,
            Err(_) if visual.is_some() => Vec::new(),
            Err(error) => return Err(error),
        };
        check()?;
        if let Some(target) = target {
            // An ambiguous semantic identity is an error, never a reason to guess visually.
            if let Some(element) = target.resolve(&elements)? { return Ok((element.clone(), elements)); }
        }
        if let Some(visual) = visual {
            super::agent::log_progress(root, &format!("画像照合で「{name}」の位置を確認"));
            let picture = window_capture::read_window_pixels(&window.id, None)?;
            if let Some((x,y)) = super::visual_target::locate(visual, &picture, check)? {
                check()?;
                return Ok((markits::ui_elements::DetectedUiElement {
                    role: "visual".into(), name: Some(name.into()), window_id: Some(window.id), pid: None,
                    x: window.x as f64 + x * window.width as f64 / picture.width() as f64 - 0.5,
                    y: window.y as f64 + y * window.height as f64 / picture.height() as f64 - 0.5,
                    width: 1.0, height: 1.0,
                }, elements));
            }
        }
        check()?;
        thread::sleep(Duration::from_millis(100));
    }
}

fn click_observed(selected: &SelectedWindow, element: &markits::ui_elements::DetectedUiElement) -> Result<(), String> {
    if !window_capture::is_wayland_session() { activate_for_input(selected)?; }
    let point = Point::new((element.x + element.width / 2.0) as i32, (element.y + element.height / 2.0) as i32);
    xa11y::input_sim().map_err(|error| error.to_string())?.mouse().click(point)
        .map_err(|error| error.to_string())
}

fn activate(selected: &SelectedWindow) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if !window_capture::is_wayland_session() {
        if let Ok(window) = selected.native() {
            return window_capture::activate_window(&window.id).map(|_| ());
        }
    }
    if let Ok(window) = selected.accessible() {
        if window.activate().is_ok() {
            return Ok(());
        }
    }
    let window = selected.native()?;
    window_capture::activate_window(&window.id).map(|_| ())
}

fn activate_for_input(selected: &SelectedWindow) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if !window_capture::is_wayland_session() {
        if let Ok(window) = selected.native() {
            if window_capture::is_window_active(&window.id)? { return Ok(()); }
            return activate(selected);
        }
    }
    if a11y_window(&selected.query).is_ok_and(|window| window.states.active) {
        return Ok(());
    }
    if window_capture::is_wayland_session() {
        let window = selected.accessible()?;
        return window.activate().map_err(|error| {
            format!("Selected window is not active; focus a control before keyboard input: {error}")
        });
    }
    activate(selected)
}

fn inset_rect(bounds: Rect, inset: u32) -> Result<Rect, String> {
    let twice = inset.checked_mul(2).ok_or("Inset is too large")?;
    let width = bounds
        .width
        .checked_sub(twice)
        .filter(|size| *size > 0)
        .ok_or("Inset exceeds capture width")?;
    let height = bounds
        .height
        .checked_sub(twice)
        .filter(|size| *size > 0)
        .ok_or("Inset exceeds capture height")?;
    let margin = i32::try_from(inset).map_err(|_| "Inset is too large")?;
    Ok(Rect {
        x: bounds
            .x
            .checked_add(margin)
            .ok_or("Capture x exceeds desktop bounds")?,
        y: bounds
            .y
            .checked_add(margin)
            .ok_or("Capture y exceeds desktop bounds")?,
        width,
        height,
    })
}

fn capture(
    selected: &SelectedWindow,
    selector: Option<&str>,
    inset: u32,
    destination: &Path,
) -> Result<(), String> {
    let portal = window_capture::is_wayland_session();
    if portal && (selected.query == "portal" || selector.is_none()) {
        if selector.is_some() {
            return Err("Select a named window for an element screenshot".into());
        }
        window_capture::capture_window("portal", inset, destination, true, None)?;
        return Ok(());
    }
    if selector.is_none() {
        if let Ok(window) = selected.native() {
            window_capture::capture_window(&window.id, inset, destination, true, Some(&window.id))?;
            return Ok(());
        }
    }
    let accessible = if selector.is_some() {
        Some(selected.accessible()?)
    } else {
        a11y_window(&selected.query)
            .ok()
            .or_else(|| selected.accessible().ok())
    };
    if let Some(window) = accessible {
        if !portal {
            activate(selected)?;
        }
        let target = if let Some(selector) = selector {
            locator(&window, selector)
                .wait_visible(Duration::from_secs(10))
                .map_err(|error| error.to_string())?
        } else {
            window
        };
        let bounds = target
            .bounds
            .ok_or("Screenshot target has no accessibility bounds")?;
        let area = inset_rect(bounds, inset)?;
        xa11y::screenshot_region(area)
            .map_err(|error| error.to_string())?
            .save_png(destination)
            .map_err(|error| error.to_string())?;
    } else {
        let window = selected.wait_native()?;
        window_capture::capture_window(&window.id, inset, destination, true, None)?;
    }
    Ok(())
}

pub fn run(
    root: &Path,
    initial_window: &str,
    steps: &[Value],
    captured_dir: &Path,
) -> Result<RunResult, String> {
    fs::create_dir_all(captured_dir).map_err(|error| error.to_string())?;
    let started = std::time::Instant::now();
    let checkpoint = super::agent::cancellation_checkpoint(root);
    let timeout = super::agent::operation_timeout(300);
    let mut selected = SelectedWindow::new(initial_window);
    let mut launched_window = None;
    let mut captured = Vec::new();
    for (index, step) in steps.iter().enumerate() {
        let (action, value) = step.as_object().unwrap().iter().next().unwrap();
        super::agent::check_cancelled(root, &checkpoint)?;
        if started.elapsed() >= timeout { return Err("撮影手順が制限時間を超えました。".into()); }
        let label = match action.as_str() {
            "launch" => "アプリを起動", "window" => "対象ウィンドウを探して前面へ移動",
            "wait_ms" => "記録された待機", "screenshot" => "画面を撮影",
            "click" => "クリック", "text" | "fill" | "fill_target" => "文字を入力", "key" => "キーを入力",
            "expect_window" => "対象ウィンドウの表示を待機",
            "expect_targets" => "撮影前に目的の画面への到達を確認",
            "expect_hidden" => "対象要素が隠れるまで待機（最大10秒）",
            "expect_enabled" => "対象要素が有効になるまで待機（最大10秒）",
            "expect_disabled" => "対象要素が無効になるまで待機（最大10秒）",
            "expect_focused" => "対象要素のフォーカスを待機（最大10秒）",
            "expect_value" => "対象要素の値を待機（最大10秒）",
            "scroll" | "scroll_into_view" => "スクロール",
            "press" => "ボタンを押す", "focus" => "対象要素へフォーカス",
            "toggle" => "切り替え", "select" => "選択",
            "expect_visible" => "対象要素の表示を待機（最大10秒）",
            _ => action.as_str(),
        };
        let detail = if action == "wait_ms" { format!("（{}秒）", value.as_u64().unwrap_or(0) as f64 / 1000.0) } else { String::new() };
        super::agent::log_progress(root, &format!("操作 {}/{}：{label}{detail}", index + 1, steps.len()));
        let result: Result<(), String> = (|| {
            match action.as_str() {
                "launch" => {
                    let program = value["program"].as_str().unwrap();
                    let args: Vec<&str> = value
                        .get("args")
                        .and_then(Value::as_array)
                        .map(|items| items.iter().filter_map(Value::as_str).collect())
                        .unwrap_or_default();
                    let executable = super::platform::application_executable_in(root, program)?;
                    let mut child = Command::new(executable)
                        .args(args)
                        .current_dir(root)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .map_err(|error| format!("Could not launch {program}: {error}"))?;
                    launched_window = Some(child.id());
                    thread::spawn(move || { let _ = child.wait(); });
                }
                "window" => {
                    let query = value.as_str().unwrap();
                    if query == "portal" && window_capture::is_wayland_session() {
                        selected = SelectedWindow::new(query);
                    } else {
                        // A freshly launched native window may not exist yet. Poll
                        // for it instead of scanning every app's accessibility tree.
                        let located = if launched_window.is_some()
                            && !window_capture::is_wayland_session()
                            && !query.starts_with("pid:")
                            && !query.starts_with("app:")
                        {
                            LocatedWindow::Native(wait_launched_window(query, launched_window.unwrap())?)
                        } else {
                            wait_any_window(query)?
                        };
                        match located {
                            LocatedWindow::Native(window) => {
                                selected = SelectedWindow {
                                    accessible: None,
                                    query: if launched_window.is_some() {
                                        window_capture::window_process_ids()?.into_iter()
                                            .find(|(id, _)| id == &window.id)
                                            .map(|(_, pid)| format!("pid:{pid}:{}", window.title))
                                            .ok_or("Selected application window has no process ID")?
                                    } else { window.title },
                                    native_id: Some(window.id),
                                };
                                activate(&selected)?;
                            }
                            LocatedWindow::Accessible(window) => {
                                let native_id = if window_capture::is_wayland_session() {
                                    None
                                } else {
                                    window
                                        .name
                                        .as_deref()
                                        .and_then(|name| find_window(name).ok())
                                        .map(|native| native.id)
                                };
                                selected = SelectedWindow {
                                    query: query.to_string(),
                                    native_id,
                                    accessible: Some(window),
                                };
                            }
                        }
                    }
                    launched_window = None;
                }
                "expect_window" => {
                    wait_any_window(value.as_str().unwrap())?;
                }
                "expect_visible" => {
                    retry_unavailable_ui_element(Duration::from_secs(10), |remaining| {
                        let window = selected.accessible()?;
                        locator(&window, value.as_str().unwrap())
                            .wait_visible(remaining)
                            .map(|_| ())
                            .map_err(|error| error.to_string())
                    })?;
                }
                "press" | "focus" | "toggle" | "select" | "scroll_into_view"
                | "expect_hidden" | "expect_enabled" | "expect_disabled" | "expect_focused" => {
                    let window = selected.accessible()?;
                    let target = locator(&window, value.as_str().unwrap());
                    match action.as_str() {
                        "press" => target.press().map_err(|error| error.to_string())?,
                        "focus" => target.focus().map_err(|error| error.to_string())?,
                        "toggle" => target.toggle().map_err(|error| error.to_string())?,
                        "select" => target.select().map_err(|error| error.to_string())?,
                        "scroll_into_view" => target
                            .scroll_into_view()
                            .map_err(|error| error.to_string())?,
                        "expect_hidden" => target
                            .wait_hidden(Duration::from_secs(10))
                            .map_err(|error| error.to_string())?,
                        "expect_enabled" => {
                            target
                                .wait_enabled(Duration::from_secs(10))
                                .map_err(|error| error.to_string())?;
                        }
                        "expect_disabled" => {
                            target
                                .wait_disabled(Duration::from_secs(10))
                                .map_err(|error| error.to_string())?;
                        }
                        "expect_focused" => {
                            target
                                .wait_focused(Duration::from_secs(10))
                                .map_err(|error| error.to_string())?;
                        }
                        _ => unreachable!(),
                    }
                }
                "fill" | "expect_value" => {
                    let window = selected.accessible()?;
                    let target = locator(&window, value["selector"].as_str().unwrap());
                    let expected = value["value"].as_str().unwrap();
                    if action == "fill" {
                        target
                            .set_value(expected)
                            .map_err(|error| error.to_string())?;
                    } else {
                        target
                            .wait_until(
                                |element| {
                                    element.and_then(|item| item.value.as_deref()) == Some(expected)
                                },
                                Duration::from_secs(10),
                            )
                            .map_err(|error| error.to_string())?;
                    }
                }
                "scroll" => {
                    let bounds = selected.bounds_for_input()?;
                    let x = value["x"].as_u64().unwrap() as u32;
                    let y = value["y"].as_u64().unwrap() as u32;
                    if x >= bounds.width || y >= bounds.height {
                        return Err("Scroll is outside the selected window".into());
                    }
                    if !window_capture::is_wayland_session() {
                        activate(&selected)?;
                    }
                    let screen_x = bounds
                        .x
                        .checked_add(x as i32)
                        .ok_or("Scroll x coordinate exceeds screen bounds")?;
                    let screen_y = bounds
                        .y
                        .checked_add(y as i32)
                        .ok_or("Scroll y coordinate exceeds screen bounds")?;
                    let dx = value["dx"]
                        .as_i64()
                        .unwrap()
                        .clamp(i32::MIN as i64, i32::MAX as i64)
                        as i32;
                    let dy = value["dy"]
                        .as_i64()
                        .unwrap()
                        .clamp(i32::MIN as i64, i32::MAX as i64)
                        as i32;
                    xa11y::input_sim()
                        .map_err(|error| error.to_string())?
                        .mouse()
                        .scroll(
                            Point::new(screen_x, screen_y),
                            xa11y::ScrollDelta::new(dx, dy),
                        )
                        .map_err(|error| error.to_string())?;
                }
                "click" => {
                    if value.get("target").is_some() || value.get("visual").is_some() {
                        let target: Option<super::semantic_target::Target> = value.get("target").cloned()
                            .map(serde_json::from_value).transpose().map_err(|error| error.to_string())?;
                        let visual: Option<super::visual_target::Target> = value.get("visual").cloned()
                            .map(serde_json::from_value).transpose().map_err(|error| error.to_string())?;
                        let (element, elements) = wait_click_target(&selected, target.as_ref(), visual.as_ref(), root, &checkpoint, started, timeout)?;
                        let name = target.as_ref().map(|target| target.name.as_str()).unwrap_or("画像の対象");
                        if target.as_ref().map(|target| target.needs_click(&elements)).transpose()?.unwrap_or(true) {
                            super::agent::log_progress(root, &format!("「{name}」をクリック"));
                            click_observed(&selected, &element)?;
                        } else {
                            super::agent::log_progress(root, &format!("「{name}」は展開済みです"));
                        }
                        return Ok(());
                    }
                    let bounds = selected.bounds_for_input()?;
                    let x = value["x"].as_u64().unwrap() as u32;
                    let y = value["y"].as_u64().unwrap() as u32;
                    if x >= bounds.width || y >= bounds.height {
                        return Err("Click is outside the selected window".into());
                    }
                    if !window_capture::is_wayland_session() {
                        activate(&selected)?;
                    }
                    let screen_x = bounds
                        .x
                        .checked_add(x as i32)
                        .ok_or("Click x coordinate exceeds screen bounds")?;
                    let screen_y = bounds
                        .y
                        .checked_add(y as i32)
                        .ok_or("Click y coordinate exceeds screen bounds")?;
                    xa11y::input_sim()
                        .map_err(|error| error.to_string())?
                        .mouse()
                        .click(Point::new(screen_x, screen_y))
                        .map_err(|error| error.to_string())?;
                }
                "fill_target" => {
                    let target: super::semantic_target::Target = serde_json::from_value(value["target"].clone())
                        .map_err(|error| error.to_string())?;
                    let visual: Option<super::visual_target::Target> = value.get("visual").cloned()
                        .map(serde_json::from_value).transpose().map_err(|error| error.to_string())?;
                    let (element, _) = wait_click_target(&selected, Some(&target), visual.as_ref(), root, &checkpoint, started, timeout)?;
                    super::agent::log_progress(root, &format!("入力欄「{}」の値を設定", target.name));
                    click_observed(&selected, &element)?;
                    let input = xa11y::input_sim().map_err(|error| error.to_string())?;
                    input.keyboard().chord(Key::Char('a'), &[if cfg!(target_os = "macos") { Key::Meta } else { Key::Ctrl }]).map_err(|error| error.to_string())?;
                    super::agent::check_cancelled(root, &checkpoint)?;
                    let text = value["value"].as_str().unwrap();
                    if text.is_empty() { input.keyboard().chord(Key::Backspace, &[]).map_err(|error| error.to_string())?; }
                    else { input.keyboard().type_text(text).map_err(|error| error.to_string())?; }
                    if element.role == "input" {
                        super::agent::log_progress(root, &format!("入力欄「{}」への反映を確認", target.name));
                        let deadline = Instant::now() + Duration::from_secs(10);
                        let mut reflected_since = None;
                        loop {
                            super::agent::check_cancelled(root, &checkpoint)?;
                            if started.elapsed() >= timeout { return Err("撮影手順が制限時間を超えました。".into()); }
                            let actual = super::semantic_target::input_value(&selected.native()?.id, &target)?;
                            super::agent::check_cancelled(root, &checkpoint)?;
                            if started.elapsed() >= timeout { return Err("撮影手順が制限時間を超えました。".into()); }
                            if actual.as_deref() == Some(text) {
                                let since = reflected_since.get_or_insert_with(Instant::now);
                                if since.elapsed() >= Duration::from_millis(300) { break; }
                            } else { reflected_since = None; }
                            if Instant::now() >= deadline {
                                return Err(format!("入力欄「{}」へ値が反映されていません。", target.name));
                            }
                            thread::sleep(Duration::from_millis(100));
                        }
                    }
                }
                "text" | "key" => {
                    if action == "text" && value.is_object() {
                        let window = selected.accessible()?;
                        let target = locator(&window, value["selector"].as_str().unwrap());
                        target.focus().map_err(|error| error.to_string())?;
                        target
                            .type_text(value["value"].as_str().unwrap())
                            .map_err(|error| error.to_string())?;
                        return Ok(());
                    }
                    if action == "key" && value.is_object() {
                        if !window_capture::is_wayland_session() {
                            activate(&selected)?;
                        }
                        let window = selected.accessible()?;
                        let target = locator(&window, value["selector"].as_str().unwrap());
                        target.focus().map_err(|error| error.to_string())?;
                        target
                            .wait_focused(Duration::from_secs(10))
                            .map_err(|error| error.to_string())?;
                    } else {
                        activate_for_input(&selected)?;
                    }
                    let input = xa11y::input_sim().map_err(|error| error.to_string())?;
                    if action == "text" {
                        input
                            .keyboard()
                            .type_text(value.as_str().unwrap())
                            .map_err(|error| error.to_string())?;
                    } else {
                        let keys =
                            parse_keys(value.as_str().or_else(|| value["keys"].as_str()).unwrap())?;
                        input
                            .keyboard()
                            .chord(keys.last().unwrap().clone(), &keys[..keys.len() - 1])
                            .map_err(|error| error.to_string())?;
                    }
                }
                "expect_targets" => {
                    let targets: Vec<super::semantic_target::Target> = serde_json::from_value(value.clone())
                        .map_err(|error| error.to_string())?;
                    let deadline = Instant::now() + Duration::from_secs(10);
                    loop {
                        super::agent::check_cancelled(root, &checkpoint)?;
                        if started.elapsed() >= timeout { return Err("撮影手順が制限時間を超えました。".into()); }
                        let elements = super::semantic_target::observe_window(&selected.native()?.id)?;
                        super::agent::check_cancelled(root, &checkpoint)?;
                        if started.elapsed() >= timeout { return Err("撮影手順が制限時間を超えました。".into()); }
                        let missing: Vec<_> = targets.iter().filter_map(|target| match target.resolve(&elements) {
                            Ok(Some(_)) => None,
                            Ok(None) => Some(Ok(target.name.clone())),
                            Err(error) => Some(Err(error)),
                        }).collect::<Result<_, _>>()?;
                        if missing.is_empty() { break; }
                        super::agent::log_progress(root, &format!("撮影する画面の表示を待機：{}", missing.join("、")));
                        if Instant::now() >= deadline { return Err(format!("目的の画面に到達していません：{}", missing.join("、"))); }
                        thread::sleep(Duration::from_millis(100));
                    }
                }
                "wait_ms" => {
                    let end=std::time::Instant::now()+Duration::from_millis(value.as_u64().unwrap());
                    while std::time::Instant::now()<end {
                        super::agent::check_cancelled(root,&checkpoint)?;
                        if started.elapsed()>=timeout {return Err("撮影手順が制限時間を超えました。".into());}
                        thread::sleep(Duration::from_millis(50).min(end.saturating_duration_since(std::time::Instant::now())));
                    }
                },
                "screenshot" => {
                    let task_id = value["task"].as_str().unwrap();
                    let inset = value.get("inset").and_then(Value::as_u64).unwrap_or(0) as u32;
                    let expectations = super::capture_validation::read(root, task_id)?;
                    if !expectations.window_title.is_empty() || !expectations.screen_text.is_empty() {
                        let window = selected.native()?;
                        super::capture_validation::check_target(root, task_id, &window.id, &window.title)?;
                    }
                    capture(
                        &selected,
                        value.get("selector").and_then(Value::as_str),
                        inset,
                        &captured_dir.join(format!("{task_id}.png")),
                    )?;
                    captured.push(task_id.to_string());
                }
                _ => unreachable!(),
            }
            Ok(())
        })();
        result.map_err(|error| {
            format!(
                "Desktop scenario step {} ({action}) failed: {error}",
                index + 1
            )
        })?;
    }
    Ok(RunResult {
        captured,
        steps: steps.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn named_click_validation_keeps_legacy_and_rejects_mixed_targets() {
        let dir = tempdir().unwrap();
        assert!(validate(&[serde_json::json!({"click":{"target":{"role":"button","name":"Open"}}})], dir.path()).is_ok());
        assert!(validate(&[serde_json::json!({"click":{"target":{"role":"button","name":""}}})], dir.path()).is_err());
        assert!(validate(&[serde_json::json!({"click":{"target":{"role":"button","name":"Open"},"x":10,"y":20}})], dir.path()).is_err());
        assert!(validate(&[serde_json::json!({"click":{"x":10,"y":20}})], dir.path()).is_ok());
        assert!(validate(&[serde_json::json!({"expect_targets":[{"role":"heading","name":"Nested page"}]})], dir.path()).is_ok());
        assert!(validate(&[serde_json::json!({"expect_targets":[]})], dir.path()).is_err());
        assert!(validate(&[serde_json::json!({"fill_target":{"target":{"role":"input","name":"Project root"},"value":"path"}})], dir.path()).is_ok());
        assert!(validate(&[serde_json::json!({"fill_target":{"target":{"role":"input","name":"Project root"},"value":1}})], dir.path()).is_err());
    }

    #[test]
    fn visible_wait_retries_replaced_uia_node_and_preserves_other_errors() {
        let unavailable = "Platform error (-2147220991): reading UIA control type failed";
        let mut reads = 0;
        let result = retry_unavailable_ui_element(Duration::from_secs(1), |_| {
            reads += 1;
            if reads == 1 { Err(unavailable.into()) } else { Ok("visible") }
        });
        assert_eq!(result.unwrap(), "visible");
        assert_eq!(reads, 2);

        let mut reads = 0;
        let result: Result<(), String> = retry_unavailable_ui_element(Duration::from_secs(1), |_| {
            reads += 1;
            Err("permission denied".into())
        });
        assert_eq!(result.unwrap_err(), "permission denied");
        assert_eq!(reads, 1);

        let result: Result<(), String> = retry_unavailable_ui_element(Duration::ZERO, |_| Err(unavailable.into()));
        assert_eq!(result.unwrap_err(), unavailable);
    }

    #[test]
    fn launched_window_selection_excludes_ide_with_matching_title() {
        let window = |id: &str, title: &str| WindowInfo { id: id.into(), title: title.into(), x: 0, y: 0, width: 1440, height: 940 };
        let windows = vec![window("ide", "Manual Studio"), window("app", "Munin Manual Studio")];
        let owners = vec![("ide".into(), u32::MAX), ("app".into(), std::process::id())];
        assert_eq!(select_launched_window("Manual Studio", &windows, &owners, std::process::id()).unwrap().id, "app");
        assert!(select_launched_window("Manual Studio", &windows[..1], &owners, std::process::id()).is_err());
    }

    #[test]
    fn validates_desktop_scenario_before_input() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("index.md"),
            "<!-- ai:task id=shot kind=screenshot\nCapture the window\n-->\n",
        )
        .unwrap();
        assert!(validate(&[serde_json::json!({"click":{"x":10,"y":20}})], dir.path()).is_ok());
        assert!(validate(
            &[serde_json::json!({"press":"button[name='Save']"})],
            dir.path()
        )
        .is_ok());
        assert!(validate(
            &[serde_json::json!({"fill":{"selector":"text_field[name='Name']","value":""}})],
            dir.path()
        )
        .is_ok());
        assert!(validate(
            &[serde_json::json!({"text":{"selector":"text_field[name='Name']","value":"Ada"}})],
            dir.path()
        )
        .is_ok());
        assert!(validate(
            &[serde_json::json!({"key":{"selector":"text_field[name='Name']","keys":"Ctrl+A"}})],
            dir.path()
        )
        .is_ok());
        assert!(validate(
            &[serde_json::json!({"expect_value":{"selector":"text_field[name='Name']","value":"Ada"}})],
            dir.path()
        ).is_ok());
        assert!(validate(
            &[serde_json::json!({"expect_hidden":"button[name='Close']"})],
            dir.path()
        )
        .is_ok());
        assert!(validate(
            &[serde_json::json!({"press":"button[name='Save'"})],
            dir.path()
        )
        .is_err());
        assert!(validate(
            &[serde_json::json!({"key":{"selector":"button[name='Save']","keys":"Ctrl+NoSuchKey"}})],
            dir.path()
        ).is_err());
        assert!(validate(
            &[serde_json::json!({"screenshot":{"task":"shot","selector":"button[name='Save']"}})],
            dir.path()
        )
        .is_ok());
        assert!(validate(
            &[serde_json::json!({"screenshot":{"task":"shot","selector":"button[name='Save'"}})],
            dir.path()
        )
        .is_err());
        assert!(validate(&[serde_json::json!({"click":{"x":-1,"y":20}})], dir.path()).is_err());
        assert!(validate(&[serde_json::json!({"key":"Ctrl+NoSuchKey"})], dir.path()).is_err());
    }

    #[test]
    fn inset_checks_capture_bounds() {
        let rect = Rect {
            x: 10,
            y: 20,
            width: 30,
            height: 40,
        };
        assert_eq!(
            inset_rect(rect, 5).unwrap(),
            Rect {
                x: 15,
                y: 25,
                width: 20,
                height: 30
            }
        );
        assert!(inset_rect(rect, 15).is_err());
    }
}
