//! MarkIts owns capture and editing. Its integration PNG is kept byte-for-byte
//! so editable metadata travels with the project asset without extra sidecars.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path};

struct ImageEdit {
    _temporary: tempfile::TempDir,
    input: std::path::PathBuf,
    output: std::path::PathBuf,
    completion: std::path::PathBuf,
}

#[tauri::command]
pub async fn capture_markits_image(root: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let temporary = tempfile::Builder::new().prefix("munin-markits-capture-").tempdir().map_err(|e| e.to_string())?;
        let output = temporary.path().join("capture.png");
        let completion = temporary.path().join("complete.done");
        let status = std::process::Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
            .args(["--munin-markits", "--capture", "--manual-studio-output"])
            .arg(&output).arg("--manual-studio-completion").arg(&completion)
            .status().map_err(|e| format!("MarkItsを起動できません: {e}"))?;
        if !status.success() { return Err(format!("MarkItsが異常終了しました: {status}")); }
        if !completion.is_file() { return Ok(None); }
        let bytes = fs::read(&output).map_err(|e| format!("撮影結果を読めません: {e}"))?;
        markits_desktop_lib::metadata::load_image_with_metadata(&bytes).map_err(|e| e.to_string())?;
        save_render(Path::new(&root), &bytes).map(Some)
    }).await.map_err(|e| e.to_string())?
}

fn prepare_image_edit(root: &Path, asset: &str, page: Option<&str>) -> Result<ImageEdit, String> {
    let input = if let Some(page) = page {
        manual_core::preview::resolve_asset_path(root, page, asset)
            .or_else(|_| manual_core::config::project_path(root, asset))?
    } else { manual_core::config::project_path(root, asset)? };
    let bytes = fs::read(&input).map_err(|e| format!("編集する画像を読めません: {e}"))?;
    image::load_from_memory(&bytes).map_err(|e| format!("画像を読めません: {e}"))?;
    let temporary = tempfile::Builder::new().prefix("munin-markits-edit-").tempdir().map_err(|e| e.to_string())?;
    Ok(ImageEdit {
        output: temporary.path().join("edited.png"),
        completion: temporary.path().join("complete.done"),
        input, _temporary: temporary,
    })
}

#[tauri::command]
pub async fn edit_markits_image(root: String, asset: String, page: Option<String>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&root);
        let edit = prepare_image_edit(root, &asset, page.as_deref())?;
        let status = std::process::Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
            .arg("--munin-markits")
            .arg("--manual-studio-input").arg(&edit.input)
            .arg("--manual-studio-output").arg(&edit.output)
            .arg("--manual-studio-completion").arg(&edit.completion)
            .status().map_err(|e| format!("MarkItsを起動できません: {e}"))?;
        if !status.success() { return Err(format!("MarkItsが異常終了しました: {status}")); }
        if !edit.completion.is_file() { return Ok(None); }
        let bytes = fs::read(&edit.output).map_err(|e| format!("編集結果を読めません: {e}"))?;
        markits_desktop_lib::metadata::load_image_with_metadata(&bytes).map_err(|e| e.to_string())?;
        save_render(root, &bytes).map(Some)
    }).await.map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct Capture {
    id: String,
    date: String,
    width: u32,
    height: u32,
    thumbnail: String,
    recorded: bool,
}

#[tauri::command]
pub fn open_markits(capture: Option<bool>) -> Result<(), String> {
    let mut command = std::process::Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
    command.arg("--munin-markits");
    if capture.unwrap_or(false) { command.arg("--capture"); }
    let mut child = command.spawn()
        .map_err(|e| format!("MarkItsを起動できません: {e}"))?;
    std::thread::spawn(move || { let _ = child.wait(); });
    Ok(())
}

#[tauri::command]
pub async fn markits_captures() -> Result<Vec<Capture>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let history = markits_desktop_lib::history::list_history().map_err(|e| e.to_string())?;
        Ok(history.into_iter().take(200).map(|item| Capture {
            id: item.id, date: item.date_formatted, width: item.width, height: item.height,
            thumbnail: item.thumbnail_data_url, recorded: item.operation_group.is_some(),
        }).collect())
    }).await.map_err(|e| e.to_string())?
}

fn render_capture(loaded: &markits_desktop_lib::metadata::LoadedImageResult) -> Result<Vec<u8>, String> {
    let (_, encoded) = loaded.image_data_url.split_once(',').ok_or("画像を読めません。")?;
    let background = STANDARD.decode(encoded).map_err(|e| e.to_string())?;
    let rendered = if let Some(scene) = &loaded.annotations_json {
        markits::render_composed_png_bytes(scene, &background).map_err(|e| e.to_string())?
    } else { background };
    // Never publish originals, UI maps, or recorded input embedded in history.
    let image = image::load_from_memory(&rendered).map_err(|e| e.to_string())?;
    let mut png = std::io::Cursor::new(Vec::new());
    image.write_to(&mut png, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(png.into_inner())
}

fn save_render(root: &Path, png: &[u8]) -> Result<String, String> {
    let assets = manual_core::config::read_config(root).assets;
    let digest = format!("{:x}", Sha256::digest(png));
    let relative = format!("{}/markits/{digest}.png", assets.trim_end_matches('/'));
    let path = manual_core::config::project_path(root, &relative)?;
    if path.exists() {
        if fs::read(&path).map_err(|e| e.to_string())? != png {
            return Err("取り込み先の画像が変更されています。別の保存先を指定してください。".into());
        }
        return Ok(relative);
    }
    let parent = path.parent().ok_or("画像保存先が不正です。")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    file.write_all(png).map_err(|e| e.to_string())?;
    if let Err(error) = file.persist_noclobber(&path) {
        // Another import may have committed the same content in the meantime.
        if fs::read(&path).ok().as_deref() != Some(png) {
            return Err(error.to_string());
        }
    }
    Ok(relative)
}

#[tauri::command]
pub async fn import_markits_capture(root: String, id: String) -> Result<String, String> {
    // Upstream history loaders accept an ID, not an arbitrary path.
    if id.is_empty() || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
        return Err("MarkIts画像の識別情報が不正です。".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let loaded = markits_desktop_lib::history::load_history_item(&id).map_err(|e| e.to_string())?;
        save_render(Path::new(&root), &render_capture(&loaded)?)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn import_markits_image(root: String, source: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, encoded) = source.split_once(',').ok_or("画像を選択してください。")?;
        let png = STANDARD.decode(encoded).map_err(|e| e.to_string())?;
        let loaded = markits_desktop_lib::metadata::load_image_with_metadata(&png).map_err(|e| e.to_string())?;
        if png.starts_with(b"\x89PNG\r\n\x1a\n") {
            save_render(Path::new(&root), &png)
        } else {
            save_render(Path::new(&root), &render_capture(&loaded)?)
        }
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_edit_roundtrip_preserves_uimap_crop_original_scene_and_operations() {
        use markits_desktop_lib::{commands, metadata, ui_elements::DetectedUiElement};
        let root = tempfile::tempdir().unwrap();
        let handoff = tempfile::tempdir().unwrap();
        let output = handoff.path().join("returned.png");
        let base = image::DynamicImage::ImageRgba8(image::RgbaImage::from_fn(160, 120, |x, y| image::Rgba([x as u8, y as u8, 70, 255])));
        let cropped = base.crop_imm(20, 10, 80, 60);
        let encode = |image: &image::DynamicImage| {
            let mut png = std::io::Cursor::new(Vec::new());
            image.write_to(&mut png, image::ImageFormat::Png).unwrap();
            format!("data:image/png;base64,{}", STANDARD.encode(png.into_inner()))
        };
        let scene = r#"{"canvas":{"width":80,"height":60},"annotations":[{"type":"rect","target":[10,10,40,20],"style":"primary"}]}"#;
        let element = |x, y| DetectedUiElement { role: "button".into(), name: Some("Save".into()),
            x, y, width: 12.0, height: 8.0, window_id: None, pid: None };
        let expected_ui = vec![element(20.0, 10.0)];
        let expected_base_ui = vec![element(40.0, 20.0), element(140.0, 100.0)];
        let initial = STANDARD.decode(encode(&cropped).split_once(',').unwrap().1).unwrap();
        let tagged = metadata::embed_text_chunk(&initial, "markits:operations", "recorded operations").unwrap();
        let mut background = format!("data:image/png;base64,{}", STANDARD.encode(tagged));
        let mut base_url = encode(&base);
        let mut first_path = None;
        for _ in 0..3 {
            commands::cmd_compose_and_save(background, scene.into(), output.to_string_lossy().into(),
                Some(expected_ui.clone()), Some(40), Some(30), false, Some(base_url),
                Some(metadata::CropInfo { is_auto_cropped: false, offset_x: 20.0, offset_y: 10.0, base_width: 160, base_height: 120 }),
                Some(commands::EditingMetadata { base_ui_elements: Some(expected_base_ui.clone()) })).unwrap();
            let bytes = fs::read(&output).unwrap();
            assert_eq!(image::load_from_memory(&bytes).unwrap().width(), 40);
            let path = save_render(root.path(), &bytes).unwrap();
            if let Some(first) = &first_path { assert_eq!(&path, first, "reopening must not nest metadata or duplicate assets"); }
            else { first_path = Some(path.clone()); }
            let edit = prepare_image_edit(root.path(), &path, None).unwrap();
            let saved = fs::read(&edit.input).unwrap();
            assert_eq!(saved, bytes, "Munin must not flatten the editable PNG");
            let loaded = metadata::load_image_with_metadata(&saved).unwrap();
            assert_eq!((loaded.width, loaded.height), (80, 60));
            assert_eq!((loaded.base_width, loaded.base_height), (Some(160), Some(120)));
            assert_eq!(loaded.ui_elements.as_ref(), Some(&expected_ui));
            assert_eq!(loaded.base_ui_elements.as_ref(), Some(&expected_base_ui));
            assert_eq!(loaded.annotations_json.as_deref(), Some(scene));
            let crop = loaded.crop_info.unwrap();
            assert_eq!((crop.offset_x, crop.offset_y), (20.0, 10.0));
            assert_eq!(metadata::extract_text_chunk(&saved, "markits:operations").unwrap().as_deref(), Some("recorded operations"));
            let restored = STANDARD.decode(loaded.image_data_url.split_once(',').unwrap().1).unwrap();
            assert_eq!(image::load_from_memory(&restored).unwrap().to_rgba8(), cropped.to_rgba8());
            background = loaded.image_data_url;
            base_url = loaded.base_image_data_url.unwrap();
        }
        assert_eq!(walkdir_count(root.path()), 1);
        assert!(!root.path().join(".munin").exists());
    }
    #[test]
    fn selected_document_image_is_opened_without_copying_it_into_the_project() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs/assets")).unwrap();
        let input = root.path().join("docs/assets/selected.png");
        image::DynamicImage::new_rgba8(80, 60).save(&input).unwrap();
        let before = fs::read(&input).unwrap();
        let edit = prepare_image_edit(root.path(), "assets/selected.png", Some("index.md")).unwrap();
        assert_eq!(edit.input.canonicalize().unwrap(), input.canonicalize().unwrap());
        assert!(!edit.output.starts_with(root.path()));
        assert_eq!(walkdir_count(root.path()), 1);
        assert_eq!(fs::read(&input).unwrap(), before);
        let temporary = edit.output.parent().unwrap().to_path_buf();
        drop(edit);
        assert!(!temporary.exists());
        assert!(prepare_image_edit(root.path(), "../outside.png", None).is_err());
    }
    #[test]
    fn history_import_keeps_rendered_pixels_without_private_metadata_or_duplicate_assets() {
        let root = tempfile::tempdir().unwrap();
        let image = image::DynamicImage::new_rgba8(20, 16);
        let mut png = std::io::Cursor::new(Vec::new());
        image.write_to(&mut png, image::ImageFormat::Png).unwrap();
        let private = markits::raster::embed_png_text_chunk(png.get_ref(), "markits:operations", "private input").unwrap();
        let loaded = markits_desktop_lib::metadata::load_image_with_metadata(&private).unwrap();
        let rendered = render_capture(&loaded).unwrap();
        assert!(markits::raster::extract_png_text_chunk(&rendered, "markits:operations").is_none());
        assert_eq!(image::load_from_memory(&rendered).unwrap().to_rgba8(), image.to_rgba8());
        let path = save_render(root.path(), &rendered).unwrap();
        assert_eq!(save_render(root.path(), &rendered).unwrap(), path);
        assert_eq!(walkdir_count(root.path()), 1);
        assert!(!root.path().join(".munin").exists());
        fs::write(manual_core::config::project_path(root.path(), &path).unwrap(), b"external change").unwrap();
        assert!(save_render(root.path(), &rendered).is_err());
    }
    fn walkdir_count(path: &Path) -> usize {
        fs::read_dir(path).unwrap().map(|entry| {
            let path = entry.unwrap().path();
            if path.is_dir() { walkdir_count(&path) } else { 1 }
        }).sum()
    }

    #[test]
    fn annotations_are_rendered_before_import_and_history_is_unchanged() {
        let image = image::DynamicImage::new_rgba8(80, 60);
        let mut png = std::io::Cursor::new(Vec::new());
        image.write_to(&mut png, image::ImageFormat::Png).unwrap();
        let scene = r#"{"canvas":{"width":80,"height":60},"annotations":[{"type":"rect","target":[10,10,40,30],"style":"primary"}]}"#;
        let private = markits::raster::embed_png_text_chunk(png.get_ref(), "markits:annotations", scene).unwrap();
        let loaded = markits_desktop_lib::metadata::load_image_with_metadata(&private).unwrap();
        let rendered = render_capture(&loaded).unwrap();
        assert_ne!(image::load_from_memory(&rendered).unwrap().to_rgba8(), image.to_rgba8());
        assert!(markits::raster::extract_png_text_chunk(&rendered, "markits:annotations").is_none());
        assert_eq!(loaded.annotations_json.as_deref(), Some(scene));
    }

    #[test]
    fn history_ids_cannot_escape_the_history_directory() {
        for id in ["../private", "a/b", "a\\b", "", "C:secret"] {
            assert!(tauri::async_runtime::block_on(import_markits_capture("unused".into(), id.into())).is_err());
        }
    }
}
