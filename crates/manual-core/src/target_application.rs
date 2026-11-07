//! Project-local launch information supplied by the user, never authored by AI.
use crate::config::project_path;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const SETTINGS: &str = ".munin/target-application.json";
#[derive(Default, Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct Settings {
    pub command: String,
    pub arguments: Vec<String>,
    pub working_directory: String,
    pub information: String,
}
pub(crate) fn read(root: &Path) -> Result<Settings, String> {
    let path = project_path(root, SETTINGS)?;
    if !path.exists() {
        return Ok(Settings::default());
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("対象アプリケーションの設定を読めません：{e}"))
}
fn directory(root: &Path, settings: &Settings) -> Result<PathBuf, String> {
    let value = if settings.working_directory.trim().is_empty() {
        root.to_path_buf()
    } else {
        let path = Path::new(&settings.working_directory);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            root.join(path)
        }
    };
    let path = value
        .canonicalize()
        .map_err(|e| format!("ワーキングフォルダを確認してください：{e}"))?;
    if !path.is_dir() {
        return Err("ワーキングフォルダにはフォルダーを指定してください。".into());
    }
    Ok(path)
}
fn validate(root: &Path, settings: &Settings) -> Result<(), String> {
    if settings.command.trim().is_empty()
        || settings.command.len() > 8192
        || settings.command.contains(['\0', '\n', '\r'])
    {
        return Err(
            "起動コマンド（実行ファイル）を指定してください。引数は別欄に入力します。".into(),
        );
    }
    if settings.arguments.len() > 128
        || settings
            .arguments
            .iter()
            .any(|arg| arg.len() > 20000 || arg.contains('\0'))
        || settings.information.len() > 20000
    {
        return Err("引数または補足情報が長すぎるか、不正です。".into());
    }
    directory(root, settings)?;
    Ok(())
}
pub(crate) fn handle(root: &Path, options: &Value) -> Result<Value, String> {
    match options["action"].as_str().unwrap_or("read") {
        "read" => serde_json::to_value(read(root)?).map_err(|e| e.to_string()),
        "save" => {
            let mut settings: Settings =
                serde_json::from_value(options["settings"].clone()).map_err(|e| e.to_string())?;
            settings.command = settings.command.trim().to_string();
            settings.working_directory = settings.working_directory.trim().to_string();
            validate(root, &settings)?;
            let path = project_path(root, SETTINGS)?;
            fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
            let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap())
                .map_err(|e| e.to_string())?;
            file.write_all(&serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            file.persist(path).map_err(|e| e.to_string())?;
            Ok(json!(settings))
        }
        _ => Err("対象アプリケーションの設定操作が不正です。".into()),
    }
}
pub(crate) fn context(root: &Path) -> Value {
    match read(root) {
        Ok(settings) if !settings.command.is_empty() => json!(settings),
        _ => Value::Null,
    }
}

fn command(root: &Path, settings: &Settings) -> Result<Command, String> {
    validate(root, settings)?;
    let cwd = directory(root, settings)?;
    let local = cwd.join(&settings.command);
    let executable = if local.is_file() {
        local
    } else {
        PathBuf::from(&settings.command)
    };
    let mut cmd = Command::new(executable);
    cmd.args(&settings.arguments)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    Ok(cmd)
}
pub(crate) fn launch(root: &Path) -> Result<Value, String> {
    let settings = read(root)?;
    let mut cmd = command(root, &settings)?;
    let previous = markits::window_capture::list_windows()?;
    let checkpoint = crate::agent::cancellation_checkpoint(root);
    crate::agent::log_progress(root, "設定した対象アプリケーションを起動しています。");
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("対象アプリケーションを起動できません：{e}"))?;
    let pid = child.id();
    let started = Instant::now();
    let mut stable = 0;
    loop {
        crate::agent::check_cancelled(root, &checkpoint)?;
        let windows = markits::window_capture::list_windows()?;
        let owners = markits::window_capture::window_process_ids()?;
        let owned: Vec<_> = windows
            .iter()
            .filter(|w| {
                owners
                    .iter()
                    .any(|(id, owner)| id == &w.id && *owner == pid)
            })
            .cloned()
            .collect();
        let fresh: Vec<_> = windows
            .iter()
            .filter(|w| !previous.iter().any(|old| old.id == w.id))
            .cloned()
            .collect();
        if !owned.is_empty() || !fresh.is_empty() {
            stable += 1;
        } else {
            stable = 0;
        }
        if stable >= 3 {
            return Ok(
                json!({"pid":pid,"identify_window":owned.is_empty(),"windows":if owned.is_empty(){fresh}else{owned},"application":settings}),
            );
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if !status.success() {
                return Err(format!("対象アプリケーションの起動コマンドが終了しました（{status}）。引数とワーキングフォルダを確認してください。"));
            }
            if started.elapsed() > Duration::from_secs(2) && !windows.is_empty() {
                return Ok(
                    json!({"pid":pid,"windows":windows,"application":settings,"existing_window":true}),
                );
            }
        }
        if started.elapsed() > Duration::from_secs(30) {
            // Single-instance applications may reuse an existing window. The AI
            // must identify it from observed titles; never silently pick one.
            return Ok(
                json!({"pid":pid,"windows":windows,"application":settings,"existing_window":true}),
            );
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_roundtrip_preserves_arguments_and_is_project_local() {
        let root = tempfile::tempdir().unwrap();
        assert!(read(root.path()).unwrap().command.is_empty());
        let value = json!({"command":"python","arguments":["folder with spaces/app.py","--name","two words",""],"working_directory":".","information":"設定画面を説明する"});
        handle(root.path(), &json!({"action":"save","settings":value})).unwrap();
        assert_eq!(context(root.path()), value);
        let cmd = command(root.path(), &read(root.path()).unwrap()).unwrap();
        assert_eq!(
            cmd.get_args()
                .map(|s| s.to_string_lossy().to_string())
                .collect::<Vec<_>>(),
            vec!["folder with spaces/app.py", "--name", "two words", ""]
        );
        let bytes = fs::read(root.path().join(SETTINGS)).unwrap();
        assert!(handle(
            root.path(),
            &json!({"action":"save","settings":{"command":"python","working_directory":"missing"}})
        )
        .is_err());
        assert_eq!(fs::read(root.path().join(SETTINGS)).unwrap(), bytes);
        let other = tempfile::tempdir().unwrap();
        assert!(context(other.path()).is_null());
    }
}
