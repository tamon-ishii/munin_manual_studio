//! Validate capture expectations before replacing an existing asset.
use crate::config::project_path;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path};
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Expectations {
    pub window_title: String,
    pub screen_text: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub reject_blank: bool,
}
pub fn read(root: &Path, id: &str) -> Result<Expectations, String> {
    let path = project_path(root, ".munin/capture-expectations.json")?;
    if !path.is_file() {
        return Ok(Expectations::default());
    }
    let mut map: BTreeMap<String, Expectations> =
        serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    Ok(map.remove(id).unwrap_or_default())
}
pub fn save(root: &Path, id: &str, expectations: Expectations) -> Result<(), String> {
    let selected = crate::task::tasks_for_config(root, &crate::config::read_config(root))?
        .into_iter()
        .find(|task| task.id == id)
        .ok_or("撮影タグがありません。")?;
    if selected.kind != "screenshot" {
        return Err("撮影タグを選択してください。".into());
    }
    crate::task::ensure_unlocked(&selected)?;
    for value in [expectations.width, expectations.height]
        .into_iter()
        .flatten()
    {
        if value == 0 || value > 32768 {
            return Err("画像サイズは1〜32768pxで指定してください。".into());
        }
    }
    let path = project_path(root, ".munin/capture-expectations.json")?;
    let mut map: BTreeMap<String, Expectations> = if path.is_file() {
        serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
    } else {
        Default::default()
    };
    map.insert(id.into(), expectations);
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut temp =
        tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut temp, &map).map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
pub fn check_image(root: &Path, id: &str, image: &Path) -> Result<(), String> {
    let expectations = read(root, id)?;
    let bytes = fs::read(image).map_err(|e| e.to_string())?;
    let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|e| format!("PNG画像の検証に失敗しました。既存画像を維持します: {e}"))?;
    let (w, h) = (decoded.width(), decoded.height());
    if w == 0
        || h == 0
        || expectations.width.is_some_and(|v| v != w)
        || expectations.height.is_some_and(|v| v != h)
    {
        return Err(format!(
            "撮影画像のサイズが期待と一致しません ({w}×{h})。既存画像を維持します。"
        ));
    }
    if expectations.reject_blank {
        let rgb = decoded.to_rgb8();
        let first = rgb.get_pixel(0, 0);
        if rgb.pixels().all(|pixel| pixel == first) {
            return Err("撮影画像が単色です。既存画像を維持します。".into());
        }
    }
    Ok(())
}
pub fn check_target(root: &Path, id: &str, window_id: &str, title: &str) -> Result<(), String> {
    let expectations = read(root, id)?;
    if !expectations.window_title.trim().is_empty() && expectations.window_title != title {
        return Err(format!("対象ウィンドウが期待と異なります: {title}"));
    }
    if !expectations.screen_text.trim().is_empty() {
        let inspection = crate::desktop_scenario::inspect_window(window_id)?;
        if !inspection.contains(&expectations.screen_text) {
            return Err(format!(
                "期待する画面要素がありません: {}",
                expectations.screen_text
            ));
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_or_wrong_size_image_does_not_pass() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("x.png");
        fs::write(&path, b"bad").unwrap();
        assert!(check_image(root.path(), "shot", &path).is_err());
        let png = image::RgbImage::new(2, 2);
        png.save(&path).unwrap();
        assert!(check_image(root.path(), "shot", &path).is_ok());
        fs::create_dir_all(root.path().join(".munin")).unwrap();
        fs::write(
            root.path().join(".munin/capture-expectations.json"),
            r#"{"shot":{"width":3}}"#,
        )
        .unwrap();
        assert!(check_image(root.path(), "shot", &path).is_err());
    }
}
