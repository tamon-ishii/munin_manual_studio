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

pub fn http_agent_json(
    root: &Path,
    prompt: &str,
    schema: &Value,
    endpoint_url: &str,
    model: &str,
    api_key: Option<&str>,
) -> Result<Value, String> {
    let base_url = if endpoint_url.trim().is_empty() {
        "http://localhost:11434/v1"
    } else {
        endpoint_url.trim().trim_end_matches('/')
    };
    let url = if base_url.ends_with("/chat/completions") {
        base_url.to_string()
    } else {
        format!("{base_url}/chat/completions")
    };

    let model_name = if model.trim().is_empty() {
        "default"
    } else {
        model.trim()
    };

    let schema_str = serde_json::to_string(schema).map_err(|e| e.to_string())?;
    let system_prompt = "You are an AI documentation assistant. You MUST respond with a valid, parseable JSON object matching the requested schema. Do NOT include markdown code blocks, backticks, or conversational text.";
    let user_prompt = format!("{prompt}\n\nRespond with a valid JSON object matching this schema:\n{schema_str}");

    let body = serde_json::json!({
        "model": model_name,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ],
        "response_format": { "type": "json_object" },
        "temperature": 0.2
    });

    log_progress(root, &format!("AI ({url}) へリクエストを送信しています..."));

    let mut request = ureq::post(&url)
        .timeout(Duration::from_secs(120))
        .set("Content-Type", "application/json");

    let effective_key = api_key
        .map(|k| k.to_string())
        .or_else(|| env::var("MUNIN_AI_API_KEY").ok())
        .or_else(|| env::var("OPENAI_API_KEY").ok());

    if let Some(key) = effective_key {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            request = request.set("Authorization", &format!("Bearer {trimmed}"));
        }
    }

    let response = request.send_json(body).map_err(|err| match err {
        ureq::Error::Status(code, resp) => {
            let body_text = resp.into_string().unwrap_or_default();
            format!("AI API returned HTTP {code}: {body_text}")
        }
        ureq::Error::Transport(transport) => {
            format!("AI API connection failed to {url}: {transport}")
        }
    })?;

    log_progress(root, "AIからの応答を受信しました。解析中...");

    let resp_json: Value = response
        .into_json()
        .map_err(|e| format!("Failed to parse API response as JSON: {e}"))?;

    let content = resp_json
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|msg| msg.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            resp_json
                .get("candidates")
                .and_then(|c| c.as_array())
                .and_then(|arr| arr.first())
                .and_then(|cand| cand.get("content"))
                .and_then(|content| content.get("parts"))
                .and_then(|parts| parts.as_array())
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(|p| p.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("")
                })
        })
        .ok_or_else(|| format!("Invalid response format from AI API: {resp_json}"))?;

    let clean_json = clean_markdown_fence(&content);

    serde_json::from_str(&clean_json).map_err(|e| {
        format!("Failed to parse model content as JSON schema: {e}\nRaw output: {content}")
    })
}

pub fn agent_json(
    root: &Path,
    prompt: &str,
    schema: &Value,
    agent: &str,
    model: &str,
) -> Result<Value, String> {
    let config = crate::config::read_config(root);
    if config.connection_type == "none" {
        return Err("AI接続は未設定です。「AI設定・出力」で接続方式を選択してください。".into());
    }
    if config.connection_type == "local_llm" || config.connection_type == "api" {
        let effective_model = if !model.is_empty() {
            model
        } else {
            &config.model
        };
        return http_agent_json(
            root,
            prompt,
            schema,
            &config.endpoint_url,
            effective_model,
            None,
        );
    }

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

    let binary = which_binary(binary_name)
        .ok_or_else(|| format!("AI CLI is unavailable: {binary_name}"))?;

    if agent == "codex" {
        return run_codex(&binary.to_string_lossy(), &cmd_args, root, &answer_path);
    }

    let log_path = progress_log_path(root);
    append_progress(&log_path, &format!("{binary_name} CLIを起動しています"));
    let started = Instant::now();
    let mut child = Command::new(&binary)
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

    let parsed: Value = extract_json_value(&stdout_str)
        .map_err(|e| format!("Failed to parse {agent} JSON: {e}\nOutput was: {stdout_str}"))?;

    extract_agent_payload(agent, &parsed, schema)
}

fn clean_markdown_fence(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.starts_with("```") {
        let lines: Vec<&str> = trimmed.lines().collect();
        if lines.len() >= 2
            && lines.first().unwrap().starts_with("```")
            && lines.last().unwrap().starts_with("```")
        {
            return lines[1..lines.len() - 1].join("\n").trim().to_string();
        }
    }
    trimmed.to_string()
}

fn extract_json_value(raw: &str) -> Result<Value, String> {
    let trimmed = raw.trim();
    if let Ok(val) = serde_json::from_str(trimmed) {
        return Ok(val);
    }
    if let Some(start) = trimmed.find('{') {
        if let Some(end) = trimmed.rfind('}') {
            if end > start {
                if let Ok(val) = serde_json::from_str(&trimmed[start..=end]) {
                    return Ok(val);
                }
            }
        }
    }
    if let Some(start) = trimmed.find('[') {
        if let Some(end) = trimmed.rfind(']') {
            if end > start {
                if let Ok(val) = serde_json::from_str(&trimmed[start..=end]) {
                    return Ok(val);
                }
            }
        }
    }
    serde_json::from_str(trimmed).map_err(|e| e.to_string())
}

fn has_schema_properties(val: &Value, schema: &Value) -> bool {
    if let Some(props) = schema.get("properties").and_then(Value::as_object) {
        if !props.is_empty() && props.keys().any(|k| val.get(k).is_some()) {
            return true;
        }
    }
    false
}

fn extract_agent_payload(agent: &str, parsed: &Value, schema: &Value) -> Result<Value, String> {
    // 1. Error checks in response envelope
    if parsed.get("is_error").and_then(Value::as_bool) == Some(true) {
        let msg = parsed
            .get("result")
            .and_then(Value::as_str)
            .or_else(|| {
                parsed.get("error").and_then(|e| {
                    e.as_str()
                        .or_else(|| e.get("message").and_then(Value::as_str))
                })
            })
            .unwrap_or("AI agent returned an error");
        return Err(format!("{agent} failed: {msg}"));
    }
    if let Some(status) = parsed.get("status").and_then(Value::as_str) {
        if status == "ERROR" || status == "FAILED" || (agent == "agy" && status != "SUCCESS") {
            let err = parsed
                .get("error")
                .and_then(|e| {
                    e.as_str()
                        .or_else(|| e.get("message").and_then(Value::as_str))
                })
                .unwrap_or("AI agent failed");
            return Err(format!("{agent} failed: {err}"));
        }
    }

    // 2. Parsed value already has expected schema properties
    if parsed.is_object() && has_schema_properties(parsed, schema) {
        return Ok(parsed.clone());
    }

    // 3. structured_output (Claude / Agy)
    if let Some(structured) = parsed.get("structured_output") {
        if structured.is_object() {
            return Ok(structured.clone());
        }
        if let Some(s) = structured.as_str() {
            let clean = clean_markdown_fence(s);
            if let Ok(val) = serde_json::from_str::<Value>(&clean) {
                if val.is_object() {
                    return Ok(val);
                }
            }
        }
    }

    // 4. result (Claude / Grok)
    if let Some(result) = parsed.get("result") {
        if result.is_object() {
            return Ok(result.clone());
        }
        if let Some(s) = result.as_str() {
            let clean = clean_markdown_fence(s);
            if let Ok(val) = serde_json::from_str::<Value>(&clean) {
                if val.is_object() {
                    return Ok(val);
                }
            }
            if schema
                .get("properties")
                .and_then(|p| p.get("markdown"))
                .is_some()
                && !clean.is_empty()
            {
                return Ok(json!({ "markdown": clean }));
            }
            return serde_json::from_str(&clean).map_err(|e| e.to_string());
        }
    }

    // 5. candidates (Gemini / Vertex AI: candidates[0].content.parts[0].text)
    if let Some(candidates) = parsed.get("candidates").and_then(Value::as_array) {
        if let Some(first_cand) = candidates.first() {
            let parts_opt = first_cand
                .get("content")
                .and_then(|c| c.get("parts"))
                .and_then(Value::as_array)
                .or_else(|| first_cand.get("parts").and_then(Value::as_array));
            if let Some(parts) = parts_opt {
                let text: String = parts
                    .iter()
                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("");
                let clean = clean_markdown_fence(&text);
                if let Ok(val) = serde_json::from_str::<Value>(&clean) {
                    if val.is_object() {
                        return Ok(val);
                    }
                }
                if schema
                    .get("properties")
                    .and_then(|p| p.get("markdown"))
                    .is_some()
                    && !clean.is_empty()
                {
                    return Ok(json!({ "markdown": clean }));
                }
            }
        }
    }

    // 6. content (Claude / OpenAI format, or content with parts)
    if let Some(content) = parsed.get("content") {
        if content.is_object() {
            if let Some(parts) = content.get("parts").and_then(Value::as_array) {
                let text: String = parts
                    .iter()
                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("");
                let clean = clean_markdown_fence(&text);
                if let Ok(val) = serde_json::from_str::<Value>(&clean) {
                    if val.is_object() {
                        return Ok(val);
                    }
                }
                if schema
                    .get("properties")
                    .and_then(|p| p.get("markdown"))
                    .is_some()
                    && !clean.is_empty()
                {
                    return Ok(json!({ "markdown": clean }));
                }
            }
        } else if let Some(arr) = content.as_array() {
            // Check for tool_use blocks
            for item in arr {
                if item.get("type").and_then(Value::as_str) == Some("tool_use") {
                    if let Some(input) = item.get("input").filter(|i| i.is_object()) {
                        return Ok(input.clone());
                    }
                }
            }
            // Collect text from blocks
            let mut texts = Vec::new();
            for item in arr {
                if let Some(t) = item.get("text").and_then(Value::as_str) {
                    texts.push(t);
                } else if let Some(parts) = item.get("parts").and_then(Value::as_array) {
                    for p in parts {
                        if let Some(t) = p.get("text").and_then(Value::as_str) {
                            texts.push(t);
                        }
                    }
                }
            }
            if !texts.is_empty() {
                let combined = texts.join("");
                let clean = clean_markdown_fence(&combined);
                if let Ok(val) = serde_json::from_str::<Value>(&clean) {
                    if val.is_object() {
                        return Ok(val);
                    }
                }
                if schema
                    .get("properties")
                    .and_then(|p| p.get("markdown"))
                    .is_some()
                    && !clean.is_empty()
                {
                    return Ok(json!({ "markdown": clean }));
                }
            }
        } else if let Some(s) = content.as_str() {
            let clean = clean_markdown_fence(s);
            if let Ok(val) = serde_json::from_str::<Value>(&clean) {
                if val.is_object() {
                    return Ok(val);
                }
            }
            if schema
                .get("properties")
                .and_then(|p| p.get("markdown"))
                .is_some()
                && !clean.is_empty()
            {
                return Ok(json!({ "markdown": clean }));
            }
        }
    }

    // 7. Direct parts array
    if let Some(parts) = parsed.get("parts").and_then(Value::as_array) {
        let text: String = parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("");
        let clean = clean_markdown_fence(&text);
        if let Ok(val) = serde_json::from_str::<Value>(&clean) {
            if val.is_object() {
                return Ok(val);
            }
        }
        if schema
            .get("properties")
            .and_then(|p| p.get("markdown"))
            .is_some()
            && !clean.is_empty()
        {
            return Ok(json!({ "markdown": clean }));
        }
    }

    // 8. response / text (Agy / Grok)
    for key in ["response", "text"] {
        if let Some(val) = parsed.get(key) {
            if val.is_object() {
                return Ok(val.clone());
            }
            if let Some(s) = val.as_str() {
                let clean = clean_markdown_fence(s);
                if let Ok(v) = serde_json::from_str::<Value>(&clean) {
                    if v.is_object() {
                        return Ok(v);
                    }
                }
                if schema
                    .get("properties")
                    .and_then(|p| p.get("markdown"))
                    .is_some()
                    && !clean.is_empty()
                {
                    return Ok(json!({ "markdown": clean }));
                }
                return serde_json::from_str(&clean).map_err(|e| e.to_string());
            }
        }
    }

    // 9. Fallback if parsed is an object
    if parsed.is_object() {
        return Ok(parsed.clone());
    }

    Err(format!(
        "Could not extract structured data from {agent} response: {parsed}"
    ))
}

fn failure_message(stderr: &str, stdout: &str) -> String {
    for output in [stderr, stdout] {
        if let Ok(value) = extract_json_value(output) {
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

    #[test]
    fn claude_structured_output_is_extracted() {
        let schema = json!({
            "type": "object",
            "properties": { "markdown": { "type": "string" } },
            "required": ["markdown"]
        });

        // 1. structured_output as object
        let res1 = json!({
            "type": "result",
            "structured_output": { "markdown": "# Title 1" }
        });
        let payload1 = extract_agent_payload("claude", &res1, &schema).unwrap();
        assert_eq!(payload1["markdown"], "# Title 1");

        // 2. structured_output as JSON string
        let res2 = json!({
            "type": "result",
            "structured_output": "{\"markdown\": \"# Title 2\"}"
        });
        let payload2 = extract_agent_payload("claude", &res2, &schema).unwrap();
        assert_eq!(payload2["markdown"], "# Title 2");

        // 3. result as plain markdown string for markdown schema
        let res3 = json!({
            "type": "result",
            "result": "## Direct markdown"
        });
        let payload3 = extract_agent_payload("claude", &res3, &schema).unwrap();
        assert_eq!(payload3["markdown"], "## Direct markdown");
    }

    #[test]
    fn claude_parts_and_candidates_are_extracted() {
        let schema = json!({
            "type": "object",
            "properties": { "markdown": { "type": "string" } },
            "required": ["markdown"]
        });

        // Gemini/Vertex candidates with parts
        let res_candidates = json!({
            "candidates": [
                {
                    "content": {
                        "parts": [
                            { "text": "```json\n{\"markdown\": \"# From parts\"}\n```" }
                        ]
                    }
                }
            ]
        });
        let payload = extract_agent_payload("claude", &res_candidates, &schema).unwrap();
        assert_eq!(payload["markdown"], "# From parts");

        // Direct parts array
        let res_parts = json!({
            "parts": [
                { "text": "{\"markdown\": \"# Direct parts\"}" }
            ]
        });
        let payload_parts = extract_agent_payload("claude", &res_parts, &schema).unwrap();
        assert_eq!(payload_parts["markdown"], "# Direct parts");
    }

    #[test]
    fn claude_content_tool_use_is_extracted() {
        let schema = json!({
            "type": "object",
            "properties": { "markdown": { "type": "string" } },
            "required": ["markdown"]
        });

        let res_tool = json!({
            "content": [
                {
                    "type": "tool_use",
                    "id": "tool_123",
                    "input": { "markdown": "# From tool" }
                }
            ]
        });
        let payload = extract_agent_payload("claude", &res_tool, &schema).unwrap();
        assert_eq!(payload["markdown"], "# From tool");
    }

    #[test]
    fn claude_error_surfaces_as_err() {
        let schema = json!({
            "type": "object",
            "properties": { "markdown": { "type": "string" } },
            "required": ["markdown"]
        });

        let err_json = json!({
            "is_error": true,
            "result": "Not logged in · Please run /login"
        });
        let err = extract_agent_payload("claude", &err_json, &schema).unwrap_err();
        assert!(err.contains("Not logged in"));
    }

    #[test]
    fn extract_json_value_handles_surrounding_text() {
        let raw = "Warning: new version available\n{\"markdown\":\"# Hello\"}\nTips: run claude update";
        let val = extract_json_value(raw).unwrap();
        assert_eq!(val["markdown"], "# Hello");
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

    let binary = which_binary(command_name)
        .ok_or_else(|| format!("AI CLI is unavailable: {command_name}"))?;

    let mut found = Vec::new();

    if agent == "codex" {
        let mut child = Command::new(&binary)
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
        let output = Command::new(&binary)
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
