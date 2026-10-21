//! Guarded single-file moves with project-local link rewriting and recovery backups.
use crate::{config::project_path, editor, workflow};
use pulldown_cmark::{Event, Parser, Tag};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    ops::Range,
    path::{Component, Path},
};

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn validate(path: &str) -> Result<(), String> {
    if path.is_empty()
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || path
            .split('/')
            .any(|p| matches!(p, ".git" | ".munin" | "node_modules" | "target" | "dist"))
        || path == "manual_setting.json"
    {
        return Err("プロジェクト内の通常ファイルを指定してください。".into());
    }
    Ok(())
}
fn relative(from: &str, to: &str) -> String {
    let mut a: Vec<_> = from.split('/').collect();
    a.pop();
    let b: Vec<_> = to.split('/').collect();
    let common = a.iter().zip(&b).take_while(|(a, b)| a == b).count();
    format!(
        "{}{}",
        "../".repeat(a.len() - common),
        b[common..].join("/")
    )
}
fn rewrite_url(
    root: &Path,
    page: &str,
    next_page: &str,
    source: &str,
    destination: &str,
    url: &str,
) -> Option<String> {
    if url.is_empty()
        || url.starts_with('#')
        || url.starts_with("//")
        || regex::Regex::new(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")
            .unwrap()
            .is_match(url)
    {
        return None;
    }
    let target = crate::quality::local_path(root, &root.join(page), url).ok()?;
    let canonical = root.canonicalize().ok()?;
    let target = target
        .strip_prefix(canonical)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    let next_target = if target == source {
        destination
    } else {
        &target
    };
    if page == next_page && target != source {
        return None;
    }
    let suffix = &url[url.find(['?', '#']).unwrap_or(url.len())..];
    let path = if url.starts_with('/') {
        format!("/{next_target}")
    } else {
        relative(next_page, next_target)
    };
    let encoded: String = path
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"/-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    Some(format!("{encoded}{suffix}"))
}
fn destination_span(text: &str) -> Option<Range<usize>> {
    let start = text.rfind("](").or_else(|| text.rfind("]:"))? + 2;
    let leading = text[start..].len() - text[start..].trim_start().len();
    let start = start + leading;
    if text[start..].starts_with('<') {
        return Some(start + 1..start + 1 + text[start + 1..].find('>')?);
    }
    let mut depth = 0;
    let mut escaped = false;
    for (offset, c) in text[start..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if c == '\\' {
            escaped = true;
            continue;
        }
        if c == '(' {
            depth += 1;
        }
        if c == ')' {
            if depth == 0 {
                return Some(start..start + offset);
            }
            depth -= 1;
        }
        if c.is_whitespace() && depth == 0 {
            return Some(start..start + offset);
        }
    }
    Some(start..text.len())
}
fn rewrite(
    root: &Path,
    page: &str,
    next: &str,
    source: &str,
    destination: &str,
    text: &str,
) -> String {
    let parser = Parser::new_ext(text, crate::gfm::options());
    let definitions: Vec<_> = parser
        .reference_definitions()
        .iter()
        .map(|(_, d)| (d.dest.to_string(), d.span.clone()))
        .collect();
    let attributes =
        regex::Regex::new(r#"(?i)\b(?:src|href|poster)\s*=\s*["'](?P<url>[^"']+)["']"#).unwrap();
    let mut edits = Vec::new();
    let mut link_edit = |url: &str, range: Range<usize>| {
        if let Some(replacement) = rewrite_url(root, page, next, source, destination, url) {
            if let Some(span) = destination_span(&text[range.clone()]) {
                edits.push((
                    range.start + span.start..range.start + span.end,
                    replacement,
                ));
            }
        }
    };
    let events: Vec<_> = parser.into_offset_iter().collect();
    for (event, range) in &events {
        if let Event::Start(Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. }) = event {
            link_edit(dest_url, range.clone());
        }
    }
    for (url, range) in definitions {
        link_edit(&url, range);
    }
    for (event, range) in events {
        if matches!(event, Event::Html(_) | Event::InlineHtml(_))
            && !text[range.clone()].trim_start().starts_with("<!--")
        {
            for cap in attributes.captures_iter(&text[range.clone()]) {
                let value = cap.name("url").unwrap();
                if let Some(replacement) = rewrite_url(
                    root,
                    page,
                    next,
                    source,
                    destination,
                    &crate::quality::decode_html_attr(value.as_str()),
                ) {
                    edits.push((
                        range.start + value.start()..range.start + value.end(),
                        replacement
                            .replace('&', "&amp;")
                            .replace('"', "&quot;")
                            .replace('\'', "&#39;"),
                    ));
                }
            }
        }
    }
    edits.sort_by_key(|(range, _)| range.start);
    edits.dedup_by(|a, b| a.0 == b.0);
    let mut result = text.to_string();
    for (range, replacement) in edits.into_iter().rev() {
        result.replace_range(range, &replacement);
    }
    result
}
#[derive(Serialize)]
struct Change {
    page: String,
    target: String,
    before: String,
    content: String,
    metadata: bool,
}
#[derive(Serialize)]
struct Plan {
    source: String,
    destination: String,
    source_hash: String,
    changes: Vec<Change>,
}
fn plan(root: &Path, source: &str, destination: &str) -> Result<Plan, String> {
    validate(source)?;
    validate(destination)?;
    if source == destination {
        return Err("移動先が現在の場所と同じです。".into());
    }
    let from = project_path(root, source)?;
    let to = project_path(root, destination)?;
    if !from.is_file() {
        return Err("移動するファイルが見つかりません。".into());
    }
    if to.exists() {
        return Err("移動先には同じ名前のファイルがあります。上書きは行いません。".into());
    }
    if !to.parent().is_some_and(Path::is_dir) {
        return Err("移動先フォルダーが見つかりません。先に作成してください。".into());
    }
    if fs::metadata(&from).map_err(|e| e.to_string())?.len() > 64_000_000 {
        return Err("移動対象は64MB以内にしてください。".into());
    }
    let mut changes = Vec::new();
    let index = crate::resource_index::ProjectIndex::scan(root)?;
    let mut paths: BTreeSet<_> = index
        .files
        .iter()
        .filter(|p| p.extension().is_some_and(|e| e == "md"))
        .cloned()
        .collect();
    for (_, path) in
        crate::task::collect_target_markdown_files(root, &crate::config::read_config(root))
    {
        paths.insert(path);
    }
    for path in paths {
        let page = path
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 3_000_000 {
            return Err(format!(
                "{page} は3MBを超えているため、リンクを安全に更新できません。"
            ));
        }
        let before = fs::read_to_string(project_path(root, &page)?).map_err(|e| e.to_string())?;
        let target = if page == source {
            destination.to_string()
        } else {
            page.clone()
        };
        let content = rewrite(root, &page, &target, source, destination, &before);
        if before != content || page == source {
            changes.push(Change {
                page,
                target,
                before,
                content,
                metadata: false,
            });
        }
    }
    // Keep current managed asset locations and explicit publication targets consistent.
    let mut metadata = Vec::new();
    let settings = project_path(root, "manual_setting.json")?;
    if settings.is_file() {
        metadata.push(settings);
    }
    for directory in [".munin/screenshots", ".munin/generated-images"] {
        let home = project_path(root, directory)?;
        if home.is_dir() {
            for entry in walkdir::WalkDir::new(home)
                .follow_links(false)
                .into_iter()
                .filter_map(Result::ok)
            {
                if entry.file_type().is_file()
                    && entry.path().extension().is_some_and(|e| e == "json")
                {
                    metadata.push(entry.path().to_path_buf());
                }
            }
        }
    }
    metadata.sort();
    for path in metadata {
        let page = path
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let before = fs::read_to_string(project_path(root, &page)?).map_err(|e| e.to_string())?;
        let Ok(mut value) = serde_json::from_str::<Value>(&before) else {
            continue;
        };
        let mut changed = false;
        if page == "manual_setting.json" {
            if let Some(targets) = value["targets"].as_array_mut() {
                for target in targets {
                    if target.as_str() == Some(source) {
                        *target = json!(destination);
                        changed = true;
                    }
                }
            }
        } else {
            for field in ["path", "output", "source_image"] {
                if value[field].as_str() == Some(source) {
                    value[field] = json!(destination);
                    changed = true;
                }
            }
        }
        if changed {
            changes.push(Change {
                target: page.clone(),
                page,
                before,
                content: serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?,
                metadata: true,
            });
        }
    }
    if changes.len() > 500
        || changes
            .iter()
            .map(|c| c.before.len() + c.content.len())
            .sum::<usize>()
            > 16_000_000
    {
        return Err("リンク更新対象が大きすぎます。対象を分けて移動してください。".into());
    }
    Ok(Plan {
        source: source.into(),
        destination: destination.into(),
        source_hash: hash(&fs::read(from).map_err(|e| e.to_string())?),
        changes,
    })
}
fn write_checked(root: &Path, path: &str, before: &[u8], after: &[u8]) -> Result<(), String> {
    let path = project_path(root, path)?;
    if fs::read(&path).map_err(|e| e.to_string())? != before {
        return Err(format!("{} が外部で変更されています。", path.display()));
    }
    let mut tmp = tempfile::NamedTempFile::new_in(path.parent().ok_or("移動先が不正です。")?)
        .map_err(|e| e.to_string())?;
    tmp.as_file()
        .set_permissions(
            fs::metadata(&path)
                .map_err(|e| e.to_string())?
                .permissions(),
        )
        .map_err(|e| e.to_string())?;
    tmp.write_all(after).map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    if fs::read(&path).map_err(|e| e.to_string())? != before {
        return Err("保存中に原稿が変更されました。".into());
    }
    tmp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
pub(crate) fn execute(root: &Path, options: &Value) -> Result<Value, String> {
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let root = canonical_root.as_path();
    let source = options["source"]
        .as_str()
        .ok_or("移動元を指定してください。")?
        .replace('\\', "/");
    let destination = options["destination"]
        .as_str()
        .ok_or("移動先を指定してください。")?
        .replace('\\', "/");
    let _move_lock = workflow::resource_lock(root, ".munin/file-move")?;
    let _asset_lock = workflow::resource_lock(root, ".munin/screenshots")?;
    let plan = plan(root, &source, &destination)?;
    let token = hash(&serde_json::to_vec(&plan).map_err(|e| e.to_string())?);
    if options["apply"].as_bool() != Some(true) {
        return Ok(
            json!({"source":source,"destination":destination,"token":token,"documents":plan.changes.iter().filter(|c|!c.metadata).map(|c|json!({"page":c.page,"destination":c.target,"before":c.before,"content":c.content})).collect::<Vec<_>>(),"metadata_changes":plan.changes.iter().filter(|c|c.metadata).count()}),
        );
    }
    if options["token"].as_str() != Some(&token) {
        return Err(
            "移動対象または参照原稿が変更されています。移動候補を作成し直してください。".into(),
        );
    }
    let mut names: BTreeSet<_> = plan.changes.iter().map(|c| c.page.as_str()).collect();
    names.insert(&source);
    names.insert(&destination);
    let _locks = names
        .into_iter()
        .map(|p| workflow::resource_lock(root, p))
        .collect::<Result<Vec<_>, _>>()?;
    let from = project_path(root, &source)?;
    let to = project_path(root, &destination)?;
    let original = fs::read(&from).map_err(|e| e.to_string())?;
    if hash(&original) != plan.source_hash {
        return Err("移動対象が変更されています。".into());
    }
    for change in &plan.changes {
        if fs::read(project_path(root, &change.page)?).map_err(|e| e.to_string())?
            != change.before.as_bytes()
        {
            return Err("参照原稿が変更されています。".into());
        }
    }
    let backup = format!(".munin/file-moves/{}", crate::screenshots::new_id("move"));
    let home = project_path(root, &backup)?;
    fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    fs::write(home.join("source.bin"), &original).map_err(|e| e.to_string())?;
    for (i, change) in plan.changes.iter().enumerate() {
        fs::write(home.join(format!("{i}.before")), &change.before).map_err(|e| e.to_string())?;
    }
    fs::write(home.join("manifest.json"),serde_json::to_vec_pretty(&json!({"source":source,"destination":destination,"files":plan.changes.iter().enumerate().map(|(i,c)|json!({"path":c.page,"destination":c.target,"backup":format!("{i}.before")})).collect::<Vec<_>>() })).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    // hard_link creates the destination atomically without replacing an existing file.
    fs::hard_link(&from, &to).map_err(|e| {
        format!("ファイルを移動できません（同じファイルシステム内で移動してください）: {e}")
    })?;
    let mut applied: Vec<&Change> = Vec::new();
    let result = (|| -> Result<(), String> {
        for change in &plan.changes {
            if change.before != change.content {
                write_checked(
                    root,
                    &change.target,
                    change.before.as_bytes(),
                    change.content.as_bytes(),
                )?;
                applied.push(change);
            }
        }
        if fs::read(project_path(root, &source)?).map_err(|e| e.to_string())? != original {
            return Err("移動中に元ファイルが変更されました。".into());
        }
        fs::remove_file(&from).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(error) = result {
        let mut failed = Vec::new();
        for change in applied.into_iter().rev() {
            if write_checked(
                root,
                &change.target,
                change.content.as_bytes(),
                change.before.as_bytes(),
            )
            .is_err()
            {
                failed.push(change.target.clone());
            }
        }
        if fs::read(&to).ok().as_deref() == Some(original.as_slice()) {
            let _ = fs::remove_file(&to);
        } else {
            failed.push(destination.clone());
        }
        return Err(format!(
            "{error}。変更前のバックアップ: {backup}{}",
            if failed.is_empty() {
                String::new()
            } else {
                format!("。外部変更のため保持したファイル: {}", failed.join(", "))
            }
        ));
    }
    let documents = plan
        .changes
        .iter()
        .filter(|c| !c.metadata)
        .map(|c| editor::read_raw(root, &c.target))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({"source":source,"destination":destination,"documents":documents,"backup":backup}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn move_file(root: &Path, from: &str, to: &str) -> Value {
        let preview = execute(root, &json!({"source":from,"destination":to})).unwrap();
        execute(
            root,
            &json!({"source":from,"destination":to,"apply":true,"token":preview["token"]}),
        )
        .unwrap()
    }
    #[test]
    fn moved_manuscript_rebases_its_links_and_incoming_markdown_html_and_definitions() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs/sub")).unwrap();
        fs::create_dir(root.path().join("images")).unwrap();
        fs::write(root.path().join("images/a.png"), b"image").unwrap();
        fs::write(
            root.path().join("docs/a.md"),
            "![Image](../images/a.png)\n[Self](a.md#part)\n[External](https://example.org/a.md)\n",
        )
        .unwrap();
        fs::write(root.path().join("README.md"),"[A](docs/a.md#part)\n[ref][a]\n\n[a]: <docs/a.md> \"Title\"\n\n<a href=\"docs/a.md?x=1&amp;y=2#part\">A</a>\n\n```md\n[A](docs/a.md)\n```\n").unwrap();
        let result = move_file(root.path(), "docs/a.md", "docs/sub/a new.md");
        let moved = fs::read_to_string(root.path().join("docs/sub/a new.md")).unwrap();
        assert!(moved.contains("../../images/a.png"));
        assert!(moved.contains("a%20new.md#part"));
        assert!(moved.contains("https://example.org/a.md"));
        let incoming = fs::read_to_string(root.path().join("README.md")).unwrap();
        assert!(incoming.contains("docs/sub/a%20new.md#part"));
        assert!(incoming.contains("[a]: <docs/sub/a%20new.md> \"Title\""));
        assert!(incoming.contains("?x=1&amp;y=2#part"));
        assert!(incoming.contains("```md\n[A](docs/a.md)\n```"));
        assert!(!root.path().join("docs/a.md").exists());
        assert!(root
            .path()
            .join(result["backup"].as_str().unwrap())
            .join("source.bin")
            .is_file());
    }
    #[test]
    fn image_move_updates_links_and_managed_output_but_not_originals() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("assets")).unwrap();
        fs::create_dir_all(root.path().join(".munin/screenshots/shot-one")).unwrap();
        fs::write(root.path().join("a.png"), b"original").unwrap();
        fs::write(root.path().join("index.md"), "![A](a.png)\n").unwrap();
        fs::write(
            root.path()
                .join(".munin/screenshots/shot-one/manifest.json"),
            r#"{"output":"a.png","original":"captures/raw.png"}"#,
        )
        .unwrap();
        move_file(root.path(), "a.png", "assets/a.png");
        assert_eq!(
            fs::read(root.path().join("assets/a.png")).unwrap(),
            b"original"
        );
        assert!(fs::read_to_string(root.path().join("index.md"))
            .unwrap()
            .contains("assets/a.png"));
        let manifest: Value = serde_json::from_slice(
            &fs::read(
                root.path()
                    .join(".munin/screenshots/shot-one/manifest.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["output"], "assets/a.png");
        assert_eq!(manifest["original"], "captures/raw.png");
    }
    #[test]
    fn stale_preview_and_existing_destination_do_not_change_files() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.md"), "old").unwrap();
        fs::write(root.path().join("index.md"), "[A](a.md)").unwrap();
        let preview = execute(root.path(), &json!({"source":"a.md","destination":"b.md"})).unwrap();
        fs::write(root.path().join("index.md"), "[A](a.md#changed)").unwrap();
        assert!(execute(
            root.path(),
            &json!({"source":"a.md","destination":"b.md","apply":true,"token":preview["token"]})
        )
        .is_err());
        assert!(root.path().join("a.md").is_file());
        assert!(!root.path().join("b.md").exists());
        fs::write(root.path().join("b.md"), "existing").unwrap();
        assert!(execute(root.path(), &json!({"source":"a.md","destination":"b.md"})).is_err());
        assert_eq!(
            fs::read_to_string(root.path().join("b.md")).unwrap(),
            "existing"
        );
        assert!(execute(
            root.path(),
            &json!({"source":"a.md","destination":"../outside.md"})
        )
        .is_err());
    }
}
