//! Project paths and bounded, content-free operation timing records.
use crate::{config, workflow};
use serde_json::{json, Value};
use std::{fs, path::Path};

pub fn paths(root: &Path) -> Value {
    let cfg = config::read_config(root);
    json!({"docs":cfg.docs,"assets":cfg.assets,"output":cfg.output})
}

pub fn save_paths(root: &Path, options: &Value) -> Result<Value, String> {
    let _lock = workflow::resource_lock(root, ".munin/settings")?;
    let current = paths(root);
    if options["expected"] != current {
        return Err("保存先設定が別の操作で変更されています。開き直してください。".into());
    }
    let field = |key: &str| -> Result<String, String> {
        let value = options[key].as_str().unwrap_or("").trim();
        if value.is_empty() || Path::new(value).is_absolute() {
            return Err("プロジェクト内の相対パスを入力してください。".into());
        }
        config::project_path(root, value)?;
        Ok(value.to_string())
    };
    let docs = field("docs")?;
    let assets = field("assets")?;
    let output = field("output")?;
    let asset_path = config::project_path(root, &assets)?;
    let output_path = config::project_path(root, &output)?;
    let docs_path = config::project_path(root, &docs)?;
    if docs_path == output_path
        || docs_path.starts_with(&output_path)
        || (output_path.starts_with(&docs_path)
            && !(docs == "." && output_path.starts_with(config::project_path(root, ".munin")?)))
    {
        return Err("原稿フォルダーとHTML出力先は分けてください。原稿が「.」の場合は出力先を「.munin/site」などに指定できます。".into());
    }
    if asset_path.starts_with(&output_path) || output_path.starts_with(&asset_path) {
        return Err("画像保存先とHTML出力先は重ならない場所にしてください。".into());
    }
    let cfg = config::read_config(root);
    let brief_path = if cfg.docs == "." {
        root.join(".munin/brief.md")
    } else {
        root.join("manual/brief.md")
    };
    let brief = fs::read_to_string(brief_path).unwrap_or_default();
    let targets: Vec<_> = cfg
        .targets
        .iter()
        .map(|path| {
            if path == &cfg.docs {
                docs.clone()
            } else {
                path.clone()
            }
        })
        .collect();
    config::save_settings(
        root,
        &docs,
        &output,
        &brief,
        &cfg.agent,
        &cfg.model,
        &cfg.format,
        &serde_json::to_string(&cfg.mkdocs).map_err(|e| e.to_string())?,
        Some(&targets),
        Some(&cfg.connection_type),
        Some(&cfg.endpoint_url),
        Some(&assets),
    )?;
    Ok(paths(root))
}

fn read_records(root: &Path) -> Result<Vec<Value>, String> {
    let path = config::project_path(root, ".munin/operation-timings.json")?;
    match fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|e| format!("処理時間の記録を読めません: {e}"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}
pub fn history(root: &Path) -> Result<Value, String> {
    let _lock = workflow::resource_lock(root, ".munin/operation-timings")?;
    Ok(json!({"items":read_records(root)?}))
}
pub fn record(root: &Path, options: &Value) -> Result<Value, String> {
    let _lock = workflow::resource_lock(root, ".munin/operation-timings")?;
    let kind = options["operation"]
        .as_str()
        .filter(|v| matches!(*v, "screenshot-insert" | "markits-import"))
        .ok_or("Invalid timing operation")?;
    let outcome = options["outcome"]
        .as_str()
        .filter(|v| matches!(*v, "success" | "cancelled" | "error"))
        .ok_or("Invalid timing outcome")?;
    let mut stages = Vec::new();
    let input = options["stages"]
        .as_array()
        .filter(|v| v.len() <= 100)
        .ok_or("Invalid timing stages")?;
    for stage in input {
        let name = stage["stage"]
            .as_str()
            .filter(|name| {
                matches!(
                    *name,
                    "retry"
                        | "select"
                        | "recording"
                        | "capture"
                        | "markits"
                        | "import"
                        | "restore"
                        | "preview"
                        | "review"
                        | "adopt"
                        | "reference"
                        | "insert"
                        | "save"
                        | "refresh"
                        | "source-read"
                        | "metadata"
                        | "register"
                        | "ai"
                )
            })
            .ok_or("Invalid timing stage")?;
        let ms = stage["duration_ms"]
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.0 && *v <= 604_800_000.0)
            .ok_or("Invalid timing duration")?;
        stages.push(json!({"stage":name,"duration_ms":ms,"waiting":matches!(name,"retry"|"select"|"recording"|"markits"|"review")}));
    }
    let entry = json!({"id":crate::screenshots::new_id("timing"),"at":chrono::Utc::now().to_rfc3339(),"operation":kind,"outcome":outcome,"stages":stages});
    let mut records = read_records(root)?;
    records.insert(0, entry.clone());
    records.truncate(50);
    let destination = config::project_path(root, ".munin/operation-timings.json")?;
    let mut temporary = tempfile::NamedTempFile::new_in(destination.parent().unwrap())
        .map_err(|e| e.to_string())?;
    use std::io::Write;
    temporary
        .write_all(&serde_json::to_vec_pretty(&records).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    temporary.persist(destination).map_err(|e| e.to_string())?;
    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn path_changes_preserve_content_connections_and_reject_stale_settings() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("README.md"), "# Original").unwrap();
        let before = paths(root);
        let options =
            json!({"expected":before,"docs":".","assets":"media/shots","output":".munin/site"});
        save_paths(root, &options).unwrap();
        assert_eq!(paths(root)["assets"], "media/shots");
        assert_eq!(
            fs::read_to_string(root.join("README.md")).unwrap(),
            "# Original"
        );
        assert!(!root.join("media").exists());
        assert!(!root.join("docs").exists());
        assert!(!root.join("manual").exists());
        assert!(save_paths(root, &options).unwrap_err().contains("変更"));
        let cfg = config::read_config(root);
        assert_eq!(cfg.agent, "codex");
        assert_eq!(cfg.mkdocs.theme, "material");
    }
    #[test]
    fn invalid_or_overlapping_paths_do_not_write_settings() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for (assets, output) in [
            ("../outside", ".munin/site"),
            ("media", "media/site"),
            ("media/site", "media"),
            ("/tmp/outside", ".munin/site"),
        ] {
            assert!(save_paths(
                root,
                &json!({"expected":paths(root),"docs":".","assets":assets,"output":output})
            )
            .is_err());
            assert!(!config::config_path(root).exists());
        }
    }
    #[test]
    fn timings_are_bounded_and_exclude_free_text_and_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for i in 0..53 {
            record(root,&json!({"operation":"screenshot-insert","outcome":"success","secret":"do-not-save","stages":[{"stage":"markits","duration_ms":i},{"stage":"save","duration_ms":10}]})).unwrap();
        }
        let entries = history(root).unwrap();
        let entries = entries["items"].as_array().unwrap();
        assert_eq!(entries.len(), 50);
        assert_eq!(entries[0]["stages"][0]["duration_ms"], 52.0);
        assert_eq!(entries[0]["stages"][0]["waiting"], true);
        assert_eq!(entries[0]["stages"][1]["waiting"], false);
        assert!(
            !fs::read_to_string(root.join(".munin/operation-timings.json"))
                .unwrap()
                .contains("do-not-save")
        );
        assert!(record(root,&json!({"operation":"screenshot-insert","outcome":"error","stages":[{"stage":"secret prompt","duration_ms":1}]})).is_err());
        assert!(record(root,&json!({"operation":"screenshot-insert","outcome":"error","stages":[{"stage":"save","duration_ms":-1}]})).is_err());
    }
}
