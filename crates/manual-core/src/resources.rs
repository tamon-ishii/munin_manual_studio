//! A common view of captured, generated, and project-owned image resources.
use crate::{config::project_path, image_generation, screenshots, task};
use base64::{engine::general_purpose::STANDARD, Engine};
use pulldown_cmark::{Event, Parser, Tag};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::Path,
};

pub(crate) fn image_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg"
    )
}
pub(crate) fn image_bytes(root: &Path, path: &str) -> Result<Vec<u8>, String> {
    let path = project_path(root, path)?;
    if !image_extension(&path) {
        return Err("画像ファイルを選択してください。".into());
    }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 32_000_000 {
        return Err("画像が大きすぎます。".into());
    }
    fs::read(path).map_err(|e| e.to_string())
}
pub fn image_data(root: &Path, path: &str) -> Result<String, String> {
    let bytes = image_bytes(root, path)?;
    let ext = Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "image/png",
    };
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}
fn thumbnail(bytes: &[u8]) -> Option<String> {
    let image = image::load_from_memory(bytes).ok()?.thumbnail(320, 200);
    let mut output = std::io::Cursor::new(Vec::new());
    image.write_to(&mut output, image::ImageFormat::Png).ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(output.into_inner())
    ))
}
pub fn usages(root: &Path) -> Result<BTreeMap<String, Vec<Value>>, String> {
    let canonical = root.canonicalize().map_err(|e| e.to_string())?;
    let config = crate::config::read_config(root);
    let mut result: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    // Include Markdown outside configured publication targets as well.
    let mut pages: Vec<(String, std::path::PathBuf)> =
        task::collect_target_markdown_files(root, &config)
            .into_iter()
            .map(|(_, file)| {
                let page = file
                    .strip_prefix(root)
                    .unwrap_or(&file)
                    .to_string_lossy()
                    .replace('\\', "/");
                (page, file)
            })
            .collect();
    let mut seen: BTreeSet<String> = pages.iter().map(|(page, _)| page.clone()).collect();
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            entry.depth() == 0
                || (!name.starts_with('.')
                    && !matches!(
                        name.as_ref(),
                        "node_modules" | "target" | "dist" | "__pycache__" | "site"
                    ))
        })
        .filter_map(Result::ok)
    {
        if entry.file_type().is_file() && entry.path().extension().is_some_and(|ext| ext == "md") {
            let page = entry
                .path()
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if seen.insert(page.clone()) {
                pages.push((page, entry.path().to_path_buf()));
            }
        }
    }
    for (page, file) in pages {
        let text = fs::read_to_string(&file).map_err(|e| e.to_string())?;
        let html_images=regex::Regex::new(r#"(?is)<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>"#).unwrap();
        for (event, range) in Parser::new(&text).into_offset_iter() {
            let images:Vec<(String,std::ops::Range<usize>)>=match event {
                Event::Start(Tag::Image{dest_url,..})=>vec![(dest_url.to_string(),range.clone())],
                Event::Html(html)|Event::InlineHtml(html)=>html_images.captures_iter(&html).map(|cap|{let matched=cap.get(0).unwrap();(crate::quality::decode_html_attr(&cap[1]),range.start+matched.start()..range.start+matched.end())}).collect(),
                _=>vec![],
            };
            for (url,range) in images {
                if let Ok(target) = crate::quality::local_path(root, &file, &url) {
                    if let Ok(relative) = target.strip_prefix(&canonical) {
                        let path = relative.to_string_lossy().replace('\\', "/");
                        result.entry(path).or_default().push(json!({"page":page,
                            "line":text[..range.start].bytes().filter(|b|*b==b'\n').count()+1,
                            "start":text[..range.start].encode_utf16().count(),"end":text[..range.end].encode_utf16().count(),
                            "snippet":&text[range]}));
                    }
                }
            }
        }
    }
    Ok(result)
}
pub fn list(root: &Path) -> Result<Value, String> {
    let usage = usages(root)?;
    let shots = screenshots::list(root)?;
    let generated = image_generation::history(root)?;
    let mut records = BTreeMap::new();
    for shot in shots["items"].as_array().into_iter().flatten() {
        if let Some(path) = shot["output"].as_str() {
            records.insert(path.to_string(), json!({"path":path,"name":shot["name"],"kind":if shot["recipe"].is_null(){"imported"}else{"screenshot"},"screenshot_id":shot["id"],"created_at":shot["created_at"]}));
        }
    }
    for item in generated["items"].as_array().into_iter().flatten() {
        if let Some(path) = item["path"].as_str() {
            records.entry(path.to_string()).or_insert_with(||json!({"path":path,"name":item["prompt"].as_str().unwrap_or("AI生成画像").chars().take(48).collect::<String>(),"kind":"generated","generation":item,"created_at":item["created_at"]}));
        }
    }
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            entry.depth() == 0
                || (!name.starts_with('.')
                    && !matches!(
                        name.as_ref(),
                        "node_modules" | "target" | "dist" | "__pycache__" | "site"
                    ))
        })
        .filter_map(Result::ok)
    {
        if entry.file_type().is_file() && image_extension(entry.path()) {
            let path = entry
                .path()
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            records.entry(path.clone()).or_insert_with(||json!({"path":path,"name":entry.file_name().to_string_lossy(),"kind":"imported"}));
        }
    }
    let mut items = Vec::new();
    for (path, mut item) in records {
        item["usages"] = json!(usage.get(&path).cloned().unwrap_or_default());
        match project_path(root, &path)
            .and_then(|path| fs::metadata(path).map_err(|e| e.to_string()))
        {
            Ok(metadata) if metadata.is_file() => {
                item["missing"] = json!(false);
                item["bytes"] = json!(metadata.len());
            }
            Ok(_) => {
                item["missing"] = json!(true);
                item["error"] = json!("画像ファイルが見つかりません。");
            }
            Err(error) => {
                item["missing"] = json!(true);
                item["error"] = json!(error);
            }
        }
        items.push(item);
    }
    Ok(json!({"items":items}))
}
pub fn preview_thumbnail(root: &Path, path: &str) -> Result<String, String> {
    let bytes = image_bytes(root, path)?;
    if let Some(image) = thumbnail(&bytes) {
        Ok(image)
    } else {
        image_data(root, path)
    }
}
pub fn detail(root: &Path, path: &str) -> Result<Value, String> {
    let bytes = image_bytes(root, path)?;
    Ok(
        json!({"path":path,"sha256":format!("{:x}",Sha256::digest(bytes)),"usages":usages(root)?.remove(path).unwrap_or_default(),"replacements":replacement_history(root,path)?}),
    )
}
pub fn copy(root: &Path, path: &str) -> Result<Value, String> {
    let bytes = image_bytes(root, path)?;
    let png = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    let config = crate::config::read_config(root);
    let target = format!(
        "{}/edited/{}.png",
        config.assets.trim_end_matches('/'),
        screenshots::new_id("image")
    );
    let mut output = std::io::Cursor::new(Vec::new());
    png.write_to(&mut output, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    crate::editor::save_asset(root, &target, &STANDARD.encode(output.into_inner()))?;
    Ok(json!({"path":target}))
}
pub fn replace(root: &Path, options: &Value) -> Result<Value, String> {
    let _lock = crate::workflow::resource_lock(root, ".munin/resources")?;
    let path = options["path"]
        .as_str()
        .ok_or("差し替える画像を選択してください。")?;
    let replacement = options["replacement"]
        .as_str()
        .ok_or("新しい画像を選択してください。")?;
    if path == replacement {
        return Err("別の画像を選択してください。".into());
    }
    for shot in screenshots::list(root)?["items"]
        .as_array()
        .into_iter()
        .flatten()
    {
        if shot["output"] == path {
            return Err("撮影管理画像は履歴から編集版を採用してください。".into());
        }
    }
    let old = image_bytes(root, path)?;
    let hash = format!("{:x}", Sha256::digest(&old));
    if options["expected_sha256"].as_str() != Some(hash.as_str()) {
        return Err("画像が変更されています。一覧を更新して確認してください。".into());
    }
    let source = image_bytes(root, replacement)?;
    let format = image::ImageFormat::from_path(path)
        .map_err(|_| "差し替えはPNGまたはJPEG画像で利用できます。")?;
    if !matches!(format, image::ImageFormat::Png | image::ImageFormat::Jpeg) {
        return Err("差し替えはPNGまたはJPEG画像で利用できます。".into());
    }
    let decoded = image::load_from_memory(&source).map_err(|e| e.to_string())?;
    let mut output = std::io::Cursor::new(Vec::new());
    if format == image::ImageFormat::Jpeg {
        decoded
            .to_rgb8()
            .write_to(&mut output, format)
            .map_err(|e| e.to_string())?;
    } else {
        decoded
            .write_to(&mut output, format)
            .map_err(|e| e.to_string())?;
    }
    let target = project_path(root, path)?;
    let backup = project_path(
        root,
        &format!(
            ".munin/resource-replacements/{}.{}",
            screenshots::new_id("before"),
            Path::new(path)
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
        ),
    )?;
    fs::create_dir_all(backup.parent().ok_or("Invalid backup")?).map_err(|e| e.to_string())?;
    fs::write(&backup, &old).map_err(|e| e.to_string())?;
    let id=backup.file_stem().unwrap().to_string_lossy().to_string();
    let output=output.into_inner();
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let backup_relative=backup.strip_prefix(&canonical_root).map_err(|e|e.to_string())?.to_string_lossy().replace('\\',"/");
    let mut record=json!({"id":id,"path":path,"backup":backup_relative,"before_sha256":hash,
        "after_sha256":format!("{:x}",Sha256::digest(&output)),"status":"pending","created_at":task::utc_now(),
        "order":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64});
    save_replacement(root,&id,&record)?;
    let affected = usages(root)?.remove(path).unwrap_or_default();
    let mut tmp = tempfile::NamedTempFile::new_in(target.parent().ok_or("Invalid image path")?)
        .map_err(|e| e.to_string())?;
    tmp.write_all(&output).map_err(|e| e.to_string())?;
    tmp.persist(target).map_err(|e| e.to_string())?;
    record["status"]=json!("replaced");save_replacement(root,&id,&record)?;
    Ok(
        json!({"id":id,"path":path,"usages":affected,"backup":backup_relative}),
    )
}


fn replacement_record(root: &Path, id: &str) -> Result<std::path::PathBuf, String> {
    if id.is_empty() || !id.chars().all(|c|c.is_ascii_alphanumeric()||c=='-') {return Err("差し替え履歴のIDが不正です。".into());}
    project_path(root,&format!(".munin/resource-replacements/{id}.json"))
}
fn save_replacement(root: &Path, id: &str, value: &Value) -> Result<(), String> {
    let path=replacement_record(root,id)?;
    let mut tmp=tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|e|e.to_string())?;
    tmp.write_all(&serde_json::to_vec_pretty(value).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    tmp.persist(path).map_err(|e|e.to_string())?;Ok(())
}
pub fn replacement_history(root: &Path, path: &str) -> Result<Vec<Value>, String> {
    let home=project_path(root,".munin/resource-replacements")?;let mut records=Vec::new();
    if home.exists(){for entry in fs::read_dir(home).map_err(|e|e.to_string())? {
        let entry=entry.map_err(|e|e.to_string())?;
        if entry.path().extension().is_some_and(|ext|ext=="json") {
            if let Some(value)=fs::read(entry.path()).ok().and_then(|bytes|serde_json::from_slice::<Value>(&bytes).ok()) {
                if value["path"]==path&&value["status"]=="replaced" {records.push(value);}
            }
        }
    }}
    records.sort_by(|a,b|b["order"].as_u64().cmp(&a["order"].as_u64()));Ok(records)
}
pub fn restore(root: &Path, options: &Value) -> Result<Value, String> {
    let _lock=crate::workflow::resource_lock(root,".munin/resources")?;
    let id=options["id"].as_str().ok_or("戻す差し替え履歴を選択してください。")?;
    let record_path=replacement_record(root,id)?;
    let mut record:Value=serde_json::from_slice(&fs::read(record_path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    if record["status"]!="replaced" {return Err("この差し替えは復元済み、または未完了です。".into());}
    let path=record["path"].as_str().ok_or("差し替え履歴が不正です。")?.to_string();
    if screenshots::list(root)?["items"].as_array().into_iter().flatten().any(|shot|shot["output"]==path){return Err("撮影管理画像は履歴から編集版を採用してください。".into());}
    let current=image_bytes(root,&path)?;let hash=format!("{:x}",Sha256::digest(&current));
    if record["after_sha256"]!=hash || options["expected_sha256"]!=hash {return Err("画像が変更されています。現在の画像を保持しました。一覧を更新して確認してください。".into());}
    let backup=record["backup"].as_str().ok_or("バックアップがありません。")?;
    if !backup.starts_with(".munin/resource-replacements/") {return Err("バックアップの場所が不正です。".into());}
    let bytes=image_bytes(root,backup)?;
    if record["before_sha256"]!=format!("{:x}",Sha256::digest(&bytes)){return Err("バックアップが変更されています。復元を中止しました。".into());}
    let target=project_path(root,&path)?;let mut tmp=tempfile::NamedTempFile::new_in(target.parent().unwrap()).map_err(|e|e.to_string())?;
    tmp.write_all(&bytes).map_err(|e|e.to_string())?;tmp.persist(target).map_err(|e|e.to_string())?;
    record["status"]=json!("restored");record["restored_at"]=json!(task::utc_now());save_replacement(root,id,&record)?;
    Ok(json!({"path":path,"restored":true,"usages":usages(root)?.remove(&path).unwrap_or_default()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png(value: u8) -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(8, 6, image::Rgba([value, 2, 3, 255]));
        let mut out = std::io::Cursor::new(Vec::new());
        image.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }
    #[test]
    fn configured_html_images_track_escaped_paths_and_ignore_examples() {
        let root=tempfile::tempdir().unwrap();fs::create_dir_all(root.path().join("docs/assets")).unwrap();fs::write(root.path().join("docs/assets/a&b.png"),png(1)).unwrap();
        let source="# 😀Images\n\n<figure data-munin-image=\"true\"><img src=\"assets/a&amp;b.png\" alt=\"Example\"><figcaption>Caption</figcaption></figure>\n\n```html\n<img src=\"assets/a&amp;b.png\">\n```";
        fs::write(root.path().join("docs/index.md"),source).unwrap();let usages=usages(root.path()).unwrap();let entries=&usages["docs/assets/a&b.png"];
        assert_eq!(entries.len(),1);assert_eq!(entries[0]["line"],3);assert_eq!(entries[0]["snippet"],"<img src=\"assets/a&amp;b.png\" alt=\"Example\">");assert_eq!(crate::quality::check(root.path()).unwrap()["passed"],true);
    }
    #[test]
    fn restore_preserves_documents_and_rejects_changed_images_and_backups() {
        let root=tempfile::tempdir().unwrap();fs::create_dir_all(root.path().join("docs/assets")).unwrap();
        let path="docs/assets/a.png";let old=png(10);let candidate=png(90);
        fs::write(root.path().join(path),&old).unwrap();fs::write(root.path().join("docs/assets/b.png"),candidate).unwrap();
        let manuscript="![A](assets/a.png)";fs::write(root.path().join("docs/index.md"),manuscript).unwrap();
        let result=replace(root.path(),&json!({"path":path,"replacement":"docs/assets/b.png","expected_sha256":format!("{:x}",Sha256::digest(&old))})).unwrap();
        let detail=detail(root.path(),path).unwrap();let options=json!({"id":result["id"],"expected_sha256":detail["sha256"]});
        let replaced=fs::read(root.path().join(path)).unwrap();assert_ne!(replaced,old);
        fs::write(root.path().join(path),png(123)).unwrap();assert!(restore(root.path(),&options).is_err());
        fs::write(root.path().join(path),&replaced).unwrap();
        let backup=root.path().join(result["backup"].as_str().unwrap());fs::write(&backup,png(200)).unwrap();assert!(restore(root.path(),&options).is_err());
        assert_eq!(fs::read(root.path().join(path)).unwrap(),replaced);fs::write(&backup,&old).unwrap();
        assert_eq!(restore(root.path(),&options).unwrap()["restored"],true);assert_eq!(fs::read(root.path().join(path)).unwrap(),old);
        assert!(backup.exists());assert!(replacement_history(root.path(),path).unwrap().is_empty());assert!(restore(root.path(),&options).is_err());
        assert_eq!(fs::read_to_string(root.path().join("docs/index.md")).unwrap(),manuscript);
    }
    #[test]
    fn unified_resources_include_usage_locations_and_ignore_code() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs/assets")).unwrap();
        fs::write(
            root.path().join("manual_setting.json"),
            r#"{"docs":"docs","assets":"docs/assets","targets":["docs"]}"#,
        )
        .unwrap();
        fs::write(root.path().join("docs/assets/日本 画像.png"), png(1)).unwrap();
        let text="# 😀原稿\n\n![画像](<assets/日本 画像.png>)\n\n```md\n![無視](<assets/日本 画像.png>)\n```\n";
        fs::write(root.path().join("docs/index.md"), text).unwrap();
        fs::write(
            root.path().join("other.md"),
            "![外部原稿](docs/assets/日本%20画像.png)",
        )
        .unwrap();
        fs::create_dir_all(root.path().join(".munin/generated-images")).unwrap();
        fs::write(root.path().join("docs/assets/ai.png"), png(2)).unwrap();
        fs::write(root.path().join(".munin/generated-images/ai.json"),r#"{"id":"ai","path":"docs/assets/ai.png","prompt":"A mountain","provider":"codex","created_at":"now"}"#).unwrap();
        let shot=screenshots::register(root.path(),&json!({"source":format!("data:image/png;base64,{}",STANDARD.encode(png(3))),"recipe":{"steps":[]},"name":"Captured"})).unwrap();
        let result = list(root.path()).unwrap();
        let items = result["items"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert!(items.iter().any(
            |item| item["kind"] == "generated" && item["generation"]["prompt"] == "A mountain"
        ));
        assert!(items
            .iter()
            .any(|item| item["screenshot_id"] == shot["screenshot"]["id"]
                && item["kind"] == "screenshot"));
        let raw = items
            .iter()
            .find(|item| item["path"] == "docs/assets/日本 画像.png")
            .unwrap();
        assert_eq!(raw["usages"].as_array().unwrap().len(), 2);
        let usage = raw["usages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|u| u["page"] == "docs/index.md")
            .unwrap();
        assert_eq!(usage["line"], 3);
        assert_eq!(
            usage["start"],
            text[..text.find("![画像]").unwrap()].encode_utf16().count()
        );
        assert!(preview_thumbnail(root.path(), "docs/assets/日本 画像.png")
            .unwrap()
            .starts_with("data:image/png"));
    }
    #[cfg(unix)]
    #[test]
    fn replacements_and_restore_accept_a_symlinked_project_root() {
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("project");
        let alias = temporary.path().join("alias");
        fs::create_dir_all(project.join("docs/assets")).unwrap();
        std::os::unix::fs::symlink(&project, &alias).unwrap();
        let original = png(1);
        fs::write(project.join("docs/assets/a.png"), &original).unwrap();
        fs::write(project.join("docs/assets/b.png"), png(9)).unwrap();
        let result = replace(&alias, &json!({"path":"docs/assets/a.png","replacement":"docs/assets/b.png","expected_sha256":format!("{:x}",Sha256::digest(&original))})).unwrap();
        assert!(result["backup"].as_str().unwrap().starts_with(".munin/resource-replacements/"));
        assert_eq!(fs::read(alias.join(result["backup"].as_str().unwrap())).unwrap(), original);
        let current = detail(&alias, "docs/assets/a.png").unwrap();
        restore(&alias, &json!({"id":result["id"],"expected_sha256":current["sha256"]})).unwrap();
        assert_eq!(fs::read(project.join("docs/assets/a.png")).unwrap(), original);
    }
    #[test]
    fn replacements_check_revision_and_keep_backup_and_manuscripts() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs/assets")).unwrap();
        let old = png(1);
        let new = png(4);
        fs::write(root.path().join("docs/assets/a.png"), &old).unwrap();
        fs::write(root.path().join("docs/assets/b.png"), &new).unwrap();
        fs::write(root.path().join("docs/index.md"), "![image](assets/a.png)").unwrap();
        let options = json!({"path":"docs/assets/a.png","replacement":"docs/assets/b.png","expected_sha256":format!("{:x}",Sha256::digest(&old))});
        let result = replace(root.path(), &options).unwrap();
        assert_eq!(result["usages"][0]["page"], "docs/index.md");
        assert_eq!(
            fs::read(root.path().join(result["backup"].as_str().unwrap())).unwrap(),
            old
        );
        assert_eq!(
            fs::read_to_string(root.path().join("docs/index.md")).unwrap(),
            "![image](assets/a.png)"
        );
        assert!(replace(root.path(), &options).unwrap_err().contains("変更"));
        let copied = copy(root.path(), "docs/assets/a.png").unwrap();
        assert_ne!(copied["path"], "docs/assets/a.png");
        assert!(image_bytes(root.path(), copied["path"].as_str().unwrap()).is_ok());
        assert!(image_bytes(root.path(), "../escape.png").is_err());
    }
    #[test]
    fn replacement_does_not_bypass_screenshot_adoption() {
        let root = tempfile::tempdir().unwrap();
        let shot = screenshots::register(
            root.path(),
            &json!({"source":format!("data:image/png;base64,{}",STANDARD.encode(png(1)))}),
        )
        .unwrap();
        let path = shot["screenshot"]["output"].as_str().unwrap();
        fs::write(root.path().join("replacement.png"), png(2)).unwrap();
        assert!(replace(
            root.path(),
            &json!({"path":path,"replacement":"replacement.png","expected_sha256":"anything"})
        )
        .unwrap_err()
        .contains("編集版を採用"));
    }
}
