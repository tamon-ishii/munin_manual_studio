//! Track and selectively accept/revert external Markdown edits made during AI terminal sessions.
use crate::{
    config::{project_path, read_config},
    task,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write as _,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const SNAPSHOT_DIR: &str = ".munin/terminal-snapshots";
const MAX_SNAPSHOTS: usize = 5;
const MAX_FILE_BYTES: usize = 512 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SnapshotEntry {
    sha256: String,
    content: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SnapshotFile {
    version: u32,
    id: String,
    created_at_ms: u128,
    files: BTreeMap<String, SnapshotEntry>,
}

fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("スナップショットIDが不正です。".into());
    }
    Ok(())
}

fn snapshot_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    valid_id(id)?;
    project_path(root, &format!("{SNAPSHOT_DIR}/{id}.json"))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("保存先が不正です。")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    temp.write_all(bytes).map_err(|error| error.to_string())?;
    temp.as_file().sync_all().map_err(|error| error.to_string())?;
    temp.persist(path).map_err(|error| error.to_string())?;
    Ok(())
}

fn collect_markdown_map(root: &Path) -> Result<BTreeMap<String, SnapshotEntry>, String> {
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let config = read_config(root);
    let files = task::collect_target_markdown_files(root, &config);
    let mut map = BTreeMap::new();
    for (page, path) in files {
        let Ok(bytes) = fs::read(&path) else { continue };
        if bytes.len() > MAX_FILE_BYTES {
            continue;
        }
        let Ok(content) = String::from_utf8(bytes) else {
            continue;
        };
        let normalized = content.replace("\r\n", "\n");
        let sha256 = hash_bytes(normalized.as_bytes());
        let rel_page = path
            .canonicalize()
            .ok()
            .and_then(|p| p.strip_prefix(&canonical_root).ok().map(Path::to_path_buf))
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or(page);
        map.insert(
            rel_page,
            SnapshotEntry {
                sha256,
                content: normalized,
            },
        );
    }
    Ok(map)
}

fn prune_old_snapshots(root: &Path) {
    let Ok(dir) = project_path(root, SNAPSHOT_DIR) else {
        return;
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let mut files: Vec<(u128, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "json"))
        .map(|e| {
            let modified = e
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0);
            (modified, e.path())
        })
        .collect();
    if files.len() <= MAX_SNAPSHOTS {
        return;
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in files.into_iter().skip(MAX_SNAPSHOTS) {
        let _ = fs::remove_file(path);
    }
}

pub fn create(root: &Path) -> Result<Value, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let id = format!("snap-{now}-{}", std::process::id());
    let files = collect_markdown_map(root)?;
    let count = files.len();
    let snapshot = SnapshotFile {
        version: 1,
        id: id.clone(),
        created_at_ms: now,
        files,
    };
    let path = snapshot_path(root, &id)?;
    let bytes = serde_json::to_vec(&snapshot).map_err(|error| error.to_string())?;
    atomic_write(&path, &bytes)?;
    prune_old_snapshots(root);
    Ok(json!({
        "session_id": id,
        "file_count": count,
        "created_at_ms": now
    }))
}

fn load_snapshot(root: &Path, id: &str) -> Result<SnapshotFile, String> {
    let path = snapshot_path(root, id)?;
    let bytes = fs::read(&path).map_err(|_| "外部変更スナップショットが見つかりません。".to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| format!("スナップショットを読み込めません: {error}"))
}

fn count_line_delta(before: &str, after: &str) -> (usize, usize) {
    let old_lines: Vec<&str> = if before.is_empty() {
        vec![]
    } else {
        before.lines().collect()
    };
    let new_lines: Vec<&str> = if after.is_empty() {
        vec![]
    } else {
        after.lines().collect()
    };
    let mut old_counts: BTreeMap<&str, usize> = BTreeMap::new();
    for line in &old_lines {
        *old_counts.entry(*line).or_insert(0) += 1;
    }
    let mut added = 0usize;
    for line in &new_lines {
        if let Some(count) = old_counts.get_mut(line) {
            if *count > 0 {
                *count -= 1;
                continue;
            }
        }
        added += 1;
    }
    let removed: usize = old_counts.values().sum();
    (added, removed)
}

pub fn diff(root: &Path, id: &str) -> Result<Value, String> {
    let snapshot = load_snapshot(root, id)?;
    let current = collect_markdown_map(root)?;
    let all_pages: BTreeSet<&String> = snapshot.files.keys().chain(current.keys()).collect();
    let mut changes = Vec::new();
    for page in all_pages {
        match (snapshot.files.get(page), current.get(page)) {
            (Some(before), Some(after)) if before.sha256 != after.sha256 => {
                let (added_lines, removed_lines) = count_line_delta(&before.content, &after.content);
                changes.push(json!({
                    "page": page,
                    "status": "modified",
                    "before": before.content,
                    "after": after.content,
                    "base_sha256": before.sha256,
                    "current_sha256": after.sha256,
                    "added_lines": added_lines,
                    "removed_lines": removed_lines
                }));
            }
            (None, Some(after)) => {
                let (added_lines, _) = count_line_delta("", &after.content);
                changes.push(json!({
                    "page": page,
                    "status": "added",
                    "before": "",
                    "after": after.content,
                    "base_sha256": "",
                    "current_sha256": after.sha256,
                    "added_lines": added_lines,
                    "removed_lines": 0
                }));
            }
            (Some(before), None) => {
                let (_, removed_lines) = count_line_delta(&before.content, "");
                changes.push(json!({
                    "page": page,
                    "status": "deleted",
                    "before": before.content,
                    "after": "",
                    "base_sha256": before.sha256,
                    "current_sha256": "",
                    "added_lines": 0,
                    "removed_lines": removed_lines
                }));
            }
            _ => {}
        }
    }
    Ok(json!({
        "session_id": snapshot.id,
        "changes": changes
    }))
}

pub fn apply(
    root: &Path,
    id: &str,
    page: &str,
    expected_sha256: &str,
    content: Option<&str>,
) -> Result<Value, String> {
    let mut snapshot = load_snapshot(root, id)?;
    let file_path = project_path(root, page)?;
    if file_path.extension().and_then(|ext| ext.to_str()) != Some("md") {
        return Err("Markdownファイル以外は変更トレーから操作できません。".into());
    }
    let current_sha = match fs::read(&file_path) {
        Ok(bytes) => {
            let text = String::from_utf8(bytes)
                .map_err(|_| "UTF-8ではないファイルは操作できません。".to_string())?
                .replace("\r\n", "\n");
            hash_bytes(text.as_bytes())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.to_string()),
    };
    if current_sha != expected_sha256 {
        return Err("ファイルがさらに変更されました。一覧を更新してからやり直してください。".into());
    }

    match content {
        Some(next) => {
            let normalized = next.replace("\r\n", "\n");
            atomic_write(&file_path, normalized.as_bytes())?;
            let new_sha = hash_bytes(normalized.as_bytes());
            snapshot.files.insert(
                page.to_string(),
                SnapshotEntry {
                    sha256: new_sha.clone(),
                    content: normalized.clone(),
                },
            );
            let snap_path = snapshot_path(root, id)?;
            let bytes = serde_json::to_vec(&snapshot).map_err(|error| error.to_string())?;
            atomic_write(&snap_path, &bytes)?;
            Ok(json!({
                "page": page,
                "applied": true,
                "deleted": false,
                "sha256": new_sha,
                "content": normalized
            }))
        }
        None => {
            if file_path.exists() {
                fs::remove_file(&file_path).map_err(|error| error.to_string())?;
            }
            snapshot.files.remove(page);
            let snap_path = snapshot_path(root, id)?;
            let bytes = serde_json::to_vec(&snapshot).map_err(|error| error.to_string())?;
            atomic_write(&snap_path, &bytes)?;
            Ok(json!({
                "page": page,
                "applied": true,
                "deleted": true,
                "sha256": ""
            }))
        }
    }
}

pub fn clear(root: &Path, id: &str) -> Result<Value, String> {
    let path = snapshot_path(root, id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    Ok(json!({"cleared": true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_added_modified_deleted_and_guards_sha256() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs")).unwrap();
        fs::write(root.path().join("docs/a.md"), "# A\nOriginal\n").unwrap();
        fs::write(root.path().join("docs/b.md"), "# B\nKeep\n").unwrap();

        let created = create(root.path()).unwrap();
        let id = created["session_id"].as_str().unwrap();

        fs::write(root.path().join("docs/a.md"), "# A\nUpdated by AI\n").unwrap();
        fs::write(root.path().join("docs/c.md"), "# C\nNew page\n").unwrap();
        fs::remove_file(root.path().join("docs/b.md")).unwrap();

        let report = diff(root.path(), id).unwrap();
        let changes = report["changes"].as_array().unwrap();
        assert_eq!(changes.len(), 3);
        let a = changes.iter().find(|c| c["page"] == "docs/a.md").unwrap();
        assert_eq!(a["status"], "modified");
        let b = changes.iter().find(|c| c["page"] == "docs/b.md").unwrap();
        assert_eq!(b["status"], "deleted");
        let c = changes.iter().find(|c| c["page"] == "docs/c.md").unwrap();
        assert_eq!(c["status"], "added");

        // Reject stale sha256
        assert!(apply(root.path(), id, "docs/a.md", "wrong-sha", Some("# A\nOriginal\n")).is_err());

        // Revert a.md to original and remove newly added c.md
        apply(
            root.path(),
            id,
            "docs/a.md",
            a["current_sha256"].as_str().unwrap(),
            Some("# A\nOriginal\n"),
        )
        .unwrap();
        apply(
            root.path(),
            id,
            "docs/c.md",
            c["current_sha256"].as_str().unwrap(),
            None,
        )
        .unwrap();
        // Restore deleted b.md
        apply(root.path(), id, "docs/b.md", "", Some("# B\nKeep\n")).unwrap();

        assert_eq!(
            fs::read_to_string(root.path().join("docs/a.md")).unwrap(),
            "# A\nOriginal\n"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("docs/b.md")).unwrap(),
            "# B\nKeep\n"
        );
        assert!(!root.path().join("docs/c.md").exists());
        assert_eq!(diff(root.path(), id).unwrap()["changes"].as_array().unwrap().len(), 0);

        clear(root.path(), id).unwrap();
        assert!(diff(root.path(), id).is_err());
    }
}
