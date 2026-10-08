//! Project-owned screenshot originals and independently adoptable edit revisions.
use crate::{config::project_path, editor, task, workflow};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tempfile::NamedTempFile;

static SEQUENCE: AtomicU64 = AtomicU64::new(0);
pub fn new_id(prefix: &str) -> String {
    let seed = format!(
        "{}-{}-{}",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    format!("{prefix}-{}", &hash(seed.as_bytes())[..24])
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err("画像の識別情報が不正です。".into());
    }
    Ok(())
}
fn directory(root: &Path, id: &str) -> Result<PathBuf, String> {
    valid_id(id)?;
    project_path(root, &format!(".munin/screenshots/{id}"))
}
fn atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid image storage")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temp = NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(bytes).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
fn immutable(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path.exists() {
        if fs::read(path).map_err(|e| e.to_string())? != bytes {
            return Err("画像の原本を上書きできません。".into());
        }
        return Ok(());
    }
    let parent = path.parent().ok_or("Invalid original storage")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temp = NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(bytes).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist_noclobber(path).map_err(|e| e.to_string())?;
    Ok(())
}
fn decode(data: &str) -> Result<Vec<u8>, String> {
    let raw = data.strip_prefix("data:image/png;base64,").unwrap_or(data);
    let bytes = STANDARD.decode(raw).map_err(|e| e.to_string())?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("PNG画像を指定してください。".into());
    }
    image::load_from_memory(&bytes).map_err(|e| format!("画像を読めません: {e}"))?;
    Ok(bytes)
}
fn data(bytes: &[u8]) -> String {
    format!("data:image/png;base64,{}", STANDARD.encode(bytes))
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Edit {
    pub id: String,
    pub original: String,
    pub original_sha256: String,
    pub width: u32,
    pub height: u32,
    pub scene: Value,
    pub crop: Value,
    pub render_sha256: String,
    pub created_at: String,
    #[serde(default)]
    pub flattened: bool,
    #[serde(default)]
    pub requires_review: bool,
    #[serde(default)]
    pub ui: Value,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Screenshot {
    pub version: u32,
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub adopted: Option<String>,
    pub output: String,
    pub output_sha256: Option<String>,
    pub edits: Vec<Edit>,
    pub recipe: Value,
    pub protected: bool,
    #[serde(default)]
    pub adopting: Option<String>,
    #[serde(default)]
    pub legacy: Option<String>,
}
fn save(root: &Path, shot: &Screenshot) -> Result<(), String> {
    atomic(
        &directory(root, &shot.id)?.join("manifest.json"),
        &serde_json::to_vec_pretty(shot).map_err(|e| e.to_string())?,
    )
}
pub fn load(root: &Path, id: &str) -> Result<Screenshot, String> {
    let shot: Screenshot = serde_json::from_slice(
        &fs::read(directory(root, id)?.join("manifest.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if shot.version != 1 || shot.id != id {
        return Err("未対応の画像管理形式です。".into());
    }
    Ok(shot)
}
fn edit<'a>(shot: &'a Screenshot, revision: &str) -> Result<&'a Edit, String> {
    shot.edits
        .iter()
        .find(|e| e.id == revision)
        .ok_or_else(|| "画像の編集版が見つかりません。".into())
}
fn read_render(root: &Path, shot: &Screenshot, revision: &str) -> Result<Vec<u8>, String> {
    let entry = edit(shot, revision)?;
    let bytes = fs::read(directory(root, &shot.id)?.join(format!("renders/{}.png", entry.id)))
        .map_err(|e| e.to_string())?;
    if hash(&bytes) != entry.render_sha256 {
        return Err("保存画像が変更されています。".into());
    }
    Ok(bytes)
}
fn recovered(root: &Path, mut shot: Screenshot) -> Result<Screenshot, String> {
    if let Some(revision) = shot.adopting.clone() {
        let candidate = edit(&shot, &revision)?.render_sha256.clone();
        if fs::read(project_path(root, &shot.output)?)
            .ok()
            .as_deref()
            .map(hash)
            .as_deref()
            == Some(candidate.as_str())
        {
            shot.adopted = Some(revision);
            shot.output_sha256 = Some(candidate);
            shot.adopting = None;
            save(root, &shot)?;
        }
    }
    Ok(shot)
}
fn adopt_locked(root: &Path, shot: &mut Screenshot, revision: &str) -> Result<(), String> {
    if shot.protected {
        return Err("保護を解除してから画像を更新してください。".into());
    }
    let output = project_path(root, &shot.output)?;
    let existing = fs::read(&output).ok().map(|bytes| hash(&bytes));
    if existing != shot.output_sha256 {
        return Err("公開画像が外部で変更されています。旧版と変更内容を確認してください。".into());
    }
    let bytes = read_render(root, shot, revision)?;
    shot.adopting = Some(revision.into());
    save(root, shot)?;
    atomic(&output, &bytes)?;
    shot.adopted = Some(revision.into());
    shot.output_sha256 = Some(hash(&bytes));
    shot.adopting = None;
    save(root, shot)
}
fn usages(root: &Path, shot: &Screenshot) -> Result<Vec<String>, String> {
    let config = crate::config::read_config(root);
    let mut found = Vec::new();
    for (page, path) in task::collect_target_markdown_files(root, &config) {
        let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let pattern = regex::Regex::new(&format!(
            r"<!--\s*screenshot:ref\s+id={}\s*-->",
            regex::escape(&shot.id)
        ))
        .unwrap();
        let ranges = task::ignored_tag_ranges(&text);
        let image_reference = pulldown_cmark::Parser::new(&text).any(|event| {
            if let pulldown_cmark::Event::Start(pulldown_cmark::Tag::Image { dest_url, .. }) = event
            {
                crate::quality::local_path(root, &path, &dest_url).ok()
                    == project_path(root, &shot.output).ok()
            } else {
                false
            }
        });
        if image_reference
            || pattern
                .find_iter(&text)
                .any(|m| !task::is_inside_ranges(&(m.start()..m.end()), &ranges))
        {
            found.push(page);
        }
    }
    Ok(found)
}
pub fn list(root: &Path) -> Result<Value, String> {
    let _lock = workflow::resource_lock(root, ".munin/screenshots")?;
    let home = project_path(root, ".munin/screenshots")?;
    let mut items = Vec::new();
    if home.exists() {
        for dir in fs::read_dir(home).map_err(|e| e.to_string())? {
            let dir = dir.map_err(|e| e.to_string())?;
            if !dir.file_type().map_err(|e| e.to_string())?.is_dir() {
                continue;
            }
            let id = dir.file_name().to_string_lossy().into_owned();
            if !dir.path().join("manifest.json").exists() {
                continue;
            }
            let shot = recovered(root, load(root, &id)?)?;
            let mut value = serde_json::to_value(&shot).map_err(|e| e.to_string())?;
            value["usage"] = json!(usages(root, &shot)?);
            value["thumbnail"] = if let Some(revision) = &shot.adopted {
                json!(data(&read_render(root, &shot, revision)?))
            } else {
                Value::Null
            };
            items.push(value);
        }
    }
    items.sort_by(|a, b| b["created_at"].as_str().cmp(&a["created_at"].as_str()));
    Ok(json!({"version":1,"items":items}))
}
pub fn register(root: &Path, options: &Value) -> Result<Value, String> {
    let _lock = workflow::resource_lock(root, ".munin/screenshots")?;
    let id = options["id"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| new_id("shot"));
    let home = directory(root, &id)?;
    let mut shot = if home.join("manifest.json").exists() {
        recovered(root, load(root, &id)?)?
    } else {
        let assets = crate::config::read_config(root).assets;
        Screenshot {
            version: 1,
            id: id.clone(),
            name: options["name"].as_str().unwrap_or_default().into(),
            created_at: task::utc_now(),
            adopted: None,
            output: format!("{}/screenshots/{id}.png", assets.trim_end_matches('/')),
            output_sha256: None,
            edits: vec![],
            recipe: options["recipe"].clone(),
            protected: false,
            adopting: None,
            legacy: options["legacy"].as_str().map(str::to_owned),
        }
    };
    if shot.protected {
        return Err("保護を解除してから画像を編集してください。".into());
    }
    if let Some(expected) = options["expected_revision"].as_str() {
        if shot.adopted.as_deref() != Some(expected) {
            return Err("画像の採用版が更新されています。開き直してください。".into());
        }
    }
    let source = decode(
        options["source"]
            .as_str()
            .ok_or("撮影原本を指定してください。")?,
    )?;
    let rendered = decode(
        options["render"]
            .as_str()
            .or_else(|| options["source"].as_str())
            .ok_or("書き出し画像を指定してください。")?,
    )?;
    let imported = options["import"] == true;
    let (source, imported_flattened) = if imported {
        recovered_legacy_source(&source)
    } else {
        (source, false)
    };
    let original_hash = hash(&source);
    let original = format!("source-{}", &original_hash[..24]);
    let (width, height) = image::load_from_memory(&source)
        .map_err(|e| e.to_string())?
        .into_rgba8()
        .dimensions();
    let scene = if imported && !imported_flattened && options["scene"].is_null() {
        markits::raster::extract_png_text_chunk(&rendered, "markits:annotations")
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null)
    } else {
        options["scene"].clone()
    };
    let crop = if imported && !imported_flattened && options["crop"].is_null() {
        markits::raster::extract_png_text_chunk(&rendered, "markits:crop_info")
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null)
    } else {
        options["crop"].clone()
    };
    // Public renders contain pixels only; source pixels and editing metadata stay private.
    let mut rendered_pixels = std::io::Cursor::new(Vec::new());
    image::load_from_memory(&rendered)
        .map_err(|e| e.to_string())?
        .write_to(&mut rendered_pixels, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let rendered = rendered_pixels.into_inner();
    let revision_hash = hash(
        &serde_json::to_vec(&json!([
            original_hash,
            hash(&rendered),
            scene,
            crop,
            options["ui"],
            if imported {
                imported_flattened
            } else {
                options["flattened"].as_bool().unwrap_or(false)
            }
        ]))
        .map_err(|e| e.to_string())?,
    );
    let revision = format!("edit-{}", &revision_hash[..24]);
    immutable(&home.join(format!("originals/{original}.png")), &source)?;
    if !shot.edits.iter().any(|e| e.id == revision) {
        let mut entry = Edit {
            id: revision.clone(),
            original,
            original_sha256: original_hash,
            width,
            height,
            scene,
            crop,
            render_sha256: hash(&rendered),
            created_at: task::utc_now(),
            requires_review: options["requires_review"].as_bool().unwrap_or(false),
            flattened: if imported {
                imported_flattened
            } else {
                options["flattened"].as_bool().unwrap_or(false)
            },
            ui: if options["ui"].is_null() {
                markits::raster::extract_png_uimap(&source)
                    .map(|ui| json!(ui))
                    .unwrap_or(Value::Null)
            } else {
                options["ui"].clone()
            },
        };
        immutable(&home.join(format!("renders/{revision}.png")), &rendered)?;
        let edit_path = home.join(format!("edits/{revision}.json"));
        if edit_path.exists() {
            let saved: Edit =
                serde_json::from_slice(&fs::read(&edit_path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if saved.id != entry.id
                || saved.original_sha256 != entry.original_sha256
                || saved.render_sha256 != entry.render_sha256
                || saved.scene != entry.scene
                || saved.crop != entry.crop
            {
                return Err("保存済みの編集版が変更されています。".into());
            }
            entry.created_at = saved.created_at;
        }
        immutable(
            &home.join(format!("edits/{revision}.json")),
            &serde_json::to_vec_pretty(&entry).map_err(|e| e.to_string())?,
        )?;
        shot.edits.push(entry);
    }
    if !options["recipe"].is_null() {
        shot.recipe = options["recipe"].clone();
    }
    if let Some(name) = options["name"].as_str() {
        shot.name = name.into();
    }
    save(root, &shot)?;
    if options["adopt"].as_bool().unwrap_or(shot.adopted.is_none()) {
        adopt_locked(root, &mut shot, &revision)?;
    }
    Ok(json!({"screenshot":shot,"revision":revision}))
}
pub fn image(
    root: &Path,
    id: &str,
    revision: Option<&str>,
    original: bool,
) -> Result<Value, String> {
    let shot = load(root, id)?;
    let revision = revision
        .or(shot.adopted.as_deref())
        .or_else(|| shot.edits.last().map(|edit| edit.id.as_str()))
        .ok_or("画像の版を選択してください。")?;
    let entry = edit(&shot, revision)?;
    let bytes = if original {
        let bytes =
            fs::read(directory(root, id)?.join(format!("originals/{}.png", entry.original)))
                .map_err(|e| e.to_string())?;
        if hash(&bytes) != entry.original_sha256 {
            return Err("原本が外部で変更されています。".into());
        }
        bytes
    } else {
        read_render(root, &shot, revision)?
    };
    Ok(json!({"data":data(&bytes),"edit":entry,"screenshot":shot}))
}
pub fn change(root: &Path, id: &str, options: &Value) -> Result<Value, String> {
    let _lock = workflow::resource_lock(root, ".munin/screenshots")?;
    let mut shot = recovered(root, load(root, id)?)?;
    if options.get("expected_revision").is_some()
        && options["expected_revision"] != json!(shot.adopted)
    {
        return Err("画像の採用版が更新されています。候補を開き直してください。".into());
    }
    if let Some(name) = options["name"].as_str() {
        shot.name = name.into();
    }
    if let Some(protected) = options["protected"].as_bool() {
        shot.protected = protected;
    }
    if let Some(revision) = options["adopt"].as_str() {
        adopt_locked(root, &mut shot, revision)?;
    }
    if options["delete"] == true {
        if shot.protected {
            return Err("保護を解除してから削除してください。".into());
        }
        if !usages(root, &shot)?.is_empty() {
            return Err("参照中の画像です。使用文書から参照を削除してください。".into());
        }
        let output = project_path(root, &shot.output)?;
        if output.exists() {
            if fs::read(&output).ok().map(|bytes| hash(&bytes)) != shot.output_sha256 {
                return Err("公開画像が外部で変更されています。".into());
            }
            fs::remove_file(output).map_err(|e| e.to_string())?;
        }
        fs::remove_dir_all(directory(root, id)?).map_err(|e| e.to_string())?;
        return Ok(json!({"deleted":id}));
    }
    save(root, &shot)?;
    serde_json::to_value(shot).map_err(|e| e.to_string())
}
pub fn reference(root: &Path, id: &str, page: &str) -> Result<String, String> {
    let shot = load(root, id)?;
    if shot.adopted.is_none() {
        return Err("画像を採用してから挿入してください。".into());
    }
    let path = editor::document_path(root, page)?;
    let from = path.parent().ok_or("Invalid page")?;
    let output = project_path(root, &shot.output)?;
    let from: Vec<_> = from.components().collect();
    let to: Vec<_> = output.components().collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let relative = format!(
        "{}{}",
        "../".repeat(from.len() - common),
        to[common..]
            .iter()
            .map(|p| p.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/")
    );
    let name = if shot.name.is_empty() {
        "スクリーンショット"
    } else {
        &shot.name
    };
    let alt = name.replace(['[', ']', '\n', '\r'], " ");
    Ok(format!(
        "<!-- screenshot:ref id={} -->\n![{alt}]({relative})\n<!-- /screenshot:ref -->",
        shot.id
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png(color: u8) -> String {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            16,
            12,
            image::Rgba([color, 2, 3, 255]),
        ))
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
        data(bytes.get_ref())
    }
    #[test]
    fn originals_revisions_and_conflicts_are_independent() {
        let root = tempfile::tempdir().unwrap();
        let first = register(root.path(), &json!({"source":png(1)})).unwrap();
        let id = first["screenshot"]["id"].as_str().unwrap();
        let original = image(root.path(), id, None, true).unwrap();
        let revised=register(root.path(),&json!({"id":id,"source":png(1),"render":png(5),"scene":{"annotations":[{"x":1}]},"adopt":false})).unwrap();
        assert_eq!(
            image(root.path(), id, None, true).unwrap()["data"],
            original["data"]
        );
        assert_ne!(revised["revision"], first["revision"]);
        assert_eq!(register(root.path(),&json!({"id":id,"source":png(1),"render":png(5),"scene":{"annotations":[{"x":1}]},"adopt":false})).unwrap()["screenshot"]["edits"].as_array().unwrap().len(),2);
        change(root.path(), id, &json!({"adopt":revised["revision"]})).unwrap();
        assert_eq!(
            image(root.path(), id, None, true).unwrap()["data"],
            original["data"]
        );
        let shot = load(root.path(), id).unwrap();
        fs::write(
            project_path(root.path(), &shot.output).unwrap(),
            b"external",
        )
        .unwrap();
        assert!(change(root.path(), id, &json!({"adopt":first["revision"]})).is_err());
    }
    #[test]
    fn references_and_optional_names_do_not_own_assets() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("docs")).unwrap();
        let a = register(root.path(), &json!({"source":png(1)})).unwrap();
        let id = a["screenshot"]["id"].as_str().unwrap();
        let markdown = reference(root.path(), id, "index.md").unwrap();
        fs::write(root.path().join("docs/index.md"), &markdown).unwrap();
        assert!(change(root.path(), id, &json!({"delete":true})).is_err());
        change(root.path(), id, &json!({"name":"same name"})).unwrap();
        assert!(
            list(root.path()).unwrap()["items"][0]["usage"]
                .as_array()
                .unwrap()
                .len()
                == 1
        );
        fs::write(root.path().join("docs/index.md"), "# Plain text").unwrap();
        assert!(load(root.path(), id).is_ok());
        change(root.path(), id, &json!({"delete":true})).unwrap();
        assert!(register(root.path(), &json!({"id":"../escape","source":png(1)})).is_err());
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct RecaptureItem {
    pub id: String,
    pub status: String,
    pub reason: Option<String>,
    pub revision: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct RecaptureRun {
    pub version: u32,
    pub id: String,
    pub created_at: String,
    pub items: Vec<RecaptureItem>,
}
fn run_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    valid_id(id)?;
    project_path(root, &format!(".munin/recaptures/{id}.json"))
}
fn save_run(root: &Path, run: &RecaptureRun) -> Result<(), String> {
    atomic(
        &run_path(root, &run.id)?,
        &serde_json::to_vec_pretty(run).map_err(|e| e.to_string())?,
    )
}
fn eligibility(root: &Path, shot: &Screenshot) -> Option<String> {
    if shot.protected {
        return Some("保護中".into());
    }
    if !shot.recipe["steps"].is_array() {
        return Some("撮影手順なし".into());
    }
    if let Some(steps) = shot.recipe["steps"].as_array() {
        for step in steps {
            if let Some(program) = step["launch"]["program"].as_str() {
                if crate::platform::application_executable_in(root, program).is_err() {
                    return Some(format!("起動アプリが見つかりません: {program}"));
                }
            }
        }
    }
    None
}
pub fn plan_recapture(root: &Path, id: Option<&str>) -> Result<Value, String> {
    let all = list(root)?;
    let mut items = Vec::new();
    for value in all["items"].as_array().ok_or("Invalid screenshots")? {
        let shot: Screenshot = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        if id.is_some_and(|id| id != shot.id) {
            continue;
        }
        let reason = eligibility(root, &shot);
        items.push(RecaptureItem {
            id: shot.id,
            status: if reason.is_some() {
                "skipped"
            } else {
                "pending"
            }
            .into(),
            reason,
            revision: None,
        });
    }
    Ok(json!({"items":items}))
}
pub fn recapture(root: &Path, options: &Value) -> Result<Value, String> {
    recapture_with(root, options, crate::scenario::capture_asset)
}
fn recapture_with<F>(root: &Path, options: &Value, mut capture: F) -> Result<Value, String>
where
    F: FnMut(&Path, &Value, &str) -> Result<Vec<u8>, String>,
{
    let _lock = workflow::resource_lock(root, ".munin/recaptures")?;
    let mut run: RecaptureRun = if let Some(id) = options["run"].as_str() {
        serde_json::from_slice(&fs::read(run_path(root, id)?).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
    } else {
        RecaptureRun {
            version: 1,
            id: new_id("run"),
            created_at: task::utc_now(),
            items: serde_json::from_value(
                plan_recapture(root, options["id"].as_str())?["items"].clone(),
            )
            .map_err(|e| e.to_string())?,
        }
    };
    if run.version != 1 {
        return Err("未対応の撮影履歴です。".into());
    }
    let failed_only = options["retry_failed"] == true;
    let failed_ids: std::collections::HashSet<_> = run
        .items
        .iter()
        .filter(|item| item.status == "failed")
        .map(|item| item.id.clone())
        .collect();
    for item in &mut run.items {
        if (!failed_only && (item.status == "running" || item.status == "cancelled"))
            || item.status == "failed" && failed_only
        {
            item.status = "pending".into();
        }
    }
    save_run(root, &run)?;
    let checkpoint = crate::agent::cancellation_checkpoint(root);
    for index in 0..run.items.len() {
        if run.items[index].status != "pending"
            || (failed_only && !failed_ids.contains(&run.items[index].id))
        {
            continue;
        }
        if crate::agent::check_cancelled(root, &checkpoint).is_err() {
            run.items[index].status = "cancelled".into();
            save_run(root, &run)?;
            break;
        }
        let id = run.items[index].id.clone();
        run.items[index].status = "running".into();
        save_run(root, &run)?;
        let result = (|| {
            let shot = load(root, &id)?;
            if let Some(reason) = eligibility(root, &shot) {
                return Err(reason);
            }
            let source = capture(root, &shot.recipe, &id)?;
            let previous = shot
                .adopted
                .as_deref()
                .and_then(|revision| shot.edits.iter().find(|edit| edit.id == revision));
            let image = image::load_from_memory(&source).map_err(|e| e.to_string())?;
            let mut render = source.clone();
            let mut scene = Value::Null;
            let mut crop = Value::Null;
            if let Some(previous) = previous {
                if previous.width == image.width()
                    && previous.height == image.height()
                    && !previous.scene.is_null()
                {
                    let mut background = image;
                    if !previous.crop.is_null() {
                        let old_render =
                            image::load_from_memory(&read_render(root, &shot, &previous.id)?)
                                .map_err(|e| e.to_string())?;
                        let x = previous.crop["offset_x"]
                            .as_f64()
                            .unwrap_or_default()
                            .max(0.0) as u32;
                        let y = previous.crop["offset_y"]
                            .as_f64()
                            .unwrap_or_default()
                            .max(0.0) as u32;
                        let width = previous.scene["canvas"]["width"]
                            .as_u64()
                            .map(|v| v as u32)
                            .unwrap_or(old_render.width());
                        let height = previous.scene["canvas"]["height"]
                            .as_u64()
                            .map(|v| v as u32)
                            .unwrap_or(old_render.height());
                        if x.saturating_add(width) > background.width()
                            || y.saturating_add(height) > background.height()
                        {
                            return Err(
                                "以前のクロップを再適用できません。MarkItsで再編集してください。"
                                    .into(),
                            );
                        }
                        background = background.crop_imm(x, y, width, height);
                        crop = previous.crop.clone();
                    }
                    let mut bytes = std::io::Cursor::new(Vec::new());
                    background
                        .write_to(&mut bytes, image::ImageFormat::Png)
                        .map_err(|e| e.to_string())?;
                    scene = previous.scene.clone();
                    render = markits::raster::render_composed_png_bytes(
                        &scene.to_string(),
                        &bytes.into_inner(),
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            register(
                root,
                &json!({"id":id,"source":data(&source),"render":data(&render),"scene":scene,"crop":crop,"requires_review":true,"adopt":false}),
            )
        })();
        match result {
            Ok(value) => {
                run.items[index].status = "succeeded".into();
                run.items[index].revision = value["revision"].as_str().map(str::to_owned);
                run.items[index].reason = None;
            }
            Err(reason) => {
                run.items[index].status =
                    if crate::agent::check_cancelled(root, &checkpoint).is_err() {
                        "cancelled"
                    } else {
                        "failed"
                    }
                    .into();
                run.items[index].reason = Some(reason);
            }
        }
        save_run(root, &run)?;
    }
    serde_json::to_value(run).map_err(|e| e.to_string())
}
pub fn recapture_history(root: &Path) -> Result<Value, String> {
    let home = project_path(root, ".munin/recaptures")?;
    let mut runs = Vec::<RecaptureRun>::new();
    if home.exists() {
        for entry in fs::read_dir(home).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().is_some_and(|s| s == "json") {
                runs.push(
                    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?,
                );
            }
        }
    }
    runs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(json!({"runs":runs}))
}

fn legacy_image(root: &Path, page: &Path, body: &str) -> Result<PathBuf, String> {
    let regex = regex::Regex::new(r"!\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)").unwrap();
    let url = regex
        .captures(body)
        .and_then(|c| c.get(1))
        .ok_or("旧撮影タグの画像がありません。")?
        .as_str();
    crate::quality::local_path(root, page, url)
}
fn recovered_legacy_source(bytes: &[u8]) -> (Vec<u8>, bool) {
    for key in ["markits:base_image", "markits:source_image"] {
        if let Some(source) = markits::raster::extract_png_text_chunk(bytes, key) {
            if let Ok(source) = decode(&source) {
                if key == "markits:source_image" {
                    if let Some(crop) =
                        markits::raster::extract_png_text_chunk(bytes, "markits:crop_info")
                            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                    {
                        if let Ok(image) = image::load_from_memory(&source) {
                            if crop["base_width"]
                                .as_u64()
                                .is_some_and(|width| width != image.width() as u64)
                                || crop["base_height"]
                                    .as_u64()
                                    .is_some_and(|height| height != image.height() as u64)
                            {
                                continue;
                            }
                        }
                    }
                }
                return (source, false);
            }
        }
    }
    (bytes.to_vec(), true)
}
pub fn migration_plan(root: &Path) -> Result<Value, String> {
    let mut pages = Vec::new();
    for (page, path) in task::collect_target_markdown_files(root, &crate::config::read_config(root))
    {
        let document = editor::read(root, &page)?;
        let tags = task::parse_page_tags(&page, &document.content, &mut Default::default())?;
        let mut candidates = Vec::new();
        for tag in tags {
            if let task::PageTag::Generated { task, body, .. } = tag {
                if task.kind != "screenshot" {
                    continue;
                }
                let result = legacy_image(root, &path, &body)
                    .and_then(|path| fs::read(path).map_err(|e| e.to_string()));
                let mut candidate =
                    json!({"id":task.id,"name":task.name,"protected":task.status=="approved"});
                match result {
                    Ok(bytes) => {
                        candidate["flattened"] = json!(recovered_legacy_source(&bytes).1);
                        candidate["image_sha256"] = json!(hash(&bytes));
                    }
                    Err(error) => {
                        candidate["error"] = json!(error);
                    }
                }
                candidates.push(candidate);
            }
        }
        if !candidates.is_empty() {
            pages.push(json!({"page":page,"revision":document.revision,"items":candidates}));
        }
    }
    Ok(json!({"pages":pages}))
}
pub fn migrate_page(root: &Path, page: &str, options: &Value) -> Result<Value, String> {
    let _lock = workflow::page_lock(root, page)?;
    let document = editor::read(root, page)?;
    if options["revision"].as_str() != Some(&document.revision) {
        return Err("移行候補の確認後に原稿が変更されています。候補を更新してください。".into());
    }
    let path = editor::document_path(root, page)?;
    let tags = task::parse_page_tags(page, &document.content, &mut Default::default())?;
    let sources = crate::capture_source::read(root)?;
    let mut replacements = Vec::new();
    let mut images = Vec::new();
    // Verify every input before writing any asset or document.
    for tag in &tags {
        if let task::PageTag::Generated {
            task, body, range, ..
        } = tag
        {
            if task.kind != "screenshot" {
                continue;
            }
            let bytes = fs::read(legacy_image(root, &path, body)?).map_err(|e| e.to_string())?;
            decode(&data(&bytes))?;
            let expected = options["items"]
                .as_array()
                .and_then(|items| items.iter().find(|item| item["id"] == task.id));
            if expected.and_then(|item| item["image_sha256"].as_str())
                != Some(hash(&bytes).as_str())
            {
                return Err("旧撮影画像が変更されています。移行候補を更新してください。".into());
            }
            images.push((task.clone(), range.clone(), bytes));
        }
    }
    if images.is_empty() {
        return Ok(json!({"migrated":0}));
    }
    let backup = project_path(
        root,
        &format!(
            ".munin/migrations/{}.md",
            hash(format!("{page}:{}", document.revision).as_bytes())
        ),
    )?;
    immutable(&backup, document.content.as_bytes())?;
    for (task, range, bytes) in images {
        let id = format!(
            "shot-{}",
            &hash(format!("{page}:{}", task.id).as_bytes())[..24]
        );
        let (source, flattened) = recovered_legacy_source(&bytes);
        let scene = if flattened {
            Value::Null
        } else {
            markits::raster::extract_png_text_chunk(&bytes, "markits:annotations")
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(Value::Null)
        };
        let crop = if flattened {
            Value::Null
        } else {
            markits::raster::extract_png_text_chunk(&bytes, "markits:crop_info")
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(Value::Null)
        };
        let recipe = match sources.get(&task.id) {
            Some(crate::capture_source::CaptureSource::Scenario { input }) => {
                serde_json::from_str::<Value>(&crate::scenario::load(root, input)?)
                    .map_err(|e| e.to_string())?
            }
            Some(crate::capture_source::CaptureSource::Window { title, inset }) => {
                json!({"version":1,"platform":"desktop","window":title,"steps":[{"window":title},{"screenshot":{"task":id,"inset":inset}}]})
            }
            _ => Value::Null,
        };
        if !directory(root, &id)?.join("manifest.json").exists() {
            register(
                root,
                &json!({"id":id,"source":data(&source),"render":data(&bytes),"scene":scene,"crop":crop,"name":task.name,"flattened":flattened,"recipe":recipe,"legacy":task.id}),
            )?;
            if task.status == "approved" {
                change(root, &id, &json!({"protected":true}))?;
            }
        }
        replacements.push((range, reference(root, &id, page)?));
        for tag in &tags {
            if let task::PageTag::Task { task: other, range } = tag {
                if other.id == task.id {
                    replacements.push((range.clone(), String::new()));
                }
            }
        }
    }
    replacements.sort_by(|a, b| b.0.start.cmp(&a.0.start));
    let count = replacements.len();
    let mut content = document.content;
    for (range, replacement) in replacements {
        content.replace_range(range, &replacement);
    }
    editor::save(root, page, &content, Some(&document.revision))?;
    Ok(json!({"migrated":count,"backup":backup.strip_prefix(root).unwrap_or(&backup)}))
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    fn png(color: u8) -> String {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            16,
            12,
            image::Rgba([color, 2, 3, 255]),
        ))
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
        data(bytes.get_ref())
    }
    #[test]
    fn interrupted_edit_save_and_adoption_can_resume() {
        let root = tempfile::tempdir().unwrap();
        let first = register(root.path(), &json!({"source":png(1)})).unwrap();
        let id = first["screenshot"]["id"].as_str().unwrap();
        let candidate =
            register(root.path(), &json!({"id":id,"source":png(2),"adopt":false})).unwrap();
        let mut shot = load(root.path(), id).unwrap();
        shot.edits.pop();
        save(root.path(), &shot).unwrap();
        let retry = register(root.path(), &json!({"id":id,"source":png(2),"adopt":false})).unwrap();
        assert_eq!(retry["revision"], candidate["revision"]);
        let mut shot = load(root.path(), id).unwrap();
        shot.adopting = candidate["revision"].as_str().map(str::to_owned);
        save(root.path(), &shot).unwrap();
        atomic(
            &project_path(root.path(), &shot.output).unwrap(),
            &read_render(root.path(), &shot, candidate["revision"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        let listed = list(root.path()).unwrap();
        assert_eq!(listed["items"][0]["adopted"], candidate["revision"]);
        assert!(listed["items"][0]["adopting"].is_null());
    }
    #[test]
    fn recapture_retry_skips_successes_and_keeps_adopted_pixels() {
        let root = tempfile::tempdir().unwrap();
        let recipe = json!({"version":1,"platform":"web","base_url":"http://localhost/","steps":[{"screenshot":{"task":"old"}}]});
        let first = register(root.path(), &json!({"source":png(1),"recipe":recipe})).unwrap();
        let a = first["screenshot"]["id"].as_str().unwrap();
        let second = register(root.path(), &json!({"source":png(2),"recipe":recipe})).unwrap();
        let b = second["screenshot"]["id"].as_str().unwrap();
        let before = image(root.path(), a, None, false).unwrap();
        let run = recapture_with(root.path(), &json!({}), |_, _, id| {
            if id == b {
                Err("failure".into())
            } else {
                decode(&png(3))
            }
        })
        .unwrap();
        assert_eq!(
            image(root.path(), a, None, false).unwrap()["data"],
            before["data"]
        );
        let mut called = Vec::new();
        let retry = recapture_with(
            root.path(),
            &json!({"run":run["id"],"retry_failed":true}),
            |_, _, id| {
                called.push(id.to_owned());
                decode(&png(4))
            },
        )
        .unwrap();
        assert_eq!(called, [b]);
        assert!(retry["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["status"] == "succeeded"));
        assert_eq!(
            recapture_history(root.path()).unwrap()["runs"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(image(root.path(), a, None, true).unwrap()["data"], png(1));
    }
    #[test]
    fn legacy_migration_is_reviewed_backed_up_and_idempotent() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs/assets")).unwrap();
        fs::write(
            root.path().join("docs/assets/old.png"),
            decode(&png(1)).unwrap(),
        )
        .unwrap();
        let old_history = json!({"id":"1","page":"index.md","created_at":"old","updated_at":"old","status":"partial","limits":{},"entries":[{"task":{"id":"legacy","kind":"screenshot","page":"index.md","prompt":"Capture","source_sha256":"old","status":"current"},"status":"failed","error":"old capture failed","attempts":1,"input":{},"references":{},"capture":{}}],"before":{},"after":{}});
        fs::create_dir_all(root.path().join(".munin/executions")).unwrap();
        fs::write(root.path().join(".munin/executions/1.json"),old_history.to_string()).unwrap();
        let source="<!-- ai:task id=legacy kind=screenshot prompt=\"Capture\" -->\n![image](assets/old.png)\n<!-- /ai:task -->\n";
        fs::write(root.path().join("docs/index.md"), source).unwrap();
        let plan = migration_plan(root.path()).unwrap();
        assert_eq!(plan["pages"][0]["items"][0]["flattened"], true);
        assert!(migrate_page(root.path(), "index.md", &json!({"revision":"stale"})).is_err());
        assert_eq!(
            fs::read_to_string(root.path().join("docs/index.md")).unwrap(),
            source
        );
        migrate_page(root.path(), "index.md", &plan["pages"][0]).unwrap();
        let document = editor::read(root.path(), "index.md").unwrap();
        assert!(document.content.contains("screenshot:ref"));
        assert!(!document.content.contains("ai:task"));
        assert!(migration_plan(root.path()).unwrap()["pages"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(
            migrate_page(
                root.path(),
                "index.md",
                &json!({"revision":document.revision})
            )
            .unwrap()["migrated"],
            0
        );
        assert_eq!(
            list(root.path()).unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(root.path().join("docs/assets/old.png").exists());
        assert_eq!(workflow::history(root.path(),None).unwrap()["runs"][0]["entries"][0]["task"]["name"], "");
        assert_eq!(fs::read_to_string(root.path().join(".munin/executions/1.json")).unwrap(),old_history.to_string());
        assert_eq!(crate::quality::check(root.path()).unwrap()["passed"],true);
    }
    #[test]
    fn legacy_migration_retains_full_base_crop_and_scene() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs/assets")).unwrap();
        let crop = json!({"offset_x":2,"offset_y":3,"base_width":16,"base_height":12});
        let scene = json!({"canvas":{"width":8,"height":6},"annotations":[]});
        let mut bytes = decode(&png(2)).unwrap();
        for (key, value) in [
            ("markits:base_image", png(1)),
            ("markits:crop_info", crop.to_string()),
            ("markits:annotations", scene.to_string()),
        ] {
            bytes = markits::raster::embed_png_text_chunk(&bytes, key, &value).unwrap();
        }
        fs::write(root.path().join("docs/assets/old.png"), bytes).unwrap();
        fs::write(root.path().join("docs/index.md"),"<!-- ai:task id=legacy kind=screenshot prompt=\"Capture\" -->\n![image](assets/old.png)\n<!-- /ai:task -->\n").unwrap();
        let plan = migration_plan(root.path()).unwrap();
        assert_eq!(plan["pages"][0]["items"][0]["flattened"], false);
        migrate_page(root.path(), "index.md", &plan["pages"][0]).unwrap();
        let items = list(root.path()).unwrap();
        let id = items["items"][0]["id"].as_str().unwrap();
        let shot = load(root.path(), id).unwrap();
        assert_eq!(shot.edits[0].crop, crop);
        assert_eq!(shot.edits[0].scene, scene);
        assert_eq!(image(root.path(), id, None, true).unwrap()["data"], png(1));
        fs::write(
            root.path().join("docs/index.md"),
            format!("![plain](assets/screenshots/{id}.png)"),
        )
        .unwrap();
        assert_eq!(
            list(root.path()).unwrap()["items"][0]["usage"][0],
            "index.md"
        );
        assert!(change(root.path(), id, &json!({"delete":true})).is_err());
    }
    #[test]
    fn older_revision_fields_default_and_unknown_versions_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let saved = register(root.path(),&json!({"source":png(1)})).unwrap();
        let id = saved["screenshot"]["id"].as_str().unwrap();
        let path = directory(root.path(),id).unwrap().join("manifest.json");
        let mut manifest = saved["screenshot"].clone();
        for field in ["flattened","requires_review","ui"] { manifest["edits"][0].as_object_mut().unwrap().remove(field); }
        manifest.as_object_mut().unwrap().remove("adopting");
        fs::write(&path,manifest.to_string()).unwrap();
        let read = load(root.path(),id).unwrap();
        assert!(!read.edits[0].requires_review);
        assert!(read.edits[0].ui.is_null());
        manifest["version"] = json!(99);
        fs::write(&path,manifest.to_string()).unwrap();
        assert!(load(root.path(),id).is_err());
    }
    #[test]
    fn moved_project_keeps_originals_and_managed_references() {
        let base = tempfile::tempdir().unwrap();
        let before = base.path().join("before");
        let after = base.path().join("after");
        fs::create_dir_all(before.join("docs")).unwrap();
        let created = register(&before, &json!({"source":png(1)})).unwrap();
        let id = created["screenshot"]["id"].as_str().unwrap();
        let reference_before = reference(&before, id, "index.md").unwrap();
        fs::write(before.join("docs/index.md"), &reference_before).unwrap();
        fs::rename(&before, &after).unwrap();
        assert_eq!(image(&after, id, None, true).unwrap()["data"], png(1));
        assert_eq!(reference(&after, id, "index.md").unwrap(), reference_before);
        assert_eq!(
            list(&after).unwrap()["items"][0]["usage"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn recapture_uses_scene_dimensions_for_scaled_exports() {
        let root = tempfile::tempdir().unwrap();
        let scene = json!({"canvas":{"width":8,"height":6},"annotations":[]});
        let recipe = json!({"version":1,"platform":"web","base_url":"http://localhost/","steps":[{"screenshot":{"task":"old"}}]});
        let created = register(root.path(), &json!({"source":png(1),"render":png(2),"scene":scene,"crop":{"offset_x":2,"offset_y":3,"base_width":16,"base_height":12},"recipe":recipe})).unwrap();
        let id = created["screenshot"]["id"].as_str().unwrap();
        let before = image(root.path(), id, None, false).unwrap();
        let run =
            recapture_with(root.path(), &json!({"id":id}), |_, _, _| decode(&png(3))).unwrap();
        assert_eq!(run["items"][0]["status"], "succeeded", "{run}");
        assert_eq!(image(root.path(), id, None, false).unwrap()["data"], before["data"]);
        let candidate = run["items"][0]["revision"].as_str().unwrap();
        let rendered = image(root.path(), id, Some(candidate), false).unwrap();
        let pixels =
            image::load_from_memory(&decode(rendered["data"].as_str().unwrap()).unwrap()).unwrap();
        assert_eq!((pixels.width(), pixels.height()), (8, 6));
    }
    #[test]
    fn cancelled_batch_resumes_only_unfinished_images() {
        let root = tempfile::tempdir().unwrap();
        let recipe = json!({"version":1,"platform":"web","base_url":"http://localhost/","steps":[{"screenshot":{"task":"old"}}]});
        for color in 1..=3 {
            register(root.path(), &json!({"source":png(color),"recipe":recipe})).unwrap();
        }
        let mut calls = 0;
        let run = recapture_with(root.path(), &json!({}), |root, _, _| {
            calls += 1;
            crate::agent::cancel(root)?;
            decode(&png(8))
        })
        .unwrap();
        assert_eq!(calls, 1);
        assert!(run["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["status"] == "cancelled"));
        let mut resumed = 0;
        let completed = recapture_with(root.path(), &json!({"run":run["id"]}), |_, _, _| {
            resumed += 1;
            decode(&png(9))
        })
        .unwrap();
        assert_eq!(resumed, 2);
        assert!(completed["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["status"] == "succeeded"));
    }
    #[test]
    fn failed_recapture_keeps_publication_ready_but_missing_asset_blocks_build() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs")).unwrap();
        let recipe = json!({"version":1,"platform":"web","base_url":"http://localhost/","steps":[{"screenshot":{"task":"old"}}]});
        let saved = register(root.path(),&json!({"source":png(1),"recipe":recipe})).unwrap();
        let id = saved["screenshot"]["id"].as_str().unwrap();
        fs::write(root.path().join("docs/index.md"),reference(root.path(),id,"index.md").unwrap()).unwrap();
        let run = recapture_with(root.path(),&json!({"id":id}),|_,_,_|Err("capture failed".into())).unwrap();
        assert_eq!(run["items"][0]["status"],"failed");
        assert_eq!(crate::quality::check(root.path()).unwrap()["passed"],true);
        crate::builder::build(&root.path().join("docs"),&root.path().join("generated"),&root.path().join("site"),false,Some(root.path())).unwrap();
        let shot = load(root.path(),id).unwrap();
        fs::remove_file(project_path(root.path(),&shot.output).unwrap()).unwrap();
        assert_eq!(crate::quality::check(root.path()).unwrap()["passed"],false);
        assert!(crate::builder::build(&root.path().join("docs"),&root.path().join("generated"),&root.path().join("site"),false,Some(root.path())).is_err());
    }
    #[test]
    fn public_render_has_no_original_or_scene_metadata() {
        let root = tempfile::tempdir().unwrap();
        let bytes = decode(&png(1)).unwrap();
        let private =
            markits::raster::embed_png_text_chunk(&bytes, "markits:source_image", &png(2)).unwrap();
        let result = register(
            root.path(),
            &json!({"source":png(1),"render":data(&private)}),
        )
        .unwrap();
        let shot = load(root.path(), result["screenshot"]["id"].as_str().unwrap()).unwrap();
        let public = fs::read(project_path(root.path(), &shot.output).unwrap()).unwrap();
        assert!(markits::raster::extract_png_text_chunk(&public, "markits:source_image").is_none());
    }
}
