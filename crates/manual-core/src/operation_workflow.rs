//! Reviewable operation runs, image comparisons and scoped manuscript updates.
use crate::{agent, config::project_path};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

fn read(root: &Path, name: &str) -> Result<Value, String> {
    if !name.ends_with("/run.json") {
        return Err("実行履歴のrun.jsonを指定してください。".into());
    }
    let path = project_path(root, name)?;
    let value: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    crate::operation_script::execute(
        root,
        "operations-validate",
        &json!({"script":value["script"]}),
    )?;
    Ok(value)
}
fn image_for<'a>(run: &'a Value, name: &str) -> Option<&'a str> {
    for field in ["published", "captures"] {
        if let Some(found) = run[field]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["name"] == name))
            .and_then(|item| item.get("image"))
            .and_then(Value::as_str)
        {
            return Some(found);
        }
    }
    None
}
pub(crate) fn handle(root: &Path, options: &Value) -> Result<Value, String> {
    let canonical = root.canonicalize().map_err(|e| e.to_string())?;
    let root = canonical.as_path();
    match options["action"].as_str().unwrap_or("") {
        "validate" => crate::operation_script::execute(root, "operations-validate", options),
        "image" => Ok(json!(crate::resources::image_data(
            root,
            options["image"].as_str().ok_or("画像が必要です。")?
        )?)),
        "history" => {
            let directory = project_path(root, ".munin/operation-runs")?;
            let mut items = Vec::new();
            if directory.is_dir() {
                for entry in fs::read_dir(directory)
                    .map_err(|e| e.to_string())?
                    .filter_map(Result::ok)
                {
                    let file = entry.path().join("run.json");
                    if file.is_file() {
                        if let Ok(bytes) = fs::read(&file) {
                            if let Ok(run) = serde_json::from_slice::<Value>(&bytes) {
                                let name = file
                                    .strip_prefix(root)
                                    .map_err(|e| e.to_string())?
                                    .to_string_lossy()
                                    .replace('\\', "/");
                                items.push(json!({"run":name,"ok":run["ok"],"title":run["script"]["window"]["title"],"captures":run["captures"].as_array().map(Vec::len).unwrap_or(0)}));
                            }
                        }
                    }
                }
            }
            items.sort_by(|a, b| b["run"].as_str().cmp(&a["run"].as_str()));
            items.truncate(40);
            Ok(json!(items))
        }
        "read" => {
            let name = options["run"].as_str().ok_or("履歴が必要です。")?;
            let mut run = read(root, name)?;
            run["run"] = json!(name);
            if run["ok"] != true
                && run["captures"]
                    .as_array()
                    .is_none_or(|items| items.is_empty())
            {
                let directory = project_path(root, name)?.parent().unwrap().to_path_buf();
                let captures:Vec<_>=run["script"]["steps"].as_array().unwrap().iter().enumerate().filter(|(_,step)|step["kind"]=="screenshot").filter_map(|(index,step)|{let name=step["name"].as_str()?;if !directory.join(format!("{name}.png")).is_file(){return None;}Some(json!({"name":name,"step":index+1,"image":format!("{}/{name}.png",Path::new(options["run"].as_str().unwrap()).parent().unwrap().to_string_lossy().replace('\\',"/"))}))}).collect();
                run["captures"] = json!(captures);
            }
            let uses = crate::resources::usages(root)?;
            if let Some(captures) = run["captures"].as_array().cloned() {
                for (index, item) in captures.iter().enumerate() {
                    let name = item["name"].as_str().unwrap_or("");
                    if let Some(image) = image_for(&run, name).map(str::to_owned) {
                        run["captures"][index]["display_image"] = json!(image);
                        run["captures"][index]["documents"] =
                            json!(uses.get(&image).cloned().unwrap_or_default());
                    }
                }
            }
            let directory = project_path(root, name)?.parent().unwrap().to_path_buf();
            run["trace"] = crate::operation_checkpoint::trace(&directory);
            Ok(run)
        }
        "run" | "resume" => {
            let resume = options["action"] == "resume";
            let output = if resume {
                let name = options["run"].as_str().ok_or("履歴が必要です。")?;
                read(root, name)?;
                Path::new(name)
                    .parent()
                    .ok_or("Invalid run")?
                    .to_string_lossy()
                    .replace('\\', "/")
            } else {
                format!(
                    ".munin/operation-runs/{}",
                    crate::screenshots::new_id("run")
                )
            };
            let request = json!({"root":root,"action":if resume{"operations-resume"}else{"operations-run"},"script":options["script"],"window":options["window"],"output":output,"retry_failed":options["retry_failed"],"return_failure":true});
            agent::log_exchange(root, "tool_request", "確認済みの操作を実行", &request);
            let result = crate::terminal_tools::invoke_isolated(root, &request);
            match &result {
                Ok(value) => agent::log_exchange(root, "tool_result", "操作の実行結果", value),
                Err(error) => agent::log_exchange(
                    root,
                    "error",
                    "操作を開始できませんでした",
                    &json!({"error":error}),
                ),
            }
            result
        }
        "compare" => compare(root, options),
        "update" => update(root, options),
        _ => Err("不明な操作ワークベンチの要求です。".into()),
    }
}

fn compare(root: &Path, options: &Value) -> Result<Value, String> {
    let before_name = options["before"]
        .as_str()
        .ok_or("比較元の履歴が必要です。")?;
    let after_name = options["after"]
        .as_str()
        .ok_or("再撮影の履歴が必要です。")?;
    if before_name == after_name {
        return Err("異なる実行を選択してください。".into());
    }
    let before = read(root, before_name)?;
    let mut after = read(root, after_name)?;
    if before["ok"] != true || after["ok"] != true {
        return Err("完了した実行同士で比較してください。".into());
    }
    let canonical = root.canonicalize().map_err(|e| e.to_string())?;
    let uses = crate::resources::usages(root)?;
    let mut images = Vec::new();
    let mut published = Vec::new();
    for item in before["captures"]
        .as_array()
        .ok_or("撮影画像がありません。")?
        .iter()
        .take(100)
    {
        let name = item["name"].as_str().ok_or("撮影名が不正です。")?;
        let old = image_for(&before, name).ok_or("比較元画像がありません。")?;
        let Some(raw) = after["captures"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["name"] == name))
            .and_then(|item| item["image"].as_str())
        else {
            images.push(json!({"name":name,"changed":true,"missing":true,"before":old}));
            continue;
        };
        let old_bytes = crate::resources::image_bytes(root, old)?;
        let source = crate::resources::image_bytes(root, raw)?;
        let mut new_bytes = source.clone();
        // Keep existing annotations, including AI-managed mosaics, on recapture.
        if let Some(scene) = markits::raster::read_png_text_chunk(&old_bytes, "markits:annotations")
            .map_err(|e| e.to_string())?
        {
            let mut scene: Value = serde_json::from_str(&scene).map_err(|e| e.to_string())?;
            let image = image::load_from_memory(&source).map_err(|e| e.to_string())?;
            crate::markits_scene::scale_markits_scene(&mut scene, image.width(), image.height())?;
            scene.as_object_mut().unwrap().remove("uimap");
            new_bytes = crate::markits_scene::render_tracked(&scene, &source)?;
            for key in [
                "markits:operations",
                "markits:operation_group",
                "markits:operation_script",
            ] {
                if let Some(text) =
                    markits::raster::read_png_text_chunk(&source, key).map_err(|e| e.to_string())?
                {
                    new_bytes = markits::raster::embed_png_text_chunk(&new_bytes, key, &text)
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        let identity = format!("{:x}", Sha256::digest(&new_bytes));
        let filename = format!("recapture-{}-{name}.png", &identity[..12]);
        let (destination, _) = crate::config::asset_destination(
            root,
            &project_path(root, "docs/index.md")?,
            &filename,
        )?;
        if !destination.exists() {
            use std::io::Write;
            fs::create_dir_all(destination.parent().unwrap()).map_err(|e| e.to_string())?;
            let mut file = tempfile::NamedTempFile::new_in(destination.parent().unwrap())
                .map_err(|e| e.to_string())?;
            file.write_all(&new_bytes).map_err(|e| e.to_string())?;
            file.persist_noclobber(&destination)
                .map_err(|e| e.to_string())?;
        }
        let new = destination
            .strip_prefix(&canonical)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        published.push(json!({"name":name,"image":new}));
        let a = image::load_from_memory(&old_bytes)
            .map_err(|e| e.to_string())?
            .to_rgb8();
        let b = image::load_from_memory(&new_bytes)
            .map_err(|e| e.to_string())?
            .to_rgb8();
        let mut changed = 0_u64;
        let same_size = a.dimensions() == b.dimensions();
        let mut diff = b.clone();
        for (x, y, pixel) in diff.enumerate_pixels_mut() {
            let different = !same_size
                || a.get_pixel(x, y)
                    .0
                    .iter()
                    .zip(b.get_pixel(x, y).0)
                    .any(|(a, b)| a.abs_diff(b) > 15);
            if different {
                changed += 1;
                *pixel = image::Rgb([220, 35, 50]);
            } else {
                *pixel = image::Rgb(pixel.0.map(|v| v / 3));
            }
        }
        let ratio = changed as f64 / (b.width() as f64 * b.height() as f64).max(1.0);
        let diff_path = project_path(root, after_name)?
            .parent()
            .unwrap()
            .join(format!("diff-{name}.png"));
        diff.save(&diff_path).map_err(|e| e.to_string())?;
        images.push(json!({"name":name,"before":old,"after":new,"diff":diff_path.strip_prefix(&canonical).map_err(|e|e.to_string())?.to_string_lossy().replace('\\',"/"),"changed":changed>0,"ratio":ratio,"size_changed":!same_size,"documents":uses.get(old).cloned().unwrap_or_default()}));
    }
    after["published"] = json!(published);
    fs::write(
        project_path(root, after_name)?,
        serde_json::to_vec_pretty(&after).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let result = json!({"before":before_name,"after":after_name,"images":images});
    agent::log_exchange(root, "comparison", "再撮影の画像差分", &result);
    Ok(result)
}

fn update(root: &Path, options: &Value) -> Result<Value, String> {
    let config = crate::config::read_config(root);
    update_with(root, options, |prompt, schema, pictures| {
        if matches!(config.connection_type.as_str(), "api" | "local_llm") {
            agent::http_agent_json_images(
                root,
                prompt,
                schema,
                &config.endpoint_url,
                &config.model,
                None,
                pictures,
            )
        } else {
            let prompt=format!("{prompt}\nCLI mode: images are supplied as project-relative before/after file paths and UIMap, rather than attached image messages. You may inspect those images with read-only image viewing tools if available. Never execute input or write files. If visual inspection is unavailable, limit the proposal to observed UIMap changes and mark other visual details as unverified.");
            agent::agent_json_candidate(root, &prompt, schema, &config.agent, &config.model)
        }
    })
}
fn update_with(
    root: &Path,
    options: &Value,
    mut ai: impl FnMut(&str, &Value, &[String]) -> Result<Value, String>,
) -> Result<Value, String> {
    let canonical = root.canonicalize().map_err(|e| e.to_string())?;
    let root = canonical.as_path();
    let comparison = compare(root, options)?;
    let mut originals = BTreeMap::new();
    let mut evidence = Vec::new();
    let mut pictures = Vec::new();
    for item in comparison["images"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["changed"] == true && item["missing"] != true)
        .take(4)
    {
        for usage in item["documents"].as_array().unwrap() {
            let Some(page) = usage["page"].as_str() else {
                continue;
            };
            let path = crate::editor::document_path(root, page)?;
            let name = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if originals.len() < 8 || originals.contains_key(&name) {
                let document = crate::editor::read_raw(root, &name)?;
                originals.insert(name, document);
            }
        }
        let mut info = item.clone();
        for field in ["before", "after"] {
            let name = item[field].as_str().unwrap();
            let bytes = crate::resources::image_bytes(root, name)?;
            let image = image::load_from_memory(&bytes)
                .map_err(|e| e.to_string())?
                .thumbnail(1280, 1280);
            let mut png = std::io::Cursor::new(Vec::new());
            image
                .write_to(&mut png, image::ImageFormat::Png)
                .map_err(|e| e.to_string())?;
            pictures.push(format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(png.into_inner())
            ));
            let metadata = markits::raster::inspect_image(&project_path(root, name)?)
                .map_err(|e| e.to_string())?;
            info[format!("{field}_uimap")] = json!(metadata.uimap);
        }
        evidence.push(info);
    }
    if originals.is_empty() {
        return Err(
            "変更画像を参照する原稿がありません。画像を原稿に挿入してから比較してください。".into(),
        );
    }
    let pages: Vec<_> = originals
        .iter()
        .map(|(path, doc)| json!({"path":path,"content":doc.content}))
        .collect();
    let prompt=format!("{}\nRevise ONLY manuscript descriptions affected by the supplied screenshot differences. Preserve unrelated text. Never claim unobserved operations succeeded. Use the actual before/after images and UIMap as evidence, not pixel change alone. Return ONLY pages from the supplied list; unchanged pages may be omitted. Update image links to the supplied after paths relative to each page. No file writes or tools.\nInput: {}",crate::rich_template::guide(),json!({"pages":pages,"changes":evidence}));
    let schema = json!({"type":"object","properties":{"pages":{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"],"additionalProperties":false}}},"required":["pages"],"additionalProperties":false});
    agent::log_exchange(
        root,
        "request",
        "AIへ送信：画像差分から原稿を更新",
        &json!({"instruction":prompt,"image_count":pictures.len()}),
    );
    let answer = ai(&prompt, &schema, &pictures)?;
    agent::log_exchange(root, "response", "AIからの更新候補", &answer);
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    for page in answer["pages"].as_array().ok_or("更新候補が不正です。")? {
        let path = page["path"].as_str().ok_or("ページが不正です。")?;
        let original = originals
            .get(path)
            .ok_or("画像と無関係なページへの変更は採用できません。")?;
        if !seen.insert(path) {
            return Err("更新ページが重複しています。".into());
        }
        let mut content = page["content"]
            .as_str()
            .filter(|text| text.len() <= 300000)
            .ok_or("本文が不正です。")?
            .to_string();
        let page_path = project_path(root, path)?;
        for item in &evidence {
            let before = project_path(root, item["before"].as_str().unwrap())?;
            let after = project_path(root, item["after"].as_str().unwrap())?;
            let mut old_links = Vec::new();
            for event in pulldown_cmark::Parser::new_ext(&content, crate::gfm::options()) {
                if let pulldown_cmark::Event::Start(pulldown_cmark::Tag::Image {
                    dest_url, ..
                }) = event
                {
                    if crate::quality::local_path(root, &page_path, &dest_url)
                        .ok()
                        .as_ref()
                        == Some(&before)
                    {
                        old_links.push(dest_url.to_string());
                    }
                }
            }
            let relative = relative_image(&page_path, &after);
            for old in old_links {
                content = content.replace(&old, &relative);
            }
        }
        result.push(json!({"path":path,"before":original.content,"revision":original.revision,"content":content}));
    }
    Ok(json!({"docs":".","pages":result,"comparison":comparison}))
}
fn relative_image(page: &Path, image: &Path) -> String {
    let from: Vec<_> = page.parent().unwrap().components().collect();
    let to: Vec<_> = image.components().collect();
    let shared = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    format!(
        "{}{}",
        "../".repeat(from.len() - shared),
        to[shared..]
            .iter()
            .map(|p| p.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/")
    )
    .replace(' ', "%20")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs/assets")).unwrap();
        fs::write(
            root.path().join("manual_setting.json"),
            json!({"docs":"docs","assets":"docs/assets"}).to_string(),
        )
        .unwrap();
        fs::write(
            root.path().join("docs/index.md"),
            "# Guide\n\n![Settings](assets/old.png)\n",
        )
        .unwrap();
        fs::write(root.path().join("docs/unrelated.md"), "Unrelated text").unwrap();
        for (id, changed) in [("before", false), ("after", true)] {
            let directory = root.path().join(format!(".munin/operation-runs/{id}"));
            fs::create_dir_all(&directory).unwrap();
            let image = image::RgbImage::from_fn(64, 40, |x, y| {
                image::Rgb([
                    if changed && x > 32 {
                        240
                    } else {
                        (x * 3) as u8
                    },
                    (y * 5) as u8,
                    20,
                ])
            });
            let mut bytes = std::io::Cursor::new(Vec::new());
            image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
            let bytes = markits::raster::embed_png_uimap(
                bytes.get_ref(),
                &[markits::UiElement::new("input", "Token", 0., 0., 24., 24.)],
            )
            .unwrap();
            fs::write(directory.join("settings.png"), &bytes).unwrap();
            if id == "before" {
                let scene =
                    json!({"annotations":[{"type":"mosaic","target":"Token","block_size":8}]});
                let rendered = crate::markits_scene::render_tracked(&scene, &bytes).unwrap();
                fs::write(root.path().join("docs/assets/old.png"), rendered).unwrap();
            }
            let script = json!({"version":1,"window":{"title":"Fixture","bounds":[0,0,64,40]},"steps":[{"kind":"screenshot","name":"settings"}]});
            let mut run = json!({"ok":true,"script":script,"captures":[{"name":"settings","step":1,"image":format!(".munin/operation-runs/{id}/settings.png")}]});
            if id == "before" {
                run["published"] = json!([{"name":"settings","image":"docs/assets/old.png"}]);
            }
            fs::write(directory.join("run.json"), run.to_string()).unwrap();
        }
        root
    }
    fn options() -> Value {
        json!({"before":".munin/operation-runs/before/run.json","after":".munin/operation-runs/after/run.json"})
    }
    #[test]
    fn comparison_links_manuscripts_preserves_mosaic_and_is_repeatable() {
        let root = fixture();
        let first = compare(root.path(), &options()).unwrap();
        let item = &first["images"][0];
        assert_eq!(item["changed"], true);
        assert!(item["ratio"].as_f64().unwrap() > 0.1);
        assert_eq!(item["documents"][0]["page"], "docs/index.md");
        let bytes =
            crate::resources::image_bytes(root.path(), item["after"].as_str().unwrap()).unwrap();
        let scene: Value = serde_json::from_str(
            &markits::raster::read_png_text_chunk(&bytes, "markits:annotations")
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(scene["annotations"][0]["type"], "mosaic");
        let image = image::load_from_memory(&bytes).unwrap().to_rgb8();
        assert_eq!(image.get_pixel(3, 3), image.get_pixel(4, 3));
        assert_eq!(compare(root.path(), &options()).unwrap(), first);
        let read = handle(
            root.path(),
            &json!({"action":"read","run":".munin/operation-runs/before/run.json"}),
        )
        .unwrap();
        assert_eq!(read["captures"][0]["documents"][0]["page"], "docs/index.md");
    }
    #[test]
    fn update_proposes_only_related_pages_with_revisions_without_writing() {
        let root = fixture();
        let before = fs::read_to_string(root.path().join("docs/index.md")).unwrap();
        let candidate=update_with(root.path(),&options(),|prompt,_,pictures|{assert!(prompt.contains("docs/index.md"));assert!(!prompt.contains("Unrelated text"));assert_eq!(pictures.len(),2);Ok(json!({"pages":[{"path":"docs/index.md","content":"# Updated\n\n![Settings](assets/old.png)"}]}))}).unwrap();
        assert_eq!(candidate["pages"][0]["before"], before);
        assert!(candidate["pages"][0]["revision"].is_string());
        assert!(candidate["pages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("recapture-"));
        assert_eq!(
            fs::read_to_string(root.path().join("docs/index.md")).unwrap(),
            before
        );
        assert!(update_with(root.path(), &options(), |_, _, _| Ok(
            json!({"pages":[{"path":"docs/unrelated.md","content":"wrong"}]})
        ))
        .is_err());
        fs::write(root.path().join("docs/index.md"), "Edited after proposal").unwrap();
        assert!(crate::draft_review::apply(
            root.path(),
            &json!({"docs":".","template":true,"pages":candidate["pages"]}).to_string()
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(root.path().join("docs/index.md")).unwrap(),
            "Edited after proposal"
        );
    }
}
