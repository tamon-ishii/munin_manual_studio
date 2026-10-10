//! Durable, cancellable image generation with explicit provider selection.
use crate::{config::project_path, editor, screenshots, task};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

fn atomic_json(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid image storage")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
fn validate_provider(provider: &str) -> Result<(), String> {
    if matches!(provider, "auto" | "agy" | "codex" | "api") {
        Ok(())
    } else {
        Err("画像の生成方法はAgy・Codex・画像APIから選択してください。".into())
    }
}
fn validate_endpoint(endpoint: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(endpoint).map_err(|_| "画像APIのURLが不正です。")?;
    let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"));
    if url.username() != ""
        || url.password().is_some()
        || !(url.scheme() == "https" || local && url.scheme() == "http")
    {
        return Err("画像APIはHTTPSまたはローカル接続を指定してください。".into());
    }
    Ok(())
}
pub fn settings(root: &Path, options: &Value) -> Result<Value, String> {
    let path = project_path(root, ".munin/image-generation.json")?;
    let mut value = if path.exists() {
        serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
    } else {
        json!({"model":"gpt-image-1.5","endpoint":"https://api.openai.com/v1/images/generations"})
    };
    if options["save"] == true {
        for name in ["model", "endpoint", "provider"] {
            if let Some(text) = options[name].as_str() {
                value[name] = json!(text.trim());
            }
        }
        validate_provider(value["provider"].as_str().unwrap_or("auto"))?;
        validate_endpoint(
            value["endpoint"]
                .as_str()
                .ok_or("画像APIのURLを指定してください。")?,
        )?;
        if value["model"].as_str().unwrap_or("").is_empty() {
            return Err("画像モデルを指定してください。".into());
        }
        // Never retain credentials, even from older settings files.
        let clean = json!({"model":value["model"],"endpoint":value["endpoint"],"provider":value["provider"]});
        atomic_json(&path, &clean)?;
        return Ok(clean);
    }
    Ok(value)
}
fn job_path(root: &Path, id: &str, suffix: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.len() > 100 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("作画の実行IDが不正です。".into());
    }
    project_path(root, &format!(".munin/image-jobs/{id}.{suffix}"))
}
pub fn cancel(root: &Path, id: &str) -> Result<Value, String> {
    let job = job_path(root, id, "json")?;
    if !job.exists() {
        return Err("作画の実行が見つかりません。".into());
    }
    fs::write(job_path(root, id, "cancel")?, b"cancel").map_err(|e| e.to_string())?;
    Ok(json!({"cancel_requested":true}))
}
fn check_cancel(root: &Path, id: Option<&str>) -> Result<(), String> {
    if let Some(id) = id {
        if job_path(root, id, "cancel")?.exists() {
            return Err("画像生成を中断しました。指示を保持しています。".into());
        }
    }
    Ok(())
}
pub fn history(root: &Path) -> Result<Value, String> {
    let mut items = Vec::new();
    let mut jobs = std::collections::BTreeSet::new();
    let generated = project_path(root, ".munin/generated-images")?;
    if generated.exists() {
        for entry in fs::read_dir(generated).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.path().extension().is_some_and(|s| s == "json") {
                if let Ok(mut item) = fs::read(entry.path())
                    .map_err(|e| e.to_string())
                    .and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| e.to_string()))
                {
                    if let Some(id) = item["job_id"].as_str() {
                        jobs.insert(id.to_string());
                    }
                    item["status"] = json!("succeeded");
                    items.push(item);
                }
            }
        }
    }
    let home = project_path(root, ".munin/image-jobs")?;
    if home.exists() {
        for entry in fs::read_dir(home).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.path().extension().is_some_and(|s| s == "json") {
                if let Ok(mut item) = fs::read(entry.path())
                    .map_err(|e| e.to_string())
                    .and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| e.to_string()))
                {
                    if item["status"]=="running" {
                        if let Some(id)=item["id"].as_str() {
                            if let Some(_lock)=crate::workflow::try_resource_lock(root,&format!(".munin/image-jobs/{id}"))? {
                                // Re-read under the same lock held by generation; active jobs are never reclassified.
                                item=serde_json::from_slice(&fs::read(entry.path()).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
                                if item["status"]=="running" {
                                    let id=item["id"].as_str().unwrap_or_default();
                                    if let Some(saved)=items.iter().find(|saved| saved["job_id"]==id) {
                                        item["status"]=json!("succeeded");item["path"]=saved["path"].clone();item["result_id"]=saved["id"].clone();
                                    } else {
                                        item["status"]=json!("interrupted");item["error"]=json!("前回の画像生成が正常に終了しませんでした。指示を確認して再試行できます。");
                                    }
                                    item["finished_at"]=json!(task::utc_now());atomic_json(&entry.path(),&item)?;
                                }
                            }
                        }
                    }
                    if !jobs.contains(item["id"].as_str().unwrap_or("")) { items.push(item); }
                }
            }
        }
    }
    items.sort_by(|a, b| b["created_at"].as_str().cmp(&a["created_at"].as_str()));
    Ok(json!({"items":items}))
}
pub fn extract_image_path(text: &str) -> Option<String> {
    let re =
        regex::Regex::new(r#"(?:file://)?(/[^\s"'`\(\)\[\]<>]+\.(?:png|jpg|jpeg|webp))"#).ok()?;
    let found = re
        .captures_iter(text)
        .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_string()))
        .find(|path| Path::new(path).is_file());
    found
}
#[cfg(test)]
fn cli_arguments(provider: &str, prompt: &str) -> Vec<String> {
    cli_image_arguments(provider, prompt, false)
}
fn cli_image_arguments(provider: &str, prompt: &str, reference: bool) -> Vec<String> {
    let instruction = if reference {
        "Edit the attached reference.png image according to the instruction. Preserve all details not explicitly requested to change."
    } else {
        "Generate one image according to the description."
    };
    if provider == "codex" {
        let mut args = vec![
            "exec".into(),
            "--ephemeral".into(),
            "--skip-git-repo-check".into(),
            "--sandbox".into(),
            "workspace-write".into(),
            "--enable".into(),
            "image_generation".into(),
            "--color".into(),
            "never".into(),
        ];
        if reference {
            args.extend(["--image".into(), "reference.png".into()]);
        }
        args.push(format!("$imagegen {instruction} Use the built-in image generation tool. After generation, copy the selected image into the current directory as generated.png in PNG format. Do not use an API fallback or draw a substitute with code. If image generation is unavailable, report the error. Do not modify any other files. Instruction:\n{prompt}"));
        args
    } else {
        vec!["-p".into(),format!("{instruction} Read reference.png from the current directory when editing. Report the absolute path of the generated image. Instruction:\n{prompt}"),"--effort".into(),"low".into(),"--print-timeout".into(),"300s".into()]
    }
}
fn png_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let image = image::load_from_memory(bytes).map_err(|_| "有効な画像が返りませんでした。")?;
    let mut png = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(png.into_inner())
}
fn save_generated(
    root: &Path,
    prompt: &str,
    provider: &str,
    model: &str,
    bytes: &[u8],
    options: &Value,
) -> Result<Value, String> {
    check_cancel(root, options["job_id"].as_str())?;
    if bytes.len() > 32_000_000 {
        return Err("生成画像が大きすぎます。".into());
    }
    let bytes = png_bytes(bytes)?;
    let config = crate::config::read_config(root);
    let id = screenshots::new_id("ai-image");
    let path = format!("{}/generated/{id}.png", config.assets.trim_end_matches('/'));
    check_cancel(root, options["job_id"].as_str())?;
    editor::save_asset(root, &path, &STANDARD.encode(bytes))?;
    let metadata = json!({"id":id,"path":path,"prompt":prompt,"provider":provider,"model":model,"job_id":options["job_id"],"reference":options["reference"],"parent_id":options["parent_id"],"endpoint":options["endpoint"],"size":options["size"],"created_at":task::utc_now()});
    atomic_json(
        &project_path(root, &format!(".munin/generated-images/{id}.json"))?,
        &metadata,
    )?;
    Ok(metadata)
}
#[cfg(test)]
fn generate_via_cli_with_binary(
    root: &Path,
    prompt: &str,
    provider: &str,
    binary: &Path,
) -> Result<Value, String> {
    run_image_cli(root, prompt, provider, binary, &Value::Null)
}
fn run_image_cli(
    root: &Path,
    prompt: &str,
    provider: &str,
    binary: &Path,
    options: &Value,
) -> Result<Value, String> {
    let label = if provider == "codex" { "Codex" } else { "Agy" };
    let scratch = tempfile::tempdir().map_err(|e| e.to_string())?;
    let reference = options["reference"].as_str().filter(|s| !s.is_empty());
    if let Some(path) = reference {
        fs::write(
            scratch.path().join("reference.png"),
            png_bytes(&crate::resources::image_bytes(root, path)?)?,
        )
        .map_err(|e| e.to_string())?;
    }
    let stdout_path = scratch.path().join("stdout.log");
    let stderr_path = scratch.path().join("stderr.log");
    let mut command = crate::agent::cli_command(
        &binary.to_string_lossy(),
        &cli_image_arguments(provider, prompt, reference.is_some()),
        scratch.path(),
    );
    command
        .stdout(fs::File::create(&stdout_path).map_err(|e| e.to_string())?)
        .stderr(fs::File::create(&stderr_path).map_err(|e| e.to_string())?);
    let checkpoint = crate::agent::cancellation_checkpoint(root);
    check_cancel(root, options["job_id"].as_str())?;
    let mut child = command
        .spawn()
        .map_err(|e| format!("{label} CLIの実行に失敗しました: {e}"))?;
    let started = Instant::now();
    let exit = loop {
        let error = check_cancel(root, options["job_id"].as_str())
            .err()
            .or_else(|| crate::agent::check_cancelled(root, &checkpoint).err())
            .or_else(|| {
                (started.elapsed() > Duration::from_secs(300)).then(|| {
                    "画像生成が制限時間（300秒）を超えました。再試行できます。".to_string()
                })
            });
        if let Some(error) = error {
            crate::agent::stop_cli_tree(&mut child);
            let _ = child.wait();
            return Err(error);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                crate::agent::stop_cli_tree(&mut child);
                break status;
            }
            Ok(None) => {}
            Err(error) => {
                crate::agent::stop_cli_tree(&mut child);
                let _ = child.wait();
                return Err(error.to_string());
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let stdout = fs::read_to_string(stdout_path).unwrap_or_default();
    let stderr = fs::read_to_string(stderr_path).unwrap_or_default();
    let diagnostic: String = format!("{stdout}\n{stderr}").chars().take(1600).collect();
    if !exit.success() {
        return Err(format!(
            "{label}の画像生成に失敗しました: {}",
            diagnostic.trim()
        ));
    }
    let image_path = if provider == "codex" {
        let path = scratch.path().join("generated.png");
        if !path.is_file() {
            return Err(format!("Codexから生成画像を取得できませんでした。ログインと画像生成の利用可否を確認してください。{}",diagnostic.trim()));
        }
        path
    } else {
        extract_image_path(&stdout)
            .or_else(|| extract_image_path(&stderr))
            .map(PathBuf::from)
            .ok_or_else(|| {
                format!(
                    "Agyから生成画像のパスを取得できませんでした。{}",
                    diagnostic.trim()
                )
            })?
    };
    if fs::metadata(&image_path).map_err(|e| e.to_string())?.len() > 32_000_000 {
        return Err("生成画像が大きすぎます。".into());
    }
    save_generated(
        root,
        prompt,
        provider,
        &format!("{provider}-image-generator"),
        &fs::read(image_path).map_err(|e| e.to_string())?,
        options,
    )
}
fn api_key(options: &Value) -> Option<String> {
    options["api_key"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            std::env::var("MUNIN_IMAGE_API_KEY")
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
        .or_else(|| {
            std::env::var("OPENAI_API_KEY")
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
}
fn run_api(
    root: &Path,
    prompt: &str,
    options: &Value,
    configured: &Value,
) -> Result<Value, String> {
    let key = api_key(options).ok_or("画像生成用のAPIキーを入力してください。")?;
    let endpoint = options["endpoint"]
        .as_str()
        .or(configured["endpoint"].as_str())
        .ok_or("画像APIのURLを指定してください。")?;
    validate_endpoint(endpoint)?;
    let model = options["model"]
        .as_str()
        .or(configured["model"].as_str())
        .unwrap_or("gpt-image-1.5");
    let size = options["size"].as_str().unwrap_or("1024x1024");
    let mut url = endpoint.to_string();
    let reference = options["reference"].as_str().filter(|s| !s.is_empty());
    let payload = if let Some(path) = reference {
        if !url.ends_with("/generations") {
            return Err(
                "画像の修正では /images/generations 形式のAPI URLを指定してください。".into(),
            );
        }
        url = format!("{}/edits", url.trim_end_matches("/generations"));
        let boundary = screenshots::new_id("multipart");
        let mut body = Vec::new();
        for (name, value) in [
            ("model", model),
            ("prompt", prompt),
            ("n", "1"),
            ("size", size),
            ("output_format", "png"),
        ] {
            body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
        }
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"image[]\"; filename=\"reference.png\"\r\nContent-Type: image/png\r\n\r\n").as_bytes());
        body.extend(png_bytes(&crate::resources::image_bytes(root, path)?)?);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        (format!("multipart/form-data; boundary={boundary}"), body)
    } else {
        (
            "application/json".into(),
            serde_json::to_vec(
                &json!({"model":model,"prompt":prompt,"size":size,"n":1,"output_format":"png"}),
            )
            .map_err(|e| e.to_string())?,
        )
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let response=runtime.block_on(async{
        let client=reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(300)).redirect(reqwest::redirect::Policy::none()).build().map_err(|_|"画像APIの接続設定が不正です。".to_string())?;
        let request=async{
            let mut response=client.post(&url).bearer_auth(key.trim()).header("Content-Type",payload.0).body(payload.1).send().await.map_err(|e|if e.is_timeout(){"画像生成が制限時間を超えました。再試行できます。".to_string()}else{"画像生成APIへの接続に失敗しました。".into()})?;
            if !response.status().is_success(){return Err(format!("画像生成APIがエラーを返しました（HTTP {}）。接続設定とモデルの利用権限を確認してください。",response.status().as_u16()));}
            let mut bytes=Vec::new();while let Some(chunk)=response.chunk().await.map_err(|_|"画像生成の応答を受信できませんでした。".to_string())?{if bytes.len()+chunk.len()>32_000_000{return Err("画像生成の応答が大きすぎます。".into());}bytes.extend_from_slice(&chunk);}Ok(bytes)
        };
        let mut request=std::pin::pin!(request);
        loop{check_cancel(root,options["job_id"].as_str())?;match tokio::time::timeout(Duration::from_millis(100),&mut request).await{Ok(result)=>break result,Err(_)=>continue,}}
    })?;
    check_cancel(root, options["job_id"].as_str())?;
    let result: Value =
        serde_json::from_slice(&response).map_err(|_| "画像生成APIの応答が不正です。")?;
    let encoded = result["data"][0]["b64_json"]
        .as_str()
        .ok_or("画像生成APIから画像が返りませんでした。")?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "画像生成APIの画像データが不正です。")?;
    save_generated(root, prompt, "api", model, &bytes, options)
}
pub fn generate(root: &Path, options: &Value) -> Result<Value, String> {
    let prompt = options["prompt"].as_str().unwrap_or_default().trim();
    if prompt.is_empty() {
        return Err("作画の指示を入力してください。".into());
    }
    let configured = settings(root, &Value::Null)?;
    let mut provider = options["provider"]
        .as_str()
        .or(configured["provider"].as_str())
        .unwrap_or("auto");
    validate_provider(provider)?;
    if provider == "auto" {
        provider = if api_key(options).is_some() {
            "api"
        } else {
            "agy"
        };
    }
    let id = options["job_id"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| screenshots::new_id("image-job"));
    let path = job_path(root, &id, "json")?;
    let _lock = crate::workflow::resource_lock(root, &format!(".munin/image-jobs/{id}"))?;
    if path.exists() {
        return Err("この作画は実行済みです。再試行には新しい実行IDを使ってください。".into());
    }
    let mut request = options.clone();
    request["job_id"] = json!(id);
    request["provider"] = json!(provider);
    request["model"] = options["model"]
        .as_str()
        .map_or_else(|| configured["model"].clone(), |v| json!(v));
    request["endpoint"] = options["endpoint"]
        .as_str()
        .map_or_else(|| configured["endpoint"].clone(), |v| json!(v));
    let mut job = json!({"id":id,"prompt":prompt,"provider":provider,"model":request["model"],"endpoint":request["endpoint"],"reference":request["reference"],"parent_id":request["parent_id"],"size":request["size"],"created_at":task::utc_now(),"status":"running"});
    atomic_json(&path, &job)?;
    let result = if provider == "api" {
        run_api(root, prompt, &request, &configured)
    } else {
        crate::agent::which_binary(provider)
            .ok_or_else(|| {
                format!(
                    "{} CLIが見つかりません。インストールとログインを確認してください。",
                    if provider == "codex" { "Codex" } else { "Agy" }
                )
            })
            .and_then(|binary| run_image_cli(root, prompt, provider, &binary, &request))
    };
    match &result {
        Ok(value) => {
            job["status"] = json!("succeeded");
            job["path"] = value["path"].clone();
            job["result_id"] = value["id"].clone();
        }
        Err(error) => {
            job["status"] = json!(if job_path(root, &id, "cancel")?.exists() {
                "cancelled"
            } else {
                "failed"
            });
            job["error"] = json!(error);
        }
    }
    job["finished_at"] = json!(task::utc_now());
    atomic_json(&path, &job)?;
    result
}
fn probe(binary: &Path, args: &[String]) -> Result<String, String> {
    let scratch = tempfile::tempdir().map_err(|e| e.to_string())?;
    let output = scratch.path().join("output");
    let mut command = crate::agent::cli_command(&binary.to_string_lossy(), args, scratch.path());
    command
        .stdout(fs::File::create(&output).map_err(|e| e.to_string())?)
        .stderr(std::process::Stdio::null());
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                crate::agent::stop_cli_tree(&mut child);
                return if status.success() {
                    fs::read_to_string(output).map_err(|e| e.to_string())
                } else {
                    Err("確認できませんでした".into())
                };
            }
            Err(e) => return Err(e.to_string()),
            Ok(None) => {}
        }
        if started.elapsed() > Duration::from_secs(5) {
            crate::agent::stop_cli_tree(&mut child);
            let _ = child.wait();
            return Err("確認がタイムアウトしました".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
pub fn capabilities(options: &Value) -> Value {
    let mut items = Vec::new();
    for provider in ["agy", "codex"] {
        let Some(binary) = crate::agent::which_binary(provider) else {
            items.push(json!({"provider":provider,"installed":false,"login":"unavailable","image":"unavailable","message":"CLIが見つかりません。インストールしてください。"}));
            continue;
        };
        if provider == "codex" {
            let login = probe(&binary, &["login".into(), "status".into()]).is_ok();
            let supported = probe(&binary, &["features".into(), "list".into()]).is_ok_and(|text| {
                text.lines()
                    .any(|line| line.split_whitespace().next() == Some("image_generation"))
            });
            items.push(json!({"provider":provider,"installed":true,"login":if login{"ready"}else{"required"},"image":if supported{"supported"}else{"unknown"},"message":if !login{"Codexにログインしてください。"}else if !supported{"CLIの画像生成対応を確認できません。Codexを更新してください。"}else{"ログイン済み・画像生成対応。プランの利用可否は生成時に確認します。"}}));
        } else {
            let connection = probe(&binary, &["models".into()]).is_ok();
            items.push(json!({"provider":provider,"installed":true,"login":if connection{"connected"}else{"unknown"},"image":"unknown","message":if connection{"Agyへの接続を確認しました。画像生成の利用可否は生成時に確認します。"}else{"Agyのログイン・接続を確認してください。画像生成の利用可否は生成時に確認します。"}}));
        }
    }
    let key = api_key(options).is_some();
    items.push(json!({"provider":"api","installed":true,"login":if key{"configured"}else{"required"},"image":"unknown","message":if key{"APIキー設定済み。モデルの利用権限は生成時に確認します。"}else{"APIキーを入力してください。"}}));
    json!({"items":items})
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_image_path() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        let path = temp.path().to_str().unwrap().to_string() + ".png";
        fs::write(&path, b"test").unwrap();

        let sample_output = format!("Generated image: file://{path} done");
        assert_eq!(extract_image_path(&sample_output), Some(path.clone()));

        let sample_markdown = format!("- **File Path**: [`image.png`]({path})");
        assert_eq!(extract_image_path(&sample_markdown), Some(path.clone()));

        assert_eq!(extract_image_path("No path here"), None);
        let _ = fs::remove_file(path);
    }
    #[test]
    fn recover_abandoned_jobs_without_reclassifying_active_jobs() {
        let root=tempfile::tempdir().unwrap();
        for id in ["active", "abandoned", "saved"] {atomic_json(&job_path(root.path(),id,"json").unwrap(),&json!({"id":id,"status":"running","prompt":id,"provider":"api"})).unwrap();}
        atomic_json(&project_path(root.path(),".munin/generated-images/saved-image.json").unwrap(),&json!({"id":"saved-image","job_id":"saved","path":"docs/assets/saved.png","prompt":"saved"})).unwrap();
        let lock=crate::workflow::resource_lock(root.path(),".munin/image-jobs/active").unwrap();
        let report=history(root.path()).unwrap();let items=report["items"].as_array().unwrap();
        assert_eq!(items.iter().find(|item|item["id"]=="active").unwrap()["status"],"running");
        assert_eq!(items.iter().find(|item|item["id"]=="abandoned").unwrap()["status"],"interrupted");
        assert_eq!(items.iter().filter(|item|item["prompt"]=="saved").count(),1);
        let saved:Value=serde_json::from_slice(&fs::read(job_path(root.path(),"saved","json").unwrap()).unwrap()).unwrap();assert_eq!(saved["status"],"succeeded");
        drop(lock);assert_eq!(history(root.path()).unwrap()["items"].as_array().unwrap().iter().find(|item|item["id"]=="active").unwrap()["status"],"interrupted");
    }
    #[test]
    fn provider_settings_roundtrip_without_secrets() {
        let root = tempfile::tempdir().unwrap();
        for provider in ["agy", "codex", "api"] {
            let saved = settings(
                root.path(),
                &json!({"save":true,"provider":provider,"model":"test","api_key":"secret"}),
            )
            .unwrap();
            assert_eq!(saved["provider"], provider);
            assert_eq!(settings(root.path(), &Value::Null).unwrap(), saved);
            assert!(
                !fs::read_to_string(root.path().join(".munin/image-generation.json"))
                    .unwrap()
                    .contains("secret")
            );
        }
        assert!(settings(root.path(), &json!({"save":true,"provider":"unknown"})).is_err());
        assert!(generate(root.path(), &json!({"prompt":"test","provider":"unknown"})).is_err());
    }

    #[test]
    fn codex_arguments_use_image_tool_in_workspace_sandbox() {
        let args = cli_arguments("codex", "a mountain");
        assert_eq!(args[0], "exec");
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--sandbox", "workspace-write"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--enable", "image_generation"]));
        assert!(args.last().unwrap().contains("$imagegen"));
        assert!(args.last().unwrap().ends_with("a mountain"));
        assert!(!args.iter().any(|arg| arg.contains("dangerously")));
    }

    #[cfg(unix)]
    #[test]
    fn cli_images_are_validated_and_do_not_edit_manuscripts() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs")).unwrap();
        let manuscript = root.path().join("docs/index.md");
        fs::write(&manuscript, "# Original").unwrap();
        let source = root.path().join("fixture.png");
        image::RgbaImage::new(3, 2).save(&source).unwrap();
        let binary = root.path().join("fake-cli");
        for provider in ["codex", "agy"] {
            let script = if provider == "codex" {
                format!(
                    "#!/bin/sh\n[ \"$1\" = exec ] || exit 2\ncp '{}' generated.png\n",
                    source.display()
                )
            } else {
                format!(
                    "#!/bin/sh\n[ \"$1\" = -p ] || exit 2\nprintf '%s\\n' '{}'\n",
                    source.display()
                )
            };
            fs::write(&binary, script).unwrap();
            fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
            let result =
                generate_via_cli_with_binary(root.path(), "landscape", provider, &binary).unwrap();
            assert_eq!(result["provider"], provider);
            let imported = image::open(root.path().join(result["path"].as_str().unwrap())).unwrap();
            assert_eq!((imported.width(), imported.height()), (3, 2));
            assert_eq!(fs::read_to_string(&manuscript).unwrap(), "# Original");
        }
        // Even if an image was written, a failed CLI must not be imported.
        fs::write(
            &binary,
            format!(
                "#!/bin/sh\ncp '{}' generated.png\nexit 1\n",
                source.display()
            ),
        )
        .unwrap();
        assert!(
            generate_via_cli_with_binary(root.path(), "test", "codex", &binary)
                .unwrap_err()
                .contains("失敗")
        );
        fs::write(&binary, "#!/bin/sh\necho invalid > generated.png\n").unwrap();
        assert!(
            generate_via_cli_with_binary(root.path(), "test", "codex", &binary)
                .unwrap_err()
                .contains("有効な画像")
        );
        fs::write(&binary, "#!/bin/sh\necho 'Image generation unavailable'\n").unwrap();
        assert!(
            generate_via_cli_with_binary(root.path(), "test", "codex", &binary)
                .unwrap_err()
                .contains("生成画像を取得")
        );
        assert_eq!(
            fs::read_dir(root.path().join(".munin/generated-images"))
                .unwrap()
                .count(),
            2
        );
        assert_eq!(fs::read_to_string(manuscript).unwrap(), "# Original");
    }
    #[test]
    fn history_restores_generated_and_failed_jobs_without_secrets() {
        let root = tempfile::tempdir().unwrap();
        settings(root.path(),&json!({"save":true,"provider":"api","endpoint":"http://127.0.0.1:1/images/generations"})).unwrap();
        let result = generate(
            root.path(),
            &json!({"job_id":"retryable-job","provider":"api","prompt":"A tree","reference":"missing.png"}),
        );
        assert!(result.is_err());
        let records = history(root.path()).unwrap();
        assert_eq!(records["items"][0]["status"], "failed");
        assert_eq!(records["items"][0]["prompt"], "A tree");
        assert!(records.to_string().find("api_key").is_none());
        assert!(cancel(root.path(), "../escape").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn cancelling_cli_stops_process_and_imports_no_image() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("fake-cli");
        fs::write(&binary, "#!/bin/sh\nsleep 30\n").unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        let id = "cancel-job";
        atomic_json(
            &job_path(root.path(), id, "json").unwrap(),
            &json!({"status":"running"}),
        )
        .unwrap();
        let owner = root.path().to_path_buf();
        let cancellation = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            cancel(&owner, id).unwrap();
        });
        let started = Instant::now();
        let error = run_image_cli(
            root.path(),
            "A tree",
            "codex",
            &binary,
            &json!({"job_id":id}),
        )
        .unwrap_err();
        cancellation.join().unwrap();
        assert!(error.contains("中断"));
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(!root.path().join(".munin/generated-images").exists());
    }
}
