use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::tempdir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub label: String,
    pub available: bool,
}

pub fn which_binary(name: &str) -> Option<PathBuf> {
    if let Some(path_var) = env::var_os("PATH") {
        for dir in env::split_paths(&path_var) {
            let full_path = dir.join(name);
            if full_path.is_file() {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Ok(meta) = fs::metadata(&full_path) {
                        if meta.permissions().mode() & 0o111 != 0 {
                            return Some(full_path);
                        }
                    }
                }
                #[cfg(not(unix))]
                return Some(full_path);
            }
            #[cfg(windows)]
            {
                for ext in &["exe", "cmd", "bat"] {
                    let with_ext = dir.join(format!("{name}.{ext}"));
                    if with_ext.is_file() {
                        return Some(with_ext);
                    }
                }
            }
        }
    }
    None
}

pub fn get_agents() -> Vec<AgentInfo> {
    let list = [
        ("codex", "Codex"),
        ("claude", "Claude Code"),
        ("grok", "Grok Build"),
        ("agy", "Agy"),
    ];
    list.into_iter()
        .map(|(id, label)| AgentInfo {
            id: id.to_string(),
            label: label.to_string(),
            available: which_binary(id).is_some(),
        })
        .collect()
}

fn progress_log_path(root: &Path) -> PathBuf {
    let hash = Sha256::digest(root.to_string_lossy().as_bytes());
    env::temp_dir().join(format!("moduleloom-agent-progress-{:x}.jsonl", hash))
}

pub fn progress(root: &Path) -> String {
    let logs = fs::read_to_string(progress_log_path(root)).unwrap_or_default();
    let entries: Vec<Value> = logs
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    let total = entries.len();
    json!({ "logs": entries.into_iter().skip(total.saturating_sub(300)).collect::<Vec<_>>(), "total": total }).to_string()
}

pub fn clear_progress(root: &Path) {
    let _ = fs::write(progress_log_path(root), "");
}

pub fn log_progress(root: &Path, message: &str) {
    append_progress(&progress_log_path(root), message);
}

fn append_progress(path: &Path, message: &str) {
    let entry = json!({
        "time": chrono::Local::now().format("%H:%M:%S").to_string(),
        "message": message,
    });
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        if serde_json::to_writer(&mut file, &entry).is_ok() {
            let _ = file.write_all(b"\n");
            let _ = file.flush();
        }
    }
}

fn codex_event_message(event: &Value) -> Option<String> {
    let event_type = event.get("type")?.as_str()?;
    match event_type {
        "thread.started" => Some("Codexセッションを開始しました".into()),
        "turn.started" => Some("回答を作成しています".into()),
        "turn.completed" => Some("Codexの応答が完了しました".into()),
        "turn.failed" | "error" => event
            .get("message")
            .and_then(Value::as_str)
            .map(|message| format!("Codexエラー: {message}")),
        "item.started" | "item.completed" => {
            let item = event.get("item")?;
            let item_type = item.get("type")?.as_str()?;
            let started = event_type == "item.started";
            match item_type {
                "command_execution" => {
                    if started {
                        let command = item
                            .get("command")
                            .and_then(Value::as_str)
                            .unwrap_or("コマンド");
                        let command: String = command.chars().take(140).collect();
                        Some(format!("コマンド実行中: {command}"))
                    } else {
                        Some("コマンドが完了しました".into())
                    }
                }
                "mcp_tool_call" => {
                    let name = item
                        .get("tool_name")
                        .and_then(Value::as_str)
                        .unwrap_or("ツール");
                    Some(format!(
                        "{}: {name}",
                        if started {
                            "ツールを実行中"
                        } else {
                            "ツールが完了"
                        }
                    ))
                }
                "web_search" => Some(
                    if started {
                        "Webを検索しています"
                    } else {
                        "Web検索が完了しました"
                    }
                    .into(),
                ),
                "file_search" => Some(
                    if started {
                        "ソースを検索しています"
                    } else {
                        "ソース検索が完了しました"
                    }
                    .into(),
                ),
                "agent_message" if !started => Some("回答を受け取りました".into()),
                "reasoning" if started => Some("内容を整理しています".into()),
                _ if started => Some("作業を進めています".into()),
                _ => None,
            }
        }
        _ => None,
    }
}

fn run_codex(
    binary: &str,
    args: &[String],
    root: &Path,
    answer_path: &Path,
) -> Result<Value, String> {
    let log_path = progress_log_path(root);
    append_progress(&log_path, "Codex CLIを起動しています");
    let started = Instant::now();

    let mut child = Command::new(binary)
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to run {binary}: {error}"))?;
    let stdout = child.stdout.take().ok_or("Failed to read Codex output")?;
    let stderr = child.stderr.take().ok_or("Failed to read Codex errors")?;
    let stderr_log_path = log_path.clone();
    let stderr_reader = thread::spawn(move || {
        let mut text = String::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            text.push_str(&line);
            text.push('\n');
            let message: String = line.chars().take(220).collect();
            if !message.trim().is_empty() {
                append_progress(&stderr_log_path, &format!("Codex: {}", message.trim()));
            }
        }
        text
    });

    let mut stdout_text = String::new();
    let mut first_output = true;
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|error| format!("Failed to read Codex output: {error}"))?;
        if first_output {
            append_progress(
                &log_path,
                &format!(
                    "Codexから最初のイベントを受信しました（起動から{}秒）",
                    started.elapsed().as_secs()
                ),
            );
            first_output = false;
        }
        stdout_text.push_str(&line);
        stdout_text.push('\n');
        if let Ok(event) = serde_json::from_str::<Value>(&line) {
            if let Some(message) = codex_event_message(&event) {
                append_progress(&log_path, &message);
            }
        }
    }
    let status = child.wait().map_err(|error| error.to_string())?;
    let stderr_text = stderr_reader.join().unwrap_or_default();
    append_progress(
        &log_path,
        &format!(
            "Codex CLIが終了しました（所要{}秒）",
            started.elapsed().as_secs()
        ),
    );
    if !status.success() {
        return Err(format!(
            "codex failed: {}",
            failure_message(&stderr_text, &stdout_text)
        ));
    }
    let answer_content = fs::read_to_string(answer_path)
        .map_err(|error| format!("Failed to read codex answer: {error}"))?;
    serde_json::from_str(&answer_content).map_err(|error| error.to_string())
}

pub fn agent_json(
    root: &Path,
    prompt: &str,
    schema: &Value,
    agent: &str,
    model: &str,
) -> Result<Value, String> {
    let tmp = tempdir().map_err(|e| e.to_string())?;
    let schema_path = tmp.path().join("schema.json");
    let answer_path = tmp.path().join("answer.json");
    let schema_str = serde_json::to_string(schema).map_err(|e| e.to_string())?;
    fs::write(&schema_path, &schema_str).map_err(|e| e.to_string())?;

    let mut cmd_args: Vec<String> = Vec::new();
    let binary_name = match agent {
        "codex" => {
            cmd_args.extend([
                "exec".into(),
                "--ephemeral".into(),
                "--skip-git-repo-check".into(),
                "--sandbox".into(),
                "read-only".into(),
                "-c".into(),
                "model_reasoning_effort=\"low\"".into(),
                "--cd".into(),
                root.to_string_lossy().into_owned(),
                "--output-schema".into(),
                schema_path.to_string_lossy().into_owned(),
                "--json".into(),
                "--output-last-message".into(),
                answer_path.to_string_lossy().into_owned(),
                prompt.to_string(),
            ]);
            "codex"
        }
        "claude" => {
            cmd_args.extend([
                "-p".into(),
                "--output-format".into(),
                "json".into(),
                "--json-schema".into(),
                schema_str.clone(),
                "--restricted".into(),
                "--no-session-persistence".into(),
                prompt.to_string(),
            ]);
            "claude"
        }
        "grok" => {
            let grok_prompt =
                format!("{prompt}\nReturn a JSON object only, matching this schema: {schema_str}");
            cmd_args.extend([
                "--no-auto-update".into(),
                "-p".into(),
                grok_prompt,
                "--cwd".into(),
                root.to_string_lossy().into_owned(),
                "--output-format".into(),
                "json".into(),
                "--tools".into(),
                "read_file,grep,list_dir".into(),
                "--no-subagents".into(),
            ]);
            "grok"
        }
        "agy" => {
            cmd_args.extend([
                "-p".into(),
                prompt.to_string(),
                "--output-format".into(),
                "json".into(),
                "--json-schema".into(),
                schema_str.clone(),
                // Documentation tasks need grounded output, but high reasoning
                // effort can make Agy spend several minutes on otherwise small
                // structured responses. Keep the interactive generation path
                // responsive by using its supported low-effort mode.
                "--effort".into(),
                "low".into(),
                "--sandbox".into(),
            ]);
            "agy"
        }
        _ => return Err(format!("Unsupported AI agent: {agent}")),
    };

    if !model.is_empty() {
        cmd_args.insert(0, model.to_string());
        cmd_args.insert(0, "--model".to_string());
    }

    if which_binary(binary_name).is_none() {
        return Err(format!("AI CLI is unavailable: {binary_name}"));
    }

    if agent == "codex" {
        return run_codex(binary_name, &cmd_args, root, &answer_path);
    }

    let log_path = progress_log_path(root);
    append_progress(&log_path, &format!("{binary_name} CLIを起動しています"));
    let started = Instant::now();
    let mut child = Command::new(binary_name)
        .args(&cmd_args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run {binary_name}: {e}"))?;
    append_progress(&log_path, "AIエージェントの応答を待っています");
    let stderr = child.stderr.take().ok_or("Failed to read AI errors")?;
    let stderr_log_path = log_path.clone();
    let stderr_reader = thread::spawn(move || {
        let mut text = String::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            text.push_str(&line);
            text.push('\n');
            let message: String = line.chars().take(220).collect();
            if !message.trim().is_empty() {
                append_progress(&stderr_log_path, &format!("CLI: {}", message.trim()));
            }
        }
        text
    });
    let mut stdout_str = String::new();
    child
        .stdout
        .take()
        .ok_or("Failed to read AI output")?
        .read_to_string(&mut stdout_str)
        .map_err(|e| format!("Failed to read {binary_name} output: {e}"))?;
    let exit_status = child.wait().map_err(|e| e.to_string())?;
    let stderr_text = stderr_reader.join().unwrap_or_default();
    append_progress(
        &log_path,
        &format!(
            "AIエージェントの応答を受け取りました（所要{}秒）",
            started.elapsed().as_secs()
        ),
    );

    if !exit_status.success() {
        return Err(format!(
            "{agent} failed: {}",
            failure_message(&stderr_text, &stdout_str)
        ));
    }

    let parsed: Value = serde_json::from_str(&stdout_str)
        .map_err(|e| format!("Failed to parse {agent} JSON: {e}\nOutput was: {stdout_str}"))?;

    if agent == "grok" {
        if let Some(text) = parsed.get("text").and_then(|t| t.as_str()) {
            return serde_json::from_str(text).map_err(|e| e.to_string());
        }
        return Ok(parsed);
    }

    if agent == "agy" {
        if let Some(status) = parsed.get("status").and_then(|s| s.as_str()) {
            if status != "SUCCESS" {
                let err = parsed
                    .get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("Agy failed");
                return Err(err.to_string());
            }
        }
        if let Some(structured) = parsed.get("structured_output") {
            if structured.is_object() {
                return Ok(structured.clone());
            }
        }
        if let Some(resp) = parsed.get("response").and_then(|r| r.as_str()) {
            return serde_json::from_str(resp).map_err(|e| e.to_string());
        }
        return Ok(parsed);
    }

    if let Some(structured) = parsed.get("structured_output") {
        if structured.is_object() {
            return Ok(structured.clone());
        }
    }
    if let Some(res) = parsed.get("result").and_then(|r| r.as_str()) {
        return serde_json::from_str(res).map_err(|e| e.to_string());
    }

    Ok(parsed)
}

fn failure_message(stderr: &str, stdout: &str) -> String {
    for output in [stderr, stdout] {
        if let Ok(value) = serde_json::from_str::<Value>(output.trim()) {
            let message = value
                .get("error")
                .and_then(|error| {
                    error
                        .as_str()
                        .or_else(|| error.get("message").and_then(Value::as_str))
                })
                .or_else(|| value.get("result").and_then(Value::as_str));
            if let Some(message) = message.filter(|message| !message.trim().is_empty()) {
                return bounded_failure_message(message.trim()).to_string();
            }
        }
    }
    let message = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    bounded_failure_message(message).to_string()
}

fn bounded_failure_message(message: &str) -> &str {
    let mut start = message.len().saturating_sub(2000);
    while !message.is_char_boundary(start) {
        start += 1;
    }
    &message[start..]
}

#[cfg(test)]
mod failure_tests {
    use super::*;

    #[test]
    fn codex_progress_events_are_summarized_without_exposing_agent_text() {
        let event = json!({
            "type": "item.completed",
            "item": { "type": "agent_message", "text": "private generated answer" }
        });
        assert_eq!(
            codex_event_message(&event).as_deref(),
            Some("回答を受け取りました")
        );

        let command = json!({
            "type": "item.started",
            "item": { "type": "command_execution", "command": "rg source" }
        });
        assert_eq!(
            codex_event_message(&command).as_deref(),
            Some("コマンド実行中: rg source")
        );
    }

    #[test]
    fn progress_log_is_readable_as_jsonl_during_a_request() {
        let root = tempfile::tempdir().unwrap();
        clear_progress(root.path());
        append_progress(&progress_log_path(root.path()), "Codexを起動しています");
        let state: Value = serde_json::from_str(&progress(root.path())).unwrap();
        assert_eq!(state["logs"][0]["message"], "Codexを起動しています");
        assert_eq!(state["total"], 1);
        clear_progress(root.path());
    }

    #[test]
    fn structured_cli_error_shows_the_actionable_reason() {
        assert_eq!(
            failure_message(
                "",
                r#"{"is_error":true,"result":"Not logged in · Please run /login","usage":{"input_tokens":0}}"#
            ),
            "Not logged in · Please run /login"
        );
        assert_eq!(
            failure_message(
                "warning",
                r#"{"error":{"message":"Authentication expired"}}"#
            ),
            "Authentication expired"
        );
    }

    #[test]
    fn plain_cli_errors_prefer_stderr() {
        assert_eq!(
            failure_message(" CLI unavailable \n", "output"),
            "CLI unavailable"
        );
        assert_eq!(failure_message("", " Failed \n"), "Failed");
    }

    #[test]
    fn long_japanese_errors_are_truncated_on_a_character_boundary() {
        let message = "認証エラー".repeat(300);
        let result = failure_message(&message, "");
        assert!(result.len() <= 2000);
        assert!(message.ends_with(&result));
        assert!(!result.is_empty());
    }
}

pub fn get_models(root: &Path, agent: &str) -> Result<Value, String> {
    if agent == "claude" {
        return Ok(json!({
            "models": [],
            "message": "Claude Code CLI はモデル一覧コマンドを提供していません。モデルIDを入力するか既定モデルを使ってください"
        }));
    }

    let command_name = match agent {
        "agy" => "agy",
        "grok" => "grok",
        "codex" => "codex",
        _ => return Err(format!("AI CLI is unavailable: {agent}")),
    };

    if which_binary(command_name).is_none() {
        return Err(format!("AI CLI is unavailable: {command_name}"));
    }

    let mut found = Vec::new();

    if agent == "codex" {
        let mut child = Command::new("codex")
            .arg("app-server")
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;

        let mut stdin = child.stdin.take().ok_or("Failed to open stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to open stdout")?;
        let mut reader = BufReader::new(stdout);

        let messages = [
            json!({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "moduleloom", "version": "1.0.6"}, "capabilities": {}}}),
            json!({"method": "initialized", "params": {}}),
            json!({"id": 2, "method": "model/list", "params": {"limit": 100}}),
        ];

        for msg in &messages {
            let line = serde_json::to_string(msg).unwrap();
            writeln!(stdin, "{line}").map_err(|e| e.to_string())?;
        }
        let _ = stdin.flush();

        let mut line_buf = String::new();
        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_secs(10) {
            line_buf.clear();
            if reader.read_line(&mut line_buf).unwrap_or(0) == 0 {
                break;
            }
            if let Ok(item) = serde_json::from_str::<Value>(&line_buf) {
                if item.get("id").and_then(|id| id.as_i64()) == Some(2) {
                    if let Some(err) = item.get("error") {
                        let _ = child.kill();
                        return Err(err.to_string());
                    }
                    if let Some(result) = item.get("result").and_then(|r| r.as_object()) {
                        if let Some(data) = result.get("data").and_then(|d| d.as_array()) {
                            for entry in data {
                                if !entry
                                    .get("hidden")
                                    .and_then(|h| h.as_bool())
                                    .unwrap_or(false)
                                {
                                    if let Some(model_id) =
                                        entry.get("model").and_then(|m| m.as_str())
                                    {
                                        let label = entry
                                            .get("displayName")
                                            .and_then(|d| d.as_str())
                                            .unwrap_or(model_id);
                                        found.push(json!({
                                            "id": model_id,
                                            "label": label
                                        }));
                                    }
                                }
                            }
                        }
                    }
                    break;
                }
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    } else {
        let output = Command::new(command_name)
            .arg("models")
            .current_dir(root)
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(err.trim().to_string());
        }

        let out = String::from_utf8_lossy(&output.stdout);
        let re = regex::Regex::new(r"^\s*([a-z][a-zA-Z0-9._-]*)\s+(.+)$").unwrap();
        for line in out.lines() {
            if let Some(cap) = re.captures(line) {
                let id = cap.get(1).unwrap().as_str();
                let label = cap.get(2).unwrap().as_str().trim();
                found.push(json!({
                    "id": id,
                    "label": label
                }));
            }
        }
    }

    Ok(json!({
        "models": found,
        "message": ""
    }))
}
