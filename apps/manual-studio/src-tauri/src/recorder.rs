use rdev::{listen, Button, Event, EventType, Key};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RecordedEvent {
    Click {
        elapsed_ms: u64,
        x: f64,
        y: f64,
    },
    Text {
        elapsed_ms: u64,
        value: String,
    },
    Key {
        elapsed_ms: u64,
        value: String,
    },
    Scroll {
        elapsed_ms: u64,
        x: f64,
        y: f64,
        dx: i64,
        dy: i64,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingResult {
    pub screenshot_id: String,
    pub scenario_file: String,
    pub operation_text: String,
    pub source_file: String,
    pub annotation_file: String,
    pub completion_file: String,
    pub events: usize,
    pub markits_started: bool,
    pub message: String,
}

struct Session {
    recorder: Option<Child>,
    app_child: Option<Child>,
    event_file: PathBuf,
    root: PathBuf,
    program: String,
    args: Vec<String>,
    window_title: String,
    window: WindowBounds,
    task_id: String,
    markits_program: String,
}

// Child handles do not terminate their process when dropped. A failed capture
// must therefore close both applications even when an early `?` returns.
impl Drop for Session {
    fn drop(&mut self) {
        if let Some(child) = self.recorder.take() {
            stop_child(child);
        }
        if let Some(child) = self.app_child.take() {
            stop_child(child);
        }
        let _ = fs::remove_file(&self.event_file);
    }
}

fn stop_child(mut child: Child) {
    match child.try_wait() {
        Ok(Some(_)) => return,
        Ok(None) | Err(_) => {
            let _ = child.kill();
        }
    }

    // kill() should end a local child promptly. Avoid an unbounded wait if the
    // OS or child process is in an unusual state; try_wait also reaps it.
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Err(_) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            Ok(None) => break,
        }
    }
    // Child::drop does not wait or reap. Transfer ownership to a background
    // waiter when the process does not exit within the UI-friendly deadline.
    let _ = thread::spawn(move || {
        let _ = child.wait();
    });
}

fn reap_child_in_background(mut child: Child) {
    // MarkIts is intentionally left running for the user. Keep ownership of
    // its handle until it exits so an eventual close cannot leave a zombie.
    let _ = thread::spawn(move || {
        let _ = child.wait();
    });
}

const MARKITS_STARTUP_GRACE: Duration = Duration::from_millis(500);
const MARKITS_POLL_INTERVAL: Duration = Duration::from_millis(20);
const MARKITS_STDERR_TAIL_BYTES: u64 = 4096;

fn launch_markits(mut command: Command, log_path: &Path) -> Result<(), String> {
    let completion_file = command
        .get_args()
        .collect::<Vec<_>>()
        .windows(2)
        .find(|args| args[0] == "--manual-studio-completion")
        .map(|args| PathBuf::from(args[1]));
    let log = File::create(log_path).map_err(|error| {
        format!(
            "MarkIts の起動ログを作成できません: {} ({error})",
            log_path.display()
        )
    })?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|error| {
            format!(
                "MarkIts Desktop を起動できませんでした: {error}。ログ: {}",
                log_path.display()
            )
        })?;

    let deadline = Instant::now() + MARKITS_STARTUP_GRACE;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let tail = read_file_tail(log_path, MARKITS_STDERR_TAIL_BYTES);
                let detail = if tail.trim().is_empty() {
                    "標準エラー出力はありません".to_string()
                } else {
                    format!("標準エラー出力（末尾）:\n{tail}")
                };
                return Err(format!(
                    "MarkIts Desktop が起動直後に終了しました（終了状態: {status}）。{detail}。ログ: {}",
                    log_path.display()
                ));
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(MARKITS_POLL_INTERVAL),
            Ok(None) => {
                let log_path = log_path.to_path_buf();
                thread::spawn(move || {
                    let status = child.wait();
                    if let Some(completion_file) = completion_file.filter(|path| !path.is_file()) {
                        let message = format!("MarkIts Desktop が編集完了前に終了しました（{status:?}）。撮影画像と入力は保持しています。ログ: {}", log_path.display());
                        let _ = fs::write(completion_file.with_extension("exit"), message);
                    }
                });
                return Ok(());
            }
            Err(error) => {
                stop_child(child);
                return Err(format!(
                    "MarkIts Desktop の起動状態を確認できません: {error}。ログ: {}",
                    log_path.display()
                ));
            }
        }
    }
}

fn read_file_tail(path: &Path, max_bytes: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = File::open(path) else {
        return String::new();
    };
    let Ok(length) = file.metadata().map(|metadata| metadata.len()) else {
        return String::new();
    };
    let start = length.saturating_sub(max_bytes);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut bytes = Vec::with_capacity((length - start) as usize);
    if file.read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

#[derive(Clone)]
struct WindowBounds {
    id: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Default, Clone)]
pub struct RecorderState(Arc<Mutex<RecorderInner>>);

#[derive(Default)]
struct RecorderInner {
    session: Option<Session>,
    starting: bool,
}

struct StartReservation(Arc<Mutex<RecorderInner>>);

impl Drop for StartReservation {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.lock() {
            state.starting = false;
        }
    }
}

pub fn run_helper(path: &Path) -> Result<(), String> {
    let file = File::create(path).map_err(|error| error.to_string())?;
    let output = Arc::new(Mutex::new(BufWriter::new(file)));
    let started = Instant::now();
    let mut ctrl = false;
    let mut shift = false;
    let mut alt = false;
    let mut meta = false;
    let mut paused = false;
    let mut pointer = (0.0, 0.0);
    let writer = Arc::clone(&output);
    let callback = move |event: Event| {
        let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        let key_state = match event.event_type {
            EventType::KeyPress(key) => Some((key, true)),
            EventType::KeyRelease(key) => Some((key, false)),
            _ => None,
        };
        if let Some((key, down)) = key_state {
            match key {
                Key::ControlLeft | Key::ControlRight => ctrl = down,
                Key::ShiftLeft | Key::ShiftRight => shift = down,
                Key::Alt | Key::AltGr => alt = down,
                Key::MetaLeft | Key::MetaRight => meta = down,
                _ => {}
            }
            if down && ctrl && shift && key == Key::F10 {
                std::process::exit(0);
            }
            if down && ctrl && shift && key == Key::F9 {
                paused = !paused;
                return;
            }
            if !down || paused || is_modifier(key) {
                return;
            }
            let chord = [
                if ctrl { Some("Control") } else { None },
                if alt { Some("Alt") } else { None },
                if meta { Some("Meta") } else { None },
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
            let special = key_name(key);
            let value = if let Some(name) = special {
                Some(if chord.is_empty() {
                    name.to_string()
                } else {
                    format!("{}+{}", chord.join("+"), name)
                })
            } else {
                event
                    .name
                    .as_deref()
                    .filter(|name| !name.is_empty() && name.chars().all(|c| !c.is_control()))
                    .map(|name| {
                        if chord.is_empty() {
                            name.to_string()
                        } else {
                            format!("{}+{}", chord.join("+"), name)
                        }
                    })
            };
            if let Some(value) = value {
                let event = if special.is_none() && chord.is_empty() {
                    RecordedEvent::Text { elapsed_ms, value }
                } else {
                    RecordedEvent::Key { elapsed_ms, value }
                };
                write_event(&writer, event);
            }
            return;
        }
        if paused {
            return;
        }
        let recorded = match event.event_type {
            EventType::MouseMove { x, y } => {
                pointer = (x, y);
                None
            }
            EventType::ButtonPress(Button::Left) => Some(RecordedEvent::Click {
                elapsed_ms,
                x: pointer.0,
                y: pointer.1,
            }),
            EventType::Wheel { delta_x, delta_y } => Some(RecordedEvent::Scroll {
                elapsed_ms,
                x: pointer.0,
                y: pointer.1,
                dx: delta_x,
                dy: delta_y,
            }),
            _ => None,
        };
        if let Some(event) = recorded {
            write_event(&writer, event);
        }
    };
    listen(callback).map_err(|error| format!("入力記録を開始できませんでした: {error:?}"))
}

fn write_event(writer: &Arc<Mutex<BufWriter<File>>>, event: RecordedEvent) {
    if let Ok(mut writer) = writer.lock() {
        if serde_json::to_writer(&mut *writer, &event).is_ok() {
            let _ = writer.write_all(b"\n");
            let _ = writer.flush();
        }
    }
}

fn is_modifier(key: Key) -> bool {
    matches!(
        key,
        Key::ControlLeft
            | Key::ControlRight
            | Key::ShiftLeft
            | Key::ShiftRight
            | Key::Alt
            | Key::AltGr
            | Key::MetaLeft
            | Key::MetaRight
    )
}

fn key_name(key: Key) -> Option<&'static str> {
    Some(match key {
        Key::Return | Key::KpReturn => "Enter",
        Key::Escape => "Escape",
        Key::Tab => "Tab",
        Key::Backspace => "Backspace",
        Key::Delete => "Delete",
        Key::Space => "Space",
        Key::UpArrow => "Up",
        Key::DownArrow => "Down",
        Key::LeftArrow => "Left",
        Key::RightArrow => "Right",
        Key::Home => "Home",
        Key::End => "End",
        Key::PageUp => "PageUp",
        Key::PageDown => "PageDown",
        Key::F1 => "F1",
        Key::F2 => "F2",
        Key::F3 => "F3",
        Key::F4 => "F4",
        Key::F5 => "F5",
        Key::F6 => "F6",
        Key::F7 => "F7",
        Key::F8 => "F8",
        Key::F9 => "F9",
        Key::F10 => "F10",
        Key::F11 => "F11",
        Key::F12 => "F12",
        _ => return None,
    })
}

pub fn start(
    state: &RecorderState,
    root: String,
    program: String,
    args: Vec<String>,
    window_title: String,
    task_id: String,
    markits_program: String,
) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    if std::env::var("WAYLAND_DISPLAY").is_ok()
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|s| s.eq_ignore_ascii_case("wayland"))
    {
        return Err(
            "操作記録は現在 X11 セッションで利用できます。Wayland では入力記録が許可されません。"
                .into(),
        );
    }
    let reservation = {
        let mut inner = state.0.lock().map_err(|e| e.to_string())?;
        if inner.session.is_some() || inner.starting {
            return Err("すでに操作を記録中、または起動処理中です。".into());
        }
        inner.starting = true;
        StartReservation(Arc::clone(&state.0))
    };
    if program.trim().is_empty() || task_id.trim().is_empty() {
        return Err("起動アプリと指示IDを入力してください。".into());
    }
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err("プロジェクトフォルダーが見つかりません。".into());
    }
    let before_raw =
        crate::native_worker::request(json!({"root": root.clone(), "action": "list-windows"}))?;
    let before_windows: Vec<Value> =
        serde_json::from_str(&before_raw).map_err(|error| error.to_string())?;
    let existing_ids: HashSet<String> = before_windows
        .iter()
        .filter_map(|window| window["id"].as_str().map(str::to_owned))
        .collect();
    let executable = manual_core::platform::application_executable_in(&root_path, &program)?;
    let mut app = Command::new(&executable)
        .args(&args)
        .current_dir(&root_path)
        .stdin(Stdio::null())
        .spawn()
        .map_err(|error| format!("アプリを起動できません: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut reused_window = false;
    let window_result = (|| -> Result<(WindowBounds, String), String> {
        loop {
            let raw = match crate::native_worker::request(
                json!({"root": root.clone(), "action": "list-windows"}),
            ) {
                Ok(raw) => raw,
                Err(error) => return Err(format!("起動ウィンドウを確認できません: {error}")),
            };
            let windows: Vec<Value> = serde_json::from_str(&raw)
                .map_err(|error| format!("ウィンドウ一覧を読み取れません: {error}"))?;
            let app_ids = if window_title.trim().is_empty() {
                launched_app_window_ids(
                    &crate::native_worker::window_processes()?,
                    &executable,
                    app.id(),
                )
            } else {
                HashSet::new()
            };
            if let Some(found) =
                select_launched_window(&windows, &existing_ids, &window_title, &app_ids)
            {
                reused_window = found["id"]
                    .as_str()
                    .is_some_and(|id| existing_ids.contains(id));
                return Ok((
                    WindowBounds {
                        id: found["id"].as_str().unwrap_or_default().to_string(),
                        x: found["x"].as_i64().unwrap_or(0) as i32,
                        y: found["y"].as_i64().unwrap_or(0) as i32,
                        width: found["width"].as_u64().unwrap_or(0) as u32,
                        height: found["height"].as_u64().unwrap_or(0) as u32,
                    },
                    found["title"].as_str().unwrap_or_default().to_string(),
                ));
            }
            if Instant::now() >= deadline {
                return Err(if window_title.trim().is_empty() {
                    "起動したアプリのウィンドウを30秒以内に自動検出できませんでした。アプリのパスと起動引数を確認してください。".into()
                } else {
                    format!("「{window_title}」ウィンドウが30秒以内に見つかりませんでした。")
                });
            }
            if let Some(status) = app
                .try_wait()
                .map_err(|error| format!("起動アプリの状態を確認できません: {error}"))?
            {
                if status.success() {
                    let processes = crate::native_worker::window_processes()?;
                    if let Some(found) = select_existing_app_window(
                        &windows,
                        &processes,
                        &executable.to_string_lossy(),
                    ) {
                        reused_window = true;
                        return Ok((
                            WindowBounds {
                                id: found["id"].as_str().unwrap_or_default().to_string(),
                                x: found["x"].as_i64().unwrap_or(0) as i32,
                                y: found["y"].as_i64().unwrap_or(0) as i32,
                                width: found["width"].as_u64().unwrap_or(0) as u32,
                                height: found["height"].as_u64().unwrap_or(0) as u32,
                            },
                            found["title"].as_str().unwrap_or_default().to_string(),
                        ));
                    }
                }
                if !status.success() {
                    return Err(format!("起動アプリがウィンドウを開く前に終了しました ({status})。起動コマンドと引数を確認してください。"));
                }
                // Single-instance launchers can exit before their existing window
                // is ready. Keep polling until the original deadline.
            }
            thread::sleep(Duration::from_millis(500));
        }
    })();
    let (window, window_title) = match window_result {
        Ok(result) => result,
        Err(error) => {
            stop_child(app);
            return Err(error);
        }
    };
    let nonce = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(value) => value.as_nanos(),
        Err(error) => {
            stop_child(app);
            return Err(error.to_string());
        }
    };
    let event_file = std::env::temp_dir().join(format!(
        "manual-studio-recorder-{}-{nonce}.jsonl",
        std::process::id()
    ));
    let recorder = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => {
            stop_child(app);
            return Err(error.to_string());
        }
    };
    let child = match Command::new(recorder)
        .arg("--manual-studio-record-input")
        .arg(&event_file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            stop_child(app);
            return Err(format!("入力記録プロセスを起動できません: {error}"));
        }
    };
    // The annotation editor is linked into this executable. Keep the RPC
    // argument for compatibility with existing frontends, but never launch an
    // independently installed executable.
    let _ = markits_program;
    let markits_program = std::env::current_exe()
        .map_err(|error| format!("注釈エディタの実行ファイルを確認できません: {error}"))?
        .to_string_lossy()
        .into_owned();
    let mut lock = match state.0.lock() {
        Ok(lock) => lock,
        Err(error) => {
            stop_child(child);
            stop_child(app);
            return Err(error.to_string());
        }
    };
    if lock.session.is_some() {
        drop(lock);
        stop_child(child);
        stop_child(app);
        return Err("別の操作記録が先に開始されました。".into());
    }
    let app_child = if reused_window {
        reap_child_in_background(app);
        None
    } else {
        Some(app)
    };
    lock.session = Some(Session {
        recorder: Some(child),
        app_child,
        event_file,
        root: root_path,
        program,
        args,
        window_title,
        window,
        task_id,
        markits_program,
    });
    lock.starting = false;
    drop(lock);
    drop(reservation);
    Ok("対象アプリを起動しました。操作後 Ctrl+Shift+F10 で記録を終了します。Ctrl+Shift+F9 で一時停止できます。".into())
}

fn select_launched_window<'a>(
    windows: &'a [Value],
    existing_ids: &HashSet<String>,
    requested_title: &str,
    app_window_ids: &HashSet<String>,
) -> Option<&'a Value> {
    if !requested_title.trim().is_empty() {
        return windows
            .iter()
            .find(|window| {
                window["title"]
                    .as_str()
                    .is_some_and(|title| title.eq_ignore_ascii_case(requested_title))
            })
            .or_else(|| {
                windows.iter().find(|window| {
                    window["title"].as_str().is_some_and(|title| {
                        title
                            .to_lowercase()
                            .contains(&requested_title.to_lowercase())
                    })
                })
            });
    }
    windows
        .iter()
        .filter(|window| {
            window["id"]
                .as_str()
                .is_some_and(|id| !existing_ids.contains(id) && app_window_ids.contains(id))
                && window["width"].as_u64().unwrap_or(0) >= 120
                && window["height"].as_u64().unwrap_or(0) >= 80
        })
        .max_by_key(|window| {
            window["width"].as_u64().unwrap_or(0) * window["height"].as_u64().unwrap_or(0)
        })
}

fn process_descends_from(mut pid: u32, launched_pid: u32) -> bool {
    for _ in 0..64 {
        if pid == launched_pid {
            return true;
        }
        #[cfg(target_os = "linux")]
        {
            let Some(parent) = fs::read_to_string(format!("/proc/{pid}/stat"))
                .ok()
                .and_then(|stat| stat.rsplit_once(')').map(|(_, fields)| fields.to_string()))
                .and_then(|fields| fields.split_whitespace().nth(1)?.parse::<u32>().ok())
            else {
                return false;
            };
            if parent == 0 || parent == pid {
                return false;
            }
            pid = parent;
        }
        #[cfg(not(target_os = "linux"))]
        return false;
    }
    false
}

fn launched_app_window_ids(
    processes: &[markits::ui_elements::DetectedUiElement],
    executable: &Path,
    launched_pid: u32,
) -> HashSet<String> {
    let executable = executable.canonicalize().ok();
    processes
        .iter()
        .filter_map(|window| {
            let pid = window.pid?;
            let same_executable = executable.as_ref().is_some_and(|expected| {
                manual_core::platform::process_executable(pid)
                    .and_then(|path| path.canonicalize().ok())
                    .as_ref()
                    == Some(expected)
            });
            if !process_descends_from(pid, launched_pid) && !same_executable {
                return None;
            }
            let raw_id = window.window_id.as_deref()?;
            let id = if let Some(hex) = raw_id.strip_prefix("0x") {
                u64::from_str_radix(hex, 16).ok()?
            } else {
                raw_id.parse::<u64>().ok()?
            };
            Some(format!("0x{id:x}"))
        })
        .collect()
}

fn select_existing_app_window<'a>(
    windows: &'a [Value],
    processes: &[markits::ui_elements::DetectedUiElement],
    program: &str,
) -> Option<&'a Value> {
    let executable = manual_core::platform::application_executable(program)
        .ok()?
        .canonicalize()
        .ok()?;
    let matching_ids: HashSet<String> = processes
        .iter()
        .filter_map(|window| {
            let pid = window.pid?;
            let process_executable = manual_core::platform::process_executable(pid)?
                .canonicalize()
                .ok()?;
            if process_executable != executable {
                return None;
            }
            let id = window.window_id.as_deref()?.parse::<u64>().ok()?;
            Some(format!("0x{id:x}"))
        })
        .collect();
    windows
        .iter()
        .filter(|window| {
            window["id"]
                .as_str()
                .is_some_and(|id| matching_ids.contains(id))
                && window["width"].as_u64().unwrap_or(0) >= 120
                && window["height"].as_u64().unwrap_or(0) >= 80
        })
        .max_by_key(|window| {
            window["width"].as_u64().unwrap_or(0) * window["height"].as_u64().unwrap_or(0)
        })
}

pub fn is_running(state: &RecorderState) -> Result<bool, String> {
    let mut lock = state.0.lock().map_err(|e| e.to_string())?;
    let Some(session) = lock.session.as_mut() else {
        return Ok(false);
    };
    Ok(session
        .recorder
        .as_mut()
        .ok_or("入力記録プロセスがありません")?
        .try_wait()
        .map_err(|e| e.to_string())?
        .is_none())
}

#[cfg(test)]
pub fn finish(state: &RecorderState) -> Result<RecordingResult, String> {
    finish_excluding_control(state, None)
}

pub fn finish_excluding_control(
    state: &RecorderState,
    control_bounds: Option<(f64, f64, f64, f64)>,
) -> Result<RecordingResult, String> {
    let mut session = state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .session
        .take()
        .ok_or("操作記録がありません")?;
    if let Some(child) = session.recorder.take() {
        stop_child(child);
    }
    let mut events = read_events(&session.event_file)?;
    if events.is_empty() {
        return Err("記録された操作がありません。".into());
    }
    if let Some((left, top, width, height)) = control_bounds {
        events.retain(|event| {
            !matches!(event, RecordedEvent::Click { x, y, .. }
            if *x >= left && *x < left + width && *y >= top && *y < top + height)
        });
    }
    let scenario = build_scenario(&session, &events);
    let operation_text = events_to_text(&events, &session.window);
    let scenario_dir = session.root.join("manual/scenarios");
    fs::create_dir_all(&scenario_dir).map_err(|e| e.to_string())?;
    let file_name = format!("recorded-{}.json", session.task_id);
    let scenario_path = scenario_dir.join(&file_name);
    fs::write(
        &scenario_path,
        serde_json::to_vec_pretty(&scenario).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let handoff_dir = std::env::temp_dir().join("manual-studio-markits");
    fs::create_dir_all(&handoff_dir).map_err(|e| e.to_string())?;
    let screenshot_path = handoff_dir.join(format!("{}-{nonce}-source.png", session.task_id));
    let annotation_path = handoff_dir.join(format!("{}-{nonce}-annotated.png", session.task_id));
    let completion_path = handoff_dir.join(format!("{}-{nonce}.done", session.task_id));
    // Attach accessibility data from the selected app only; avoid scanning unrelated windows.
    crate::native_worker::capture_window(
        &session.window.id,
        &screenshot_path,
        session.app_child.is_some(),
    )?;
    use base64::Engine;
    let original_bytes = fs::read(&screenshot_path).map_err(|e| e.to_string())?;
    let registered = manual_core::screenshots::register(
        &session.root,
        &json!({
            "id": if session.task_id.starts_with("shot-") { Some(session.task_id.clone()) } else { None },
            "source": base64::engine::general_purpose::STANDARD.encode(&original_bytes),
            "recipe": scenario, "adopt": false
        }),
    )?;
    let screenshot_id = registered["screenshot"]["id"]
        .as_str()
        .ok_or("画像の保存に失敗しました。")?
        .to_owned();
    if let Some(child) = session.app_child.take() {
        stop_child(child);
    }
    let log_path = handoff_dir.join(format!("{}-{nonce}-markits.log", session.task_id));
    let mut command = Command::new(&session.markits_program);
    command
        .arg("--manual-studio-annotate")
        .arg("--manual-studio-input")
        .arg(&screenshot_path)
        .arg("--manual-studio-output")
        .arg(&annotation_path)
        .arg("--manual-studio-completion")
        .arg(&completion_path);
    let markits_result = launch_markits(command, &log_path);
    let (markits_started, message) = match markits_result {
        Ok(()) => (true, "操作シナリオを保存し、撮影画像をMarkIts Desktopで開きました。注釈を保存するとスクリーンショット一覧へ取り込みます。".into()),
        Err(error) => (false, format!("操作シナリオと撮影画像は保存しましたが、MarkIts Desktop を起動できませんでした。{error}")),
    };
    Ok(RecordingResult {
        screenshot_id,
        scenario_file: format!("manual/scenarios/{file_name}"),
        operation_text,
        source_file: screenshot_path.to_string_lossy().into_owned(),
        annotation_file: annotation_path.to_string_lossy().into_owned(),
        completion_file: completion_path.to_string_lossy().into_owned(),
        events: events.len(),
        markits_started,
        message,
    })
}

fn events_to_text(events: &[RecordedEvent], window: &WindowBounds) -> String {
    events
        .iter()
        .enumerate()
        .map(|(index, event)| match event {
            RecordedEvent::Click { x, y, .. } => format!(
                "{}. クリック: ({}, {})",
                index + 1,
                (*x as i32 - window.x).max(0),
                (*y as i32 - window.y).max(0)
            ),
            RecordedEvent::Text { value, .. } => format!("{}. テキスト入力: {}", index + 1, value),
            RecordedEvent::Key { value, .. } => format!("{}. キー入力: {}", index + 1, value),
            RecordedEvent::Scroll { dx, dy, .. } => {
                format!("{}. スクロール: 横 {}・縦 {}", index + 1, dx, dy)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn read_events(path: &Path) -> Result<Vec<RecordedEvent>, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    BufReader::new(file)
        .lines()
        .filter_map(|line| match line {
            Ok(line) if !line.trim().is_empty() => {
                Some(serde_json::from_str(&line).map_err(|error| error.to_string()))
            }
            Ok(_) => None,
            Err(error) => Some(Err(error.to_string())),
        })
        .collect()
}

fn build_scenario(session: &Session, events: &[RecordedEvent]) -> Value {
    let mut steps = vec![
        json!({"launch": {"program": session.program, "args": session.args}}),
        json!({"window": session.window_title}),
    ];
    let mut text_buffer = String::new();
    let flush_text = |steps: &mut Vec<Value>, text: &mut String| {
        if !text.is_empty() {
            steps.push(json!({"text": text}));
            text.clear();
        }
    };
    for event in events {
        match event {
            RecordedEvent::Text { value, .. } => text_buffer.push_str(value),
            RecordedEvent::Key { value, .. } => {
                flush_text(&mut steps, &mut text_buffer);
                steps.push(json!({"key":value}));
            }
            RecordedEvent::Click { x, y, .. } => {
                flush_text(&mut steps, &mut text_buffer);
                let x = (*x as i32 - session.window.x).max(0) as u32;
                let y = (*y as i32 - session.window.y).max(0) as u32;
                if x < session.window.width && y < session.window.height {
                    steps.push(json!({"click":{"x":x,"y":y}}));
                }
            }
            RecordedEvent::Scroll { x, y, dx, dy, .. } => {
                flush_text(&mut steps, &mut text_buffer);
                let x = (*x as i32 - session.window.x).max(0) as u32;
                let y = (*y as i32 - session.window.y).max(0) as u32;
                if x < session.window.width && y < session.window.height {
                    steps.push(json!({"scroll":{"x":x,"y":y,"dx":dx,"dy":dy}}));
                }
            }
        }
    }
    flush_text(&mut steps, &mut text_buffer);
    steps.push(json!({"screenshot":{"task":session.task_id}}));
    json!({"version":1,"platform":"desktop","window":session.window_title,"steps":steps})
}

pub fn clone_scenario_for_task(
    root: String,
    input: String,
    task_id: String,
) -> Result<String, String> {
    if !task_id
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_lowercase())
        || !task_id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err("撮影指示IDが不正です。".into());
    }
    let relative = Path::new(&input);
    if !input.starts_with("manual/scenarios/")
        || !input.ends_with(".json")
        || relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err("シナリオは manual/scenarios/ 内の JSON を指定してください。".into());
    }
    let root = PathBuf::from(root);
    let mut scenario: Value =
        serde_json::from_slice(&fs::read(root.join(relative)).map_err(|e| e.to_string())?)
            .map_err(|e| format!("シナリオJSONを読み取れません: {e}"))?;
    if scenario["version"].as_u64() != Some(1) || scenario["platform"].as_str() != Some("desktop") {
        return Err("読み込めるのは version 1 のデスクトップシナリオです。".into());
    }
    let steps = scenario["steps"]
        .as_array_mut()
        .ok_or("シナリオに操作手順がありません。")?;
    let screenshot = steps
        .iter_mut()
        .rev()
        .find_map(|step| step.get_mut("screenshot"))
        .ok_or("シナリオに撮影手順がありません。")?;
    screenshot["task"] = Value::String(task_id.clone());
    let destination = root.join("manual/scenarios");
    fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let file_name = format!("replay-{task_id}-{nonce}.json");
    fs::write(
        destination.join(&file_name),
        serde_json::to_vec_pretty(&scenario).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(format!("manual/scenarios/{file_name}"))
}

pub fn import_annotation_spec() -> Result<Option<String>, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_title("MarkIts のアノテーション出力 JSON を選択")
        .add_filter("MarkIts 出力", &["png", "json"])
        .pick_file()
    else {
        return Ok(None);
    };
    let raw = read_annotation_file(&path)?;
    normalize_annotation_spec(&raw).map(Some)
}

pub fn read_annotation_file(path: &Path) -> Result<String, String> {
    if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
    {
        let bytes = fs::read(path).map_err(|error| error.to_string())?;
        return markits::raster::read_png_text_chunk(&bytes, "markits:annotations")
            .map_err(|error| error.to_string())?.ok_or("PNGにMarkItsアノテーションがありません。MarkIts Desktopで注釈を付けてPNG保存してください。".into());
    }
    fs::read_to_string(path).map_err(|error| error.to_string())
}

pub fn annotation_if_complete(
    source_file: &str,
    annotation_file: &str,
    completion_file: &str,
) -> Result<Option<String>, String> {
    let marker = Path::new(completion_file);
    if !marker.is_file() {
        let exit_marker = marker.with_extension("exit");
        if exit_marker.is_file() {
            return Err(fs::read_to_string(exit_marker).unwrap_or_else(|_| {
                "MarkIts Desktop が編集完了前に終了しました。撮影画像と入力は保持しています。"
                    .into()
            }));
        }
        return Ok(None);
    }
    let annotation = read_annotation_file(Path::new(annotation_file))?;
    // Closing the MarkIts editor completes the capture even when the user
    // drew no marks. Keep that distinct from importing an annotation spec,
    // where an empty spec is almost certainly an accidental selection.
    let normalized = normalize_annotation_spec_for_capture(&annotation)?;
    // Keep completion markers until adoption so a failed import can retry.
    // Original staging file remains available for completion retries.
    let _ = source_file;
    Ok(Some(normalized))
}

pub fn preserve_annotated_capture(
    root: &str,
    page: &str,
    task_id: &str,
    image_file: &str,
    prompt: &str,
) -> Result<String, String> {
    if !task_id
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_lowercase())
        || !task_id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err("撮影指示IDが不正です。".into());
    }
    let root = Path::new(root);
    let page_path = manual_core::editor::document_path(root, page)?;
    if !page_path.is_file() {
        return Err(format!("原稿が見つかりません: {}", page_path.display()));
    }
    let image_path = Path::new(image_file);
    let bytes = fs::read(image_path).map_err(|e| format!("MarkIts画像を読み取れません: {e}"))?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("MarkIts出力がPNG画像ではありません。".into());
    }
    let (initial_asset, _) = manual_core::config::asset_destination(
        root,
        &page_path,
        &format!("markits-{task_id}.png"),
    )?;
    let asset_dir = initial_asset
        .parent()
        .ok_or("Invalid asset destination")?
        .to_path_buf();
    fs::create_dir_all(&asset_dir).map_err(|e| e.to_string())?;
    let base_filename = format!("markits-{task_id}.png");
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let base_path = asset_dir.join(&base_filename);
    let mut filename = match fs::read(&base_path) {
        Ok(existing) if existing != bytes => format!("markits-{task_id}-{digest}.png"),
        Ok(_) => base_filename.clone(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => base_filename.clone(),
        Err(error) => return Err(error.to_string()),
    };

    // Stage once, then publish with an atomic no-replace hard link. If a
    // different capture wins the base-name race, retry under the content hash.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temporary = asset_dir.join(format!(
        ".{base_filename}.tmp-{}-{nonce}",
        std::process::id()
    ));
    let mut staged = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|e| format!("一時画像を作成できません: {e}"))?;
    if let Err(error) = staged.write_all(&bytes).and_then(|_| staged.sync_all()) {
        drop(staged);
        let _ = fs::remove_file(&temporary);
        return Err(format!("MarkIts画像を一時保存できません: {error}"));
    }
    drop(staged);
    loop {
        let asset_path = asset_dir.join(&filename);
        match publish_image(&temporary, &asset_path, &bytes, |source, destination| {
            fs::hard_link(source, destination)
        }) {
            Ok(()) => break,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let existing = match fs::read(&asset_path) {
                    Ok(existing) => existing,
                    Err(read_error) => {
                        let _ = fs::remove_file(&temporary);
                        return Err(read_error.to_string());
                    }
                };
                if existing == bytes {
                    break;
                }
                if filename == base_filename {
                    filename = format!("markits-{task_id}-{digest}.png");
                } else {
                    let _ = fs::remove_file(&temporary);
                    return Err(format!(
                        "撮影画像のハッシュ名が既存画像と衝突しました: {}",
                        asset_path.display()
                    ));
                }
            }
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                return Err(format!("撮影画像を確定できません: {error}"));
            }
        }
    }
    fs::remove_file(&temporary).map_err(|e| format!("一時画像を削除できません: {e}"))?;
    let (_, relative_image) = manual_core::config::asset_destination(root, &page_path, &filename)?;
    let prompt_attr = manual_core::task::escape_prompt(prompt);
    let block = format!("<!-- ai:task id={task_id} kind=screenshot prompt=\"{prompt_attr}\" -->\n![撮影画面]({relative_image})\n<!-- /ai:task -->");
    Ok(block)
}

/// Filesystems such as exFAT do not support hard links. create_new preserves
/// the no-overwrite guarantee there, and incomplete copies are removed.
fn publish_image(
    source: &Path,
    destination: &Path,
    bytes: &[u8],
    link: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    match link(source, destination) {
        Ok(()) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Err(error),
        Err(_) => {}
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let result = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if result.is_err() {
        let _ = fs::remove_file(destination);
    }
    result
}

pub fn normalize_annotation_spec(raw: &str) -> Result<String, String> {
    normalize_annotation_spec_inner(raw, false)
}

fn normalize_annotation_spec_for_capture(raw: &str) -> Result<String, String> {
    normalize_annotation_spec_inner(raw, true)
}

fn normalize_annotation_spec_inner(raw: &str, allow_empty: bool) -> Result<String, String> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|error| format!("MarkIts JSON を読み取れません: {error}"))?;
    let annotations = value
        .get("annotations")
        .and_then(Value::as_array)
        .ok_or("MarkIts の出力に annotations がありません")?;
    if annotations.is_empty() && !allow_empty {
        return Err("MarkIts の出力にアノテーションがありません。".into());
    }
    let mut result = serde_json::Map::new();
    if let Some(canvas) = value.get("canvas") {
        result.insert("canvas".into(), canvas.clone());
    }
    result.insert("annotations".into(), Value::Array(annotations.clone()));
    serde_json::to_string_pretty(&Value::Object(result)).map_err(|e| e.to_string())
}

pub fn cleanup_completed_capture(image_file: &str) -> Result<(), String> {
    let path = Path::new(image_file);
    if path
        .parent()
        .and_then(Path::file_name)
        .is_none_or(|name| name != "manual-studio-markits")
        || path
            .file_name()
            .is_none_or(|name| !name.to_string_lossy().ends_with("-annotated.png"))
    {
        return Err("一時撮影画像のパスが不正です。".into());
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("一時撮影画像を削除できません: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "manual-studio-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn capture_publication_without_hard_links_preserves_existing_images() {
        let dir = test_dir("image-copy-fallback");
        let source = dir.join("source.png");
        let destination = dir.join("capture.png");
        fs::write(&source, b"new image").unwrap();
        let unsupported =
            |_: &Path, _: &Path| Err(std::io::Error::from(std::io::ErrorKind::Unsupported));
        publish_image(&source, &destination, b"new image", unsupported).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"new image");
        let error = publish_image(&source, &destination, b"replacement", unsupported).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&destination).unwrap(), b"new image");
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn markits_early_exit_reports_status_stderr_and_keeps_log() {
        let dir = test_dir("markits-early-exit");
        let log = dir.join("markits.log");
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "echo startup-failure >&2; exit 17"]);
        let error = launch_markits(command, &log).unwrap_err();
        assert!(error.contains("17"), "{error}");
        assert!(error.contains("startup-failure"), "{error}");
        assert!(error.contains(log.to_str().unwrap()), "{error}");
        assert!(log.exists());
    }

    #[cfg(unix)]
    #[test]
    fn markits_late_exit_stops_annotation_wait_and_preserves_capture() {
        let dir = test_dir("markits-late-exit");
        let source = dir.join("source.png");
        fs::write(&source, b"original capture").unwrap();
        let completion = dir.join("capture.done");
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 0.7; exit 19", "--manual-studio-completion"]);
        command.arg(&completion);
        launch_markits(command, &dir.join("markits.log")).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match annotation_if_complete(
                source.to_str().unwrap(),
                dir.join("annotated.png").to_str().unwrap(),
                completion.to_str().unwrap(),
            ) {
                Err(error) => {
                    assert!(error.contains("編集完了前"));
                    break;
                }
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
                other => panic!("missing exit notification: {other:?}"),
            }
        }
        assert_eq!(fs::read(source).unwrap(), b"original capture");
    }

    #[cfg(unix)]
    #[test]
    fn markits_running_child_is_reaped_after_exit() {
        let dir = test_dir("markits-reap");
        let log = dir.join("markits.log");
        let pid_file = dir.join("pid");
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            &format!("echo $$ > '{}'; sleep 0.7", pid_file.display()),
        ]);
        launch_markits(command, &log).unwrap();
        let pid: u32 = fs::read_to_string(pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Path::new(&format!("/proc/{pid}")).exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !Path::new(&format!("/proc/{pid}")).exists(),
            "child {pid} was not reaped"
        );
    }

    #[test]
    fn markits_capture_import_is_retryable_and_preserves_source_until_completion() {
        let root = test_dir("capture-retry");
        let page = root.join("docs/guide.md");
        fs::create_dir_all(page.parent().unwrap()).unwrap();
        fs::write(&page, "# Guide\n").unwrap();
        let source = root.join("annotated.png");
        let bytes = b"\x89PNG\r\n\x1a\nsmoke-image";
        fs::write(&source, bytes).unwrap();

        let first = preserve_annotated_capture(
            root.to_str().unwrap(),
            "docs/guide.md",
            "screen-one",
            source.to_str().unwrap(),
            "annotated",
        )
        .unwrap();
        let retry = preserve_annotated_capture(
            root.to_str().unwrap(),
            "docs/guide.md",
            "screen-one",
            source.to_str().unwrap(),
            "annotated",
        )
        .unwrap();
        assert_eq!(first, retry);
        assert!(
            source.is_file(),
            "staged MarkIts image must survive until the complete workflow succeeds"
        );
        assert_eq!(
            fs::read(root.join("docs/assets/markits-screen-one.png")).unwrap(),
            bytes
        );
        assert!(first.contains("ai:task id=screen-one kind=screenshot"));

        let different = root.join("different.png");
        fs::write(&different, b"\x89PNG\r\n\x1a\ndifferent").unwrap();
        let different_block = preserve_annotated_capture(
            root.to_str().unwrap(),
            "docs/guide.md",
            "screen-one",
            different.to_str().unwrap(),
            "annotated",
        )
        .unwrap();
        let different_retry = preserve_annotated_capture(
            root.to_str().unwrap(),
            "docs/guide.md",
            "screen-one",
            different.to_str().unwrap(),
            "annotated",
        )
        .unwrap();
        assert_eq!(different_block, different_retry);
        assert!(different_block.contains("assets/markits-screen-one-"));
        assert_ne!(different_block, first);
        assert_eq!(
            fs::read(root.join("docs/assets/markits-screen-one.png")).unwrap(),
            bytes,
            "the original capture must remain unchanged"
        );
        let hashed_asset = different_block
            .split("![撮影画面](")
            .nth(1)
            .unwrap()
            .split(')')
            .next()
            .unwrap();
        assert_eq!(
            fs::read(root.join("docs").join(hashed_asset)).unwrap(),
            b"\x89PNG\r\n\x1a\ndifferent"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn markits_capture_uses_configured_assets_for_nested_pages() {
        let root = test_dir("capture-configured-assets");
        fs::create_dir_all(root.join("docs/sub")).unwrap();
        fs::write(root.join("docs/sub/guide.md"), "# Guide\n").unwrap();
        fs::write(
            root.join("manual_setting.json"),
            r#"{"docs":"docs","assets":"media/shots"}"#,
        )
        .unwrap();
        let source = root.join("capture.png");
        let bytes = b"\x89PNG\r\n\x1a\nimage";
        fs::write(&source, bytes).unwrap();
        let block = preserve_annotated_capture(
            root.to_str().unwrap(),
            "docs/sub/guide.md",
            "nested-shot",
            source.to_str().unwrap(),
            "capture",
        )
        .unwrap();
        assert!(block.contains("../../media/shots/markits-nested-shot.png"));
        assert_eq!(
            fs::read(root.join("media/shots/markits-nested-shot.png")).unwrap(),
            bytes
        );
        assert!(!root.join("docs/sub/assets").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn markits_capture_resolves_docs_relative_page_from_editor() {
        let root = test_dir("capture-docs-relative");
        let docs = root.join("docs");
        fs::create_dir_all(&docs).unwrap();
        fs::write(docs.join("index.md"), "# Guide\n").unwrap();
        let source = root.join("capture.png");
        let bytes = b"\x89PNG\r\n\x1a\nimage";
        fs::write(&source, bytes).unwrap();

        let block = preserve_annotated_capture(
            root.to_str().unwrap(),
            "index.md",
            "index-shot",
            source.to_str().unwrap(),
            "capture",
        )
        .unwrap();
        assert!(block.contains("assets/markits-index-shot.png"));
        assert_eq!(
            fs::read(docs.join("assets/markits-index-shot.png")).unwrap(),
            bytes
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_completed_annotation_keeps_completion_marker_for_recovery() {
        let root = test_dir("annotation-marker");
        let marker = root.join("complete");
        let source = root.join("source");
        let image = root.join("broken.png");
        fs::write(&marker, "done").unwrap();
        fs::write(&source, "scenario").unwrap();
        fs::write(&image, b"not a png").unwrap();
        assert!(annotation_if_complete(
            source.to_str().unwrap(),
            image.to_str().unwrap(),
            marker.to_str().unwrap()
        )
        .is_err());
        assert!(marker.is_file());
        assert!(source.is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn completed_capture_accepts_empty_annotations_and_cleans_handoff_files() {
        let root = test_dir("empty-annotations");
        let marker = root.join("complete");
        let source = root.join("source.png");
        let annotation = root.join("annotated.png");
        let docs = root.join("docs");
        fs::create_dir_all(&docs).unwrap();
        fs::write(docs.join("guide.md"), "# Guide\n").unwrap();
        fs::write(&marker, "done").unwrap();
        fs::write(&source, "source image").unwrap();

        // Valid 1x1 PNG, then realistic MarkIts UI map and empty annotation
        // metadata chunks as produced when the editor is closed without marks.
        let base_png = [
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
            8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 156, 99, 96, 96, 0, 0,
            0, 3, 0, 1, 43, 9, 77, 132, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
        ];
        let with_ui = markits::raster::embed_png_uimap(
            &base_png,
            &[markits::UiElement::new(
                "button", "保存", 10.0, 20.0, 30.0, 12.0,
            )],
        )
        .unwrap();
        let annotated_png = markits::raster::embed_png_text_chunk(
            &with_ui,
            "markits:annotations",
            r#"{"canvas":{"width":800,"height":600},"annotations":[]}"#,
        )
        .unwrap();
        fs::write(&annotation, &annotated_png).unwrap();
        assert_eq!(
            markits::raster::extract_png_uimap(&annotated_png).unwrap()[0].name,
            "保存"
        );

        let normalized = annotation_if_complete(
            source.to_str().unwrap(),
            annotation.to_str().unwrap(),
            marker.to_str().unwrap(),
        )
        .unwrap()
        .unwrap();
        let value: Value = serde_json::from_str(&normalized).unwrap();
        assert_eq!(value["annotations"], json!([]));
        assert_eq!(value["canvas"]["width"], 800);
        assert!(marker.exists());
        assert!(source.exists());
        assert_eq!(
            annotation_if_complete(
                source.to_str().unwrap(),
                annotation.to_str().unwrap(),
                marker.to_str().unwrap()
            )
            .unwrap(),
            Some(normalized.clone())
        );

        let block = preserve_annotated_capture(
            root.to_str().unwrap(),
            "docs/guide.md",
            "empty-capture",
            annotation.to_str().unwrap(),
            "Capture without markup",
        )
        .unwrap();
        assert!(block.contains("assets/markits-empty-capture.png"));
        assert_eq!(
            fs::read(root.join("docs/assets/markits-empty-capture.png")).unwrap(),
            annotated_png,
            "empty annotation handoff must retain the original PNG and its metadata"
        );

        // Importing a standalone spec retains its existing nonempty requirement.
        assert!(normalize_annotation_spec(&normalized).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn completed_capture_cleanup_only_removes_markits_handoff_images() {
        let root = test_dir("capture-cleanup");
        let handoff = root.join("manual-studio-markits");
        fs::create_dir_all(&handoff).unwrap();
        let image = handoff.join("task-1-annotated.png");
        fs::write(&image, b"image").unwrap();
        assert!(cleanup_completed_capture(root.join("other.png").to_str().unwrap()).is_err());
        cleanup_completed_capture(image.to_str().unwrap()).unwrap();
        assert!(!image.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn finish_with_no_events_still_stops_recording_and_target_processes() {
        let root = test_dir("empty-recording");
        let event_file = root.join("events.jsonl");
        fs::write(&event_file, "\n").unwrap();
        let recorder = Command::new("sh")
            .args(["-c", "exec sleep 60"])
            .spawn()
            .unwrap();
        let recorder_pid = recorder.id();
        let app_child = Command::new("sh")
            .args(["-c", "exec sleep 60"])
            .spawn()
            .unwrap();
        let app_pid = app_child.id();
        let state = RecorderState::default();
        state.0.lock().unwrap().session = Some(Session {
            recorder: Some(recorder),
            app_child: Some(app_child),
            event_file: event_file.clone(),
            root: root.clone(),
            program: "demo".into(),
            args: vec![],
            window_title: "Demo".into(),
            window: WindowBounds {
                id: "1".into(),
                x: 0,
                y: 0,
                width: 400,
                height: 300,
            },
            task_id: "demo-shot".into(),
            markits_program: "markits-desktop".into(),
        });

        assert!(finish(&state)
            .unwrap_err()
            .contains("記録された操作がありません"));
        assert!(!Path::new(&format!("/proc/{recorder_pid}")).exists());
        assert!(!Path::new(&format!("/proc/{app_pid}")).exists());
        assert!(
            !event_file.exists(),
            "failed recordings must remove their event journal"
        );
        assert!(state.0.lock().unwrap().session.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn background_waiter_reaps_a_completed_child() {
        let child = Command::new("sh")
            .args(["-c", "sleep 0.05"])
            .spawn()
            .unwrap();
        let pid = child.id();
        reap_child_in_background(child);
        let process_path = PathBuf::from(format!("/proc/{pid}"));
        let deadline = Instant::now() + Duration::from_secs(2);
        while process_path.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            !process_path.exists(),
            "background waiter should collect the child exit status"
        );
    }

    #[test]
    fn scenario_keeps_launch_and_annotations_out_of_markits_spec() {
        let session = Session {
            recorder: Some(
                Command::new(std::env::current_exe().unwrap())
                    .arg("--help")
                    .spawn()
                    .unwrap(),
            ),
            app_child: Some(
                Command::new(std::env::current_exe().unwrap())
                    .arg("--help")
                    .spawn()
                    .unwrap(),
            ),
            event_file: PathBuf::new(),
            root: PathBuf::new(),
            program: "demo".into(),
            args: vec!["--safe".into()],
            window_title: "Demo".into(),
            window: WindowBounds {
                id: "0x1".into(),
                x: 100,
                y: 50,
                width: 400,
                height: 300,
            },
            task_id: "demo-shot".into(),
            markits_program: "markits-desktop".into(),
        };
        let scenario = build_scenario(
            &session,
            &[
                RecordedEvent::Click {
                    elapsed_ms: 500,
                    x: 120.0,
                    y: 80.0,
                },
                RecordedEvent::Text {
                    elapsed_ms: 900,
                    value: "hello".into(),
                },
                RecordedEvent::Text {
                    elapsed_ms: 60_900,
                    value: " world".into(),
                },
            ],
        );
        assert_eq!(scenario["steps"][0]["launch"]["program"], "demo");
        assert_eq!(scenario["steps"][1]["window"], "Demo");
        assert_eq!(scenario["steps"][2]["click"]["x"], 20);
        assert_eq!(scenario["steps"][3]["text"], "hello world");
        assert_eq!(
            scenario["steps"][scenario["steps"].as_array().unwrap().len() - 1]["screenshot"]
                ["task"],
            "demo-shot"
        );
        assert!(scenario["steps"]
            .as_array()
            .unwrap()
            .iter()
            .all(|step| step.get("wait_ms").is_none()));
        assert!(scenario.get("annotations").is_none());
    }
    #[test]
    fn annotation_import_keeps_only_canvas_and_marks() {
        let raw = r#"{"canvas":{"width":800,"height":600},"annotations":[{"type":"rect","target":"button:Save"}],"capture_target":"settings","operations":["click"]}"#;
        let normalized: Value =
            serde_json::from_str(&normalize_annotation_spec(raw).unwrap()).unwrap();
        assert_eq!(normalized["annotations"][0]["target"], "button:Save");
        assert_eq!(normalized["canvas"]["width"], 800);
        assert!(normalized.get("capture_target").is_none());
        assert!(normalized.get("operations").is_none());
    }

    #[test]
    fn automatic_window_selection_only_chooses_the_launched_app() {
        let existing = HashSet::from(["manual-studio-window".to_string()]);
        let windows = vec![
            json!({"id":"manual-studio-window","title":"Manual Studio","width":1400,"height":900}),
            json!({"id":"unrelated-new","title":"Other app","width":2000,"height":1400}),
            json!({"id":"new-splash","title":"Loading","width":320,"height":120}),
            json!({"id":"new-app","title":"Settings","width":1000,"height":700}),
        ];
        assert_eq!(
            select_launched_window(
                &windows,
                &existing,
                "",
                &HashSet::from(["new-splash".into(), "new-app".into()])
            )
            .unwrap()["id"],
            "new-app"
        );
        assert!(select_launched_window(&windows, &existing, "", &HashSet::new()).is_none());
        assert_eq!(
            select_launched_window(&windows, &existing, "Manual Studio", &HashSet::new()).unwrap()
                ["id"],
            "manual-studio-window"
        );
    }

    #[test]
    fn existing_window_requires_the_launched_executable() {
        let executable = std::env::current_exe().unwrap();
        let windows = vec![
            json!({"id":"0x10","title":"Existing app","width":800,"height":600}),
            json!({"id":"0x20","title":"Other app","width":1400,"height":900}),
        ];
        let detected = vec![markits::ui_elements::DetectedUiElement {
            role: "window".into(),
            name: Some("Existing app".into()),
            window_id: Some("16".into()),
            pid: Some(std::process::id()),
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        }];
        assert_eq!(
            select_existing_app_window(&windows, &detected, executable.to_str().unwrap()).unwrap()
                ["id"],
            "0x10"
        );
        assert!(select_existing_app_window(
            &windows,
            &detected,
            "manual-studio-missing-test-executable"
        )
        .is_none());
    }
}
