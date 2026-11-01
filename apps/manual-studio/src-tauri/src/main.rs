#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::PathBuf,
};
use tauri::{Manager, State};

mod clipboard_paths;
mod editor_context_menu;
mod native_worker;

mod markits_bridge;

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
    #[serde(default)]
    working_directory: String,
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
        if command.working_directory.len() > 4096 || command.working_directory.contains('\0') {
            return Err("作業フォルダのパスが不正です。".into());
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

#[derive(serde::Serialize)]
struct LaunchedApplication {
    pid: u32,
    host_pid: u32,
    program: String,
}

#[tauri::command]
fn test_launch_application(program: String, args: Vec<String>, root: Option<String>, working_directory: Option<String>) -> Result<Option<LaunchedApplication>, String> {
    if program.trim().is_empty() { return Err("アプリのパスを指定してください。".into()); }
    if let Some(url) = browser_launch_url(&program)? {
        open_browser_url(url)?;
        // The default browser may reuse an existing process, so there is no launch identity.
        return Ok(None);
    }
    let directory = resolve_working_directory(root.as_deref(), working_directory.as_deref())?;
    let launch_root = directory.clone().unwrap_or(std::env::current_dir().map_err(|e| e.to_string())?);
    let (executable, args) = manual_core::platform::application_command_in(&launch_root, &program, &args)?;
    let mut command = std::process::Command::new(&executable);
    command.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    if let Some(directory) = directory { command.current_dir(directory); }
    let mut child = command.spawn().map_err(|e| format!("アプリを起動できません: {e}"))?;
    let pid = child.id();
    std::thread::spawn(move || { let _ = child.wait(); });
    Ok(Some(LaunchedApplication { pid, host_pid: std::process::id(), program: executable.to_string_lossy().into_owned() }))
}

fn default_browser_executable(url: &str) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        #[link(name = "shlwapi")]
        unsafe extern "system" {
            fn AssocQueryStringW(flags: u32, kind: u32, association: *const u16,
                extra: *const u16, output: *mut u16, length: *mut u32) -> i32;
        }
        let scheme = url::Url::parse(url).map_err(|e| e.to_string())?.scheme().to_owned();
        let association: Vec<u16> = scheme.encode_utf16().chain(Some(0)).collect();
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        let result = unsafe {
            AssocQueryStringW(0x1000, 2, association.as_ptr(), std::ptr::null(), buffer.as_mut_ptr(), &mut length)
        };
        if result != 0 || length <= 1 || length as usize > buffer.len() {
            return Err(format!("標準ブラウザの実行ファイルを確認できません（Windowsエラー: {result:#x}）。"));
        }
        use std::os::windows::ffi::OsStringExt;
        Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length as usize - 1])))
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = url; Err("URLからの操作記録はWindows版で利用できます。".into()) }
}

fn open_browser_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "shell32")]
        unsafe extern "system" {
            fn ShellExecuteW(
                window: *mut std::ffi::c_void,
                operation: *const u16,
                file: *const u16,
                parameters: *const u16,
                directory: *const u16,
                show: i32,
            ) -> *mut std::ffi::c_void;
        }
        let operation: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        let target: Vec<u16> = std::ffi::OsStr::new(url).encode_wide().chain(Some(0)).collect();
        let result = unsafe {
            ShellExecuteW(std::ptr::null_mut(), operation.as_ptr(), target.as_ptr(),
                std::ptr::null(), std::ptr::null(), 1)
        } as isize;
        if result <= 32 {
            return Err(format!("標準ブラウザでページを開けません（Windowsエラー: {result}）。"));
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    open::that(url).map_err(|error| format!("ページを開けません: {error}"))
}

fn browser_launch_url(program: &str) -> Result<Option<&str>, String> {
    let program = program.trim();
    let scheme = program.split(':').next().unwrap_or_default();
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Ok(None);
    }
    let parsed = url::Url::parse(program).map_err(|error| format!("URLが不正です: {error}"))?;
    if parsed.host_str().is_none() {
        return Err("URLのホストを指定してください。".into());
    }
    Ok(Some(program))
}

fn resolve_working_directory(root: Option<&str>, working_directory: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(directory) = working_directory.filter(|value| !value.trim().is_empty()).or(root) else { return Ok(None); };
    let path = PathBuf::from(directory);
    let path = if path.is_absolute() { path } else if let Some(root) = root { PathBuf::from(root).join(path) } else { std::env::current_dir().map_err(|error| error.to_string())?.join(path) };
    let path = path.canonicalize().map_err(|_| format!("作業フォルダが見つかりません: {}", path.display()))?;
    if !path.is_dir() { return Err(format!("作業フォルダはディレクトリではありません: {}", path.display())); }
    Ok(Some(path))
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
async fn choose_project(initial_directory: Option<String>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new()
            .set_title("マニュアルを管理するプロジェクトを選択");
        if let Some(directory) = initial_directory.filter(|directory| !directory.trim().is_empty()) {
            let path = PathBuf::from(directory);
            if path.is_dir() {
                dialog = dialog.set_directory(path);
            }
        }
        dialog.pick_folder()
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
async fn choose_working_directory(initial_directory: Option<String>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title("アプリの作業フォルダを選択");
        if let Some(directory) = initial_directory.filter(|directory| !directory.trim().is_empty()) {
            let path = PathBuf::from(directory);
            if path.is_dir() { dialog = dialog.set_directory(path); }
        }
        dialog.pick_folder().map(|path| path.to_string_lossy().into_owned())
    }).await.map_err(|error| error.to_string())
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

fn main() {
    let mut args = std::env::args_os();
    let _ = args.next();
    let mode = args.next();
    if mode.as_deref() == Some(std::ffi::OsStr::new("--manual-studio-annotate"))
        || mode.as_deref() == Some(std::ffi::OsStr::new("--munin-markits")) {
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
        if let Err(error) = markits::recording::run_helper(&output) {
            eprintln!("{error}");
            std::process::exit(2);
        }
        return;
    }
    let context = tauri::generate_context!();
    #[cfg(all(debug_assertions, target_os = "windows"))]
    let context = {
        let mut context = context;
        if mode.as_deref() == Some(std::ffi::OsStr::new("--manual-studio-webview2-test")) {
            let port: u16 = args.next().expect("test debug port is required")
                .to_string_lossy().parse().expect("test debug port must be a number");
            assert!(port != 0, "test debug port must not be zero");
            let profile = PathBuf::from(args.next().expect("test WebView2 profile is required"));
            assert!(profile.is_absolute(), "test WebView2 profile must be absolute");
            let window = context.config_mut().app.windows.first_mut().expect("main window is required");
            // Keep Wry's standard disabled features. Elevated WebView2 hosts
            // ignore environment overrides, so pass fixture options via API.
            window.additional_browser_args = Some(format!(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-address=127.0.0.1 --remote-debugging-port={port}"
            ));
            window.data_directory = Some(profile);
        }
        context
    };
    tauri::Builder::default()
        .manage(editor_context_menu::EditorContextMenus::default())
        .manage(HiddenStudioWindows::default())
        .invoke_handler(tauri::generate_handler![
            markits_bridge::open_markits,
            markits_bridge::edit_markits_image,
            markits_bridge::capture_markits_image,
            markits_bridge::markits_captures,
            markits_bridge::import_markits_capture,
            markits_bridge::import_markits_image,
            manual_request,
            editor_context_menu::set_editor_context_menu_state,
            load_launch_commands,
            import_launch_commands,
            load_workspace_history,
            record_workspace_history,
            save_launch_commands,
            test_launch_application,
            hide_manual_studio,
            restore_manual_studio,
            choose_project,
            choose_image,
            read_clipboard_image,
            paste_clipboard_image,
            choose_application,
            choose_working_directory,
            open_editor,
            open_output,
        ])
        .run(context)
        .expect("Failed to start Munin Manual Studio");
}

#[cfg(test)]
mod application_profile_tests {
    use super::*;
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "requires a configured Windows default browser"]
    fn configured_default_browser_is_an_executable() {
        let browser = default_browser_executable("https://www.youtube.com/").unwrap();
        assert!(browser.is_file(), "{}", browser.display());
    }
    #[test]
    fn browser_urls_preserve_query_and_fragment_without_parsing_command_arguments() {
        let url = "https://example.com/page?q=a&next=b#section";
        assert_eq!(browser_launch_url(&format!("  {url}  ")).unwrap(), Some(url));
        assert_eq!(browser_launch_url("HTTP://localhost:8080").unwrap(), Some("HTTP://localhost:8080"));
        assert!(browser_launch_url("https://").is_err());
        for command in [r"C:\Program Files\app.exe", "uv run app.py", "ftp://example.com"] {
            assert_eq!(browser_launch_url(command).unwrap(), None);
        }
    }
    #[test]
    fn launch_profiles_are_owned_by_each_project() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let first_root = first.path().to_str().unwrap().to_string();
        let second_root = second.path().to_str().unwrap().to_string();
        let commands = vec![LaunchCommand { id: "app-one".into(), name: "".into(), program: "/path with spaces/app".into(), args: vec![" value $(literal) ".into()], working_directory: "/tmp/work space".into() }];
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
