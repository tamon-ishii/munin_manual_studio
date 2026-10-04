use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULT_BRIEF: &str =
    "# マニュアル作成の指示\n\n## 対象読者\n\n## 目的\n\n## 含める操作\n\n## 追加の指示\n";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MkDocsConfig {
    pub site_name: String,
    pub theme: String,
    pub language: String,
    pub use_directory_urls: bool,
}

impl Default for MkDocsConfig {
    fn default() -> Self {
        Self {
            site_name: "ModuleLoom マニュアル".to_string(),
            theme: "material".to_string(),
            language: "ja".to_string(),
            use_directory_urls: false,
        }
    }
}

pub fn default_targets() -> Vec<String> {
    vec!["docs".to_string(), "README.md".to_string()]
}

pub fn default_connection_type() -> String {
    "cli".to_string()
}

pub fn default_assets() -> String {
    "docs/assets".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManualConfig {
    pub docs: String,
    pub output: String,
    #[serde(default = "default_targets")]
    pub targets: Vec<String>,
    pub format: String,
    pub agent: String,
    pub model: String,
    #[serde(default = "default_connection_type")]
    pub connection_type: String,
    #[serde(default)]
    pub endpoint_url: String,
    #[serde(default = "default_assets")]
    pub assets: String,
    pub mkdocs: MkDocsConfig,
}

impl Default for ManualConfig {
    fn default() -> Self {
        Self {
            docs: "docs".to_string(),
            output: "manual".to_string(),
            targets: default_targets(),
            format: "mkdocs".to_string(),
            agent: "codex".to_string(),
            model: "".to_string(),
            connection_type: default_connection_type(),
            endpoint_url: String::new(),
            assets: default_assets(),
            mkdocs: MkDocsConfig::default(),
        }
    }
}

pub fn config_path(root: &Path) -> PathBuf {
    root.join("manual_setting.json")
}

pub fn has_config(root: &Path) -> bool {
    config_path(root).is_file()
}

pub fn read_config(root: &Path) -> ManualConfig {
    let setting_json = root.join("manual_setting.json");
    let legacy_json = root.join("manual").join("config.json");
    let path = if setting_json.is_file() {
        setting_json
    } else if legacy_json.is_file() {
        legacy_json
    } else {
        return ManualConfig::default();
    };

    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return ManualConfig::default(),
    };
    let value: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return ManualConfig::default(),
    };

    let mut config = ManualConfig::default();
    if let Some(d) = value.get("docs").and_then(|v| v.as_str()) {
        config.docs = d.to_string();
    }
    if let Some(o) = value.get("output").and_then(|v| v.as_str()) {
        config.output = o.to_string();
    }
    if let Some(arr) = value.get("targets").and_then(|v| v.as_array()) {
        let t_list: Vec<String> = arr
            .iter()
            .filter_map(|item| item.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect();
        if !t_list.is_empty() {
            config.targets = t_list;
        }
    } else {
        config.targets = vec![config.docs.clone(), "README.md".to_string()];
    }
    if let Some(f) = value.get("format").and_then(|v| v.as_str()) {
        config.format = f.to_string();
    }
    if let Some(a) = value.get("agent").and_then(|v| v.as_str()) {
        if ["codex", "claude", "gemini", "grok", "agy"].contains(&a) {
            config.agent = a.to_string();
        }
    }
    if let Some(m) = value.get("model").and_then(|v| v.as_str()) {
        config.model = m.to_string();
    }
    if let Some(mk) = value.get("mkdocs").and_then(|v| v.as_object()) {
        if let Some(sn) = mk.get("site_name").and_then(|v| v.as_str()) {
            config.mkdocs.site_name = sn.to_string();
        }
        if let Some(th) = mk.get("theme").and_then(|v| v.as_str()) {
            config.mkdocs.theme = th.to_string();
        }
        if let Some(lg) = mk.get("language").and_then(|v| v.as_str()) {
            config.mkdocs.language = lg.to_string();
        }
        if let Some(du) = mk.get("use_directory_urls").and_then(|v| v.as_bool()) {
            config.mkdocs.use_directory_urls = du;
        }
    }

    if let Some(ct) = value.get("connection_type").and_then(|v| v.as_str()) {
        if ["cli", "local_llm", "api"].contains(&ct) {
            config.connection_type = ct.to_string();
        }
    }
    if let Some(ep) = value.get("endpoint_url").and_then(|v| v.as_str()) {
        config.endpoint_url = ep.to_string();
    }
    if let Some(a) = value.get("assets").and_then(|v| v.as_str()) {
        config.assets = a.to_string();
    } else {
        config.assets = format!("{}/assets", config.docs);
    }

    config
}

pub fn project_path(root: &Path, value: &str) -> Result<PathBuf, String> {
    let abs_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    if value.trim().is_empty()
        || Path::new(value)
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(format!("Manual path must stay inside the project: {value}"));
    }
    let target = root.join(value);
    let mut candidate = target.as_path();
    while candidate != root {
        if fs::symlink_metadata(candidate).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(format!("Manual path contains a symbolic link: {value}"));
        }
        let parent = candidate
            .parent()
            .ok_or_else(|| format!("Invalid manual path: {value}"))?;
        if parent == candidate {
            break;
        }
        candidate = parent;
    }
    let mut nearest = target.as_path();
    let mut missing = Vec::new();
    while !nearest.exists() {
        if fs::symlink_metadata(nearest).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(format!("Manual path contains a symbolic link: {value}"));
        }
        let name = nearest
            .file_name()
            .ok_or_else(|| format!("Invalid manual path: {value}"))?;
        missing.push(name.to_os_string());
        nearest = nearest
            .parent()
            .ok_or_else(|| format!("Invalid manual path: {value}"))?;
    }
    let mut abs_target = nearest.canonicalize().map_err(|e| e.to_string())?;
    for part in missing.iter().rev() {
        abs_target.push(part);
    }

    if !abs_target.starts_with(&abs_root) {
        return Err(format!("Manual path must stay inside the project: {value}"));
    }
    Ok(abs_target)
}

pub fn save_settings(
    root: &Path,
    docs: &str,
    output: &str,
    brief: &str,
    agent: &str,
    model: &str,
    doc_format: &str,
    mkdocs_raw: &str,
    targets: Option<&[String]>,
    connection_type: Option<&str>,
    endpoint_url: Option<&str>,
    assets: Option<&str>,
) -> Result<ManualConfig, String> {
    let docs_path = project_path(root, docs)?;
    let output_path = project_path(root, output)?;

    if docs_path == output_path
        || docs_path.starts_with(&output_path)
        || output_path.starts_with(&docs_path)
    {
        return Err("Template and output directories must be separate".to_string());
    }
    let final_brief = if brief.trim().is_empty() {
        let existing = root.join("manual").join("brief.md");
        if existing.is_file() {
            fs::read_to_string(&existing).unwrap_or_else(|_| DEFAULT_BRIEF.to_string())
        } else {
            DEFAULT_BRIEF.to_string()
        }
    } else {
        brief.to_string()
    };
    let conn_type = connection_type.unwrap_or("cli");
    if !["cli", "local_llm", "api"].contains(&conn_type) {
        return Err(format!("Unsupported AI connection type: {conn_type}"));
    }
    if conn_type == "cli" && !["codex", "claude", "gemini", "grok", "agy"].contains(&agent) {
        return Err(format!("Unsupported AI agent: {agent}"));
    }
    if model.len() > 120 || model.contains('\n') {
        return Err("Invalid model ID".to_string());
    }

    let mut mkdocs_cfg = MkDocsConfig::default();
    if !mkdocs_raw.trim().is_empty() {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(mkdocs_raw) {
            if let Some(obj) = parsed.as_object() {
                if let Some(sn) = obj.get("site_name").and_then(|v| v.as_str()) {
                    mkdocs_cfg.site_name = sn.to_string();
                }
                if let Some(th) = obj.get("theme").and_then(|v| v.as_str()) {
                    mkdocs_cfg.theme = th.to_string();
                }
                if let Some(lg) = obj.get("language").and_then(|v| v.as_str()) {
                    mkdocs_cfg.language = lg.to_string();
                }
                if let Some(du) = obj.get("use_directory_urls").and_then(|v| v.as_bool()) {
                    mkdocs_cfg.use_directory_urls = du;
                }
            }
        }
    }

    let abs_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let rel_docs = docs_path
        .strip_prefix(&abs_root)
        .unwrap_or(&docs_path)
        .to_string_lossy()
        .into_owned();
    let rel_output = output_path
        .strip_prefix(&abs_root)
        .unwrap_or(&output_path)
        .to_string_lossy()
        .into_owned();

    let final_targets: Vec<String> = if let Some(t_list) = targets {
        let list: Vec<String> = t_list
            .iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if list.is_empty() {
            vec![rel_docs.clone(), "README.md".to_string()]
        } else {
            list
        }
    } else {
        let current = read_config(root);
        if !current.targets.is_empty() {
            current.targets
        } else {
            vec![rel_docs.clone(), "README.md".to_string()]
        }
    };

    let rel_assets = if let Some(a) = assets.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        a.to_string()
    } else {
        format!("{rel_docs}/assets")
    };

    let config = ManualConfig {
        docs: rel_docs,
        output: rel_output.clone(),
        targets: final_targets,
        format: doc_format.to_string(),
        agent: agent.to_string(),
        model: model.trim().to_string(),
        connection_type: conn_type.to_string(),
        endpoint_url: endpoint_url.unwrap_or_default().trim().to_string(),
        assets: rel_assets,
        mkdocs: mkdocs_cfg,
    };

    let dest = config_path(root);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json_bytes = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&dest, format!("{json_bytes}\n")).map_err(|e| e.to_string())?;

    let brief_path = root.join("manual").join("brief.md");
    if let Some(parent) = brief_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&brief_path, format!("{}\n", final_brief.trim_end())).map_err(|e| e.to_string())?;

    Ok(config)
}
