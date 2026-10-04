use serde_json::{json, Value};
use std::{fs, path::Path};

pub fn validate(root: &Path, options: &Value) -> Result<String, String> {
    if !root.is_absolute()
        || root.file_name().is_none()
        || root
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("新規ワークスペースの絶対パスを指定してください。".into());
    }
    if root.symlink_metadata().is_ok() {
        return Err("保存先は既に存在します。既存のワークスペースを開くか、新しいフォルダー名を指定してください。".into());
    }
    let parent = root.parent().ok_or("保存先の親フォルダーがありません。")?;
    if !parent.is_dir() {
        return Err("保存先の親フォルダーが見つかりません。".into());
    }
    if parent
        .metadata()
        .map_err(|e| e.to_string())?
        .permissions()
        .readonly()
    {
        return Err("保存先の親フォルダーに書き込めません。".into());
    }
    if options["step"].as_u64() == Some(0) {
        return Ok("{}".into());
    }
    let normalized = parent
        .canonicalize()
        .map_err(|e| e.to_string())?
        .join(root.file_name().unwrap());
    let folder = |key: &str, default: &str| {
        crate::config::project_path(&normalized, options[key].as_str().unwrap_or(default))
    };
    let docs = folder("docs", "docs")?;
    let output = folder("output", "manual")?;
    let assets = folder("assets", "docs/assets")?;
    if docs.starts_with(&output) || output.starts_with(&docs) {
        return Err("原稿フォルダーとHTML出力先は、重ならない別の場所にしてください。".into());
    }
    if assets.starts_with(&output) || output.starts_with(&assets) {
        return Err("画像保存フォルダーとHTML出力先は、重ならない別の場所にしてください。".into());
    }
    if options["site_name"]
        .as_str()
        .unwrap_or("マニュアル")
        .trim()
        .is_empty()
    {
        return Err("サイト名を入力してください。".into());
    }
    Ok("{}".into())
}

pub fn create(root: &Path, options: &Value) -> Result<String, String> {
    let mut full_options = options.clone();
    if let Some(object) = full_options.as_object_mut() {
        object.remove("step");
    }
    validate(root, &full_options)?;
    if !root.is_absolute() || root.file_name().is_none() {
        return Err("新規ワークスペースの絶対パスを指定してください。".into());
    }
    if root.symlink_metadata().is_ok() {
        return Err("保存先は既に存在します。既存のワークスペースを開くか、新しいフォルダー名を指定してください。".into());
    }
    let parent = root.parent().ok_or("保存先の親フォルダーがありません。")?;
    let stage = tempfile::Builder::new()
        .prefix(".munin-workspace-")
        .tempdir_in(parent)
        .map_err(|e| format!("保存先の親フォルダーを確認してください: {e}"))?;
    let text = |key: &str, default: &str| options[key].as_str().unwrap_or(default).to_string();
    let docs = text("docs", "docs");
    let assets = text("assets", "docs/assets");
    let title = text("site_name", "マニュアル");
    if title.trim().is_empty() {
        return Err("サイト名を入力してください。".into());
    }
    let cfg = crate::config::save_settings(
        stage.path(),
        &docs,
        &text("output", "manual"),
        &text("brief", ""),
        &text("agent", "codex"),
        &text("model", ""),
        "mkdocs",
        &json!({"site_name": title}).to_string(),
        None,
        Some(&text("connection_type", "cli")),
        Some(&text("endpoint_url", "")),
        Some(&assets),
    )?;
    let docs_path = crate::config::project_path(stage.path(), &cfg.docs)?;
    let assets_path = crate::config::project_path(stage.path(), &cfg.assets)?;
    fs::create_dir_all(&docs_path).map_err(|e| e.to_string())?;
    fs::create_dir_all(assets_path).map_err(|e| e.to_string())?;
    fs::write(
        docs_path.join("index.md"),
        format!(
            "# {}\n\nここからマニュアルを書き始めましょう。\n",
            title.replace(['\r', '\n'], " ")
        ),
    )
    .map_err(|e| e.to_string())?;
    // Reserve the destination exclusively after all settings have been validated.
    fs::create_dir(root).map_err(|e| format!("ワークスペースを作成できません: {e}"))?;
    for entry in fs::read_dir(stage.path()).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        fs::rename(entry.path(), root.join(entry.file_name()))
            .map_err(|e| format!("初期ファイルの保存に失敗しました: {e}"))?;
    }
    Ok(json!({"root": root, "page": format!("{}/index.md", cfg.docs)}).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validation_is_read_only_and_deferred_ai_remains_disabled() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("guide");
        assert!(validate(&root, &json!({"step": 0})).is_ok());
        assert!(!root.exists());
        assert!(validate(&root, &json!({"docs":"docs", "output":"docs/html"})).is_err());
        assert!(validate(&root, &json!({"assets":"manual/images"})).is_err());
        assert!(!root.exists());
        create(&root, &json!({"connection_type":"none"})).unwrap();
        assert_eq!(crate::config::read_config(&root).connection_type, "none");
        let error = crate::agent::agent_json(&root, "test", &json!({}), "codex", "").unwrap_err();
        assert!(error.contains("未設定"));
    }
    #[test]
    fn creates_workspace_and_preserves_existing_destination() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("guide");
        create(&root, &json!({"site_name":"操作ガイド", "docs":"pages", "assets":"pages/images", "connection_type":"local_llm", "model":"test"})).unwrap();
        assert!(root.join("pages/index.md").is_file());
        assert!(root.join("pages/images").is_dir());
        assert_eq!(crate::config::read_config(&root).model, "test");
        assert!(create(&root, &json!({})).is_err());
        assert!(fs::read_to_string(root.join("pages/index.md"))
            .unwrap()
            .contains("操作ガイド"));
    }
    #[test]
    fn invalid_paths_leave_no_workspace() {
        let parent = tempfile::tempdir().unwrap();
        for options in [
            json!({"docs":"../outside"}),
            json!({"assets":"../outside"}),
            json!({"docs":"same", "output":"same"}),
        ] {
            let root = parent.path().join("invalid");
            assert!(create(&root, &options).is_err());
            assert!(!root.exists());
        }
    }
}
