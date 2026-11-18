//! MarkIts owns capture and editing. Studio stores private resources and public derivatives.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path};

fn markits_command()->Result<std::process::Command,String>{
    let mut command=std::process::Command::new(std::env::current_exe().map_err(|e|e.to_string())?);
    // Independent apps must not share Studio's WebView2 profile or test debugger.
    command.env_remove("WEBVIEW2_USER_DATA_FOLDER").env_remove("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
    Ok(command)
}

#[tauri::command]
pub fn get_markits_capture_shortcut() -> String { markits_desktop_lib::saved_capture_shortcut() }

#[tauri::command]
pub fn set_markits_capture_shortcut(shortcut: String) -> Result<(), String> {
    markits_desktop_lib::save_capture_shortcut(&shortcut)
}

struct ImageEdit {
    _temporary: tempfile::TempDir,
    input: std::path::PathBuf,
    output: std::path::PathBuf,
    completion: std::path::PathBuf,
    resource_id: Option<String>,
}

#[tauri::command]
pub async fn capture_markits_image(app:tauri::AppHandle,root: String, include_cursor: Option<bool>, shortcut: Option<String>) -> Result<Option<manual_core::capture_resources::Resource>, String> {
    if RESOURCE_OPERATION.swap(true,std::sync::atomic::Ordering::SeqCst){return Err("撮影処理が実行中です。".into());}
    let guard=ResourceOperation;
    use tauri::Manager;
    let main=app.get_webview_window("main");
    if let Some(window)=&main{let _=window.hide();}
    let result=tauri::async_runtime::spawn_blocking(move || {
        let _guard=guard;
        let temporary = tempfile::Builder::new().prefix("munin-markits-capture-").tempdir().map_err(|e| e.to_string())?;
        let output = temporary.path().join("capture.png");
        let completion = temporary.path().join("complete.done");
        let mut command = markits_command()?;
        let shortcut = shortcut.unwrap_or_else(markits_desktop_lib::saved_capture_shortcut);
        markits_desktop_lib::LaunchCaptureOptions::parse(&["--capture-shortcut".into(), shortcut.clone()])?;
        command.args(["--munin-markits", "--capture", "--capture-shortcut"]).arg(shortcut);
        command.arg(if include_cursor.unwrap_or(false) { "--include-cursor" } else { "--no-cursor" });
        let status = command.arg("--manual-studio-output")
            .arg(&output).arg("--manual-studio-completion").arg(&completion)
            .status().map_err(|e| format!("MarkItsを起動できません: {e}"))?;
        if !status.success() { return Err(format!("MarkItsが異常終了しました: {status}")); }
        if !completion.is_file() { return Ok(None); }
        let bytes = fs::read(&output).map_err(|e| format!("撮影結果を読めません: {e}"))?;
        markits_desktop_lib::metadata::load_image_with_metadata(&bytes).map_err(|e| e.to_string())?;
        manual_core::capture_resources::register(Path::new(&root), &bytes,"撮影画像").map(Some)
    }).await.map_err(|e| e.to_string()).and_then(|r|r);
    if let Some(window)=main{let _=window.show();let _=window.set_focus();}
    result
}

fn prepare_image_edit(root: &Path, asset: &str, page: Option<&str>) -> Result<ImageEdit, String> {
    let input = if let Some(page) = page {
        manual_core::preview::resolve_asset_path(root, page, asset)
            .or_else(|_| manual_core::config::project_path(root, asset))?
    } else { manual_core::config::project_path(root, asset)? };
    let canonical_root=root.canonicalize().map_err(|e|e.to_string())?;
    let relative=input.strip_prefix(&canonical_root).map_err(|e|e.to_string())?.to_string_lossy().replace('\\',"/");
    let resource_id=manual_core::capture_resources::registered_id(root,&fs::read(&input).map_err(|e|e.to_string())?)?;
    let input=manual_core::capture_resources::editing_source(root,&relative)?.unwrap_or(input);
    let bytes = fs::read(&input).map_err(|e| format!("編集する画像を読めません: {e}"))?;
    image::load_from_memory(&bytes).map_err(|e| format!("画像を読めません: {e}"))?;
    let temporary = tempfile::Builder::new().prefix("munin-markits-edit-").tempdir().map_err(|e| e.to_string())?;
    Ok(ImageEdit {
        output: temporary.path().join("edited.png"),
        completion: temporary.path().join("complete.done"),
        input, resource_id, _temporary: temporary,
    })
}

#[tauri::command]
pub async fn edit_markits_image(root: String, asset: String, page: Option<String>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&root);
        let edit = prepare_image_edit(root, &asset, page.as_deref())?;
        let status = markits_command()?
            .arg("--munin-markits")
            .arg("--manual-studio-input").arg(&edit.input)
            .arg("--manual-studio-output").arg(&edit.output)
            .arg("--manual-studio-completion").arg(&edit.completion)
            .status().map_err(|e| format!("MarkItsを起動できません: {e}"))?;
        if !status.success() { return Err(format!("MarkItsが異常終了しました: {status}")); }
        if !edit.completion.is_file() { return Ok(None); }
        let bytes = fs::read(&edit.output).map_err(|e| format!("編集結果を読めません: {e}"))?;
        markits_desktop_lib::metadata::load_image_with_metadata(&bytes).map_err(|e| e.to_string())?;
        let resource=match &edit.resource_id {
            Some(id)=>manual_core::capture_resources::load(root,id)?,
            None=>manual_core::capture_resources::register(root,&bytes,"編集画像")?,
        };
        manual_core::capture_resources::generate(root,&resource.id,None,Some(&bytes)).map(|d|Some(d.path))
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
    let mut command = markits_command()?;
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

static RESOURCE_OPERATION: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
struct ResourceOperation;
impl Drop for ResourceOperation {fn drop(&mut self){RESOURCE_OPERATION.store(false,std::sync::atomic::Ordering::SeqCst);}}

/// Rebuild an independently editable derivative on the freshly captured source.
fn recompose_variant(old:&[u8],fresh:&[u8])->Result<Vec<u8>,String> {
    use markits_desktop_lib::{metadata,commands};
    let state=metadata::load_image_with_metadata(old).map_err(|e|e.to_string())?;
    let base=metadata::load_image_with_metadata(fresh).map_err(|e|e.to_string())?;
    let base_url=base.base_image_data_url.as_ref().unwrap_or(&base.image_data_url);
    let raw=STANDARD.decode(base_url.split_once(',').ok_or("原本を読めません。")?.1).map_err(|e|e.to_string())?;
    let full=image::load_from_memory(&raw).map_err(|e|e.to_string())?;
    let background=if let Some(crop)=&state.crop_info {
        let x=crop.offset_x as u32;let y=crop.offset_y as u32;
        if x.checked_add(state.width).is_none_or(|end|end>full.width())||y.checked_add(state.height).is_none_or(|end|end>full.height()) {return Err("新しい撮影画像にクロップ範囲が収まりません。".into());}
        let mut output=std::io::Cursor::new(vec![]);
        full.crop_imm(x,y,state.width,state.height).write_to(&mut output,image::ImageFormat::Png).map_err(|e|e.to_string())?;
        markits_desktop_lib::playback::copy_metadata(&output.into_inner(),&raw).map_err(|e|e.to_string())?
    }else{raw};
    let scene=state.annotations_json.unwrap_or_else(||format!(r#"{{"canvas":{{"width":{},"height":{}}},"annotations":[]}}"#,full.width(),full.height()));
    let temp=tempfile::tempdir().map_err(|e|e.to_string())?;let output=temp.path().join("variant.png");
    let previous_render=image::load_from_memory(old).map_err(|e|e.to_string())?;
    commands::cmd_compose_and_save(format!("data:image/png;base64,{}",STANDARD.encode(background)),scene,output.to_string_lossy().into(),base.ui_elements,Some(previous_render.width()),Some(previous_render.height()),false,Some(base_url.clone()),state.crop_info,Some(commands::EditingMetadata{base_ui_elements:base.base_ui_elements} ))?;
    fs::read(output).map_err(|e|e.to_string())
}

fn apply_recapture(root:&Path,id:&str,expected:&str,fresh:&[u8],force:bool)->Result<manual_core::capture_resources::Resource,String> {
    let r=manual_core::capture_resources::load(root,id)?;
    let previous=fs::read(manual_core::capture_resources::source(root,id)?).map_err(|e|e.to_string())?;
    let old=markits_desktop_lib::metadata::load_image_with_metadata(&previous).map_err(|e|e.to_string())?;
    let new=markits_desktop_lib::metadata::load_image_with_metadata(fresh).map_err(|e|e.to_string())?;
    let size=|v:&markits_desktop_lib::metadata::LoadedImageResult|(v.base_width.unwrap_or(v.width),v.base_height.unwrap_or(v.height));
    // Derivatives store pixel coordinates. Recomposition checks that each crop
    // fits the new source and preserves its annotation scene and output size.
    let review=!force && size(&old)!=size(&new) && r.derived.iter().any(|d|!d.protected);
    let variants=if review {vec![]} else {r.derived.iter().filter(|d|!d.protected).map(|d|{
        let old=fs::read(manual_core::config::project_path(root,&d.editing)?).map_err(|e|e.to_string())?;
        Ok((d.id.clone(),recompose_variant(&old,fresh)?))
    }).collect::<Result<Vec<_>,String>>()?};
    manual_core::capture_resources::update(root,id,expected,fresh,variants,review)
}

#[tauri::command]
pub async fn recapture_capture_resource(app:tauri::AppHandle,root:String,id:String)->Result<Option<manual_core::capture_resources::Resource>,String> {
    if RESOURCE_OPERATION.swap(true,std::sync::atomic::Ordering::SeqCst){return Err("撮影処理が実行中です。".into());}
    let guard=ResourceOperation;
    use tauri::Manager;
    let main=app.get_webview_window("main");
    if let Some(window)=&main{let _=window.hide();}
    let result=tauri::async_runtime::spawn_blocking(move||{
        let _guard=guard;let root=Path::new(&root);let r=manual_core::capture_resources::load(root,&id)?;
        let input=manual_core::capture_resources::source(root,&id)?;
        if !r.recorded {
            use markits_desktop_lib::playback;
            let source = fs::read(&input).map_err(|e| e.to_string())?;
            let target = manual_core::capture_resources::window_recapture_target(&source)
                .ok_or("このリソースには操作記録や撮影先ウィンドウの情報がありません。")?;
            let window = playback::resolve_window(target.window_id.as_deref(), target.pid, target.name.as_deref())?;
            let fresh = playback::snapshot(&window.id)?;
            return apply_recapture(root, &id, &r.revision, &fresh, false).map(Some);
        }
        let temp=tempfile::tempdir().map_err(|e|e.to_string())?;let output=temp.path().join("recapture.png");let complete=temp.path().join("complete.done");
        let status=markits_command()?.arg("--munin-markits")
            .arg("--manual-studio-recapture").arg("--manual-studio-input").arg(input).arg("--manual-studio-output").arg(&output).arg("--manual-studio-completion").arg(&complete).status().map_err(|e|e.to_string())?;
        if !status.success(){return Err(format!("MarkItsが異常終了しました: {status}"));}
        let completion = match fs::read_to_string(&complete) {
            Ok(completion) => completion,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        if let Some(error) = completion.strip_prefix("error:") { return Err(error.into()); }
        if completion != "saved" { return Err("再撮影の完了通知が不正です。".into()); }
        let fresh=fs::read(output).map_err(|e|e.to_string())?;
        apply_recapture(root,&id,&r.revision,&fresh,false).map(Some)
    }).await.map_err(|e|e.to_string()).and_then(|r|r);
    if let Some(window)=main{let _=window.show();let _=window.set_focus();}
    result
}

#[tauri::command]
pub async fn adopt_capture_resource(root:String,id:String)->Result<manual_core::capture_resources::Resource,String> {
    tauri::async_runtime::spawn_blocking(move||{
        let root=Path::new(&root);let r=manual_core::capture_resources::load(root,&id)?;
        let pending=r.pending.as_ref().ok_or("比較する候補がありません。")?;
        let path=manual_core::config::project_path(root,&format!(".munin/capture-resources/{id}/revisions/{pending}.png"))?;
        apply_recapture(root,&id,&r.revision,&fs::read(path).map_err(|e|e.to_string())?,true)
    }).await.map_err(|e|e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn document_resource_id_restores_private_editing_state_and_survives_reopening() {
        use manual_core::capture_resources as resources;
        let root=tempfile::tempdir().unwrap();
        let mut png=std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(80,60).write_to(&mut png,image::ImageFormat::Png).unwrap();
        let original=markits::raster::embed_png_text_chunk(png.get_ref(),"markits:annotations",r#"{"canvas":{"width":80,"height":60},"annotations":[]}"#).unwrap();
        let original=markits::raster::embed_png_text_chunk(&original,"markits:operations","private operation history").unwrap();
        let r=resources::register(root.path(),&original,"capture").unwrap();
        let d=resources::generate(root.path(),&r.id,None,None).unwrap();
        let public=fs::read(manual_core::config::project_path(root.path(),&d.path).unwrap()).unwrap();
        assert!(!resources::has_private_metadata(&public));
        let edit=prepare_image_edit(root.path(),&d.path,None).unwrap();
        assert_eq!(edit.resource_id.as_deref(),Some(r.id.as_str()));
        assert_eq!(fs::read(&edit.input).unwrap(),original);
        let changed=markits::raster::embed_png_text_chunk(&original,"markits:annotations",r#"{"canvas":{"width":80,"height":60},"annotations":[{"type":"rect","target":[5,5,20,20]}]}"#).unwrap();
        let variant=resources::generate(root.path(),edit.resource_id.as_deref().unwrap(),None,Some(&changed)).unwrap();
        let reopened=prepare_image_edit(root.path(),&variant.path,None).unwrap();
        assert_eq!(reopened.resource_id,edit.resource_id);
        assert_eq!(fs::read(&reopened.input).unwrap(),changed);
        assert_eq!(resources::catalog(root.path()).unwrap().len(),1,"Editing retains the original resource identity");
        fs::create_dir_all(root.path().join("docs")).unwrap();
        let mut resized=std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(40,30).write_to(&mut resized,image::ImageFormat::Png).unwrap();
        let id_only=resources::document_png(resized.get_ref(),Some(&r.id)).unwrap();
        fs::write(root.path().join("docs/copied.png"),&id_only).unwrap();
        let copied=prepare_image_edit(root.path(),"copied.png",Some("index.md")).unwrap();
        assert_eq!(copied.resource_id.as_deref(),Some(r.id.as_str()));
        assert_eq!(fs::read(copied.input).unwrap(),original);
    }
    #[test]
    fn child_markits_does_not_inherit_studio_webview_profile(){
        let command=markits_command().unwrap();
        for key in ["WEBVIEW2_USER_DATA_FOLDER","WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] {
            assert!(command.get_envs().any(|(name,value)|name==key&&value.is_none()));
        }
    }
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

    #[test]
    fn recapture_preserves_each_crop_scene_output_size_and_editable_base() {
        use markits_desktop_lib::{commands,metadata};
        let temp=tempfile::tempdir().unwrap();
        let encode=|value:u8|{let image=image::RgbaImage::from_pixel(160,120,image::Rgba([value,20,30,255]));let mut c=std::io::Cursor::new(vec![]);image.write_to(&mut c,image::ImageFormat::Png).unwrap();c.into_inner()};
        let previous=encode(80);let fresh=encode(160);
        let data=|bytes:&[u8]|format!("data:image/png;base64,{}",STANDARD.encode(bytes));
        let scene=r#"{"canvas":{"width":80,"height":60},"annotations":[{"type":"rect","target":[5,5,25,20],"style":"primary"}]}"#;
        let cropped=image::load_from_memory(&previous).unwrap().crop_imm(20,10,80,60);let mut c=std::io::Cursor::new(vec![]);cropped.write_to(&mut c,image::ImageFormat::Png).unwrap();
        let file=temp.path().join("old.png");
        commands::cmd_compose_and_save(data(c.get_ref()),scene.into(),file.to_string_lossy().into(),None,Some(40),Some(30),false,Some(data(&previous)),Some(metadata::CropInfo{is_auto_cropped:false,offset_x:20.0,offset_y:10.0,base_width:160,base_height:120}),Some(commands::EditingMetadata{base_ui_elements:None})).unwrap();
        let old=fs::read(&file).unwrap();let result=recompose_variant(&old,&fresh).unwrap();
        assert_eq!((image::load_from_memory(&result).unwrap().width(),image::load_from_memory(&result).unwrap().height()),(40,30));
        let loaded=metadata::load_image_with_metadata(&result).unwrap();assert_eq!(loaded.annotations_json.as_deref(),Some(scene));assert_eq!((loaded.base_width,loaded.base_height),(Some(160),Some(120)));assert_eq!(loaded.crop_info.unwrap().offset_x,20.0);
        assert_ne!(image::load_from_memory(&result).unwrap().to_rgba8(),image::load_from_memory(&old).unwrap().to_rgba8());
        assert_eq!(fs::read(file).unwrap(),old);
    }

    #[test]
    fn recapture_updates_compatible_images_and_holds_changed_dimensions_for_review(){
        use manual_core::capture_resources as resources;
        let root=tempfile::tempdir().unwrap();let encode=|width,value|{let image=image::RgbaImage::from_pixel(width,60,image::Rgba([value,20,30,255]));let mut c=std::io::Cursor::new(vec![]);image.write_to(&mut c,image::ImageFormat::Png).unwrap();c.into_inner()};
        let with_ui=|png:&[u8],name:&str|{
            let elements=[markits::ui_elements::DetectedUiElement {
                role:"button".into(),name:Some(name.into()),window_id:None,pid:None,x:1.0,y:2.0,width:30.0,height:15.0,
            }];
            markits::metadata::embed_ui_elements(png,&elements).unwrap()
        };
        let original=with_ui(&encode(80,20),"23:28");let r=resources::register(root.path(),&original,"").unwrap();let d=resources::generate(root.path(),&r.id,None,None).unwrap();
        let fresh=with_ui(&encode(80,40),"27:54");
        let updated=apply_recapture(root.path(),&r.id,&r.revision,&fresh,false).unwrap();assert!(updated.pending.is_none());
        assert_ne!(updated.revision,r.revision);
        let path=manual_core::config::project_path(root.path(),&d.path).unwrap();let bytes=fs::read(&path).unwrap();assert_eq!(resources::resource_id(&bytes).as_deref(),Some(r.id.as_str()));
        let pending=apply_recapture(root.path(),&r.id,&updated.revision,&encode(100,60),false).unwrap();assert!(pending.pending.is_some());assert_eq!(fs::read(path).unwrap(),bytes);
        assert!(apply_recapture(root.path(),&r.id,"stale",&encode(80,70),false).is_err());
    }
}
