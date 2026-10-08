use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub const FLAG: &str = "--manual-studio-native-worker";

#[derive(Serialize, Deserialize)]
enum Operation {
    Request(serde_json::Value),
    WindowProcesses,
    Capture {
        window: String,
        destination: PathBuf,
        close_after_capture: bool,
    },
}

struct WorkDirectory(PathBuf);
impl Drop for WorkDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Native X11/accessibility failures can exit or abort a process, bypassing
/// catch_unwind. Keep those calls out of the Tauri host process.
fn execute(operation: Operation) -> Result<String, String> {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let dir = WorkDirectory(std::env::temp_dir().join(format!(
        "manual-studio-native-{}-{nonce}",
        std::process::id()
    )));
    fs::create_dir(&dir.0).map_err(|e| e.to_string())?;
    fs::write(
        dir.0.join("request.json"),
        serde_json::to_vec(&operation).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let log = fs::File::create(dir.0.join("stderr.log")).map_err(|e| e.to_string())?;
    let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
    command
        .arg(FLAG)
        .arg(&dir.0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    let timeout = match &operation {
        Operation::Request(request) => request["options"]["json"]["limits"]["timeout_seconds"]
            .as_u64()
            .unwrap_or(300)
            .clamp(5, 1800),
        _ => 60,
    };
    run_child(
        &mut command,
        Duration::from_secs(timeout + 5),
        &dir.0.join("stderr.log"),
    )?;
    let response = fs::read(dir.0.join("response.json"))
        .map_err(|e| format!("撮影プロセスの応答を読み取れません: {e}"))?;
    serde_json::from_slice::<Result<String, String>>(&response).map_err(|e| e.to_string())?
}

fn run_child(command: &mut Command, timeout: Duration, log: &Path) -> Result<(), String> {
    let mut child = command
        .spawn()
        .map_err(|e| format!("撮影プロセスを起動できません: {e}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                let bytes = fs::read(log).unwrap_or_default();
                let tail = &bytes[bytes.len().saturating_sub(4096)..];
                return Err(format!(
                    "撮影プロセスが異常終了しました ({status})。Manual Studio は継続します。\n{}",
                    String::from_utf8_lossy(tail)
                ));
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            other => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(match other {
                    Err(e) => format!("撮影プロセスの状態を確認できません: {e}"),
                    _ => "撮影処理が時間内に完了しませんでした。Manual Studioへ戻ります。".into(),
                });
            }
        }
    }
}

pub fn request(value: serde_json::Value) -> Result<String, String> {
    execute(Operation::Request(value))
}

pub fn window_processes() -> Result<Vec<markits::ui_elements::DetectedUiElement>, String> {
    serde_json::from_str(&execute(Operation::WindowProcesses)?).map_err(|e| e.to_string())
}

pub fn capture_window(
    window: &str,
    destination: &Path,
    close_after_capture: bool,
) -> Result<(), String> {
    execute(Operation::Capture {
        window: window.into(),
        destination: destination.into(),
        close_after_capture,
    })
    .map(|_| ())
}

pub fn requires_worker(action: &str) -> bool {
    matches!(
        action,
        "list-windows"
            | "list-accessible-windows"
            | "inspect-window"
            | "activate-window"
            | "capture-window"
            | "recapture"
            | "screenshots-recapture"
            | "capture-source-auto"
            | "markits-capture"
            | "ui-map-from-desktop"
    )
}

pub fn requires_hiding(action: &str) -> bool {
    matches!(
        action,
        "capture-window" | "recapture" | "capture-source-auto" | "markits-capture"
    )
}

pub fn run(dir: &Path) -> Result<(), String> {
    let operation: Operation =
        serde_json::from_slice(&fs::read(dir.join("request.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let response = match operation {
        Operation::Request(value) => manual_core::request(value),
        Operation::WindowProcesses => {
            #[cfg(target_os = "linux")]
            let windows = markits::ui_elements::capture_desktop_windows(0, 0);
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            let windows = manual_core::window_capture::window_process_ids()?
                .into_iter()
                .map(|(id, pid)| markits::ui_elements::DetectedUiElement {
                    role: "window".into(),
                    name: None,
                    window_id: Some(id),
                    pid: Some(pid),
                    x: 0.0,
                    y: 0.0,
                    width: 0.0,
                    height: 0.0,
                })
                .collect::<Vec<_>>();
            serde_json::to_string(&windows).map_err(|e| e.to_string())
        }
        Operation::Capture {
            window,
            destination,
            close_after_capture,
        } => manual_core::window_capture::capture_window(
            &window,
            0,
            &destination,
            false,
            Some(&window),
        )
        .map(|_| {
            if close_after_capture {
                let _ = manual_core::window_capture::close_window(&window);
            }
            String::new()
        }),
    };
    fs::write(
        dir.join("response.json"),
        serde_json::to_vec(&response).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn child_exit_and_abort_are_errors_instead_of_terminating_host() {
        for script in ["exit 19", "kill -ABRT $$"] {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", script]);
            assert!(run_child(
                &mut command,
                Duration::from_secs(2),
                Path::new("/nonexistent/log")
            )
            .unwrap_err()
            .contains("異常終了"));
        }
    }
    #[test]
    fn stuck_worker_is_terminated_and_host_can_continue() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exec sleep 30"]);
        let started = Instant::now();
        assert!(run_child(
            &mut command,
            Duration::from_millis(40),
            Path::new("/nonexistent/log")
        )
        .unwrap_err()
        .contains("時間内"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
