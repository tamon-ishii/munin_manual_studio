//! Durable execution receipts and compare-before-restore document/asset snapshots.
use crate::{
    config::{project_path, read_config},
    editor,
    task::{self, PageTag, Task},
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Limits {
    pub timeout_seconds: u64,
    pub retries: u32,
}
impl Limits {
    pub fn checked(mut self) -> Result<Self, String> {
        if self.timeout_seconds == 0 {
            self.timeout_seconds = 300;
        }
        if !(5..=1800).contains(&self.timeout_seconds) || self.retries > 3 {
            return Err("制限時間は5〜1800秒、再試行は0〜3回で指定してください。".into());
        }
        Ok(self)
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Entry {
    pub task: Task,
    pub status: String,
    pub error: Option<String>,
    pub attempts: u32,
    pub input: Value,
    pub references: BTreeMap<String, String>,
    pub capture: Value,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Run {
    pub id: String,
    pub page: String,
    pub created_at: String,
    pub updated_at: String,
    pub status: String,
    pub limits: Limits,
    pub entries: Vec<Entry>,
    pub before: BTreeMap<String, Option<String>>,
    pub after: BTreeMap<String, Option<String>>,
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn dir(root: &Path) -> Result<PathBuf, String> {
    let path = project_path(root, ".munin/executions")?;
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}
fn path(root: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit() || c == '-') {
        return Err("実行IDが不正です。".into());
    }
    project_path(root, &format!(".munin/executions/{id}.json"))
}
fn write(root: &Path, run: &Run) -> Result<(), String> {
    let directory = dir(root)?;
    let mut temp = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut temp, run).map_err(|e| e.to_string())?;
    temp.flush().map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path(root, &run.id)?)
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn load(root: &Path, id: &str) -> Result<Run, String> {
    serde_json::from_slice(&fs::read(path(root, id)?).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
fn relative(root: &Path, path: &Path) -> Result<String, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    Ok(path
        .strip_prefix(root)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/"))
}
pub(crate) fn resource_lock(root: &Path, name: &str) -> Result<fs::File, String> {
    let directory = project_path(root, ".munin/resource-locks")?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let canonical = project_path(root, name)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join(format!(
            "{}.lock",
            digest(canonical.to_string_lossy().as_bytes())
        )))
        .map_err(|e| e.to_string())?;
    lock.lock().map_err(|e| e.to_string())?;
    Ok(lock)
}
pub(crate) fn page_lock(root: &Path, page: &str) -> Result<fs::File, String> {
    resource_lock(root, &relative(root, &editor::document_path(root, page)?)?)
}
fn read_file(root: &Path, name: &str) -> Result<Option<String>, String> {
    let path = project_path(root, name)?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(
        BASE64.encode(fs::read(path).map_err(|e| e.to_string())?),
    ))
}
fn asset_links(body: &str) -> Vec<String> {
    use pulldown_cmark::{Event, Parser, Tag};
    Parser::new(body)
        .filter_map(|event| match event {
            Event::Start(Tag::Image { dest_url, .. }) => Some(dest_url.to_string()),
            _ => None,
        })
        .collect()
}
fn resources(root: &Path, page: &str, entries: &[Entry]) -> Result<BTreeSet<String>, String> {
    let page_path = editor::document_path(root, page)?;
    let mut names = BTreeSet::from([relative(root, &page_path)?]);
    let content = fs::read_to_string(&page_path).map_err(|e| e.to_string())?;
    let tags = task::parse_page_tags(page, &content, &mut Default::default())?;
    for entry in entries {
        let id = &entry.task.id;
        let (asset, _) = crate::config::asset_destination(root, &page_path, &format!("{id}.png"))?;
        if entry.task.kind == "screenshot" {
            names.insert(relative(root, &asset)?);
        }
        for prefix in ["manual/ai/answers", "manual/ai/assets"] {
            if prefix.ends_with("assets") && entry.task.kind != "screenshot" {
                continue;
            }
            names.insert(format!(
                "{prefix}/{id}.{}",
                if prefix.ends_with("answers") {
                    "md"
                } else {
                    "png"
                }
            ));
        }
        for tag in &tags {
            if entry.task.kind != "screenshot" {
                continue;
            }
            if let PageTag::Generated { task, body, .. } = tag {
                if task.id != *id {
                    continue;
                }
                for link in asset_links(body) {
                    if link.contains(':') || link.starts_with('/') {
                        continue;
                    }
                    let clean = link.split(['?', '#']).next().unwrap_or(&link);
                    let decoded = percent_encoding::percent_decode_str(clean)
                        .decode_utf8()
                        .map_err(|e| e.to_string())?;
                    if let Ok(path) = crate::quality::local_path(root, &page_path, &decoded) {
                        if let Ok(name) = relative(root, &path) {
                            names.insert(name);
                        }
                    }
                }
            }
        }
    }
    Ok(names)
}
fn snapshot(
    root: &Path,
    names: &BTreeSet<String>,
) -> Result<BTreeMap<String, Option<String>>, String> {
    names
        .iter()
        .map(|name| Ok((name.clone(), read_file(root, name)?)))
        .collect()
}
fn reference_fingerprints(
    root: &Path,
    page: &str,
    id: &str,
) -> Result<BTreeMap<String, String>, String> {
    let content = editor::read(root, page)?.content;
    let mut paths = BTreeSet::new();
    for tag in task::parse_page_tags(page, &content, &mut Default::default())? {
        if let PageTag::Generated { task, body, .. } = tag {
            if task.id != id {
                continue;
            }
            let pattern = regex::Regex::new(r"(?s)<!--\s*ai:fact\s+(.*?)\s*-->").unwrap();
            for cap in pattern.captures_iter(&body) {
                if let Ok(value) = serde_json::from_str::<Value>(&cap[1]) {
                    if let Some(path) = value["file"].as_str() {
                        paths.insert(path.to_owned());
                    }
                }
            }
        }
    }
    let result = paths
        .into_iter()
        .map(|name| {
            let value = project_path(root, &name)
                .ok()
                .and_then(|path| fs::read(path).ok())
                .map(|bytes| digest(&bytes))
                .unwrap_or_else(|| "missing".into());
            (name, value)
        })
        .collect::<BTreeMap<_, _>>();
    Ok(result)
}
fn capture_fingerprint(root: &Path, id: &str) -> Result<Value, String> {
    let source = crate::capture_source::read(root)?.remove(id);
    let mut value = serde_json::to_value(source).map_err(|e| e.to_string())?;
    if let Some(input) = value["input"].as_str() {
        let hash = project_path(root, input)
            .ok()
            .and_then(|path| fs::read(path).ok())
            .map(|bytes| digest(&bytes));
        value["scenario_hash"] = json!(hash);
    }
    let expectations = crate::capture_validation::read(root, id)?;
    Ok(json!({"source":value,"expectations":expectations}))
}
pub fn begin(root: &Path, page: &str, options: &Value) -> Result<Value, String> {
    let requested = options["ids"]
        .as_array()
        .ok_or("更新対象のIDを指定してください。")?;
    let tasks = task::tasks_for_page(root, page)?;
    let limits = serde_json::from_value::<Limits>(
        options["limits"]
            .as_object()
            .map(|m| Value::Object(m.clone()))
            .unwrap_or(json!({})),
    )
    .map_err(|e| e.to_string())?
    .checked()?;
    let mut seen = BTreeSet::new();
    let mut entries = Vec::new();
    for id in requested {
        let id = id.as_str().ok_or("IDは文字列で指定してください。")?;
        if !seen.insert(id) {
            return Err("更新対象が重複しています。".into());
        }
        let task = tasks
            .iter()
            .find(|task| task.id == id)
            .ok_or("更新対象がありません。")?;
        task::ensure_unlocked(task)?;
        if !["text", "diagram", "screenshot"].contains(&task.kind.as_str()) {
            return Err("未対応のAIタグです。".into());
        }
        entries.push(Entry {task:task.clone(),status:"pending".into(),error:None,attempts:0,input:json!({"existing_content":editor::read(root,page)?.content,"prompt":task.prompt,"agent":read_config(root).agent,"model":read_config(root).model,"connection_type":read_config(root).connection_type}),references:reference_fingerprints(root,page,id)?,capture:capture_fingerprint(root,id)?});
    }
    if entries.is_empty() {
        return Err("更新対象を選択してください。".into());
    }
    let now = task::utc_now();
    let id = format!(
        "{}-{}",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        std::process::id()
    );
    let mut names = resources(root, page, &entries)?;
    if let Some(assets) = options["asset_names"].as_array() {
        let page_path = editor::document_path(root, page)?;
        for asset in assets {
            let filename = asset.as_str().ok_or("画像名が不正です。")?;
            let (path, _) = crate::config::asset_destination(root, &page_path, filename)?;
            names.insert(relative(root, &path)?);
        }
    }
    let before = snapshot(root, &names)?;
    let run = Run {
        id,
        page: page.into(),
        created_at: now.clone(),
        updated_at: now,
        status: "running".into(),
        limits,
        entries,
        before: before.clone(),
        after: before,
    };
    write(root, &run)?;
    Ok(serde_json::to_value(run).map_err(|e| e.to_string())?)
}
pub fn checkpoint(root: &Path, id: &str, options: &Value) -> Result<Value, String> {
    let mut run = load(root, id)?;
    if !["running", "interrupted", "partial"].contains(&run.status.as_str()) {
        return Err("終了済みの実行は変更できません。".into());
    }
    for result in options["results"]
        .as_array()
        .ok_or("結果を指定してください。")?
    {
        let entry = run
            .entries
            .iter_mut()
            .find(|entry| Some(entry.task.id.as_str()) == result["id"].as_str())
            .ok_or("対象外の結果です。")?;
        let status = result["status"]
            .as_str()
            .ok_or("状態を指定してください。")?;
        if !["running", "succeeded", "failed", "cancelled", "pending"].contains(&status) {
            return Err("状態が不正です。".into());
        }
        entry.status = status.into();
        entry.error = result["error"].as_str().map(str::to_owned);
        if status == "running" {
            entry.attempts += 1;
        }
        if status == "succeeded" {
            entry.references = reference_fingerprints(root, &run.page, &entry.task.id)?;
            entry.capture = capture_fingerprint(root, &entry.task.id)?;
        }
    }
    let names: BTreeSet<String> = resources(root, &run.page, &run.entries)?
        .union(&run.before.keys().cloned().collect())
        .cloned()
        .collect();
    run.after = snapshot(root, &names)?;
    run.updated_at = task::utc_now();
    write(root, &run)?;
    Ok(serde_json::to_value(run).map_err(|e| e.to_string())?)
}
fn restore_files(
    root: &Path,
    expected: &BTreeMap<String, Option<String>>,
    target: &BTreeMap<String, Option<String>>,
) -> Result<(), String> {
    for (name, value) in expected {
        if read_file(root, name)? != *value {
            return Err(format!(
                "更新後に変更されています。復元を中止しました: {name}"
            ));
        }
    }
    // Resolve and decode every path before the first write.
    let prepared: Vec<_> = target
        .iter()
        .map(|(name, value)| {
            Ok((
                project_path(root, name)?,
                value
                    .as_ref()
                    .map(|s| BASE64.decode(s).map_err(|e| e.to_string()))
                    .transpose()?,
            ))
        })
        .collect::<Result<_, String>>()?;
    let mut applied: Vec<String> = Vec::new();
    for (path, bytes) in prepared {
        let result = (|| {
            if let Some(bytes) = bytes {
                let parent = path.parent().ok_or("保存先が不正です。")?;
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                let mut temp =
                    tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
                temp.write_all(&bytes).map_err(|e| e.to_string())?;
                temp.persist(&path).map_err(|e| e.to_string())?;
            } else if path.is_file() {
                fs::remove_file(&path).map_err(|e| e.to_string())?;
            }
            Ok::<_, String>(())
        })();
        if let Err(error) = result {
            for name in applied {
                match expected.get(&name) {
                    Some(Some(data)) => {
                        if let Ok(bytes) = BASE64.decode(data) {
                            let _ = fs::write(project_path(root, &name)?, bytes);
                        }
                    }
                    Some(None) => {
                        let _ = fs::remove_file(project_path(root, &name)?);
                    }
                    _ => {}
                }
            }
            return Err(error);
        }
        applied.push(relative(root, &path)?);
    }
    Ok(())
}
pub fn finish(root: &Path, id: &str, rollback: bool) -> Result<Value, String> {
    let mut run = load(root, id)?;
    if rollback {
        let _locks = run
            .after
            .keys()
            .map(|name| resource_lock(root, name))
            .collect::<Result<Vec<_>, _>>()?;
        let current = task::tasks_for_page(root, &run.page)?;
        for entry in &run.entries {
            if current
                .iter()
                .any(|task| task.id == entry.task.id && task.status == "approved")
            {
                return Err(
                    "確定済みタグを含むため復元できません。先に確定を解除してください。".into(),
                );
            }
        }
        restore_files(root, &run.after, &run.before)?;
        run.status = "rolled_back".into();
        for entry in &mut run.entries {
            if entry.status == "succeeded" {
                entry.status = "pending".into();
            }
        }
    } else {
        run.status = if run.entries.iter().all(|e| e.status == "succeeded") {
            "completed"
        } else {
            "partial"
        }
        .into();
    }
    run.updated_at = task::utc_now();
    write(root, &run)?;
    Ok(serde_json::to_value(run).map_err(|e| e.to_string())?)
}
pub fn history(root: &Path, page: Option<&str>) -> Result<Value, String> {
    let mut runs = Vec::new();
    for item in fs::read_dir(dir(root)?).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        if item.path().extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let run: Run = serde_json::from_slice(&fs::read(item.path()).map_err(|e| e.to_string())?)
            .map_err(|e| format!("実行記録が破損しています: {e}"))?;
        if page.is_some_and(|page| page != run.page) {
            continue;
        }
        runs.push(json!({"id":run.id,"page":run.page,"created_at":run.created_at,"status":run.status,"limits":run.limits,"entries":run.entries}));
    }
    runs.sort_by(|a, b| b["id"].as_str().cmp(&a["id"].as_str()));
    Ok(json!({"runs":runs}))
}
pub fn update_reasons(root: &Path, tasks: &[Task]) -> Result<Value, String> {
    let history = history(root, None)?;
    let mut result = serde_json::Map::new();
    for task in tasks {
        let mut reasons = Vec::new();
        if task.status == "missing" {
            reasons.push("未生成".to_owned());
        }
        if task.status == "stale" {
            reasons.push("指示変更".to_owned());
        }
        if task.status == "approved" {
            let content = editor::read(root, &task.page)?.content;
            for tag in task::parse_page_tags(&task.page, &content, &mut Default::default())? {
                if let PageTag::Generated {
                    task: current,
                    range,
                    ..
                } = tag
                {
                    if current.id == task.id {
                        let header = &content[range.start..range.end]
                            .split("-->")
                            .next()
                            .unwrap_or_default();
                        let pattern =
                            regex::Regex::new(r#"source-sha256=["']?([a-f0-9]+)"#).unwrap();
                        if pattern
                            .captures(header)
                            .is_some_and(|cap| cap[1] != task.source_sha256)
                        {
                            reasons.push("指示変更".into());
                        }
                    }
                }
            }
        }

        let entry = history["runs"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|run| run["entries"].as_array().unwrap())
            .find(|entry| entry["task"]["id"] == task.id && entry["status"] == "succeeded");
        if let Some(entry) = entry {
            if entry["task"]["source_sha256"] != task.source_sha256 {
                reasons.push("指示変更".into());
            }
            if entry["capture"] != capture_fingerprint(root, &task.id)? {
                reasons.push("撮影条件・手順変更".into());
            }
            if let Some(refs) = entry["references"].as_object() {
                for (name, old) in refs {
                    let new = project_path(root, name)
                        .ok()
                        .and_then(|path| fs::read(path).ok())
                        .map(|bytes| digest(&bytes))
                        .unwrap_or_else(|| "missing".into());
                    if old.as_str() != Some(&new) {
                        reasons.push(format!("参照変更: {name}"));
                    }
                }
            }
        }
        reasons.sort();
        reasons.dedup();
        result.insert(task.id.clone(), json!(reasons));
    }
    Ok(Value::Object(result))
}

pub fn resume(root: &Path, id: &str) -> Result<Value, String> {
    let run = load(root, id)?;
    if run.status == "completed" {
        return Err("この実行は完了済みです。".into());
    }
    let expected = if run.status == "rolled_back" {
        &run.before
    } else {
        &run.after
    };
    for (name, data) in expected {
        if read_file(root, name)? != *data {
            return Err(format!("実行記録の後に変更されています。原稿を確認して新しい更新を開始してください: {name}"));
        }
    }
    let current = task::tasks_for_page(root, &run.page)?;
    let ids: Vec<_> = run
        .entries
        .iter()
        .filter(|entry| entry.status != "succeeded")
        .filter_map(|entry| {
            current
                .iter()
                .find(|task| task.id == entry.task.id && task.status != "approved")
        })
        .map(|task| task.id.clone())
        .collect();
    if ids.is_empty() {
        return Err("再開できる未完了タグがありません。".into());
    }
    Ok(json!({"page":run.page,"ids":ids,"limits":run.limits,"previous_run":id}))
}

pub fn latest_results(root: &Path) -> Result<Value, String> {
    let history = history(root, None)?;
    let mut results = serde_json::Map::new();
    for run in history["runs"].as_array().unwrap() {
        for entry in run["entries"].as_array().unwrap() {
            if let Some(id) = entry["task"]["id"].as_str() {
                if !results.contains_key(id) {
                    results.insert(
                        id.into(),
                        json!({"status":entry["status"],"error":entry["error"],"run_id":run["id"]}),
                    );
                }
            }
        }
    }
    Ok(Value::Object(results))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs/assets")).unwrap();
        fs::write(root.path().join("docs/index.md"),"# Guide\n<!-- ai:task id=write kind=text prompt=\"Write\" -->\nOld text\n<!-- /ai:task -->\n<!-- ai:task id=shot kind=screenshot prompt=\"Capture\" -->\n![shot](assets/shot.png)\n<!-- /ai:task -->").unwrap();
        image::RgbImage::from_pixel(2, 2, image::Rgb([0, 0, 0]))
            .save(root.path().join("docs/assets/shot.png"))
            .unwrap();
        root
    }
    #[test]
    fn partial_run_survives_reload_and_resumes_only_unfinished_tags() {
        let root = fixture();
        let run = begin(
            root.path(),
            "docs/index.md",
            &json!({"ids":["write","shot"]}),
        )
        .unwrap();
        let id = run["id"].as_str().unwrap();
        checkpoint(
            root.path(),
            id,
            &json!({"results":[{"id":"write","status":"running"}]}),
        )
        .unwrap();
        let task = task::tasks_for_page(root.path(), "docs/index.md")
            .unwrap()
            .remove(0);
        task::update_task_in_docs(&root.path().join("docs"), &task, "New text", None).unwrap();
        checkpoint(root.path(),id,&json!({"results":[{"id":"write","status":"succeeded"},{"id":"shot","status":"failed","error":"target missing"}]})).unwrap();
        finish(root.path(), id, false).unwrap();
        assert_eq!(load(root.path(), id).unwrap().entries[0].attempts, 1);
        assert_eq!(resume(root.path(), id).unwrap()["ids"], json!(["shot"]));
        assert_eq!(
            latest_results(root.path()).unwrap()["shot"]["status"],
            "failed"
        );
    }
    #[test]
    fn rollback_restores_document_and_image_and_rejects_external_edits() {
        let root = fixture();
        let before = fs::read(root.path().join("docs/index.md")).unwrap();
        let old_image = fs::read(root.path().join("docs/assets/shot.png")).unwrap();
        let run = begin(
            root.path(),
            "docs/index.md",
            &json!({"ids":["write","shot"]}),
        )
        .unwrap();
        let id = run["id"].as_str().unwrap();
        fs::write(
            root.path().join("docs/index.md"),
            String::from_utf8(before.clone())
                .unwrap()
                .replace("Old text", "New text"),
        )
        .unwrap();
        image::RgbImage::from_pixel(3, 3, image::Rgb([255, 0, 0]))
            .save(root.path().join("docs/assets/shot.png"))
            .unwrap();
        checkpoint(root.path(),id,&json!({"results":[{"id":"write","status":"succeeded"},{"id":"shot","status":"succeeded"}]})).unwrap();
        let changed = fs::read(root.path().join("docs/index.md")).unwrap();
        fs::write(root.path().join("docs/index.md"), "External edit").unwrap();
        assert!(finish(root.path(), id, true).is_err());
        assert_ne!(
            fs::read(root.path().join("docs/assets/shot.png")).unwrap(),
            old_image
        );
        fs::write(root.path().join("docs/index.md"), changed).unwrap();
        finish(root.path(), id, true).unwrap();
        assert_eq!(fs::read(root.path().join("docs/index.md")).unwrap(), before);
        assert_eq!(
            fs::read(root.path().join("docs/assets/shot.png")).unwrap(),
            old_image
        );
        assert_eq!(
            resume(root.path(), id).unwrap()["ids"],
            json!(["write", "shot"])
        );
    }
    #[test]
    fn approved_tags_and_invalid_ids_limits_are_rejected() {
        let root = fixture();
        let docs = root.path().join("docs");
        task::approve_task(&docs, &root.path().join("manual/ai"), "write").unwrap();
        assert!(begin(root.path(), "docs/index.md", &json!({"ids":["write"]})).is_err());
        assert!(begin(
            root.path(),
            "docs/index.md",
            &json!({"ids":["shot","shot"]})
        )
        .is_err());
        assert!(begin(
            root.path(),
            "docs/index.md",
            &json!({"ids":["shot"],"limits":{"retries":4}})
        )
        .is_err());
        assert!(load(root.path(), "../wrong").is_err());
    }
    #[test]
    fn references_and_capture_conditions_report_change_reasons() {
        let root = fixture();
        fs::write(root.path().join("source.py"), "old").unwrap();
        let page = root.path().join("docs/index.md");
        let content = fs::read_to_string(&page).unwrap().replace(
            "Old text",
            r#"Old text <!-- ai:fact {"file":"source.py"} -->"#,
        );
        fs::write(&page, content).unwrap();
        let run = begin(
            root.path(),
            "docs/index.md",
            &json!({"ids":["write","shot"]}),
        )
        .unwrap();
        let id = run["id"].as_str().unwrap();
        checkpoint(root.path(),id,&json!({"results":[{"id":"write","status":"succeeded"},{"id":"shot","status":"succeeded"}]})).unwrap();
        finish(root.path(), id, false).unwrap();
        fs::write(root.path().join("source.py"), "new").unwrap();
        crate::capture_validation::save(
            root.path(),
            "shot",
            crate::capture_validation::Expectations {
                width: Some(300),
                ..Default::default()
            },
        )
        .unwrap();
        let reasons = update_reasons(
            root.path(),
            &task::tasks_for_page(root.path(), "docs/index.md").unwrap(),
        )
        .unwrap();
        assert!(reasons["write"].to_string().contains("参照変更"));
        assert!(reasons["shot"].to_string().contains("撮影条件"));
    }
}
