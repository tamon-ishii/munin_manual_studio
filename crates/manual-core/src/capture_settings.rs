use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::Path};

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CaptureSettings { pub max_depth: usize }
impl Default for CaptureSettings {
    fn default() -> Self { Self { max_depth: markits::ui_elements::DEFAULT_CAPTURE_DEPTH } }
}
pub fn read(root: &Path) -> Result<CaptureSettings, String> {
    let path = crate::config::project_path(root, ".munin/capture-settings.json")?;
    match fs::read(path) {
        Ok(bytes) => {
            let settings: CaptureSettings = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            validate(settings.max_depth)?;
            Ok(settings)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(CaptureSettings::default()),
        Err(error) => Err(error.to_string()),
    }
}
fn validate(depth: usize) -> Result<(), String> {
    if !(1..=128).contains(&depth) { return Err("探索階層は1〜128の整数で指定してください。".into()); }
    Ok(())
}
pub fn save(root: &Path, options: &Value) -> Result<CaptureSettings, String> {
    let _lock = crate::workflow::resource_lock(root, ".munin/capture-settings")?;
    let max_depth = options["max_depth"].as_u64().filter(|value| (1..=128).contains(value))
        .ok_or("探索階層は1〜128の整数で指定してください。")? as usize;
    let settings = CaptureSettings { max_depth };
    let path = crate::config::project_path(root, ".munin/capture-settings.json")?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(path, serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn depth_is_persisted_per_project_and_invalid_values_leave_settings_unchanged() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        assert_eq!(read(first.path()).unwrap().max_depth, 64);
        save(first.path(), &serde_json::json!({"max_depth":96})).unwrap();
        assert_eq!(read(first.path()).unwrap().max_depth, 96);
        assert_eq!(read(second.path()).unwrap().max_depth, 64);
        for depth in [serde_json::json!(0),serde_json::json!(129),serde_json::json!(1.5),serde_json::json!("64")] {
            assert!(save(first.path(), &serde_json::json!({"max_depth":depth})).is_err());
        }
        assert_eq!(read(first.path()).unwrap().max_depth, 96);
    }
}
