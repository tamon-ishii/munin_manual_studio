#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
use tauri::{Manager, State};

mod clipboard_paths;
mod native_worker;
mod recorder;

static WORKSPACE_HISTORY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn workspace_history_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("workspace_history.json"))
}

fn read_workspace_history(path: &std::path::Path) -> Result<Vec<String>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|error| format!("ワークスペース履歴を読み込めません: {error}"))
}

#[tauri::command]
fn load_workspace_history(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let _guard = WORKSPACE_HISTORY_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    read_workspace_history(&workspace_history_path(&app)?)
}

#[tauri::command]
fn record_workspace_history(app: tauri::AppHandle, root: String) -> Result<Vec<String>, String> {
    let _guard = WORKSPACE_HISTORY_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("ワークスペースのフォルダーがありません。".into());
    }
    let root = root.to_string_lossy().into_owned();
    let path = workspace_history_path(&app)?;
    let mut history = read_workspace_history(&path)?;
    history.retain(|entry| entry != &root);
    history.insert(0, root);
    history.truncate(20);
    fs::create_dir_all(path.parent().ok_or("設定フォルダーを取得できません。")?)
        .map_err(|error| error.to_string())?;
    fs::write(
        &path,
        serde_json::to_vec_pretty(&history).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(history)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchCommand {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    program: String,
    #[serde(default)]
    args: Vec<String>,
}

fn normalize_launch_commands(commands: &mut [LaunchCommand]) -> bool {
    let mut changed = false;
    for command in commands {
        if command.id.is_empty() {
            command.id = manual_core::screenshots::new_id("app");
            changed = true;
        }
    }
    changed
}

fn launch_commands_path(root: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    if !root.is_dir() { return Err("プロジェクトのフォルダーがありません。".into()); }
    Ok(root.join(".munin").join("launch_commands.json"))
}

#[tauri::command]
fn load_launch_commands(root: String) -> Result<Vec<LaunchCommand>, String> {
    let path = launch_commands_path(&root)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let mut commands: Vec<LaunchCommand> = serde_json::from_slice(&bytes)
        .map_err(|error| format!("対象アプリを読み込めません: {error}"))?;
    let needs_migration = normalize_launch_commands(&mut commands);
    if needs_migration {
        save_launch_commands(root, commands.clone())?;
    }
    Ok(commands)
}

#[tauri::command]
fn save_launch_commands(root: String, commands: Vec<LaunchCommand>) -> Result<(), String> {
    if commands.len() > 100 {
        return Err("アプリ登録は100件以内にしてください。".into());
    }
    let mut ids = std::collections::HashSet::new();
    for command in &commands {
        if command.program.trim().is_empty() {
            return Err("アプリのパスは必須です。".into());
        }
        if command.id.is_empty() || !ids.insert(command.id.clone()) {
            return Err("アプリの識別情報が不正です。".into());
        }
    }
    let path = launch_commands_path(&root)?;
    let parent = path.parent().ok_or("設定フォルダーを取得できません。")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec_pretty(&commands).map_err(|error| error.to_string())?;
    use std::io::Write;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temporary.write_all(&bytes).map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn import_launch_commands(app: tauri::AppHandle, root: String) -> Result<Vec<LaunchCommand>, String> {
    let legacy = app.path().app_config_dir().map_err(|error| error.to_string())?.join("launch_commands.json");
    import_launch_commands_from_path(root, &legacy)
}

fn import_launch_commands_from_path(root: String, legacy: &std::path::Path) -> Result<Vec<LaunchCommand>, String> {
    if !load_launch_commands(root.clone())?.is_empty() {
        return Err("既存のアプリ登録があります。取り込みは空のプロジェクトで行ってください。".into());
    }
    if !legacy.exists() { return Err("以前の共通設定がありません。".into()); }
    let mut commands: Vec<LaunchCommand> = serde_json::from_slice(&fs::read(legacy).map_err(|error| error.to_string())?)
        .map_err(|error| format!("以前の共通設定を読み込めません: {error}"))?;
    normalize_launch_commands(&mut commands);
    save_launch_commands(root, commands.clone())?;
    Ok(commands)
}

#[tauri::command]
fn test_launch_application(program: String, args: Vec<String>) -> Result<(), String> {
    if program.trim().is_empty() {
        return Err("アプリのパスを指定してください。".into());
    }
    let executable = manual_core::platform::application_executable(&program)?;
    std::process::Command::new(executable)
        .args(args)
        .spawn()
        .map_err(|e| format!("アプリを起動できません: {e}"))?;
    Ok(())
}

#[tauri::command]
fn show_recording_control(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("recording-control") {
        window.show().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        window
            .set_always_on_top(true)
            .map_err(|error| error.to_string())?;
        return window.set_focus().map_err(|error| error.to_string());
    }
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        "recording-control",
        tauri::WebviewUrl::App("index.html?recordingControl=1".into()),
    )
    .title("Munin Manual Studio — 撮影")
    .inner_size(310.0, 100.0)
    .min_inner_size(1.0, 1.0)
    // GTK locks an unresizable WebView at its initial minimum (200px).
    // Allow the content-driven resize to shrink the native popup.
    .resizable(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .center()
    .build()
    .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
fn close_recording_control(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("recording-control") {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn hide_recording_control(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("recording-control") {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn show_recording_control_again(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("recording-control") {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[derive(Default)]
struct HiddenStudioWindows(std::sync::Mutex<Vec<String>>);

#[tauri::command]
fn hide_manual_studio(
    app: tauri::AppHandle,
    state: State<'_, HiddenStudioWindows>,
) -> Result<(), String> {
    let mut hidden = state.0.lock().map_err(|error| error.to_string())?;
    for (label, window) in app.webview_windows() {
        if (label == "main" || label.starts_with("editor-"))
            && window.is_visible().map_err(|error| error.to_string())?
        {
            window.hide().map_err(|error| error.to_string())?;
            if !hidden.contains(&label) {
                hidden.push(label);
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn restore_manual_studio(
    app: tauri::AppHandle,
    state: State<'_, HiddenStudioWindows>,
) -> Result<(), String> {
    let mut hidden = state.0.lock().map_err(|error| error.to_string())?;
    // Retain labels when show fails so the next restore can retry.
    while let Some(label) = hidden.last().cloned() {
        if let Some(window) = app.get_webview_window(&label) {
            window.show().map_err(|error| error.to_string())?;
            window.unminimize().map_err(|error| error.to_string())?;
        }
        hidden.pop();
    }
    if let Some(main) = app.get_webview_window("main") {
        main.show().map_err(|error| error.to_string())?;
        main.unminimize().map_err(|error| error.to_string())?;
        // Raising explicitly also brings Studio back above the app launched
        // for capture. Keep its usual stacking policy after taking focus.
        let was_on_top = main.is_always_on_top().map_err(|error| error.to_string())?;
        main.set_always_on_top(true)
            .map_err(|error| error.to_string())?;
        let focused = main.set_focus();
        let reset = main.set_always_on_top(was_on_top);
        focused.map_err(|error| error.to_string())?;
        reset.map_err(|error| error.to_string())?;
        #[cfg(target_os = "linux")]
        {
            // GTK focus requests can be denied after the replay raised another
            // application. Activate our own X11 window through the isolated worker.
            use raw_window_handle::{HasWindowHandle, RawWindowHandle};
            let handle = main.window_handle().map_err(|error| error.to_string())?;
            let id = match handle.as_raw() {
                RawWindowHandle::Xlib(handle) => Some(handle.window as u64),
                RawWindowHandle::Xcb(handle) => Some(handle.window.get() as u64),
                _ => None,
            };
            if let Some(id) = id {
                native_worker::activate_window(&format!("0x{id:x}"))?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn return_to_manual_studio(
    app: tauri::AppHandle,
    state: State<'_, HiddenStudioWindows>,
) -> Result<(), String> {
    if let Some(control) = app.get_webview_window("recording-control") {
        control.close().map_err(|error| error.to_string())?;
    }
    if let Some(main) = app.get_webview_window("main") {
        main.unminimize().map_err(|error| error.to_string())?;
    }
    restore_manual_studio(app, state)
}

#[tauri::command]
async fn manual_request(
    app: tauri::AppHandle,
    request: serde_json::Value,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let recapture = request["action"].as_str() == Some("screenshots-recapture");
        let capture_app = app.clone();
        let attempted_capture = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let attempted = attempted_capture.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            manual_core::window_capture::with_capture_preparation(
                move || {
                    attempted.store(true, std::sync::atomic::Ordering::Relaxed);
                    hide_manual_studio(
                        capture_app.clone(),
                        capture_app.state::<HiddenStudioWindows>(),
                    )?;
                    // Wait for the compositor to remove Studio before activating/capturing the target.
                    std::thread::sleep(std::time::Duration::from_millis(350));
                    Ok(())
                },
                || {
                    let action = request["action"].as_str().unwrap_or_default();
                    if native_worker::requires_worker(action) {
                        if native_worker::requires_hiding(action) {
                            attempted_capture.store(true, std::sync::atomic::Ordering::Relaxed);
                            hide_manual_studio(app.clone(), app.state::<HiddenStudioWindows>())?;
                            std::thread::sleep(std::time::Duration::from_millis(350));
                        }
                        native_worker::request(request)
                    } else {
                        manual_core::request(request)
                    }
                },
            )
        }))
        .unwrap_or_else(|_| {
            Err("処理中に予期しないエラーが発生しました。Munin Manual Studioへ戻ります。".into())
        });
        if recapture || attempted_capture.load(std::sync::atomic::Ordering::Relaxed) {
            let restored = restore_manual_studio(app.clone(), app.state::<HiddenStudioWindows>());
            match (result, restored) {
                (Err(error), Err(restore_error)) => Err(format!(
                    "{error}\nMunin Manual Studioの再表示にも失敗しました: {restore_error}"
                )),
                (Err(error), _) => Err(error),
                (Ok(_), Err(error)) => Err(error),
                (Ok(output), Ok(())) => Ok(output),
            }
        } else {
            result
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn choose_project() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("マニュアルを管理するプロジェクトを選択")
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn choose_image() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("登録するPNGを選択")
            .add_filter("PNG画像", &["png"])
            .pick_file()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PastedImageResult {
    file_path: String,
    filename: String,
    alt: String,
}

#[tauri::command]
async fn paste_clipboard_image(
    root: String,
    _page: String,
    assets_folder: String,
) -> Result<Option<PastedImageResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut clipboard = match arboard::Clipboard::new() {
            Ok(c) => c,
            Err(_) => return Ok(None),
        };

        let root_path = PathBuf::from(&root);
        let folder = if assets_folder.trim().is_empty() {
            "docs/assets".to_string()
        } else {
            assets_folder
                .trim()
                .trim_matches(|c| c == '/' || c == '\\')
                .to_string()
        };
        let target_dir = root_path.join(&folder);

        let now = chrono::Local::now();
        let stamp = now.format("%Y%m%d-%H%M%S").to_string();

        let find_filename = |ext: &str| -> (String, PathBuf) {
            let mut name = format!("image-{stamp}.{ext}");
            let mut path = target_dir.join(&name);
            let mut counter = 1;
            while path.exists() {
                name = format!("image-{stamp}-{counter}.{ext}");
                path = target_dir.join(&name);
                counter += 1;
            }
            (name, path)
        };

        // 1. Direct fast PNG encoding from clipboard bitmap directly to file
        if let Ok(img_data) = clipboard.get_image() {
            if img_data.width > 0 && img_data.height > 0 && !img_data.bytes.is_empty() {
                if let Err(e) = std::fs::create_dir_all(&target_dir) {
                    return Err(format!("画像保存先フォルダーの作成に失敗しました: {e}"));
                }
                let (filename, dest_path) = find_filename("png");

                let file = std::fs::File::create(&dest_path)
                    .map_err(|e| format!("画像ファイルの作成に失敗しました: {e}"))?;
                let buf_writer = std::io::BufWriter::new(file);

                use image::ImageEncoder;
                let encoder = image::codecs::png::PngEncoder::new_with_quality(
                    buf_writer,
                    image::codecs::png::CompressionType::Fast,
                    image::codecs::png::FilterType::Sub,
                );
                encoder
                    .write_image(
                        &img_data.bytes,
                        img_data.width as u32,
                        img_data.height as u32,
                        image::ExtendedColorType::Rgba8,
                    )
                    .map_err(|e| format!("PNG画像の保存に失敗しました: {e}"))?;

                let full_asset_path = format!("{folder}/{filename}");
                let alt = filename.trim_end_matches(".png").to_string();
                return Ok(Some(PastedImageResult {
                    file_path: full_asset_path,
                    filename,
                    alt,
                }));
            }
        }

        // 2. Direct copy of copied image file path or file:// URI (e.g. from file manager)
        if let Ok(text) = clipboard.get_text() {
            for raw_line in text.lines() {
                let line = raw_line.trim();
                let Some(src_path) = clipboard_paths::image_path(line) else {
                    continue;
                };
                if src_path.is_file() {
                    let ext = src_path
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_lowercase();
                    if ["png", "jpg", "jpeg", "gif", "webp", "svg"].contains(&ext.as_str()) {
                        if let Err(e) = std::fs::create_dir_all(&target_dir) {
                            return Err(format!("画像保存先フォルダーの作成に失敗しました: {e}"));
                        }
                        let (filename, dest_path) = find_filename(&ext);
                        if std::fs::copy(&src_path, &dest_path).is_ok() {
                            let full_asset_path = format!("{folder}/{filename}");
                            let alt = filename
                                .rsplit_once('.')
                                .map(|(base, _)| base)
                                .unwrap_or(&filename)
                                .to_string();
                            return Ok(Some(PastedImageResult {
                                file_path: full_asset_path,
                                filename,
                                alt,
                            }));
                        }
                    }
                }
            }
        }

        Ok(None)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn read_clipboard_image() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut clipboard = match arboard::Clipboard::new() {
            Ok(c) => c,
            Err(_) => return Ok(None),
        };

        // 1. Try reading bitmap image directly
        if let Ok(img_data) = clipboard.get_image() {
            if img_data.width > 0 && img_data.height > 0 && !img_data.bytes.is_empty() {
                let mut png_bytes = std::io::Cursor::new(Vec::new());
                use image::ImageEncoder;
                let encoder = image::codecs::png::PngEncoder::new_with_quality(
                    &mut png_bytes,
                    image::codecs::png::CompressionType::Fast,
                    image::codecs::png::FilterType::Sub,
                );
                if encoder
                    .write_image(
                        &img_data.bytes,
                        img_data.width as u32,
                        img_data.height as u32,
                        image::ExtendedColorType::Rgba8,
                    )
                    .is_ok()
                {
                    use base64::Engine;
                    let base64_str =
                        base64::engine::general_purpose::STANDARD.encode(png_bytes.into_inner());
                    return Ok(Some(format!("data:image/png;base64,{base64_str}")));
                }
            }
        }

        // 2. Check if clipboard text contains an image file path or file:// URI (e.g. copied from file manager)
        if let Ok(text) = clipboard.get_text() {
            for raw_line in text.lines() {
                let line = raw_line.trim();
                let Some(path) = clipboard_paths::image_path(line) else {
                    continue;
                };
                if path.is_file() {
                    let ext = path
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_lowercase();
                    if ["png", "jpg", "jpeg", "gif", "webp", "svg"].contains(&ext.as_str()) {
                        if let Ok(bytes) = std::fs::read(&path) {
                            use base64::Engine;
                            let mime = if ext == "svg" {
                                "image/svg+xml"
                            } else if ext == "jpg" || ext == "jpeg" {
                                "image/jpeg"
                            } else {
                                &format!("image/{ext}")
                            };
                            let base64_str =
                                base64::engine::general_purpose::STANDARD.encode(&bytes);
                            return Ok(Some(format!("data:{mime};base64,{base64_str}")));
                        }
                    }
                }
            }
        }

        Ok(None)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn choose_application() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("起動するアプリを選択")
            .pick_file()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_output(root: String) -> Result<(), String> {
    let root = PathBuf::from(root);
    let output =
        manual_core::config::project_path(&root, &manual_core::config::read_config(&root).output)?;
    if !output.is_dir() {
        return Err("先に下書きビルドを実行してください。".into());
    }
    open::that(output).map_err(|error| error.to_string())
}

#[tauri::command]
fn open_editor(app: tauri::AppHandle, root: String, page: String) -> Result<(), String> {
    use tauri::Manager;
    manual_core::editor::read(&PathBuf::from(&root), &page)?;
    let label = format!(
        "editor-{:x}",
        Sha256::digest(format!("{root}\n{page}").as_bytes())
    );
    if let Some(window) = app.get_webview_window(&label) {
        return window.set_focus().map_err(|error| error.to_string());
    }
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("editor", "1")
        .append_pair("root", &root)
        .append_pair("page", &page)
        .finish();
    tauri::WebviewWindowBuilder::new(
        &app,
        label,
        tauri::WebviewUrl::App(format!("index.html?{query}").into()),
    )
    .title(format!("{page} — Munin Manual Studio"))
    .inner_size(1250.0, 850.0)
    .build()
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn start_operation_recording(
    state: State<'_, recorder::RecorderState>,
    root: String,
    program: String,
    args: Vec<String>,
    window_title: String,
    task_id: String,
    markits_program: String,
) -> Result<String, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        recorder::start(
            &state,
            root,
            program,
            args,
            window_title,
            task_id,
            markits_program,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn operation_recording_running(state: State<'_, recorder::RecorderState>) -> Result<bool, String> {
    recorder::is_running(state.inner())
}

#[tauri::command]
async fn finish_operation_recording(
    app: tauri::AppHandle,
    state: State<'_, recorder::RecorderState>,
) -> Result<recorder::RecordingResult, String> {
    let control_bounds = app
        .get_webview_window("recording-control")
        .and_then(|window| {
            let position = window.outer_position().ok()?;
            let size = window.outer_size().ok()?;
            #[cfg(target_os = "macos")]
            let scale = window.scale_factor().ok()?;
            #[cfg(not(target_os = "macos"))]
            let scale = 1.0;
            Some((
                position.x as f64 / scale,
                position.y as f64 / scale,
                size.width as f64 / scale,
                size.height as f64 / scale,
            ))
        });
    let state = state.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        recorder::finish_excluding_control(&state, control_bounds)
    })
    .await
    .map_err(|error| error.to_string())??;
    if result.markits_started {
        let completion = PathBuf::from(&result.completion_file);
        let source = PathBuf::from(&result.source_file);
        std::thread::spawn(move || {
            // Hidden WebKit views can suspend JS timers. Restore natively so
            // an editor crash cannot leave the main window waiting invisibly.
            loop {
                if completion.is_file() || completion.with_extension("exit").is_file() {
                    let _ = restore_manual_studio(app.clone(), app.state::<HiddenStudioWindows>());
                    break;
                }
                if !source.is_file() || app.get_webview_window("main").is_none() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        });
    }
    Ok(result)
}

#[tauri::command]
async fn clone_operation_scenario_for_task(
    root: String,
    input: String,
    task_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        recorder::clone_scenario_for_task(root, input, task_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn import_markits_annotation() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(recorder::import_annotation_spec)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn markits_annotation_ready(
    source_file: String,
    annotation_file: String,
    completion_file: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        recorder::annotation_if_complete(&source_file, &annotation_file, &completion_file)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn preserve_markits_capture(
    root: String,
    page: String,
    task_id: String,
    image_file: String,
    prompt: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        recorder::preserve_annotated_capture(&root, &page, &task_id, &image_file, &prompt)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn import_library_capture(
    root: String,
    id: String,
    revision: Option<String>,
    image_file: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let root = PathBuf::from(root);
        let source = manual_core::screenshots::image(&root,&id,revision.as_deref(),true)?;
        let bytes = fs::read(image_file).map_err(|e|e.to_string())?;
        let loaded = markits_desktop_lib::metadata::load_image_with_metadata(&bytes).map_err(|e|e.to_string())?;
        let mut ui = loaded.ui_elements.clone();
        if let Some(crop) = &loaded.crop_info { if let Some(elements) = &mut ui { for element in elements { element.x += crop.offset_x; element.y += crop.offset_y; } } }
        let scene = loaded.annotations_json.as_deref().map(serde_json::from_str::<serde_json::Value>).transpose().map_err(|e|e.to_string())?;
        let result = manual_core::screenshots::register(&root,&serde_json::json!({"id":id,"source":source["data"],"render":base64::engine::general_purpose::STANDARD.encode(&bytes),"scene":scene,"crop":loaded.crop_info,"ui":ui,"adopt":source["screenshot"]["adopted"].is_null()}))?;
        Ok(result.to_string())
    }).await.map_err(|e|e.to_string())?
}

fn prepare_library_screenshot(
    root: String,
    id: String,
    revision: Option<String>,
) -> Result<serde_json::Value, String> {
    use base64::Engine;
    let root = PathBuf::from(root);
    let source = manual_core::screenshots::image(&root, &id, revision.as_deref(), true)?;
    if source["screenshot"]["protected"] == true {
        return Err("保護を解除してから編集してください。".into());
    }
    let data = source["data"].as_str().ok_or("原本を読めません。")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.strip_prefix("data:image/png;base64,").unwrap_or(data))
        .map_err(|e| e.to_string())?;
    let edit = &source["edit"];
    let scene = if edit["scene"].is_null() {
        serde_json::json!({"canvas":{"width":edit["width"],"height":edit["height"]},"annotations":[]})
    } else {
        edit["scene"].clone()
    };
    let crop: Option<markits_desktop_lib::metadata::CropInfo> = if edit["crop"].is_null() {
        None
    } else {
        Some(serde_json::from_value(edit["crop"].clone()).map_err(|e| e.to_string())?)
    };
    let mut background = bytes.clone();
    if let Some(crop) = &crop {
        let render = manual_core::screenshots::image(&root, &id, revision.as_deref(), false)?;
        let render_data = render["data"].as_str().ok_or("画像を読めません。")?;
        let render_bytes = base64::engine::general_purpose::STANDARD
            .decode(
                render_data
                    .strip_prefix("data:image/png;base64,")
                    .unwrap_or(render_data),
            )
            .map_err(|e| e.to_string())?;
        let dimensions = image::load_from_memory(&render_bytes).map_err(|e| e.to_string())?;
        let original = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
        if crop.offset_x < 0.0
            || crop.offset_y < 0.0
            || crop.offset_x as u32
                + scene["canvas"]["width"]
                    .as_u64()
                    .unwrap_or(dimensions.width() as u64) as u32
                > original.width()
            || crop.offset_y as u32
                + scene["canvas"]["height"]
                    .as_u64()
                    .unwrap_or(dimensions.height() as u64) as u32
                > original.height()
        {
            return Err("クロップが原本の範囲外です。".into());
        }
        let cropped = original.crop_imm(
            crop.offset_x as u32,
            crop.offset_y as u32,
            scene["canvas"]["width"]
                .as_u64()
                .unwrap_or(dimensions.width() as u64) as u32,
            scene["canvas"]["height"]
                .as_u64()
                .unwrap_or(dimensions.height() as u64) as u32,
        );
        let mut cursor = std::io::Cursor::new(Vec::new());
        cropped
            .write_to(&mut cursor, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        background = cursor.into_inner();
    }
    let ui: Option<Vec<markits_desktop_lib::ui_elements::DetectedUiElement>> =
        if edit["ui"].is_null() {
            None
        } else {
            Some(serde_json::from_value(edit["ui"].clone()).map_err(|e| e.to_string())?)
        };
    let ui = if let Some(crop) = &crop {
        ui.map(|elements| {
            markits_desktop_lib::ui_elements::filter_elements_for_crop(
                &elements,
                crop.offset_x,
                crop.offset_y,
                scene["canvas"]["width"].as_f64().unwrap_or(0.0),
                scene["canvas"]["height"].as_f64().unwrap_or(0.0),
            )
        })
    } else {
        ui
    };
    let annotated = markits_desktop_lib::metadata::embed_metadata(
        &background,
        Some(&scene.to_string()),
        ui.as_deref(),
        crop.as_ref(),
    )
    .map_err(|e| e.to_string())?;
    let annotated = markits_desktop_lib::metadata::embed_text_chunk(
        &annotated,
        "markits:source_image",
        &format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&background)
        ),
    )
    .map_err(|e| e.to_string())?;
    let annotated =
        markits_desktop_lib::metadata::embed_text_chunk(&annotated, "markits:base_image", data)
            .map_err(|e| e.to_string())?;
    let home = manual_core::config::project_path(
        &root,
        &format!(
            ".munin/screenshots/{id}/sessions/{}",
            manual_core::screenshots::new_id("session")
        ),
    )?;
    fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let input = home.join("input.png");
    let output = home.join("output.png");
    let completion = home.join("complete.done");
    fs::write(&input, annotated).map_err(|e| e.to_string())?;
    fs::write(home.join("session.json"),serde_json::json!({"version":1,"id":id,"revision":edit["id"],"original":edit["original"],"completion":completion}).to_string()).map_err(|e|e.to_string())?;
    Ok(
        serde_json::json!({"sourceFile":input,"annotationFile":output,"completionFile":completion,"revision":edit["id"]}),
    )
}

#[tauri::command]
async fn edit_library_screenshot(
    root: String,
    id: String,
    revision: Option<String>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let handoff = prepare_library_screenshot(root, id, revision)?;
        let mut command =
            std::process::Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
        command
            .arg("--manual-studio-annotate")
            .arg("--manual-studio-input")
            .arg(handoff["sourceFile"].as_str().ok_or("Invalid input")?)
            .arg("--manual-studio-output")
            .arg(handoff["annotationFile"].as_str().ok_or("Invalid output")?)
            .arg("--manual-studio-completion")
            .arg(
                handoff["completionFile"]
                    .as_str()
                    .ok_or("Invalid session")?,
            )
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(handoff)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn cleanup_markits_capture(image_file: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || recorder::cleanup_completed_capture(&image_file))
        .await
        .map_err(|error| error.to_string())?
}

fn main() {
    let mut args = std::env::args_os();
    let _ = args.next();
    let mode = args.next();
    if mode.as_deref() == Some(std::ffi::OsStr::new("--manual-studio-annotate")) {
        markits_desktop_lib::run();
        return;
    }
    if mode.as_deref() == Some(std::ffi::OsStr::new(native_worker::FLAG)) {
        let result = args
            .next()
            .map(PathBuf::from)
            .ok_or_else(|| "native worker directory is required".to_string())
            .and_then(|dir| native_worker::run(&dir));
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(2);
        }
        return;
    }
    if mode.as_deref() == Some(std::ffi::OsStr::new("--manual-studio-record-input")) {
        let output = args
            .next()
            .map(PathBuf::from)
            .expect("recorder output path is required");
        if let Err(error) = recorder::run_helper(&output) {
            eprintln!("{error}");
            std::process::exit(2);
        }
        return;
    }
    tauri::Builder::default()
        .manage(recorder::RecorderState::default())
        .manage(HiddenStudioWindows::default())
        .invoke_handler(tauri::generate_handler![
            manual_request,
            load_launch_commands,
            import_launch_commands,
            load_workspace_history,
            record_workspace_history,
            save_launch_commands,
            test_launch_application,
            show_recording_control,
            close_recording_control,
            hide_recording_control,
            show_recording_control_again,
            hide_manual_studio,
            restore_manual_studio,
            return_to_manual_studio,
            choose_project,
            choose_image,
            read_clipboard_image,
            paste_clipboard_image,
            choose_application,
            start_operation_recording,
            operation_recording_running,
            finish_operation_recording,
            import_markits_annotation,
            markits_annotation_ready,
            preserve_markits_capture,
            import_library_capture,
            edit_library_screenshot,
            cleanup_markits_capture,
            clone_operation_scenario_for_task,
            open_editor,
            open_output
        ])
        .run(tauri::generate_context!())
        .expect("Failed to start Munin Manual Studio");
}

#[cfg(test)]
mod application_profile_tests {
    use super::*;
    #[test]
    fn library_completion_is_retryable_and_keeps_adopted_and_original_pixels() {
        use base64::Engine;
        let root = tempfile::tempdir().unwrap();
        let original = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(20,16,image::Rgba([10,20,30,255])));
        let mut buffer = std::io::Cursor::new(Vec::new());
        original.write_to(&mut buffer,image::ImageFormat::Png).unwrap();
        let source = base64::engine::general_purpose::STANDARD.encode(buffer.into_inner());
        let saved = manual_core::screenshots::register(root.path(),&serde_json::json!({"source":source})).unwrap();
        let id = saved["screenshot"]["id"].as_str().unwrap().to_string();
        let owner = root.path().to_string_lossy().into_owned();
        let before = manual_core::screenshots::image(root.path(),&id,None,false).unwrap();
        let handoff = prepare_library_screenshot(owner.clone(),id.clone(),None).unwrap();
        // A missing/failed MarkIts output leaves the persistent source and adoption untouched.
        assert!(tauri::async_runtime::block_on(import_library_capture(owner.clone(),id.clone(),None,"missing-output.png".into())).is_err());
        for _ in 0..2 {
            tauri::async_runtime::block_on(import_library_capture(owner.clone(),id.clone(),None,handoff["sourceFile"].as_str().unwrap().into())).unwrap();
        }
        let after = manual_core::screenshots::image(root.path(),&id,None,false).unwrap();
        assert_eq!(after["data"],before["data"]);
        assert_eq!(after["screenshot"]["adopted"],before["screenshot"]["adopted"]);
        assert_eq!(after["screenshot"]["edits"].as_array().unwrap().len(),2,"repeated empty-annotation completion saves one candidate");
        assert_eq!(manual_core::screenshots::image(root.path(),&id,None,true).unwrap()["data"],format!("data:image/png;base64,{source}"));
    }
    #[test]
    fn handoff_reconstructs_raw_crop_scene_and_full_original_after_reload() {
        use base64::Engine;
        let root = tempfile::tempdir().unwrap();
        let original = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            80,
            60,
            image::Rgba([10, 20, 30, 255]),
        ));
        let cropped = original.crop_imm(20, 10, 30, 25);
        let encode = |image: &image::DynamicImage| {
            let mut bytes = std::io::Cursor::new(Vec::new());
            image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
            base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
        };
        let scene = serde_json::json!({"canvas":{"width":30,"height":25},"annotations":[{"type":"rect","target":[3,4,10,5],"style":"primary"}]});
        let saved=manual_core::screenshots::register(root.path(),&serde_json::json!({"source":encode(&original),"render":encode(&cropped.resize_exact(15,12,image::imageops::FilterType::Nearest)),"scene":scene,"crop":{"is_auto_cropped":false,"offset_x":20.0,"offset_y":10.0,"base_width":80,"base_height":60}})).unwrap();
        let id = saved["screenshot"]["id"].as_str().unwrap();
        let copied = manual_core::screenshots::change(root.path(), id, &serde_json::json!({"copy":true})).unwrap();
        let copy_id = copied["screenshot"]["id"].as_str().unwrap();
        let handoff =
            prepare_library_screenshot(root.path().to_string_lossy().into_owned(), copy_id.into(), None)
                .unwrap();
        let loaded = markits_desktop_lib::metadata::load_image_with_metadata(
            &fs::read(handoff["sourceFile"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!((loaded.width, loaded.height), (30, 25));
        assert_eq!(
            (loaded.base_width, loaded.base_height),
            (Some(80), Some(60))
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(loaded.annotations_json.as_deref().unwrap())
                .unwrap(),
            scene
        );
        assert_eq!(loaded.crop_info.unwrap().offset_x, 20.0);
        assert_eq!(
            loaded.image_data_url,
            format!("data:image/png;base64,{}", encode(&cropped))
        );
        assert_eq!(
            manual_core::screenshots::image(root.path(), id, None, true).unwrap()["data"],
            format!("data:image/png;base64,{}", encode(&original))
        );
        let session = std::path::Path::new(handoff["sourceFile"].as_str().unwrap())
            .parent()
            .unwrap()
            .join("session.json");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(session).unwrap()).unwrap()
                ["revision"],
            saved["revision"]
        );
    }
    #[test]
    fn launch_profiles_are_owned_by_each_project() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let first_root = first.path().to_str().unwrap().to_string();
        let second_root = second.path().to_str().unwrap().to_string();
        let commands = vec![LaunchCommand { id: "app-one".into(), name: "".into(), program: "/path with spaces/app".into(), args: vec![" value $(literal) ".into()] }];
        save_launch_commands(first_root.clone(), commands).unwrap();
        assert!(load_launch_commands(second_root).unwrap().is_empty());
        let restored = load_launch_commands(first_root.clone()).unwrap();
        assert_eq!(restored[0].args, [" value $(literal) "]);
        assert!(first.path().join(".munin/launch_commands.json").is_file());
        save_launch_commands(first_root.clone(), vec![]).unwrap();
        assert!(load_launch_commands(first_root).unwrap().is_empty());
    }

    #[test]
    fn legacy_import_preserves_source_and_does_not_overwrite_project() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("legacy.json");
        let original = br#"[{"name":"","program":"/old/app","args":[" a $(literal) "]}]"#;
        fs::write(&legacy, original).unwrap();
        let project = root.path().to_str().unwrap().to_string();
        let imported = import_launch_commands_from_path(project.clone(), &legacy).unwrap();
        assert_eq!(imported[0].args, [" a $(literal) "]);
        assert!(!imported[0].id.is_empty());
        assert_eq!(fs::read(&legacy).unwrap(), original);
        assert!(import_launch_commands_from_path(project.clone(), &legacy).is_err());
        assert_eq!(load_launch_commands(project).unwrap()[0].id, imported[0].id);
    }

    #[test]
    fn legacy_profiles_keep_argument_boundaries_and_optional_names() {
        let mut profiles:Vec<LaunchCommand>=serde_json::from_value(serde_json::json!([
            {"name":"","program":"/path with spaces/app","args":[" value with spaces ","$(literal)","--flag"]},
            {"name":"","program":"other","args":[]}
        ])).unwrap();
        assert!(normalize_launch_commands(&mut profiles));
        let snapshot = profiles[0].clone();
        let id = snapshot.id.clone();
        assert_ne!(id, profiles[1].id);
        assert!(!normalize_launch_commands(&mut profiles));
        profiles[0].name = "renamed".into();
        profiles[0].args.clear();
        assert_eq!(profiles[0].id, id);
        profiles.clear();
        assert_eq!(
            snapshot.args,
            [" value with spaces ", "$(literal)", "--flag"]
        );
        let restored: LaunchCommand =
            serde_json::from_slice(&serde_json::to_vec(&snapshot).unwrap()).unwrap();
        assert_eq!(restored.id, id);
    }
}
