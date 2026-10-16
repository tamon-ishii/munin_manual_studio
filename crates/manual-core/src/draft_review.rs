use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, HashSet}, fs, io::Write, path::{Component, Path}};

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct DraftPage {
    path: String,
    before: String,
    content: String,
    revision: Option<String>,
}

fn valid_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.contains('\\') || Path::new(path).extension().is_none_or(|ext| ext != "md")
        || Path::new(path).components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err(format!("下書きのページパスが不正です: {path}"));
    }
    Ok(())
}

fn existing(path: &Path) -> Result<Option<(String, String)>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some((String::from_utf8(bytes.clone()).map_err(|e| e.to_string())?, format!("{:x}", Sha256::digest(bytes))))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub(crate) fn propose(root: &Path) -> Result<String, String> {
    let config = crate::config::read_config(root);
    let docs = crate::config::project_path(root, &config.docs)?;
    let mut originals = BTreeMap::new();
    for path in crate::task::collect_markdown_files(&docs) {
        let relative = path.strip_prefix(&docs).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
        let safe = crate::config::project_path(&docs, &relative)?;
        originals.insert(relative, existing(&safe)?.ok_or("原稿が削除されました。")?);
    }
    let checkpoint = crate::agent::cancellation_checkpoint(root);
    let generated = crate::author::draft_pages(root)?;
    crate::agent::check_cancelled(root, &checkpoint)?;
    let mut seen = HashSet::new();
    let mut pages = Vec::new();
    for (path, content) in generated {
        valid_path(&path)?;
        crate::config::project_path(&docs, &path)?;
        if !seen.insert(path.clone()) { return Err(format!("下書きのページが重複しています: {path}")); }
        let original = originals.remove(&path);
        pages.push(DraftPage {
            path,
            before: original.as_ref().map(|(text, _)| crate::legacy_ai::plain_markdown(text, None)).unwrap_or_default(),
            revision: original.map(|(_, revision)| revision),
            content: format!("{}\n", crate::legacy_ai::plain_markdown(&content, None).trim_end()),
        });
    }
    crate::agent::log_progress(root, &format!("{}ページの候補を作成しました。原稿は変更していません。", pages.len()));
    serde_json::to_string(&serde_json::json!({"docs":config.docs,"pages":pages})).map_err(|e| e.to_string())
}

pub(crate) fn apply(root: &Path, options: &str) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_str(options).map_err(|e| e.to_string())?;
    let config = crate::config::read_config(root);
    if value["docs"].as_str() != Some(&config.docs) { return Err("原稿フォルダーの設定が変わりました。候補を作り直してください。".into()); }
    let pages: Vec<DraftPage> = serde_json::from_value(value["pages"].clone()).map_err(|e| e.to_string())?;
    if pages.len() > 8 { return Err("下書きは8ページまでです。".into()); }
    let docs = crate::config::project_path(root, &config.docs)?;
    let mut seen = HashSet::new();
    let mut checked = Vec::new();
    // Validate every accepted page before writing any of them.
    for page in &pages {
        valid_path(&page.path)?;
        if !seen.insert(&page.path) { return Err("採用ページが重複しています。".into()); }
        let path = crate::config::project_path(&docs, &page.path)?;
        let current = existing(&path)?;
        if current.as_ref().map(|(_, revision)| revision) != page.revision.as_ref() {
            return Err(format!("{}の原稿が更新されました。候補を作り直してください。", page.path));
        }
        if page.content.len() > 300_000 { return Err("下書きのページが長すぎます。".into()); }
        checked.push((path, current));
    }
    let backup = crate::config::project_path(root, &format!("manual/.backup/draft-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()))?;
    for (page, (_, current)) in pages.iter().zip(&checked) {
        if let Some((content, _)) = current {
            let target = backup.join(&page.path);
            fs::create_dir_all(target.parent().ok_or("Invalid backup path")?).map_err(|e| e.to_string())?;
            fs::write(target, content).map_err(|e| e.to_string())?;
        }
    }
    for (page, (path, current)) in pages.iter().zip(&checked) {
        let parent = path.parent().ok_or("Invalid page path")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        if let Ok(metadata)=fs::metadata(path){temporary.as_file().set_permissions(metadata.permissions()).map_err(|e|e.to_string())?;}
        temporary.write_all(crate::legacy_ai::plain_markdown(&page.content, None).as_bytes()).map_err(|e| e.to_string())?;
        temporary.as_file().sync_all().map_err(|e| e.to_string())?;
        if existing(path)?.as_ref().map(|(_, revision)| revision) != current.as_ref().map(|(_, revision)| revision) {
            return Err(format!("{}の原稿が保存中に更新されました。",page.path));
        }
        if current.is_some() { temporary.persist(path).map_err(|e| e.to_string())?; }
        else { temporary.persist_noclobber(path).map_err(|e| e.to_string())?; }
    }
    serde_json::to_string(&serde_json::json!({"applied":pages.len(),"backup":if backup.exists(){Some(backup.to_string_lossy())}else{None}})).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn adoption_checks_all_revisions_before_writes_and_backs_up() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path();
        fs::create_dir(root.join("docs")).unwrap();
        fs::write(root.join("manual_setting.json"), r#"{"docs":"docs"}"#).unwrap();
        fs::write(root.join("docs/index.md"), "original").unwrap();
        let revision = existing(&root.join("docs/index.md")).unwrap().unwrap().1;
        let page = json!({"path":"index.md","before":"original","content":"approved","revision":revision});
        let stale = json!({"path":"new.md","before":"","content":"new","revision":"stale"});
        assert!(apply(root, &json!({"docs":"docs","pages":[page.clone(),stale]}).to_string()).is_err());
        assert_eq!(fs::read_to_string(root.join("docs/index.md")).unwrap(), "original");
        assert!(!root.join("docs/new.md").exists());
        let result: serde_json::Value = serde_json::from_str(&apply(root, &json!({"docs":"docs","pages":[page]}).to_string()).unwrap()).unwrap();
        assert_eq!(fs::read_to_string(root.join("docs/index.md")).unwrap(), "approved");
        assert_eq!(fs::read_to_string(Path::new(result["backup"].as_str().unwrap()).join("index.md")).unwrap(), "original");
    }
    #[test]
    fn adoption_rejects_unsafe_and_duplicate_paths_and_created_pages() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path();
        fs::create_dir(root.join("docs")).unwrap();
        fs::write(root.join("manual_setting.json"), r#"{"docs":"docs"}"#).unwrap();
        for path in ["../escape.md", "/tmp/escape.md", "a\\b.md", "a/../b.md"] {
            assert!(apply(root,&json!({"docs":"docs","pages":[{"path":path,"before":"","content":"x","revision":null}]}).to_string()).is_err());
        }
        let page=json!({"path":"new.md","before":"","content":"x","revision":null});
        assert!(apply(root,&json!({"docs":"docs","pages":[page.clone(),page.clone()]}).to_string()).is_err());
        fs::write(root.join("docs/new.md"), "external").unwrap();
        assert!(apply(root,&json!({"docs":"docs","pages":[page]}).to_string()).is_err());
        assert_eq!(fs::read_to_string(root.join("docs/new.md")).unwrap(), "external");
        let nested=json!({"path":"chapter/new.md","before":"","content":"new content","revision":null});
        apply(root,&json!({"docs":"docs","pages":[nested]}).to_string()).unwrap();
        assert_eq!(fs::read_to_string(root.join("docs/chapter/new.md")).unwrap(), "new content");
        assert!(!root.join("docs/docs").exists());
    }
}
