//! Image generation saves assets only after a successful, validated image response.
use crate::{config::project_path, editor, screenshots, task};
use base64::Engine;
use serde_json::{json, Value};
use std::{fs, io::Read, path::Path, time::Duration};


pub fn settings(root: &Path, options: &Value) -> Result<Value,String> {
    let path=project_path(root,".munin/image-generation.json")?;
    if options["save"]==true {
        let model=options["model"].as_str().unwrap_or("gpt-image-1.5").trim();
        let endpoint=options["endpoint"].as_str().unwrap_or("https://api.openai.com/v1/images/generations").trim();
        validate_endpoint(endpoint)?;
        if model.is_empty(){return Err("画像モデルを指定してください。".into());}
        let value=json!({"model":model,"endpoint":endpoint});
        fs::create_dir_all(path.parent().ok_or("Invalid path")?).map_err(|e|e.to_string())?;
        fs::write(path,serde_json::to_vec_pretty(&value).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        return Ok(value);
    }
    if path.exists(){serde_json::from_slice(&fs::read(path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())}
    else {Ok(json!({"model":"gpt-image-1.5","endpoint":"https://api.openai.com/v1/images/generations"}))}
}
fn validate_endpoint(endpoint:&str)->Result<(),String>{
    let url=reqwest::Url::parse(endpoint).map_err(|_|"画像APIのURLが不正です。")?;
    let local=matches!(url.host_str(),Some("127.0.0.1"|"localhost"|"::1"));
    if url.username()!="" || url.password().is_some() || !(url.scheme()=="https" || local && url.scheme()=="http") {return Err("画像APIはHTTPSまたはローカル接続を指定してください。".into());}
    Ok(())
}
pub fn extract_image_path(text: &str) -> Option<String> {
    let re = regex::Regex::new(r#"(?:file://)?(/[^\s"'`\(\)\[\]<>]+\.(?:png|jpg|jpeg|webp))"#).ok()?;
    for cap in re.captures_iter(text) {
        if let Some(m) = cap.get(1) {
            let path_str = m.as_str();
            if Path::new(path_str).exists() {
                return Some(path_str.to_string());
            }
        }
    }
    None
}

pub fn generate_via_agy(root: &Path, prompt: &str) -> Result<Value, String> {
    let agy_prompt = format!("Generate an image based on this description and report the absolute file path: {prompt}");
    let output = std::process::Command::new("agy")
        .args(&[
            "-p", &agy_prompt,
            "--effort", "low",
            "--print-timeout", "180s",
        ])
        .current_dir(root)
        .output()
        .map_err(|e| format!("Agy CLIの実行に失敗しました: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    let image_path = extract_image_path(&stdout)
        .or_else(|| extract_image_path(&stderr))
        .ok_or_else(|| {
            let combined = format!("{stdout} {stderr}");
            let trimmed = combined.trim();
            if !trimmed.is_empty() {
                format!("Agyから画像パスを取得できませんでした: {trimmed}")
            } else {
                "Agy画像生成の応答を受信できませんでした。".into()
            }
        })?;

    let raw_bytes = fs::read(&image_path)
        .map_err(|e| format!("生成された画像の読み込みに失敗しました ({image_path}): {e}"))?;

    let final_base64 = base64::engine::general_purpose::STANDARD.encode(&raw_bytes);

    let config = crate::config::read_config(root);
    let id = screenshots::new_id("ai-image");
    let path = format!("{}/generated/{id}.png", config.assets.trim_end_matches('/'));
    editor::save_asset(root, &path, &format!("data:image/png;base64,{final_base64}"))?;

    let metadata = json!({
        "id": id,
        "path": path,
        "prompt": prompt,
        "model": "agy-image-generator",
        "source_image": image_path,
        "created_at": task::utc_now()
    });
    let home = project_path(root, ".munin/generated-images")?;
    fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    fs::write(home.join(format!("{id}.json")), serde_json::to_vec_pretty(&metadata).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(metadata)
}

pub fn generate(root:&Path,options:&Value)->Result<Value,String>{
    let prompt=options["prompt"].as_str().unwrap_or_default().trim();
    if prompt.is_empty(){return Err("作画の指示を入力してください。".into());}

    let key_opt = options["api_key"].as_str().filter(|key|!key.trim().is_empty()).map(str::to_string)
        .or_else(||std::env::var("MUNIN_IMAGE_API_KEY").ok()).or_else(||std::env::var("OPENAI_API_KEY").ok());

    // If no API key is specified, automatically fall back to Agy CLI (if installed)
    let key = match key_opt {
        Some(k) => k,
        None => {
            if crate::agent::which_binary("agy").is_some() {
                return generate_via_agy(root, prompt);
            }
            return Err("画像生成用のAPIキーを入力するか、Agy CLIをご利用ください。".into());
        }
    };

    let configured=settings(root,&Value::Null)?;
    let endpoint=configured["endpoint"].as_str().ok_or("画像APIの設定が不正です。")?;validate_endpoint(endpoint)?;
    let size=options["size"].as_str().unwrap_or("1024x1024");
    let agent=ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(15)).timeout_read(Duration::from_secs(360)).redirects(0).build();
    let response=agent.post(endpoint).set("Authorization",&format!("Bearer {}",key.trim())).send_json(json!({"model":configured["model"],"prompt":prompt,"size":size,"n":1,"output_format":"png"})).map_err(|error|match error {ureq::Error::Status(status,_)=>format!("画像生成APIがエラーを返しました（HTTP {status}）。接続設定とモデルの利用権限を確認してください。"),_=>"画像生成APIへの接続に失敗しました。接続設定を確認してください。".into()})?;
    let mut bytes=Vec::new();response.into_reader().take(32_000_001).read_to_end(&mut bytes).map_err(|_|"画像生成の応答を受信できませんでした。")?;
    if bytes.len()>32_000_000{return Err("画像生成の応答が大きすぎます。".into());}
    let result:Value=serde_json::from_slice(&bytes).map_err(|_|"画像生成APIの応答が不正です。")?;
    let base64=result["data"][0]["b64_json"].as_str().ok_or("画像生成APIから画像が返りませんでした。")?;
    let config=crate::config::read_config(root);let id=screenshots::new_id("ai-image");
    let path=format!("{}/generated/{id}.png",config.assets.trim_end_matches('/'));
    editor::save_asset(root,&path,&format!("data:image/png;base64,{base64}"))?;
    let metadata=json!({"id":id,"path":path,"prompt":prompt,"model":configured["model"],"created_at":task::utc_now()});
    let home=project_path(root,".munin/generated-images")?;fs::create_dir_all(&home).map_err(|e|e.to_string())?;
    fs::write(home.join(format!("{id}.json")),serde_json::to_vec_pretty(&metadata).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    Ok(metadata)
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
}

