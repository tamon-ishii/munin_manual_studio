//! Project-owned MarkIts sources and metadata-minimal document derivatives.
use crate::{config::project_path, resources, screenshots, workflow};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Write as _,
    path::{Path, PathBuf},
};

pub const ID_KEY: &str = "munin:resource-id";
const HOME: &str = ".munin/capture-resources";
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 100
        || !id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err("撮影リソースのIDが不正です。".into());
    }
    Ok(())
}
fn home(root: &Path, id: &str) -> Result<PathBuf, String> {
    valid(id)?;
    project_path(root, &format!("{HOME}/{id}"))
}
fn atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("保存先が不正です。")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(bytes).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
fn immutable(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path.exists() {
        if fs::read(path).map_err(|e| e.to_string())? != bytes {
            return Err("保存済み原本が変更されています。".into());
        }
        return Ok(());
    }
    atomic(path, bytes)
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Derived {
    pub id: String,
    pub path: String,
    pub revision: String,
    pub sha256: String,
    /// Editable integration PNG, kept private, independent of other variants.
    pub editing: String,
    #[serde(default)]
    pub protected: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Resource {
    pub version: u32,
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub revision: String,
    pub recorded: bool,
    pub derived: Vec<Derived>,
    #[serde(default)]
    pub pending: Option<String>,
}
fn save(root: &Path, r: &Resource) -> Result<(), String> {
    atomic(
        &home(root, &r.id)?.join("manifest.json"),
        &serde_json::to_vec_pretty(r).map_err(|e| e.to_string())?,
    )
}
pub fn load(root: &Path, id: &str) -> Result<Resource, String> {
    let path = home(root, id)?;
    if path.join("transaction.json").exists() {
        return Err("撮影画像の更新または回復が必要です。一覧を更新してください。".into());
    }
    let r: Resource =
        serde_json::from_slice(&fs::read(path.join("manifest.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if r.id != id || r.version != 1 {
        return Err("撮影リソースの形式が不正です。".into());
    }
    valid(&r.revision)?;
    for d in &r.derived {
        valid(&d.id)?;
        valid(&d.revision)?;
        project_path(root, &d.path)?;
        project_path(root, &d.editing)?;
    }
    Ok(r)
}
pub fn source(root: &Path, id: &str) -> Result<PathBuf, String> {
    let r = load(root, id)?;
    revision_path(root, id, &r.revision)
}
fn revision_path(root: &Path, id: &str, revision: &str) -> Result<PathBuf, String> {
    valid(revision)?;
    Ok(home(root, id)?.join(format!("revisions/{revision}.png")))
}
pub fn resource_id(bytes: &[u8]) -> Option<String> {
    let id = markits::raster::extract_png_text_chunk(bytes, ID_KEY)?;
    valid(&id).ok()?;
    Some(id)
}
/// Keep encoded pixel/color chunks intact. Drop all text and non-display payloads.
pub fn document_png(bytes: &[u8], id: Option<&str>) -> Result<Vec<u8>, String> {
    image::load_from_memory(bytes).map_err(|e| e.to_string())?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("PNG画像が必要です。".into());
    }
    let mut result = bytes[..8].to_vec();
    let mut offset = 8usize;
    let mut ended = false;
    while offset < bytes.len() {
        let header = bytes
            .get(offset..offset + 8)
            .ok_or("PNGチャンクが不正です。")?;
        let len = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
        let end = offset
            .checked_add(12)
            .and_then(|n| n.checked_add(len))
            .filter(|n| *n <= bytes.len())
            .ok_or("PNGサイズが不正です。")?;
        let kind = &header[4..8];
        let chunk = &bytes[offset..end];
        if markits::raster::crc32(&chunk[4..chunk.len() - 4])
            != u32::from_be_bytes(chunk[chunk.len() - 4..].try_into().unwrap())
        {
            return Err("PNG CRCが不正です。".into());
        }
        if matches!(
            kind,
            b"IHDR"
                | b"PLTE"
                | b"tRNS"
                | b"IDAT"
                | b"IEND"
                | b"sRGB"
                | b"gAMA"
                | b"cHRM"
                | b"iCCP"
                | b"pHYs"
                | b"sBIT"
        ) {
            result.extend_from_slice(chunk);
        }
        offset = end;
        if kind == b"IEND" {
            ended = true;
            break;
        }
    }
    if !ended || offset != bytes.len() {
        return Err("PNG終端が不正です。".into());
    }
    if let Some(id) = id {
        valid(id)?;
        result = markits::raster::embed_png_text_chunk(&result, ID_KEY, id)
            .map_err(|e| e.to_string())?;
    }
    Ok(result)
}
pub fn register(root: &Path, bytes: &[u8], name: &str) -> Result<Resource, String> {
    let _lock = workflow::resource_lock(root, HOME)?;
    document_png(bytes, None)?;
    let revision = hash(bytes);
    // A completed handoff can safely be retried without duplicate registration.
    for r in catalog(root)? {
        if r.revision == revision {
            return Ok(r);
        }
    }
    let id = screenshots::new_id("capture");
    immutable(&revision_path(root, &id, &revision)?, bytes)?;
    let r = Resource {
        version: 1,
        id,
        name: name.into(),
        created_at: crate::task::utc_now(),
        revision,
        recorded: markits::raster::extract_png_text_chunk(bytes, "markits:operations").is_some(),
        derived: vec![],
        pending: None,
    };
    save(root, &r)?;
    Ok(r)
}
pub fn catalog(root: &Path) -> Result<Vec<Resource>, String> {
    let dir = project_path(root, HOME)?;
    let mut result = vec![];
    if !dir.exists() {
        return Ok(result);
    }
    for item in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        if item.file_type().map_err(|e| e.to_string())?.is_dir() {
            let id = item.file_name().to_string_lossy().to_string();
            if item.path().join("transaction.json").exists() {
                let _lock = workflow::try_resource_lock(root, HOME)?
                    .ok_or("撮影画像を更新しています。完了後に一覧を更新してください。")?;
                recover(root, &item.path())?;
            }
            if item.path().join("manifest.json").exists() {
                result.push(load(root, &id)?);
            }
        }
    }
    result.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(result)
}
pub fn generate(
    root: &Path,
    id: &str,
    variant: Option<&str>,
    edited: Option<&[u8]>,
) -> Result<Derived, String> {
    let _lock = workflow::resource_lock(root, HOME)?;
    let mut r = load(root, id)?;
    if let Some(bytes) = edited {
        let suffix = format!("/{}.png", hash(bytes));
        if let Some(d) = r
            .derived
            .iter()
            .find(|d| d.editing.ends_with(&suffix) && d.revision == r.revision)
        {
            if fs::read(project_path(root, &d.path)?).is_ok_and(|b| hash(&b) == d.sha256) {
                return Ok(d.clone());
            }
        }
    }
    if edited.is_none() {
        if let Some(d) = r
            .derived
            .iter()
            .find(|d| variant.map_or(d.id == "default", |v| d.id == v))
        {
            if fs::read(project_path(root, &d.path)?)
                .map(|b| hash(&b) == d.sha256)
                .unwrap_or(false)
            {
                return Ok(d.clone());
            }
            return Err("生成画像が欠落または外部変更されています。".into());
        }
    }
    let derived_id = variant.map(str::to_owned).unwrap_or_else(|| {
        if edited.is_some() {
            screenshots::new_id("variant")
        } else {
            "default".into()
        }
    });
    valid(&derived_id)?;
    if r.derived.iter().any(|d| d.id == derived_id) {
        return Err("派生画像は既に存在します。".into());
    }
    let bytes = match edited {
        Some(b) => b.to_vec(),
        None => fs::read(source(root, id)?).map_err(|e| e.to_string())?,
    };
    let png = document_png(&bytes, Some(id))?;
    let assets = crate::config::read_config(root).assets;
    let path = format!(
        "{}/captures/{id}/{derived_id}.png",
        assets.trim_end_matches('/')
    );
    let editing = format!("{HOME}/{id}/variants/{derived_id}/{}.png", hash(&bytes));
    immutable(&project_path(root, &editing)?, &bytes)?;
    let d = Derived {
        id: derived_id,
        path,
        editing,
        revision: r.revision.clone(),
        sha256: hash(&png),
        protected: false,
    };
    immutable(&project_path(root, &d.path)?, &png)?;
    r.derived.push(d.clone());
    save(root, &r)?;
    Ok(d)
}
pub fn editing_source(root: &Path, path: &str) -> Result<Option<PathBuf>, String> {
    let bytes = resources::image_bytes(root, path)?;
    let Some(id) = resource_id(&bytes) else {
        return Ok(None);
    };
    let r = load(root, &id)?;
    let digest = hash(&bytes);
    let d = if let Some(d) = r.derived.iter().find(|d| d.path == path) {
        d
    } else {
        let mut matches = r.derived.iter().filter(|d| d.sha256 == digest);
        let d = matches.next().ok_or("派生の編集状態が見つかりません。")?;
        if matches.any(|other| other.editing != d.editing) {
            return Err(
                "一致する編集状態が複数あります。一覧から派生画像を選択してください。".into(),
            );
        }
        d
    };
    Ok(Some(project_path(root, &d.editing)?))
}
/// All Studio insertion routes use this before exposing a path to Markdown.
pub fn resolve(root: &Path, path: &str) -> Result<String, String> {
    let bytes = resources::image_bytes(root, path)?;
    if let Some(id) = resource_id(&bytes) {
        load(root, &id)?;
        return Ok(path.into());
    }
    if !has_private_metadata(&bytes) {
        return Ok(path.into());
    }
    let r = register(
        root,
        &bytes,
        Path::new(path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("撮影画像"),
    )?;
    Ok(generate(root, &r.id, None, None)?.path)
}
pub fn has_private_metadata(bytes: &[u8]) -> bool {
    [
        "markits:operations",
        "markits:annotations",
        "markits:source_image",
        "markits:base_image",
        "markits:ui_elements",
        "markits:crop_info",
        "markits:operation_group",
        "markits:capture_target",
    ]
    .iter()
    .any(|key| markits::raster::extract_png_text_chunk(bytes, key).is_some())
}
pub fn list(root: &Path) -> Result<Value, String> {
    let usage = resources::usages(root)?;
    let mut identities: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for (path, refs) in &usage {
        if let Ok(bytes) = resources::image_bytes(root, path) {
            if let Some(id) = resource_id(&bytes) {
                for reference in refs {
                    let mut v = reference.clone();
                    v["path"] = json!(path);
                    identities.entry(id.clone()).or_default().push(v);
                }
            }
        }
    }
    let mut items = vec![];
    for r in catalog(root)? {
        let mut v = serde_json::to_value(&r).map_err(|e| e.to_string())?;
        v["missing"] = json!(!revision_path(root, &r.id, &r.revision)?.is_file());
        v["usages"] = json!(identities.get(&r.id).cloned().unwrap_or_default());
        items.push(v);
    }
    Ok(json!({"items":items}))
}
pub fn thumbnail(root: &Path, id: &str, pending: bool) -> Result<String, String> {
    let path = if pending {
        let r = load(root, id)?;
        revision_path(root, id, r.pending.as_deref().ok_or("候補がありません。")?)?
    } else {
        source(root, id)?
    };
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let image = image::load_from_memory(&bytes)
        .map_err(|e| e.to_string())?
        .thumbnail(320, 200);
    let mut out = std::io::Cursor::new(vec![]);
    image
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(out.into_inner())
    ))
}

#[derive(Serialize, Deserialize)]
struct Write {
    path: String,
    before: Option<String>,
    after: String,
}
#[derive(Serialize, Deserialize)]
struct Transaction {
    old: Resource,
    next: Resource,
    writes: Vec<Write>,
}
fn commit(
    root: &Path,
    old: Resource,
    next: Resource,
    writes: Vec<(String, Vec<u8>)>,
) -> Result<(), String> {
    let dir = home(root, &old.id)?;
    let mut changes = vec![];
    for (path, bytes) in writes {
        let dest = project_path(root, &path)?;
        let before = fs::read(&dest).ok().map(|b| STANDARD.encode(b));
        changes.push(Write {
            path,
            before,
            after: STANDARD.encode(bytes),
        });
    }
    let tx = Transaction {
        old,
        next,
        writes: changes,
    };
    atomic(
        &dir.join("transaction.json"),
        &serde_json::to_vec(&tx).map_err(|e| e.to_string())?,
    )?;
    for w in &tx.writes {
        if let Some(before) = &w.before {
            immutable(
                &dir.join(format!("backups/{}.png", hash(before.as_bytes()))),
                &STANDARD.decode(before).map_err(|e| e.to_string())?,
            )?;
        }
        let current = fs::read(project_path(root, &w.path)?)
            .ok()
            .map(|b| STANDARD.encode(b));
        if current != w.before {
            return Err("画像が外部変更されました。更新を中断しました。".into());
        }
        atomic(
            &project_path(root, &w.path)?,
            &STANDARD.decode(&w.after).map_err(|e| e.to_string())?,
        )?;
    }
    save(root, &tx.next)?;
    fs::remove_file(dir.join("transaction.json")).map_err(|e| e.to_string())?;
    Ok(())
}
fn recover(root: &Path, dir: &Path) -> Result<(), String> {
    let file = dir.join("transaction.json");
    if !file.exists() {
        return Ok(());
    }
    let tx: Transaction = serde_json::from_slice(&fs::read(&file).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    // Roll back only our writes. Never overwrite an unrelated external modification.
    for w in &tx.writes {
        let path = project_path(root, &w.path)?;
        let current = fs::read(&path).ok().map(|b| STANDARD.encode(b));
        if current == w.before {
            continue;
        }
        if current.as_ref() != Some(&w.after) {
            return Err(
                "更新回復中に外部変更を検出しました。バックアップを確認してください。".into(),
            );
        }
        if let Some(before) = &w.before {
            atomic(&path, &STANDARD.decode(before).map_err(|e| e.to_string())?)?;
        } else {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    save(root, &tx.old)?;
    fs::remove_file(file).map_err(|e| e.to_string())?;
    Ok(())
}
/// Native MarkIts prepares each edited integration PNG from the new original.
pub fn update(
    root: &Path,
    id: &str,
    expected: &str,
    original: &[u8],
    variants: Vec<(String, Vec<u8>)>,
    review: bool,
) -> Result<Resource, String> {
    let _lock = workflow::resource_lock(root, HOME)?;
    let old = load(root, id)?;
    if old.revision != expected {
        return Err("撮影リソースが変更されました。".into());
    }
    let revision = hash(original);
    document_png(original, None)?;
    immutable(&revision_path(root, id, &revision)?, original)?;
    let mut next = old.clone();
    if review {
        next.pending = Some(revision);
        save(root, &next)?;
        return Ok(next);
    }
    let usage = resources::usages(root)?;
    let observed: Vec<(String, String)> = usage
        .keys()
        .filter_map(|path| {
            let bytes = resources::image_bytes(root, path).ok()?;
            (resource_id(&bytes).as_deref() == Some(id)).then(|| (path.clone(), hash(&bytes)))
        })
        .collect();
    let known_paths: std::collections::BTreeSet<_> =
        old.derived.iter().map(|d| d.path.clone()).collect();
    let mut hash_counts: BTreeMap<String, usize> = BTreeMap::new();
    for d in &old.derived {
        *hash_counts.entry(d.sha256.clone()).or_default() += 1;
    }
    let mut writes = vec![];
    for d in &mut next.derived {
        if d.protected {
            continue;
        }
        let png = variants
            .iter()
            .find(|(v, _)| v == &d.id)
            .ok_or("派生画像の生成が完了していません。")?;
        match fs::read(project_path(root, &d.path)?) {
            Ok(bytes) if hash(&bytes) == d.sha256 => {}
            Ok(_) => return Err(format!("画像が外部変更されています: {}", d.path)),
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound && hash_counts[&d.sha256] == 1 =>
            {
                d.path = observed
                    .iter()
                    .find(|(path, digest)| digest == &d.sha256 && !known_paths.contains(path))
                    .map(|(path, _)| path.clone())
                    .ok_or("生成画像が見つかりません。")?;
            }
            Err(error) => return Err(error.to_string()),
        }
        let public = document_png(&png.1, Some(id))?;
        let editing = format!("{HOME}/{id}/variants/{}/{}.png", d.id, hash(&png.1));
        immutable(&project_path(root, &editing)?, &png.1)?;
        writes.push((d.path.clone(), public.clone()));
        // Adopt only copies whose exact bytes still match this variant.
        for (path, digest) in &observed {
            if hash_counts[&d.sha256] == 1
                && !known_paths.contains(path)
                && digest == &d.sha256
                && !writes.iter().any(|(p, _)| p == path)
            {
                writes.push((path.clone(), public.clone()));
            }
        }
        d.editing = editing;
        d.revision = revision.clone();
        d.sha256 = hash(&public);
    }
    next.revision = revision;
    next.pending = None;
    next.recorded =
        markits::raster::extract_png_text_chunk(original, "markits:operations").is_some();
    commit(root, old, next.clone(), writes)?;
    Ok(next)
}
pub fn migrate(root: &Path, path: &str) -> Result<Resource, String> {
    let bytes = resources::image_bytes(root, path)?;
    if let Some(id) = resource_id(&bytes) {
        return load(root, &id);
    }
    if !has_private_metadata(&bytes) {
        return Err("MarkItsのメタデータがありません。".into());
    }
    let r = register(root, &bytes, "取り込み画像")?;
    let _lock = workflow::resource_lock(root, HOME)?;
    if resources::image_bytes(root, path)? != bytes {
        return Err("変換対象が外部変更されています。".into());
    }
    let mut next = r.clone();
    let public = document_png(&bytes, Some(&r.id))?;
    if !next.derived.iter().any(|d| d.path == path) {
        next.derived.push(Derived {
            id: screenshots::new_id("import"),
            path: path.into(),
            revision: r.revision.clone(),
            sha256: hash(&public),
            editing: format!("{HOME}/{}/revisions/{}.png", r.id, r.revision),
            protected: false,
        });
    }
    commit(root, r, next.clone(), vec![(path.into(), public)])?;
    Ok(next)
}

/// File uploads keep their chosen public path but never expose MarkIts payloads.
pub fn store_upload(root: &Path, path: &str, bytes: &[u8]) -> Result<(), String> {
    let r = register(root, bytes, "取り込み画像")?;
    let _lock = workflow::resource_lock(root, HOME)?;
    let old = load(root, &r.id)?;
    let mut next = old.clone();
    let public = document_png(bytes, Some(&r.id))?;
    if next.derived.iter().any(|d| d.path == path) {
        return Err("登録済みの画像を上書きできません。".into());
    }
    next.derived.push(Derived {
        id: screenshots::new_id("upload"),
        path: path.into(),
        revision: r.revision.clone(),
        sha256: hash(&public),
        editing: format!("{HOME}/{}/revisions/{}.png", r.id, r.revision),
        protected: false,
    });
    commit(root, old, next, vec![(path.into(), public)])
}
pub fn restore_migration(root: &Path, path: &str) -> Result<Resource, String> {
    let _lock = workflow::resource_lock(root, HOME)?;
    let bytes = resources::image_bytes(root, path)?;
    let id = resource_id(&bytes).ok_or("管理画像ではありません。")?;
    let old = load(root, &id)?;
    let d = old
        .derived
        .iter()
        .find(|d| d.path == path && d.id.starts_with("import-"))
        .ok_or("変換済み画像ではありません。")?;
    if hash(&bytes) != d.sha256 {
        return Err("変換後の画像が変更されています。".into());
    }
    let original = fs::read(project_path(root, &d.editing)?).map_err(|e| e.to_string())?;
    if document_png(&original, Some(&id))? != bytes {
        return Err("復元元が変更されています。".into());
    }
    let mut next = old.clone();
    next.derived.retain(|v| v.path != path);
    commit(root, old, next.clone(), vec![(path.into(), original)])?;
    Ok(next)
}
pub fn rpc(root: &Path, action: &str, options: &Value) -> Result<String, String> {
    let id = options["id"].as_str().unwrap_or_default();
    let result = match action {
        "capture-resources-migration-list" => {
            let all = resources::list(root)?;
            json!({"items":all["items"].as_array().into_iter().flatten().filter(|v|v["path"].as_str().is_some_and(|path|resources::image_bytes(root,path).is_ok_and(|bytes|has_private_metadata(&bytes)))).collect::<Vec<_>>()})
        }
        "capture-resources-list" => list(root)?,
        "capture-resources-thumbnail" => return thumbnail(root, id, options["pending"] == true),
        "capture-resources-generate" => {
            json!(generate(root, id, options["variant"].as_str(), None)?)
        }
        "capture-resources-resolve" => {
            json!({"path":resolve(root,options["path"].as_str().ok_or("画像を選択してください。")?)?})
        }
        "capture-resources-migrate" => json!(migrate(
            root,
            options["path"].as_str().ok_or("画像を選択してください。")?
        )?),
        "capture-resources-restore-migration" => json!(restore_migration(
            root,
            options["path"].as_str().ok_or("画像を選択してください。")?
        )?),
        "capture-resources-register" => {
            let raw = options["source"]
                .as_str()
                .ok_or("PNG画像を指定してください。")?;
            let bytes = STANDARD
                .decode(raw.split_once(',').map_or(raw, |(_, b)| b))
                .map_err(|e| e.to_string())?;
            json!(register(
                root,
                &bytes,
                options["name"].as_str().unwrap_or("撮影画像")
            )?)
        }
        _ => return Err("不明な撮影リソース操作です。".into()),
    };
    Ok(result.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uploaded_markits_images_are_registered_and_public_path_has_only_id() {
        let root = tempfile::tempdir().unwrap();
        let bytes = private(1);
        let saved =
            crate::editor::save_asset(root.path(), "assets/upload.png", &STANDARD.encode(&bytes))
                .unwrap();
        assert_eq!(saved.path, "assets/upload.png");
        let public = fs::read(root.path().join(&saved.path)).unwrap();
        let id = resource_id(&public).unwrap();
        assert!(!has_private_metadata(&public));
        assert_eq!(fs::read(source(root.path(), &id).unwrap()).unwrap(), bytes);
        assert_eq!(load(root.path(), &id).unwrap().derived[0].path, saved.path);
        assert_eq!(
            document_png(&bytes, None).unwrap(),
            document_png(&public, None).unwrap()
        );
    }
    #[test]
    fn renamed_document_images_update_at_their_current_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let r = register(root, &private(1), "").unwrap();
        let d = generate(root, &r.id, None, None).unwrap();
        fs::rename(
            project_path(root, &d.path).unwrap(),
            root.join("renamed.png"),
        )
        .unwrap();
        fs::write(root.join("usage.md"), "![image](renamed.png)").unwrap();
        let updated = update(
            root,
            &r.id,
            &r.revision,
            &private(2),
            vec![(d.id, private(2))],
            false,
        )
        .unwrap();
        assert_eq!(updated.derived[0].path, "renamed.png");
        assert!(!project_path(root, &d.path).unwrap().exists());
        assert_eq!(
            document_png(&fs::read(root.join("renamed.png")).unwrap(), None).unwrap(),
            document_png(&private(2), None).unwrap()
        );
    }
    fn png(value: u8) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(8, 6, image::Rgba([value, 0, 0, 255]));
        let mut c = std::io::Cursor::new(vec![]);
        img.write_to(&mut c, image::ImageFormat::Png).unwrap();
        c.into_inner()
    }
    fn private(value: u8) -> Vec<u8> {
        let mut b = png(value);
        for key in [
            "markits:operations",
            "markits:annotations",
            "markits:source_image",
            "markits:ui_elements",
            "other",
        ] {
            b = markits::raster::embed_png_text_chunk(&b, key, "private secret").unwrap();
        }
        b
    }
    #[test]
    fn registration_survives_restart_and_retry_and_is_project_owned() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let bytes = private(1);
        let r = register(a.path(), &bytes, "test").unwrap();
        assert_eq!(register(a.path(), &bytes, "again").unwrap().id, r.id);
        assert_eq!(fs::read(source(a.path(), &r.id).unwrap()).unwrap(), bytes);
        assert_eq!(load(a.path(), &r.id).unwrap().revision, r.revision);
        assert!(load(b.path(), &r.id).is_err());
        assert!(load(a.path(), "../escape").is_err());
        assert_ne!(register(b.path(), &bytes, "").unwrap().id, r.id);
    }
    #[test]
    fn public_png_keeps_pixels_and_only_identity() {
        let b = private(7);
        let clean = document_png(&b, Some("capture-test")).unwrap();
        assert_eq!(resource_id(&clean).as_deref(), Some("capture-test"));
        assert!(!has_private_metadata(&clean));
        assert!(markits::raster::extract_png_text_chunk(&clean, "other").is_none());
        assert_eq!(
            image::load_from_memory(&b).unwrap().to_rgba8(),
            image::load_from_memory(&clean).unwrap().to_rgba8()
        );
        assert_eq!(
            document_png(&b, None).unwrap(),
            document_png(&clean, None).unwrap()
        );
        let mut bad = b.clone();
        bad[29] ^= 1;
        assert!(document_png(&bad, None).is_err());
    }
    #[test]
    fn independent_variants_and_conflict_safe_update() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let r = register(root, &private(1), "").unwrap();
        let d = generate(root, &r.id, None, None).unwrap();
        assert_eq!(generate(root, &r.id, None, None).unwrap().path, d.path);
        let v = generate(root, &r.id, None, Some(&private(2))).unwrap();
        assert_ne!(d.path, v.path);
        let updated = update(
            root,
            &r.id,
            &r.revision,
            &private(3),
            vec![(d.id.clone(), private(4)), (v.id.clone(), private(5))],
            false,
        )
        .unwrap();
        assert_eq!(updated.id, r.id);
        assert_eq!(
            fs::read(revision_path(root, &r.id, &r.revision).unwrap()).unwrap(),
            private(1)
        );
        assert_eq!(
            resource_id(&fs::read(project_path(root, &d.path).unwrap()).unwrap()).unwrap(),
            r.id
        );
        fs::write(project_path(root, &d.path).unwrap(), png(9)).unwrap();
        assert!(update(
            root,
            &r.id,
            &updated.revision,
            &private(6),
            vec![(d.id, private(6)), (v.id, private(6))],
            false
        )
        .is_err());
        assert_eq!(
            fs::read(project_path(root, &d.path).unwrap()).unwrap(),
            png(9)
        );
    }
    #[test]
    fn migration_is_repeatable_and_keeps_backup() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("old.png"), private(1)).unwrap();
        let r = migrate(root, "old.png").unwrap();
        assert_eq!(migrate(root, "old.png").unwrap().id, r.id);
        assert_eq!(fs::read(source(root, &r.id).unwrap()).unwrap(), private(1));
        assert!(!has_private_metadata(
            &fs::read(root.join("old.png")).unwrap()
        ));
        assert!(home(root, &r.id).unwrap().join("backups").is_dir());
    }
    #[test]
    fn interrupted_commit_recovers_without_rolling_back_an_active_writer() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let r = register(root, &private(1), "").unwrap();
        let d = generate(root, &r.id, None, None).unwrap();
        let r = load(root, &r.id).unwrap();
        let before = fs::read(project_path(root, &d.path).unwrap()).unwrap();
        let after = document_png(&private(2), Some(&r.id)).unwrap();
        let tx = Transaction {
            old: r.clone(),
            next: r.clone(),
            writes: vec![Write {
                path: d.path.clone(),
                before: Some(STANDARD.encode(&before)),
                after: STANDARD.encode(&after),
            }],
        };
        let journal = home(root, &r.id).unwrap().join("transaction.json");
        atomic(&journal, &serde_json::to_vec(&tx).unwrap()).unwrap();
        atomic(&project_path(root, &d.path).unwrap(), &after).unwrap();
        {
            let _active = workflow::resource_lock(root, HOME).unwrap();
            assert!(catalog(root).is_err());
            assert_eq!(
                fs::read(project_path(root, &d.path).unwrap()).unwrap(),
                after
            );
        }
        assert_eq!(catalog(root).unwrap().len(), 1);
        assert!(!journal.exists());
        assert_eq!(
            fs::read(project_path(root, &d.path).unwrap()).unwrap(),
            before
        );
        atomic(&journal, &serde_json::to_vec(&tx).unwrap()).unwrap();
        atomic(&project_path(root, &d.path).unwrap(), &png(9)).unwrap();
        assert!(catalog(root).is_err());
        assert_eq!(
            fs::read(project_path(root, &d.path).unwrap()).unwrap(),
            png(9)
        );
    }
    #[test]
    fn migration_restore_verifies_both_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let bytes = private(1);
        fs::write(root.join("old.png"), &bytes).unwrap();
        migrate(root, "old.png").unwrap();
        restore_migration(root, "old.png").unwrap();
        assert_eq!(fs::read(root.join("old.png")).unwrap(), bytes);
        migrate(root, "old.png").unwrap();
        fs::write(root.join("old.png"), png(9)).unwrap();
        assert!(restore_migration(root, "old.png").is_err());
    }
    #[test]
    fn identity_usages_copies_review_and_failed_generation() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let r = register(root, &private(1), "").unwrap();
        let d = generate(root, &r.id, None, None).unwrap();
        let original = fs::read(project_path(root, &d.path).unwrap()).unwrap();
        fs::write(root.join("renamed.png"), &original).unwrap();
        fs::write(
            root.join("outside.md"),
            format!("日本語\n![copy](renamed.png)\n```md\n![example](renamed.png)\n```\n"),
        )
        .unwrap();
        let listed = list(root).unwrap();
        assert_eq!(listed["items"][0]["usages"].as_array().unwrap().len(), 1);
        assert_eq!(
            editing_source(root, "renamed.png").unwrap(),
            Some(project_path(root, &d.editing).unwrap())
        );
        let reviewed = update(root, &r.id, &r.revision, &private(2), vec![], true).unwrap();
        assert!(reviewed.pending.is_some());
        assert_eq!(
            fs::read(project_path(root, &d.path).unwrap()).unwrap(),
            original
        );
        assert!(update(
            root,
            &r.id,
            &r.revision,
            &private(3),
            vec![(d.id.clone(), b"invalid".to_vec())],
            false
        )
        .is_err());
        assert_eq!(
            fs::read(project_path(root, &d.path).unwrap()).unwrap(),
            original
        );
        update(
            root,
            &r.id,
            &r.revision,
            &private(2),
            vec![(d.id, private(2))],
            false,
        )
        .unwrap();
        assert_ne!(fs::read(root.join("renamed.png")).unwrap(), original);
    }
}
