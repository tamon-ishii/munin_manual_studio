//! Image generation saves assets only after a successful, validated image response.
use crate::{config::project_path, editor, screenshots, task};
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
pub fn generate(root:&Path,options:&Value)->Result<Value,String>{
    let prompt=options["prompt"].as_str().unwrap_or_default().trim();
    if prompt.is_empty(){return Err("作画の指示を入力してください。".into());}
    let configured=settings(root,&Value::Null)?;
    let endpoint=configured["endpoint"].as_str().ok_or("画像APIの設定が不正です。")?;validate_endpoint(endpoint)?;
    let key=options["api_key"].as_str().filter(|key|!key.trim().is_empty()).map(str::to_string)
        .or_else(||std::env::var("MUNIN_IMAGE_API_KEY").ok()).or_else(||std::env::var("OPENAI_API_KEY").ok())
        .ok_or("画像生成用のAPIキーを入力してください。")?;
    let size=options["size"].as_str().unwrap_or("1024x1024");
    if !["1024x1024","1536x1024","1024x1536"].contains(&size){return Err("画像サイズが不正です。".into());}
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
