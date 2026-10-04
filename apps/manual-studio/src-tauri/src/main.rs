#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
use tauri::{Manager, State};

mod recorder;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchCommand {
    name: String,
    program: String,
    #[serde(default)]
    args: Vec<String>,
}

fn launch_commands_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("launch_commands.json"))
}

#[tauri::command]
fn load_launch_commands(app: tauri::AppHandle) -> Result<Vec<LaunchCommand>, String> {
    let path = launch_commands_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("共通起動コマンドを読み込めません: {error}"))
}

#[tauri::command]
fn save_launch_commands(app: tauri::AppHandle, commands: Vec<LaunchCommand>) -> Result<(), String> {
    if commands.len() > 100 {
        return Err("共通起動コマンドは100件以内にしてください。".into());
    }
    let mut names = std::collections::HashSet::new();
    for command in &commands {
        if command.name.trim().is_empty() || command.program.trim().is_empty() {
            return Err("コマンド名とアプリのパスは必須です。".into());
        }
        if !names.insert(command.name.trim().to_lowercase()) {
            return Err(format!(
                "コマンド名「{}」が重複しています。",
                command.name.trim()
            ));
        }
    }
    let path = launch_commands_path(&app)?;
    let parent = path.parent().ok_or("設定フォルダーを取得できません。")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec_pretty(&commands).map_err(|error| error.to_string())?;
    fs::write(path, bytes).map_err(|error| format!("共通起動コマンドを保存できません: {error}"))
}

#[tauri::command]
fn show_recording_control(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("recording-control") {
        return window.set_focus().map_err(|error| error.to_string());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "recording-control",
        tauri::WebviewUrl::App("index.html?recordingControl=1".into()),
    )
    .title("Manual Studio — 撮影")
    .inner_size(310.0, 100.0)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .center()
    .build()
    .map(|_| ())
    .map_err(|error| error.to_string())
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
        }
        hidden.pop();
    }
    if let Some(main) = app.get_webview_window("main") {
        main.show().map_err(|error| error.to_string())?;
        main.set_focus().map_err(|error| error.to_string())?;
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
                || manual_core::request(request),
            )
        }))
        .unwrap_or_else(|_| {
            Err("処理中に予期しないエラーが発生しました。Manual Studioへ戻ります。".into())
        });
        if attempted_capture.load(std::sync::atomic::Ordering::Relaxed) {
            let restored = restore_manual_studio(app.clone(), app.state::<HiddenStudioWindows>());
            match (result, restored) {
                (Err(error), Err(restore_error)) => Err(format!(
                    "{error}\nManual Studioの再表示にも失敗しました: {restore_error}"
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
    .title(format!("{page} — Manual Studio"))
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
    state: State<'_, recorder::RecorderState>,
) -> Result<recorder::RecordingResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || recorder::finish(&state))
        .await
        .map_err(|error| error.to_string())?
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
async fn cleanup_markits_capture(image_file: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || recorder::cleanup_completed_capture(&image_file))
        .await
        .map_err(|error| error.to_string())?
}

fn main() {
    let mut args = std::env::args_os();
    let _ = args.next();
    if args.next().as_deref() == Some(std::ffi::OsStr::new("--manual-studio-record-input")) {
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
            save_launch_commands,
            show_recording_control,
            close_recording_control,
            hide_recording_control,
            show_recording_control_again,
            hide_manual_studio,
            restore_manual_studio,
            return_to_manual_studio,
            choose_project,
            choose_image,
            choose_application,
            start_operation_recording,
            operation_recording_running,
            finish_operation_recording,
            import_markits_annotation,
            markits_annotation_ready,
            preserve_markits_capture,
            cleanup_markits_capture,
            clone_operation_scenario_for_task,
            open_editor,
            open_output
        ])
        .run(tauri::generate_context!())
        .expect("Failed to start Manual Studio");
}
