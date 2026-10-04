use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

use super::uimap::{extract_ui_map, UIMap};
use crate::analyze_directory;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplicationContext {
    pub name: String,
    pub version: String,
    pub description: String,
    pub readme_summary: String,
    pub modules_count: usize,
    pub cycles_count: usize,
    pub key_modules: Vec<String>,
    pub key_classes: Vec<String>,
    pub key_functions: Vec<String>,
    pub ui_map: UIMap,
    pub prompt_summary: String,
}

pub fn build_application_context(root: &Path) -> ApplicationContext {
    let mut name = root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project")
        .to_string();
    let mut version = "1.0.0".to_string();
    let mut description = String::new();

    // 1. Check pyproject.toml
    let pyproject = root.join("pyproject.toml");
    if pyproject.is_file() {
        if let Ok(content) = fs::read_to_string(&pyproject) {
            if let Ok(val) = content.parse::<toml::Value>() {
                if let Some(proj) = val.get("project") {
                    if let Some(n) = proj.get("name").and_then(|v| v.as_str()) {
                        name = n.to_string();
                    }
                    if let Some(v) = proj.get("version").and_then(|v| v.as_str()) {
                        version = v.to_string();
                    }
                    if let Some(d) = proj.get("description").and_then(|v| v.as_str()) {
                        description = d.to_string();
                    }
                }
            }
        }
    }

    // 2. Check README.md
    let mut readme_summary = String::new();
    let readme_path = root.join("README.md");
    if readme_path.is_file() {
        if let Ok(content) = fs::read_to_string(&readme_path) {
            let lines: Vec<&str> = content
                .lines()
                .filter(|l| !l.trim().starts_with("!["))
                .take(30)
                .collect();
            readme_summary = lines.join("\n");
            if readme_summary.chars().count() > 1500 {
                readme_summary = readme_summary.chars().take(1500).collect();
            }
        }
    }

    // 3. Run AST Analysis
    let mut key_modules = Vec::new();
    let mut key_classes = Vec::new();
    let mut key_functions = Vec::new();
    let mut modules_count = 0;
    let mut cycles_count = 0;

    if let Ok(res) = analyze_directory(root) {
        modules_count = res.modules.len();
        cycles_count = res.cycles.len();

        for m in res.modules.iter().take(20) {
            key_modules.push(m.id.clone());
            for c in m.classes.iter().take(5) {
                key_classes.push(format!("{}.{}", m.id, c.name));
            }
            for f in m.functions.iter().take(5) {
                key_functions.push(format!("{}.{}", m.id, f.name));
            }
        }
    }

    // 4. Extract UI Map
    let ui_map = extract_ui_map(root);

    // 5. Build Formatted Prompt Summary
    let mut p = String::new();
    p.push_str("# アプリケーション仕様と構成情報\n");
    p.push_str(&format!("- プロジェクト名: {name} (v{version})\n"));
    if !description.is_empty() {
        p.push_str(&format!("- 概要: {description}\n"));
    }
    p.push_str(&format!(
        "- 総モジュール数: {modules_count} 件, 循環インポート: {cycles_count} 件\n\n"
    ));

    if !readme_summary.is_empty() {
        p.push_str("## README 抜粋\n");
        p.push_str(&readme_summary);
        p.push_str("\n\n");
    }

    if !key_modules.is_empty() {
        p.push_str("## 主要な Python モジュール (AST抽出)\n");
        for m in key_modules.iter().take(12) {
            p.push_str(&format!("- `{m}`\n"));
        }
        p.push('\n');
    }

    if !key_classes.is_empty() {
        p.push_str("## 主要なクラス & 関数\n");
        for c in key_classes.iter().take(8) {
            p.push_str(&format!("- クラス: `{c}`\n"));
        }
        for f in key_functions.iter().take(8) {
            p.push_str(&format!("- 関数: `{f}`\n"));
        }
        p.push('\n');
    }

    if !ui_map.views.is_empty() {
        p.push_str("## 検出された UI 画面・要素 (UI Map)\n");
        for v in &ui_map.views {
            let evidence = v
                .observed_from
                .as_deref()
                .map(|source| format!("実画面観測: {source}"))
                .unwrap_or_else(|| "静的解析".to_string());
            p.push_str(&format!(
                "### 画面: {} (`#{}`; {})\n",
                v.name, v.id, evidence
            ));
            for el in v.elements.iter().take(10) {
                p.push_str(&format!(
                    "- [{}] {} (`{}`)\n",
                    el.role, el.name, el.selector
                ));
            }
        }
        p.push('\n');
    }

    ApplicationContext {
        name,
        version,
        description,
        readme_summary,
        modules_count,
        cycles_count,
        key_modules,
        key_classes,
        key_functions,
        ui_map,
        prompt_summary: p,
    }
}
