#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
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
        let restore_after_capture = request["action"].as_str() == Some("screenshots-recapture")
            || request["action"].as_str()==Some("selection-generate")&&request["options"]["json"]["include_screenshots"]==true;
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
        if restore_after_capture || attempted_capture.load(std::sync::atomic::Ordering::Relaxed) {
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
async fn choose_path(initial_path: String, folder: bool) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(initial_path);
        let mut directory = if folder { path.as_path() } else { path.parent().unwrap_or(path.as_path()) };
        while !directory.is_dir() {
            match directory.parent() { Some(parent) => directory = parent, None => break }
        }
        let mut dialog = rfd::FileDialog::new().set_title(if folder { "出力フォルダーを選択" } else { "出力ファイルを指定" }).set_directory(directory);
        if !folder { if let Some(name) = path.file_name() { dialog = dialog.set_file_name(name.to_string_lossy()); } }
        let selected = if folder { dialog.pick_folder() } else { dialog.save_file() };
        selected.map(|path| path.to_string_lossy().into_owned())
    }).await.map_err(|error| error.to_string())
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
    if mode.as_deref() == Some(std::ffi::OsStr::new("--studio-tools")) {
        let result=args.next().zip(args.next()).ok_or("--studio-tools requires request and response file paths".to_string())
            .and_then(|(input,output)|manual_core::terminal_tools::run_files(std::path::Path::new(&input),std::path::Path::new(&output)));
        if let Err(error)=result {eprintln!("{error}");std::process::exit(2);}
        return;
    }
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
            markits_bridge::get_markits_capture_shortcut,
            markits_bridge::set_markits_capture_shortcut,
            markits_bridge::edit_markits_image,
            markits_bridge::capture_markits_image,
            markits_bridge::markits_captures,
            markits_bridge::import_markits_capture,
            markits_bridge::import_markits_image,
            manual_request,
            editor_context_menu::set_editor_context_menu_state,
            load_workspace_history,
            record_workspace_history,
            hide_manual_studio,
            restore_manual_studio,
            choose_project,
            choose_path,
            choose_image,
            read_clipboard_image,
            paste_clipboard_image,
            open_editor,
            open_output,
        ])
        .run(context)
        .expect("Failed to start Munin Manual Studio");
}
