use std::fs;
use std::path::Path;
use tempfile::tempdir_in;
use walkdir::WalkDir;

use super::config::{
    config_path, project_path, read_config, ManualConfig, MkDocsConfig, DEFAULT_BRIEF,
};
use super::task::{collect_markdown_files, utc_now};
use crate::analyze_directory;

pub fn init_template(
    root: &Path,
    template_type: &str,
    clear: bool,
    docs_opt: Option<&str>,
    output_opt: Option<&str>,
    agent_opt: Option<&str>,
    model_opt: Option<&str>,
) -> Result<(), String> {
    init_template_inner(
        root,
        template_type,
        clear,
        docs_opt,
        output_opt,
        agent_opt,
        model_opt,
        None,
    )
}

#[cfg(test)]
pub(crate) fn init_template_with_response(
    root: &Path,
    template_type: &str,
    clear: bool,
    response: Result<serde_json::Value, String>,
) -> Result<(), String> {
    init_template_inner(
        root,
        template_type,
        clear,
        None,
        None,
        None,
        None,
        Some(response),
    )
}

fn init_template_inner(
    root: &Path,
    template_type: &str,
    clear: bool,
    docs_opt: Option<&str>,
    output_opt: Option<&str>,
    agent_opt: Option<&str>,
    model_opt: Option<&str>,
    response: Option<Result<serde_json::Value, String>>,
) -> Result<(), String> {
    let existing_cfg = if !config_path(root).is_file() && read_config(root).docs == "." {
        ManualConfig::default()
    } else { read_config(root) };
    let project_name = root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("プロジェクト");

    let docs_dir_name = if let Some(d) = docs_opt.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        d.to_string()
    } else if !existing_cfg.docs.trim().is_empty() {
        existing_cfg.docs.clone()
    } else {
        "docs".to_string()
    };

    let output_dir_name = if let Some(o) = output_opt.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        o.to_string()
    } else if !existing_cfg.output.trim().is_empty() {
        existing_cfg.output.clone()
    } else {
        "manual".to_string()
    };

    let agent = if let Some(a) = agent_opt.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        if ["codex", "claude", "gemini", "grok", "agy"].contains(&a) {
            a.to_string()
        } else {
            return Err(format!("Unsupported AI agent: {a}"));
        }
    } else if ["codex", "claude", "gemini", "grok", "agy"].contains(&existing_cfg.agent.as_str()) {
        existing_cfg.agent.clone()
    } else {
        "codex".to_string()
    };
    let model = if let Some(m) = model_opt {
        m.trim().to_string()
    } else {
        existing_cfg.model.clone()
    };
    let is_offline_or_test =
        response.is_none() && (cfg!(test) || std::env::var("MODULELOOM_OFFLINE_TEMPLATE").is_ok());
    let requires_cli =
        existing_cfg.connection_type != "local_llm" && existing_cfg.connection_type != "api";
    if requires_cli
        && !is_offline_or_test
        && response.is_none()
        && super::agent::which_binary(&agent).is_none()
    {
        return Err(format!("AI CLI is unavailable: {agent}。インストールされているエージェントを選択するか、PATHを確認してください。"));
    }

    let templates = project_path(root, &docs_dir_name)?;
    let output_path = project_path(root, &output_dir_name)?;
    let project_root = root.canonicalize().map_err(|e| e.to_string())?;
    if templates == project_root
        || output_path == project_root
        || templates.starts_with(&output_path)
        || output_path.starts_with(&templates)
    {
        return Err("Template and output directories must be separate".to_string());
    }
    let existing = if templates.is_dir() {
        collect_markdown_files(&templates)
    } else {
        Vec::new()
    };
    if !existing.is_empty() && !clear {
        return Err("EXISTING_DOCS_CONFIRM_REQUIRED".to_string());
    }

    let staging = tempdir_in(root).map_err(|e| e.to_string())?;
    let staged_docs = staging.path().join("docs");
    fs::create_dir_all(&staged_docs).map_err(|e| e.to_string())?;
    if templates.is_dir() {
        for entry in WalkDir::new(&templates) {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_type().is_symlink() {
                return Err(format!(
                    "Symbolic links are not supported in manual templates: {}",
                    entry.path().display()
                ));
            }
            if !entry.file_type().is_file()
                || entry.path().extension().is_some_and(|ext| ext == "md")
            {
                continue;
            }
            let rel = entry
                .path()
                .strip_prefix(&templates)
                .map_err(|e| e.to_string())?;
            let dest = staged_docs.join(rel);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(entry.path(), dest).map_err(|e| e.to_string())?;
        }
    }

    if !is_offline_or_test {
        generate_template_with_llm(root, &staged_docs, template_type, &agent, &model, response)?;
    } else {
        match template_type {
            "api" => init_api_template(root, &staged_docs, project_name)?,
            _ => init_manual_template(root, &staged_docs, project_name)?,
        }
    }

    if !existing.is_empty() {
        let backup_root = root.join(&output_dir_name).join(".backup");
        fs::create_dir_all(&backup_root).map_err(|e| {
            format!(
                "Failed to create backup directory {}: {e}",
                backup_root.display()
            )
        })?;
        let backup = tempfile::Builder::new()
            .prefix(&format!("{}-", utc_now().replace(':', "-")))
            .tempdir_in(&backup_root)
            .map_err(|e| format!("Failed to create backup directory: {e}"))?;
        for old_file in &existing {
            let rel = old_file
                .strip_prefix(&templates)
                .map_err(|e| e.to_string())?;
            let dest = backup.path().join(rel);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(old_file, dest)
                .map_err(|e| format!("Failed to back up {}: {e}", old_file.display()))?;
        }
        let _ = backup.keep();
    }

    let old_docs = staging.path().join("old-docs");
    if templates.exists() {
        fs::rename(&templates, &old_docs).map_err(|e| e.to_string())?;
    }
    if let Err(error) = fs::rename(&staged_docs, &templates) {
        if old_docs.exists() {
            if let Err(restore) = fs::rename(&old_docs, &templates) {
                let recovery = staging.keep();
                return Err(format!(
                    "Failed to publish template: {error}; failed to restore originals: {restore}; originals are at {}",
                    recovery.join("old-docs").display()
                ));
            }
        }
        return Err(format!("Failed to publish template: {error}"));
    }

    // manual_setting.json を確実に生成
    let site_name = match template_type {
        "api" => format!("{project_name} アーキテクチャ & API リファレンス"),
        _ => format!("{project_name} 利用マニュアル"),
    };
    let new_config = ManualConfig {
        docs: docs_dir_name.clone(),
        output: output_dir_name.clone(),
        targets: vec![docs_dir_name.clone(), "README.md".to_string()],
        format: "mkdocs".to_string(),
        agent: agent.clone(),
        model: model.clone(),
        connection_type: existing_cfg.connection_type.clone(),
        endpoint_url: existing_cfg.endpoint_url.clone(),
        assets: existing_cfg.assets.clone(),
        mkdocs: MkDocsConfig {
            site_name,
            theme: "material".to_string(),
            language: "ja".to_string(),
            use_directory_urls: false,
        },
    };
    let setting_dest = config_path(root);
    let json_bytes = serde_json::to_string_pretty(&new_config).map_err(|e| e.to_string())?;
    fs::write(&setting_dest, format!("{json_bytes}\n"))
        .map_err(|e| format!("Failed to write manual_setting.json: {e}"))?;

    let brief_path = root.join("manual").join("brief.md");
    if !brief_path.is_file() {
        if let Some(parent) = brief_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create parent dir for brief.md: {e}"))?;
        }
        fs::write(&brief_path, format!("{DEFAULT_BRIEF}\n"))
            .map_err(|e| format!("Failed to write brief.md: {e}"))?;
    }

    if !is_offline_or_test {
        finish_generated_template(root, &templates, &output_dir_name);
    }

    Ok(())
}

fn generate_template_with_llm(
    root: &Path,
    templates: &Path,
    template_type: &str,
    agent: &str,
    model: &str,
    response: Option<Result<serde_json::Value, String>>,
) -> Result<(), String> {
    let app_context = super::context::build_application_context(root);
    let brief_path = root.join("manual").join("brief.md");
    let brief = if brief_path.is_file() {
        fs::read_to_string(&brief_path).unwrap_or_else(|_| DEFAULT_BRIEF.to_string())
    } else {
        DEFAULT_BRIEF.to_string()
    };

    let prompt = format!("Create a factual Japanese Markdown {template_type} document set as JSON pages, including index.md. Write actual prose and Mermaid directly. Do not create AI tags, metadata comments, or automatic screenshot tasks. Only describe controls verified from the project source. Context: {}\nBrief: {brief}",app_context.prompt_summary);

    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "pages": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "content": {"type": "string"}
                    },
                    "required": ["path", "content"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["pages"],
        "additionalProperties": false
    });

    let res = if let Some(response) = response {
        response?
    } else {
        super::agent::agent_json(root, &prompt, &schema, agent, model)?
    };
    let pages = res
        .get("pages")
        .and_then(|p| p.as_array())
        .ok_or_else(|| format!("{agent} returned an invalid page list"))?;

    let mut has_index = false;
    let mut valid_pages = Vec::new();
    for p in pages {
        let p_str = p.get("path").and_then(|s| s.as_str()).unwrap_or("");
        let c_str = p.get("content").and_then(|s| s.as_str()).unwrap_or("");
        let rel = Path::new(p_str);
        if !rel.is_absolute()
            && !p_str.contains("..")
            && rel.extension().map_or(false, |ext| ext == "md")
            && !p_str.is_empty()
        {
            if p_str == "index.md" {
                has_index = true;
            }
            valid_pages.push((p_str.to_string(), c_str.to_string()));
        }
    }

    if !has_index || valid_pages.is_empty() {
        return Err(format!("{agent} draft must include index.md"));
    }

    fs::create_dir_all(templates).map_err(|e| e.to_string())?;
    for (rel_path, content) in &valid_pages {
        let dest = templates.join(rel_path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&dest, format!("{}\n", crate::legacy_ai::plain_markdown(content,None).trim_end())).map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn finish_generated_template(root: &Path, templates: &Path, output_dir_name: &str) {
    for path in collect_markdown_files(templates) {
        if let Ok(content)=fs::read_to_string(&path) {
            let plain=crate::legacy_ai::plain_markdown(&content,Some(&root.join("manual/ai")));
            let _=fs::write(path,plain);
        }
    }
    let _ = super::deps::build_manual_dependency_graph(root, templates);
    let _ = super::builder::build(
        templates,
        &root.join("manual").join("ai"),
        &root.join(output_dir_name),
        true,
        Some(root),
    );
}

fn init_manual_template(_root: &Path, templates: &Path, project_name: &str) -> Result<(), String> {
    let index_md = format!(
        r#"# {project_name} 利用マニュアル

このドキュメントでは、{project_name} の主な機能と操作方法について説明します。









## ドキュメント構成
- [はじめに・クイックスタート](quickstart.md): 基本的な操作手順と初期設定
- [主な機能と操作方法](features.md): 各画面の詳しい機能解説
- [設定とカスタマイズ](settings.md): 動作環境と各種設定
"#
    );
    fs::write(templates.join("index.md"), index_md).map_err(|e| e.to_string())?;

    let quickstart_md = format!(
        r#"# クイックスタートガイド

本ツールの基本的な使い方と操作手順をステップ順に説明します。

## ステップ 1: 起動とプロジェクト選択




アプリケーション起動後、対象のソースコードディレクトリを選択します。自動的に構文解析が実行され、モジュール一覧および依存関係が読み込まれます。

## ステップ 2: 主要機能の実行




解析完了後、メインビューにモジュール関係図が表示されます。各ノードをクリックすると詳細なプロパティや接続関係を確認できます。
"#
    );
    fs::write(templates.join("quickstart.md"), quickstart_md).map_err(|e| e.to_string())?;

    let features_md = format!(
        r#"# 主な機能と操作方法

{project_name} に備わっている機能の詳細と活用方法を説明します。

## 主要機能一覧







"#
    );
    fs::write(templates.join("features.md"), features_md).map_err(|e| e.to_string())?;

    let settings_md = format!(
        r#"# 設定とカスタマイズ

環境設定およびオプション項目について説明します。








"#
    );
    fs::write(templates.join("settings.md"), settings_md).map_err(|e| e.to_string())?;

    // text タスクのデフォルト回答を自動生成して保存


    Ok(())
}

fn init_api_template(root: &Path, templates: &Path, project_name: &str) -> Result<(), String> {
    let index_md = format!(
        r#"# {project_name} アーキテクチャ & API リファレンス

本ドキュメントは、{project_name} の内部モジュール構造、依存関係、および公開 API に関する技術仕様書です。

## システム全体アーキテクチャ





## 仕様書構成
- [モジュール依存関係とアーキテクチャ](architecture.md): レイヤー構造と依存ルール
- [API リファレンス](api.md): モジュール・クラス・関数仕様
"#
    );
    fs::write(templates.join("index.md"), index_md).map_err(|e| e.to_string())?;

    let architecture_md = format!(
        r#"# モジュール依存関係とアーキテクチャ

プロジェクト内のモジュール構造およびパッケージ間の依存関係を整理した技術仕様です。

## パッケージ間依存図





## 循環インポート・メトリクス
コード解析によって検出されたモジュール間結合度および循環参照の状況です。
"#
    );
    fs::write(templates.join("architecture.md"), architecture_md).map_err(|e| e.to_string())?;

    // diagram タスクのデフォルト回答を自動生成して保存


    // API リファレンス：AST解析からモジュール一覧を自動生成
    let mut api_content = format!(
        r#"# API リファレンス

本プロジェクトで定義されている主要モジュール、クラス、および関数の一覧です。

"#
    );

    if let Ok(analysis) = analyze_directory(root) {
        if !analysis.modules.is_empty() {
            for m in &analysis.modules {
                api_content.push_str(&format!("## モジュール `{}`\n\n", m.id));
                if let Some(ref doc) = m.docstring {
                    api_content.push_str(&format!("{}\n\n", doc.trim()));
                }
                if !m.classes.is_empty() {
                    api_content.push_str("### クラス一覧\n");
                    for c in &m.classes {
                        api_content.push_str(&format!("- **`{}`**", c.name));
                        if let Some(ref doc) = c.docstring {
                            let first_line = doc.lines().next().unwrap_or("").trim();
                            if !first_line.is_empty() {
                                api_content.push_str(&format!(": {}", first_line));
                            }
                        }
                        api_content.push('\n');
                    }
                    api_content.push('\n');
                }
                if !m.functions.is_empty() {
                    api_content.push_str("### 関数一覧\n");
                    for f in &m.functions {
                        api_content.push_str(&format!("- **`{}()`**", f.name));
                        if let Some(ref doc) = f.docstring {
                            let first_line = doc.lines().next().unwrap_or("").trim();
                            if !first_line.is_empty() {
                                api_content.push_str(&format!(": {}", first_line));
                            }
                        }
                        api_content.push('\n');
                    }
                    api_content.push('\n');
                }
            }
        } else {
            api_content.push_str("モジュールが検出されませんでした。\n");
        }
    } else {
        api_content.push_str("コード解析を実行してモジュール仕様を抽出します。\n");
    }

    fs::write(templates.join("api.md"), api_content).map_err(|e| e.to_string())?;

    Ok(())
}
