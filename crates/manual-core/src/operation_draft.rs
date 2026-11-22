//! Generate procedural Markdown drafts from MarkIts operation recordings, scripts, UIMaps, and annotations.
use crate::{
    capture_resources,
    config::{project_path, read_config},
    glossary,
};
use serde_json::{json, Value};
use std::{fs, path::Path};

fn relative_asset_from_page(root: &Path, image_rel: &str, page: Option<&str>) -> String {
    let config = read_config(root);
    let page_rel = match page {
        Some(p) if !p.trim().is_empty() => {
            let clean = p.trim().replace('\\', "/");
            if clean.starts_with(&format!("{}/", config.docs.trim_end_matches('/')))
                || config.docs == "."
            {
                clean
            } else {
                format!("{}/{}", config.docs.trim_end_matches('/'), clean)
            }
        }
        _ => return image_rel.replace('\\', "/"),
    };
    let page_dir = Path::new(&page_rel)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let img_path = Path::new(image_rel);
    let page_parts: Vec<_> = page_dir.components().collect();
    let img_parts: Vec<_> = img_path.components().collect();
    let mut common = 0usize;
    while common < page_parts.len()
        && common < img_parts.len()
        && page_parts[common] == img_parts[common]
    {
        common += 1;
    }
    let mut rel_parts: Vec<String> = vec!["..".into(); page_parts.len() - common];
    for comp in &img_parts[common..] {
        rel_parts.push(comp.as_os_str().to_string_lossy().into_owned());
    }
    if rel_parts.is_empty() {
        image_rel.replace('\\', "/")
    } else {
        rel_parts.join("/")
    }
}

fn format_circled(step: usize) -> String {
    const CIRCLED: [char; 20] = [
        '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩',
        '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳',
    ];
    if (1..=20).contains(&step) {
        CIRCLED[step - 1].to_string()
    } else {
        format!("({step})")
    }
}

fn find_uimap_at(x: f64, y: f64, uimap: &[markits::UiElement]) -> Option<String> {
    uimap
        .iter()
        .filter(|el| {
            !el.name.trim().is_empty()
                && x >= el.x
                && x <= el.x + el.width
                && y >= el.y
                && y <= el.y + el.height
        })
        .min_by(|a, b| {
            (a.width * a.height)
                .partial_cmp(&(b.width * b.height))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|el| el.name.trim().to_string())
}

fn step_from_script_item(item: &Value) -> Option<String> {
    match item["kind"].as_str().unwrap_or("") {
        "click" => {
            let name = item["target"]["name"].as_str().map(str::trim).filter(|s| !s.is_empty());
            let role = item["target"]["role"].as_str().unwrap_or("");
            match (name, role) {
                (Some(n), "button") => Some(format!("「**{n}**」ボタンをクリックします。")),
                (Some(n), "input" | "textbox") => Some(format!("「**{n}**」入力欄を選択します。")),
                (Some(n), "checkbox") => Some(format!("「**{n}**」チェックボックスを切り替えます。")),
                (Some(n), "tab") => Some(format!("「**{n}**」タブを開きます。")),
                (Some(n), _) => Some(format!("「**{n}**」をクリックします。")),
                (None, _) => Some("画面上の対象箇所をクリックします。".into()),
            }
        }
        "text" => {
            let value = item["value"].as_str().unwrap_or("");
            if value.is_empty() {
                None
            } else {
                Some(format!("`{value}` と入力します。"))
            }
        }
        "key" => {
            let value = item["value"].as_str().unwrap_or("");
            if value.is_empty() {
                None
            } else {
                Some(format!("`{value}` キーを押します。"))
            }
        }
        "wait_for" => {
            let name = item["target"]["name"].as_str().map(str::trim).filter(|s| !s.is_empty());
            let state = item["state"].as_str().unwrap_or("visible");
            match (name, state) {
                (Some(n), "hidden") => Some(format!("「**{n}**」が閉じる（非表示になる）まで待ちます。")),
                (Some(n), "value") => {
                    let expected = item["value"].as_str().unwrap_or("");
                    Some(format!("「**{n}**」の値が `{expected}` になることを確認します。"))
                }
                (Some(n), _) => Some(format!("「**{n}**」が表示されることを確認します。")),
                _ => None,
            }
        }
        _ => None,
    }
}

fn step_from_recorded_op(item: &Value, uimap: &[markits::UiElement]) -> Option<String> {
    let kind = item["type"]
        .as_str()
        .or_else(|| item["kind"].as_str())
        .or_else(|| item["action"].as_str())
        .unwrap_or("");
    let explicit_name = item["target"]["name"]
        .as_str()
        .or_else(|| item["element"]["name"].as_str())
        .or_else(|| item["label"].as_str())
        .or_else(|| item["name"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let x = item["x"].as_f64()?;
            let y = item["y"].as_f64()?;
            find_uimap_at(x, y, uimap)
        });
    match kind.to_lowercase().as_str() {
        "click" | "mouse_click" | "mousedown" | "press" => Some(match explicit_name {
            Some(name) => format!("「**{name}**」をクリックします。"),
            None => "対象箇所をクリックします。".into(),
        }),
        "double_click" | "dblclick" => Some(match explicit_name {
            Some(name) => format!("「**{name}**」をダブルクリックします。"),
            None => "対象箇所をダブルクリックします。".into(),
        }),
        "text" | "type" | "input" | "text_input" => {
            let value = item["text"]
                .as_str()
                .or_else(|| item["value"].as_str())
                .unwrap_or("");
            if value.is_empty() {
                None
            } else {
                Some(format!("`{value}` と入力します。"))
            }
        }
        "key" | "key_press" | "shortcut" => {
            let key = item["key"]
                .as_str()
                .or_else(|| item["value"].as_str())
                .unwrap_or("");
            if key.is_empty() {
                None
            } else {
                Some(format!("`{key}` キーを押します。"))
            }
        }
        _ => None,
    }
}

fn steps_from_annotations(scene: &Value, uimap: &[markits::UiElement]) -> Vec<String> {
    let Some(annotations) = scene.get("annotations").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut badges: Vec<(usize, Option<String>)> = Vec::new();
    for ann in annotations {
        if ann["type"].as_str() != Some("badge") {
            continue;
        }
        let Some(step) = ann["step"].as_u64() else {
            continue;
        };
        let label = ann
            .get("target")
            .and_then(|target| {
                if let Some(s) = target.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    return Some(s.to_string());
                }
                let arr = target.as_array()?;
                if arr.len() != 4 {
                    return None;
                }
                let cx = arr[0].as_f64()? + arr[2].as_f64()? / 2.0;
                let cy = arr[1].as_f64()? + arr[3].as_f64()? / 2.0;
                find_uimap_at(cx, cy, uimap)
            });
        badges.push((step as usize, label));
    }
    badges.sort_by_key(|(step, _)| *step);
    badges
        .into_iter()
        .map(|(step, label)| {
            let circled = format_circled(step);
            match label {
                Some(name) => format!("「**{name}**」（{circled}）を操作します。"),
                None => format!("{circled} の箇所を操作します。"),
            }
        })
        .collect()
}

/// List available PNGs/capture resources that contain recording, script, or annotation metadata.
pub fn list_sources(root: &Path) -> Result<Value, String> {
    let mut items = Vec::new();
    if let Ok(resources) = capture_resources::catalog(root) {
        for resource in resources {
            let Ok(src) = capture_resources::source(root, &resource.id) else {
                continue;
            };
            let Ok(bytes) = fs::read(&src) else { continue };
            let has_script = markits::raster::extract_png_text_chunk(&bytes, "markits:operation_script").is_some();
            let has_ops = markits::raster::extract_png_text_chunk(&bytes, "markits:operations").is_some();
            let has_ann = markits::raster::extract_png_text_chunk(&bytes, "markits:annotations").is_some();
            let uimap_count = markits::raster::extract_png_uimap(&bytes).map_or(0, |v| v.len());
            let doc_path = resource.derived.first().map(|d| d.path.clone());
            items.push(json!({
                "resource_id": resource.id,
                "name": resource.name,
                "path": doc_path,
                "has_script": has_script,
                "has_operations": has_ops || resource.recorded,
                "has_annotations": has_ann,
                "uimap_elements": uimap_count,
            }));
        }
    }
    Ok(json!({ "items": items }))
}

/// Build a procedural Markdown draft from a recorded/annotated PNG or capture resource ID.
pub fn generate(
    root: &Path,
    image: Option<&str>,
    resource_id: Option<&str>,
    page: Option<&str>,
    title: Option<&str>,
    use_ai: bool,
) -> Result<Value, String> {
    let (bytes, display_rel, default_title) = match (image, resource_id) {
        (Some(path), _) if !path.trim().is_empty() => {
            let rel = path.trim().replace('\\', "/");
            let full = project_path(root, &rel)?;
            let mut raw = fs::read(&full).map_err(|e| format!("画像を読み込めません: {e}"))?;
            // Prefer editing source when document PNG has stripped metadata.
            if markits::raster::extract_png_text_chunk(&raw, "markits:operation_script").is_none()
                && markits::raster::extract_png_text_chunk(&raw, "markits:operations").is_none()
                && markits::raster::extract_png_text_chunk(&raw, "markits:annotations").is_none()
            {
                if let Ok(Some(editing)) = capture_resources::editing_source(root, &rel) {
                    if let Ok(edit_bytes) = fs::read(editing) {
                        raw = edit_bytes;
                    }
                }
            }
            let stem = full
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("操作手順")
                .to_string();
            (raw, rel, stem)
        }
        (_, Some(id)) if !id.trim().is_empty() => {
            let resource = capture_resources::load(root, id.trim())?;
            let src_path = capture_resources::source(root, &resource.id)?;
            let mut raw = fs::read(&src_path).map_err(|e| e.to_string())?;
            // If derived editing PNG has annotations, prefer it when source lacks annotations.
            if markits::raster::extract_png_text_chunk(&raw, "markits:annotations").is_none() {
                if let Some(derived) = resource.derived.first() {
                    if let Ok(edit_path) = project_path(root, &derived.editing) {
                        if let Ok(edit_bytes) = fs::read(edit_path) {
                            raw = edit_bytes;
                        }
                    }
                }
            }
            let doc_path = if let Some(derived) = resource.derived.first() {
                derived.path.clone()
            } else {
                capture_resources::generate(root, &resource.id, None, None)?.path
            };
            (raw, doc_path, resource.name)
        }
        _ => return Err("対象画像パスまたは撮影リソースIDを指定してください。".into()),
    };

    let uimap = markits::raster::extract_png_uimap(&bytes).unwrap_or_default();
    let script_json = markits::raster::extract_png_text_chunk(&bytes, "markits:operation_script")
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let ops_json = markits::raster::extract_png_text_chunk(&bytes, "markits:operations")
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let scene_json = markits::raster::extract_png_text_chunk(&bytes, "markits:annotations")
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());

    let mut steps: Vec<String> = Vec::new();
    let mut source_kind = "uimap";

    if let Some(script) = &script_json {
        if let Some(arr) = script["steps"].as_array() {
            for item in arr {
                if let Some(line) = step_from_script_item(item) {
                    steps.push(line);
                }
            }
            if !steps.is_empty() {
                source_kind = "operation_script";
            }
        }
    }
    if steps.is_empty() {
        if let Some(ops) = &ops_json {
            let list = ops
                .as_array()
                .or_else(|| ops["steps"].as_array())
                .or_else(|| ops["operations"].as_array())
                .or_else(|| ops["events"].as_array());
            if let Some(arr) = list {
                for item in arr {
                    if let Some(line) = step_from_recorded_op(item, &uimap) {
                        steps.push(line);
                    }
                }
                if !steps.is_empty() {
                    source_kind = "operations";
                }
            }
        }
    }
    if steps.is_empty() {
        if let Some(scene) = &scene_json {
            steps = steps_from_annotations(scene, &uimap);
            if !steps.is_empty() {
                source_kind = "annotations";
            }
        }
    }
    if steps.is_empty() && !uimap.is_empty() {
        for el in uimap.iter().filter(|e| !e.name.trim().is_empty()).take(5) {
            steps.push(format!("「**{}**」を確認・操作します。", el.name.trim()));
        }
    }
    if steps.is_empty() {
        steps.push("画面の内容を確認し、必要な操作を行います。".into());
    }

    let heading = title
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&default_title);
    let rel_img = relative_asset_from_page(root, &display_rel, page);
    let numbered: String = steps
        .iter()
        .enumerate()
        .map(|(i, s)| format!("{}. {}", i + 1, s))
        .collect::<Vec<_>>()
        .join("\n");

    let mut markdown = format!(
        "## {heading}\n\n![{heading}](<{rel_img}>)\n\n{numbered}\n\n**操作後の結果**: 変更が画面に反映されます。\n"
    );
    let mut ai_refined = false;

    if use_ai {
        let config = read_config(root);
        if config.connection_type != "none" {
            let glossary_hint = glossary::prompt_section(root, &markdown);
            let prompt = format!(
                "Polish this auto-generated procedural manual draft into clear, concise Japanese Markdown. Keep the exact image link, UI labels, and factual steps without inventing features. Return only the revised Markdown in the content field.\n{glossary_hint}\nDraft JSON: {}",
                json!({
                    "heading": heading,
                    "source_kind": source_kind,
                    "draft": markdown,
                    "uimap": uimap.iter().take(40).map(|e| json!({"role": e.role, "name": e.name})).collect::<Vec<_>>()
                })
            );
            let schema = json!({
                "type": "object",
                "properties": { "content": { "type": "string" } },
                "required": ["content"],
                "additionalProperties": false
            });
            if let Ok(answer) =
                crate::agent::agent_json(root, &prompt, &schema, &config.agent, &config.model)
            {
                if let Some(polished) = answer["content"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && s.len() <= 200_000)
                {
                    markdown = format!("{polished}\n");
                    ai_refined = true;
                }
            }
        }
    }

    Ok(json!({
        "markdown": markdown,
        "source_kind": source_kind,
        "step_count": steps.len(),
        "uimap_elements": uimap.len(),
        "image": display_rel,
        "ai_refined": ai_refined
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_procedural_draft_from_operation_script_png() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs/assets")).unwrap();
        let mut buf = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(120, 90)
            .write_to(&mut buf, image::ImageFormat::Png)
            .unwrap();
        let png = markits::raster::embed_png_text_chunk(
            &buf.into_inner(),
            "markits:operation_script",
            &json!({
                "version": 1,
                "steps": [
                    {"kind": "click", "target": {"role": "button", "name": "設定"}},
                    {"kind": "text", "value": "サンプル"},
                    {"kind": "click", "target": {"role": "button", "name": "保存"}},
                    {"kind": "wait_for", "target": {"role": "button", "name": "完了"}, "state": "visible"}
                ]
            })
            .to_string(),
        )
        .unwrap();
        fs::write(root.path().join("docs/assets/rec.png"), png).unwrap();

        let result = generate(
            root.path(),
            Some("docs/assets/rec.png"),
            None,
            Some("docs/guide.md"),
            Some("設定の保存手順"),
            false,
        )
        .unwrap();
        assert_eq!(result["source_kind"], "operation_script");
        assert_eq!(result["step_count"], 4);
        let md = result["markdown"].as_str().unwrap();
        assert!(md.contains("## 設定の保存手順"));
        assert!(md.contains("![設定の保存手順](<assets/rec.png>)"));
        assert!(md.contains("「**設定**」ボタンをクリックします。"));
        assert!(md.contains("`サンプル` と入力します。"));
        assert!(md.contains("「**保存**」ボタンをクリックします。"));
    }
}
