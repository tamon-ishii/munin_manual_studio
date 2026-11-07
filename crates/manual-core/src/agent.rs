use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use tempfile::tempdir;

thread_local! { static REQUEST_TIMEOUT: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) }; }
pub struct TimeoutScope(Option<u64>);
impl Drop for TimeoutScope { fn drop(&mut self) { REQUEST_TIMEOUT.with(|value|value.set(self.0)); } }
pub fn request_timeout(seconds: Option<u64>) -> TimeoutScope {
    TimeoutScope(REQUEST_TIMEOUT.with(|value|value.replace(seconds)))
}
pub(crate) fn operation_timeout(default: u64) -> Duration {
    Duration::from_secs(REQUEST_TIMEOUT.with(|value|value.get()).unwrap_or(default))
}
pub(crate) fn run_process(root: &Path,binary: &str,args: &[String]) -> Result<std::process::Output,String> {
    let checkpoint=cancellation_checkpoint(root);
    let mut child=cli_command(binary,args,root).spawn().map_err(|e|e.to_string())?;
    let mut stdout=child.stdout.take().ok_or("No process stdout")?;
    let mut stderr=child.stderr.take().ok_or("No process stderr")?;
    let out=thread::spawn(move||{let mut bytes=Vec::new();stdout.read_to_end(&mut bytes).map(|_|bytes)});
    let err=thread::spawn(move||{let mut bytes=Vec::new();stderr.read_to_end(&mut bytes).map(|_|bytes)});
    let result=wait_for_cli(&mut child,root,&checkpoint,operation_timeout(300));
    let stdout=out.join().map_err(|_|"stdout reader failed")?.map_err(|e|e.to_string())?;
    let stderr=err.join().map_err(|_|"stderr reader failed")?.map_err(|e|e.to_string())?;
    Ok(std::process::Output{status:result?,stdout,stderr})
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub label: String,
    pub available: bool,
}

pub fn which_binary(name: &str) -> Option<PathBuf> {
    env::var_os("PATH").and_then(|path| which_binary_in_path(name, &path))
}

fn which_binary_in_path(name: &str, path: &std::ffi::OsStr) -> Option<PathBuf> {
    for dir in env::split_paths(path) {
        #[cfg(windows)]
        {
            // npm installs a Unix shell script beside its Windows .cmd shim.
            // Never select that extensionless script as a Win32 executable.
            let extension = Path::new(name).extension().and_then(|value| value.to_str());
            if extension.is_some_and(|ext| ["exe", "com", "cmd", "bat"].iter().any(|known| ext.eq_ignore_ascii_case(known))) {
                let candidate = dir.join(name);
                if candidate.is_file() { return Some(candidate); }
            } else if extension.is_none() {
                for ext in ["exe", "com", "cmd", "bat"] {
                    let candidate = dir.join(format!("{name}.{ext}"));
                    if candidate.is_file() { return Some(candidate); }
                }
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let full_path = dir.join(name);
            if let Ok(meta) = fs::metadata(&full_path) {
                if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
                    return Some(full_path);
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

/// Log observable requests/results, never provider reasoning or raw CLI streams.
pub(crate) fn log_exchange(root: &Path, kind: &str, message: &str, value: &Value) {
    let mut detail = value.as_str().map(str::to_owned).unwrap_or_else(|| serde_json::to_string_pretty(value).unwrap_or_default());
    REQUEST_API_KEY.with(|key| {
        if let Some(key) = key.borrow().as_ref().filter(|key| !key.is_empty()) {detail = detail.replace(key, "[REDACTED]");}
    });
    let bearer = regex::Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*").unwrap();
    detail = bearer.replace_all(&detail,"Bearer [REDACTED]").into_owned();
    let secrets = regex::Regex::new(r#"(?i)("?(?:api[_-]?key|authorization|password|access_token|refresh_token|secret)"?\s*[:=]\s*)(?:"[^"\n]*"|[^\s,}]+)"#).unwrap();
    detail = secrets.replace_all(&detail, "${1}\"[REDACTED]\"").into_owned();
    if detail.chars().count() > 32_000 {detail = detail.chars().take(32_000).collect::<String>() + "\n…（ログは32,000文字まで表示）";}
    let entry = json!({"time":chrono::Local::now().format("%H:%M:%S").to_string(),"message":message,"kind":kind,"detail":detail});
    append_event(&progress_log_path(root),&entry);
}

pub(crate) fn traced_candidate(root: &Path, prompt: &str, schema: &Value, agent: &str, model: &str) -> Result<Value,String> {
    log_exchange(root,"request","AIへ送信：雛形作成の指示",&json!({"instruction":prompt,"response_schema":schema}));
    let result = agent_json_candidate(root,prompt,schema,agent,model);
    match &result {
        Ok(value) => log_exchange(root,"response","AIからの応答：雛形の候補・操作計画",value),
        Err(error) => log_exchange(root,"error","AIへの依頼に失敗",&json!({"error":error})),
    }
    result
}

fn append_progress(path: &Path, message: &str) {
    let entry = json!({
        "time": chrono::Local::now().format("%H:%M:%S").to_string(),
        "message": message,
    });
    append_event(path,&entry);
}

fn append_event(path: &Path, entry: &Value) {
    if let Ok(mut bytes) = serde_json::to_vec(entry) {
        bytes.push(b'\n');
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = file.write_all(&bytes);let _ = file.flush();
        }
    }
}

thread_local! {
    static REQUEST_API_KEY: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

pub(crate) struct ApiKeyScope(Option<String>);
impl Drop for ApiKeyScope {
    fn drop(&mut self) {
        REQUEST_API_KEY.with(|key| *key.borrow_mut() = self.0.take());
    }
}
pub(crate) fn request_api_key(key: Option<&str>) -> ApiKeyScope {
    ApiKeyScope(REQUEST_API_KEY.with(|current| current.replace(key.map(str::to_string))))
}

// The marker works across the separate manualctl processes used by the dev bridge.
fn cancel_path(root: &Path) -> PathBuf {
    progress_log_path(root).with_extension("cancel")
}

pub(crate) fn cancellation_checkpoint(root: &Path) -> String {
    fs::read_to_string(cancel_path(root)).unwrap_or_default()
}

pub(crate) fn check_cancelled(root: &Path, checkpoint: &str) -> Result<(), String> {
    if cancellation_checkpoint(root) != checkpoint {
        Err("AI生成を中断しました。原稿は変更していません。".into())
    } else {
        Ok(())
    }
}

pub fn cancel(root: &Path) -> Result<(), String> {
    fs::write(cancel_path(root), format!("{:?}", SystemTime::now()))
        .map_err(|error| error.to_string())
}

pub(crate) fn stop_cli_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        if let Ok(group) = libc::pid_t::try_from(child.id()) {
            if group > 0 {
                // cli_command gives this owned child its own process group.
                // Signal it directly: external kill utility syntax differs on
                // Unix platforms and killing only the parent leaves pipes open.
                unsafe { libc::killpg(group, libc::SIGKILL); }
            }
        }
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

pub(crate) fn wait_for_cli(
    child: &mut std::process::Child,
    root: &Path,
    checkpoint: &str,
    timeout: Duration,
) -> Result<std::process::ExitStatus, String> {
    let started = Instant::now();
    loop {
        let interrupted = check_cancelled(root, checkpoint).err().or_else(|| {
            (started.elapsed() >= timeout)
                .then(|| format!("AI CLIが制限時間（{}秒）を超えました。", timeout.as_secs()))
        });
        if let Some(error) = interrupted {
            // CLI tools can launch descendants that keep stdout/stderr open.
            // Stop the process group as well so pipe reader threads can finish.
            stop_cli_tree(child);
            let _ = child.wait();
            return Err(error);
        }
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            // A completed CLI must not leave background tools holding its pipes.
            stop_cli_tree(child);
            return Ok(status);
        }
        thread::sleep(Duration::from_millis(50));
    }
}

pub(crate) fn cli_command(binary: &str, args: &[String], root: &Path) -> Command {
    #[cfg(windows)]
    let mut command = npm_cli_command(Path::new(binary)).unwrap_or_else(|| Command::new(binary));
    #[cfg(not(windows))]
    let mut command = Command::new(binary);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
}

#[cfg(windows)]
fn npm_cli_command(binary: &Path) -> Option<Command> {
    // cmd.exe cannot transport arbitrary multiline prompts. Invoke npm's JS
    // entry point with Node so Windows receives the original argument vector.
    let package=match binary.file_name()?.to_str()?.to_ascii_lowercase().as_str(){
        "codex.cmd"=>"node_modules/@openai/codex/bin/codex.js",
        "claude.cmd"=>"node_modules/@anthropic-ai/claude-code/cli.js",
        _=>return None,
    };
    let directory = binary.parent()?;
    let script = directory.join(package);
    if !script.is_file() { return None; }
    let local_node = directory.join("node.exe");
    let node = if local_node.is_file() { local_node } else {
        which_binary("node").unwrap_or_else(|| PathBuf::from("node.exe"))
    };
    let mut command = Command::new(node);
    command.arg(script);
    Some(command)
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
    workdir: &Path,
) -> Result<Value, String> {
    let log_path = progress_log_path(root);
    append_progress(&log_path, "Codex CLIを起動しています");
    let started = Instant::now();

    let checkpoint = cancellation_checkpoint(root);
    let mut child = cli_command(binary, args, workdir)
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

    let stdout_log_path = log_path.clone();
    let stdout_reader = thread::spawn(move || -> Result<String, String> {
        let log_path = stdout_log_path;
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
        Ok(stdout_text)
    });
    let status = wait_for_cli(&mut child, root, &checkpoint, operation_timeout(300));
    let stderr_text = stderr_reader.join().unwrap_or_default();
    let stdout_text = stdout_reader
        .join()
        .map_err(|_| "Codex output reader failed")??;
    let status = status?;
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
    if answer_content.trim().is_empty(){return Err(empty_cli_answer("codex",&stderr_text));}
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
    http_agent_json_images(root,prompt,schema,endpoint_url,model,api_key,&[])
}

pub(crate) fn http_agent_json_images(root:&Path,prompt:&str,schema:&Value,endpoint_url:&str,model:&str,api_key:Option<&str>,images:&[String])->Result<Value,String>{
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
    let user_prompt =
        format!("{prompt}\n\nRespond with a valid JSON object matching this schema:\n{schema_str}");

    let user_content = if images.is_empty() { json!(user_prompt) } else {
        let mut parts=vec![json!({"type":"text","text":user_prompt})];
        parts.extend(images.iter().map(|url|json!({"type":"image_url","image_url":{"url":url}})));
        json!(parts)
    };
    let body = serde_json::json!({
        "model": model_name,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_content }
        ],
        "response_format": { "type": "json_object" },
        "temperature": 0.2
    });

    log_progress(root, &format!("AI ({url}) へリクエストを送信しています..."));

    let checkpoint = cancellation_checkpoint(root);
    let effective_key = api_key
        .map(str::to_string)
        .or_else(|| REQUEST_API_KEY.with(|key| key.borrow().clone()))
        .or_else(|| env::var("MUNIN_AI_API_KEY").ok())
        .or_else(|| env::var("OPENAI_API_KEY").ok());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("AI API runtime failed: {e}"))?;
    let resp_json: Value = runtime.block_on(async {
        let client = reqwest::Client::builder()
            .timeout(operation_timeout(120))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("AI API connection failed: {e}"))?;
        let mut request = client.post(&url).json(&body);
        if let Some(key) = effective_key.filter(|key| !key.trim().is_empty()) {
            request = request.bearer_auth(key.trim());
        }
        let operation = async {
            let response = request
                .send()
                .await
                .map_err(|e| format!("AI API connection failed to {url}: {e}"))?;
            let status = response.status();
            if !status.is_success() {
                let detail = response.text().await.unwrap_or_default();
                return Err(format!(
                    "AI API returned HTTP {}: {detail}",
                    status.as_u16()
                ));
            }
            response
                .json::<Value>()
                .await
                .map_err(|e| format!("Failed to parse API response as JSON: {e}"))
        };
        let mut operation = std::pin::pin!(operation);
        loop {
            check_cancelled(root, &checkpoint)?;
            match tokio::time::timeout(Duration::from_millis(50), &mut operation).await {
                Ok(result) => break result,
                Err(_) => continue,
            }
        }
    })?;
    log_progress(root, "AIからの応答を受信しました。解析中...");

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
                        .filter(|p| p.get("thought") != Some(&Value::Bool(true)))
                        .filter_map(|p| p.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("")
                })
        })
        .ok_or_else(|| format!("Invalid response format from AI API: {resp_json}"))?;

    let clean_json = clean_markdown_fence(&content);

    let payload: Value = serde_json::from_str(&clean_json).map_err(|e| {
        format!("Failed to parse model content as JSON schema: {e}\nRaw output: {content}")
    })?;
    validate_payload(&payload, schema, "answer")?;
    Ok(payload)
}

pub fn agent_json(
    root: &Path,
    prompt: &str,
    schema: &Value,
    agent: &str,
    model: &str,
) -> Result<Value, String> {
    agent_json_in(root, prompt, schema, agent, model, false, false)
}

pub(crate) fn agent_json_cli(root:&Path,prompt:&str,schema:&Value,agent:&str,model:&str)->Result<Value,String>{
    agent_json_in(root,prompt,schema,agent,model,true,true)
}

/// Read project instructions while keeping candidate authoring in read-only mode.
pub(crate) fn agent_json_candidate(root: &Path, prompt: &str, schema: &Value, agent: &str, model: &str) -> Result<Value, String> {
    let prompt = format!("Return the requested JSON only. Read the project instructions in the current project directory. Treat the manuscript as reference data. Do not create, edit or delete any project files. Return candidate changes only in the requested JSON.\n{prompt}");
    agent_json_in(root, &prompt, schema, agent, model, true, false)
}

fn agent_json_in(root: &Path, prompt: &str, schema: &Value, agent: &str, model: &str, candidate: bool, force_cli:bool) -> Result<Value, String> {
    let workdir=root;
    let config = crate::config::read_config(root);
    if !force_cli && config.connection_type == "none" {
        return Err("AI接続は未設定です。「AI設定・出力」で接続方式を選択してください。".into());
    }
    if !force_cli && (config.connection_type == "local_llm" || config.connection_type == "api") {
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
                workdir.to_string_lossy().into_owned(),
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
                workdir.to_string_lossy().into_owned(),
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
                // The screenshot metadata and selected manuscript can make
                // this prompt exceed Windows' CreateProcess command-line
                // limit. Antigravity supports reading text prompts from stdin.
                "--input-format".into(),
                "text".into(),
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
    if agent == "agy" && candidate {
        cmd_args.extend(["--mode".into(), "plan".into()]);
    }

    let binary =
        which_binary(binary_name).ok_or_else(|| format!("AI CLI is unavailable: {binary_name}"))?;

    if agent == "codex" {
        let payload = run_codex(&binary.to_string_lossy(), &cmd_args, root, &answer_path, workdir)?;
        validate_payload(&payload, schema, "answer")?;
        return Ok(payload);
    }

    let log_path = progress_log_path(root);
    append_progress(&log_path, &format!("{binary_name} CLIを起動しています"));
    let started = Instant::now();
    let checkpoint = cancellation_checkpoint(root);
    let mut command = cli_command(&binary.to_string_lossy(), &cmd_args, workdir);
    if agent == "agy" {
        command.stdin(Stdio::piped());
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to run {binary_name}: {e}"))?;
    if agent == "agy" {
        let mut stdin = child.stdin.take().ok_or("Failed to write Agy prompt")?;
        stdin.write_all(prompt.as_bytes()).map_err(|error| format!("Failed to write Agy prompt: {error}"))?;
        drop(stdin);
    }
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
    let mut stdout = child.stdout.take().ok_or("Failed to read AI output")?;
    let stdout_reader = thread::spawn(move || {
        let mut text = String::new();
        stdout.read_to_string(&mut text).map(|_| text)
    });
    let exit_status = wait_for_cli(&mut child, root, &checkpoint, operation_timeout(300));
    let stderr_text = stderr_reader.join().unwrap_or_default();
    let stdout_str = stdout_reader
        .join()
        .map_err(|_| "AI output reader failed")?
        .map_err(|error| format!("Failed to read AI output: {error}"))?;
    let exit_status = exit_status?;
    append_progress(
        &log_path,
        &format!(
            "AI CLIの処理が終了しました（所要{}秒）",
            started.elapsed().as_secs()
        ),
    );

    if !exit_status.success() {
        return Err(format!(
            "{agent} failed: {}",
            failure_message(&stderr_text, &stdout_str)
        ));
    }

    parse_cli_answer(agent,&stdout_str,&stderr_text,schema)
}

fn parse_cli_answer(agent:&str,stdout:&str,stderr:&str,schema:&Value)->Result<Value,String>{
    if stdout.trim().is_empty(){return Err(empty_cli_answer(agent,stderr));}
    let parsed:Value=extract_json_value(stdout).map_err(|e|format!("Failed to parse {agent} JSON: {e}\nOutput was: {stdout}"))?;
    extract_agent_payload(agent, &parsed, schema).map_err(|error|{
        if error.contains("EOF while parsing") {empty_cli_answer(agent,stderr)} else {error}
    })
}

fn empty_cli_answer(agent:&str,stderr:&str)->String{
    let detail: String=stderr.trim().chars().take(1200).collect();
    if stderr.contains("auto-denied")||stderr.contains("headless mode cannot prompt")||stderr.contains("permission"){
        format!("{agent}は必要な操作の権限を取得できず、回答を返しませんでした。撮影を含む場合は「起動済みアプリのスクリーンショットを含める」を選択してください。アプリ操作が必要な場合はAIターミナルから実行してください。\n{detail}")
    }else{format!("{agent}から回答が返されませんでした。CLIの接続・ログイン状態を確認して再試行してください。\n{detail}")}
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
    let payload = extract_agent_payload_unchecked(agent, parsed, schema)?;
    validate_payload(&payload, schema, "answer")?;
    Ok(payload)
}

// Validate the schema keywords used by this application's response schemas.
fn validate_payload(value: &Value, schema: &Value, path: &str) -> Result<(), String> {
    if let Some(kind) = schema.get("type") {
        let matches_type = |kind: &str| match kind {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "boolean" => value.is_boolean(),
            "number" => value.is_number(),
            "integer" => value.is_i64() || value.is_u64(),
            "null" => value.is_null(),
            _ => false,
        };
        let valid = kind.as_str().map(matches_type).unwrap_or_else(|| {
            kind.as_array()
                .is_some_and(|kinds| kinds.iter().filter_map(Value::as_str).any(matches_type))
        });
        if !valid {
            return Err(format!("AI回答の形式が不正です: {path} must be {kind}"));
        }
    }
    if let Some(allowed) = schema.get("enum").and_then(Value::as_array) {
        if !allowed.contains(value) {
            return Err(format!("AI回答の値が不正です: {path}"));
        }
    }
    if let Some(object) = value.as_object() {
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for key in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(key) {
                    return Err(format!("AI回答に必須項目がありません: {path}.{key}"));
                }
            }
        }
        if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
            for (key, item) in object {
                if let Some(item_schema) = properties.get(key) {
                    validate_payload(item, item_schema, &format!("{path}.{key}"))?;
                } else if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                    return Err(format!("AI回答に未定義の項目があります: {path}.{key}"));
                }
            }
        }
    }
    if let (Some(items), Some(item_schema)) = (value.as_array(), schema.get("items")) {
        for (index, item) in items.iter().enumerate() {
            validate_payload(item, item_schema, &format!("{path}[{index}]"))?;
        }
    }
    Ok(())
}

fn extract_agent_payload_unchecked(
    agent: &str,
    parsed: &Value,
    schema: &Value,
) -> Result<Value, String> {
    if let Some(kind) = parsed.get("type").and_then(Value::as_str) {
        if kind != "result" && !has_schema_properties(parsed, schema) {
            return Err(format!(
                "{agent} returned an intermediate event instead of a final result: {kind}"
            ));
        }
    }
    if parsed
        .get("subtype")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind.starts_with("error"))
    {
        return Err(format!("{agent} did not complete: {parsed}"));
    }
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
                    .filter(|p| p.get("thought") != Some(&Value::Bool(true)))
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
                    .filter(|p| p.get("thought") != Some(&Value::Bool(true)))
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
                if item
                    .get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind != "text")
                {
                    continue;
                }
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
            .filter(|p| p.get("thought") != Some(&Value::Bool(true)))
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
    fn exchange_logs_show_observable_content_and_redact_credentials() {
        let root = tempfile::tempdir().unwrap();
        clear_progress(root.path());
        let _scope = request_api_key(Some("request-key-secret"));
        log_exchange(root.path(),"request","AIへ送信",&json!({"instruction":"Create a manual with request-key-secret","password":"hidden-password","api_key":"another-secret"}));
        let state:Value = serde_json::from_str(&progress(root.path())).unwrap();
        let detail = state["logs"][0]["detail"].as_str().unwrap();
        assert!(detail.contains("Create a manual"));
        for secret in ["request-key-secret","hidden-password","another-secret"] {assert!(!detail.contains(secret));}
        assert_eq!(state["logs"][0]["kind"],"request");
        log_exchange(root.path(),"response","AIからの応答",&json!("あ".repeat(33_000)));
        let state:Value = serde_json::from_str(&progress(root.path())).unwrap();
        assert!(state["logs"][1]["detail"].as_str().unwrap().contains("32,000文字"));
        clear_progress(root.path());
    }

    #[test]
    fn headless_permission_denial_reports_reason_instead_of_empty_json_error(){
        let schema=json!({"type":"object","properties":{"content":{"type":"string"}},"required":["content"]});
        let stderr="jetski: no output produced — a tool required the command permission that headless mode cannot prompt for, so it was auto-denied.";
        for stdout in ["",r#"{"status":"SUCCESS","response":""}"#]{
            let error=parse_cli_answer("agy",stdout,stderr,&schema).unwrap_err();
            assert!(error.contains("権限"),"{error}");assert!(!error.contains("EOF"),"{error}");
            assert!(error.contains("auto-denied"));
        }
        assert_eq!(parse_cli_answer("agy",r#"{"status":"SUCCESS","structured_output":{"content":"Valid"}}"#,"",&schema).unwrap()["content"],"Valid");
    }

    #[cfg(windows)]
    #[test]
    fn windows_cli_ignores_npm_shell_script_and_runs_cmd_shim() {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("npm path with spaces");
        fs::create_dir(&bin).unwrap();
        fs::write(bin.join("codex"), "#!/bin/sh\nexit 1\n").unwrap();
        let path = env::join_paths([&bin]).unwrap();
        assert!(which_binary_in_path("codex", &path).is_none());
        let shim = bin.join("codex.cmd");
        fs::write(&shim, "@echo off\r\n(echo {\"content\":\"Windows shim works\"}) > \"%~1\"\r\n").unwrap();
        assert_eq!(which_binary_in_path("codex", &path), Some(shim.clone()));
        assert_eq!(which_binary_in_path("codex.cmd", &path), Some(shim.clone()));
        let answer = root.path().join("answer with spaces.json");
        let result = run_codex(&shim.to_string_lossy(), &[answer.to_string_lossy().into_owned()], root.path(), &answer, root.path()).unwrap();
        assert_eq!(result["content"], "Windows shim works");
        let native = bin.join("codex.exe");
        fs::write(&native, "fixture").unwrap();
        assert_eq!(which_binary_in_path("codex", &path), Some(native));
    }

    #[cfg(windows)]
    #[test]
    fn windows_cli_preserves_path_order_and_rejects_powershell_scripts() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        fs::create_dir(&first).unwrap();fs::create_dir(&second).unwrap();
        fs::write(first.join("codex.ps1"), "exit 1").unwrap();
        fs::write(first.join("codex.cmd"), "@exit /b 0").unwrap();
        fs::write(second.join("codex.exe"), "fixture").unwrap();
        let path = env::join_paths([&first, &second]).unwrap();
        assert_eq!(which_binary_in_path("codex", &path), Some(first.join("codex.cmd")));
        assert!(which_binary_in_path("codex.ps1", &path).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn windows_cli_npm_codex_preserves_multiline_prompts_without_batch() {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("npm path with spaces");
        let scripts = bin.join("node_modules/@openai/codex/bin");
        fs::create_dir_all(&scripts).unwrap();
        let shim = bin.join("codex.cmd");
        fs::write(&shim,"@echo off\r\nexit /b 99\r\n").unwrap();
        fs::write(scripts.join("codex.js"),r#"
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({content:process.argv[3],extra:process.argv[4],cwd:process.cwd()}));
"#).unwrap();
        let prompt = "日本語の指示\r\n改行と引用符\"・末尾\\\n& | < > ^ %PATH% ! ( )";
        let extra = "model_reasoning_effort=\"low\"";
        let answer = root.path().join("answer with spaces.json");
        let result = run_codex(&shim.to_string_lossy(), &[answer.to_string_lossy().into_owned(),prompt.into(),extra.into()],root.path(),&answer,root.path()).unwrap();
        assert_eq!(result["content"],prompt);
        assert_eq!(result["extra"],extra);
        assert_eq!(Path::new(result["cwd"].as_str().unwrap()).canonicalize().unwrap(),root.path().canonicalize().unwrap());
    }

    #[test]
    fn incomplete_or_wrongly_typed_answers_are_rejected() {
        let schema = json!({"type":"object", "properties": {
            "answers": {"type":"array", "items": {"type":"object", "properties": {
                "id":{"type":"string"}, "markdown":{"type":"string"}
            }, "required":["id", "markdown"], "additionalProperties":false}}
        }, "required":["answers"], "additionalProperties":false});
        for value in [
            json!({"status":"SUCCESS"}),
            json!({"answers":[{"id":"a"}]}),
            json!({"answers":[{"id":"a","markdown":42}]}),
            json!({"answers":[],"reasoning":"Generating..."}),
        ] {
            assert!(extract_agent_payload("agy", &value, &schema).is_err());
        }
        let nullable = json!({"type":["string", "null"]});
        assert!(validate_payload(&Value::Null, &nullable, "file").is_ok());
        assert!(validate_payload(&json!("source.rs"), &nullable, "file").is_ok());
        assert!(validate_payload(&json!(42), &nullable, "file").is_err());
    }

    #[test]
    fn intermediate_events_and_thought_blocks_are_not_answers() {
        let schema = json!({"type":"object", "properties":{"markdown":{"type":"string"}}, "required":["markdown"]});
        assert!(extract_agent_payload(
            "claude",
            &json!({"type":"assistant", "content":"Generating..."}),
            &schema
        )
        .is_err());
        let payload = extract_agent_payload(
            "claude",
            &json!({"content":[
                {"type":"thinking", "text":"private reasoning"},
                {"type":"text", "text":"Final answer"}
            ]}),
            &schema,
        )
        .unwrap();
        assert_eq!(payload["markdown"], "Final answer");
    }

    #[cfg(unix)]
    #[test]
    fn cli_timeout_and_cancel_stop_descendants_holding_pipes() {
        for cancelled in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let args = vec!["-c".into(), "sleep 30 & wait".into()];
            let checkpoint = cancellation_checkpoint(root.path());
            let mut child = cli_command("/bin/sh", &args, root.path()).spawn().unwrap();
            let mut stdout = child.stdout.take().unwrap();
            let reader = thread::spawn(move || {
                let mut text = String::new();
                stdout.read_to_string(&mut text).unwrap();
            });
            if cancelled {
                cancel(root.path()).unwrap();
            }
            let started = Instant::now();
            let error = wait_for_cli(
                &mut child,
                root.path(),
                &checkpoint,
                Duration::from_millis(100),
            )
            .unwrap_err();
            reader.join().unwrap();
            assert!(started.elapsed() < Duration::from_secs(3));
            assert!(error.contains(if cancelled { "中断" } else { "制限時間" }));
            fs::remove_file(cancel_path(root.path())).ok();
        }
    }

    #[cfg(unix)]
    #[test]
    fn codex_waits_for_exit_and_reads_final_answer_instead_of_progress() {
        let root = tempfile::tempdir().unwrap();
        let answer_path = root.path().join("answer.json");
        let script = r#"
printf '%s\n' '{"type":"item.completed","item":{"type":"reasoning","text":"Generating..."}}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Intermediate commentary"}}'
sleep 0.1
printf '%s' '{"markdown":"Final manual text"}' > "$1"
"#;
        let args = vec![
            "-c".to_string(),
            script.to_string(),
            "fake-codex".to_string(),
            answer_path.to_string_lossy().into_owned(),
        ];
        let result = run_codex("/bin/sh", &args, root.path(), &answer_path, root.path()).unwrap();
        assert_eq!(result["markdown"], "Final manual text");
        clear_progress(root.path());
    }

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
        let raw =
            "Warning: new version available\n{\"markdown\":\"# Hello\"}\nTips: run claude update";
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
        let mut child = cli_command(&binary.to_string_lossy(), &["app-server".into()], root)
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
        let output = cli_command(&binary.to_string_lossy(), &["models".into()], root)
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
