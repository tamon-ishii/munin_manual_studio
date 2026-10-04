use std::fs;
use std::path::Path;
use tempfile::tempdir_in;
use walkdir::WalkDir;

use super::config::{
    config_path, project_path, read_config, ManualConfig, MkDocsConfig, DEFAULT_BRIEF,
};
use super::task::{collect_markdown_files, parse_page_tags, utc_now, PageTag};
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
    let existing_cfg = read_config(root);
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
    if !is_offline_or_test && response.is_none() && super::agent::which_binary(&agent).is_none() {
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

    let prompt = if template_type == "api" {
        format!(
            "Read the application context, AST module structure, UI Map, and manual brief below.\n\
            Create a concise, focused Japanese MkDocs architecture & API reference outline (たたき台) as JSON pages for this specific application.\n\
            The API documentation must focus strictly on facts, architecture designs, module specifications, and public interfaces without UI operation narratives.\n\
            IMPORTANT RULES FOR TASKS & LAYOUT:\n\
            - index.md is required. Include an architecture overview, module hierarchy, and table of contents.\n\
            - Create 2 to 3 core pages (e.g. architecture.md for system architecture & data flows, api_reference.md for core module API signatures).\n\
            - Write comprehensive, factual Japanese descriptions, module specifications, and class summaries DIRECTLY as markdown body text (DO NOT use kind=text tasks, write the real content directly).\n\
            - For architecture and dependency diagrams, write valid Mermaid diagram blocks (```mermaid ... ```) directly in the markdown body.\n\
            - Do not invent non-existent modules. Return exactly 3 to 4 pages total. Keep the draft concise, clean, and fast to generate.\n\n\
            {}\n\n\
            Brief:\n{}",
            app_context.prompt_summary,
            brief
        )
    } else {
        format!(
            "Read the application context, AST module structure, UI Map, and manual brief below.\n\
            Create a concise, focused Japanese MkDocs user manual outline (たたき台) as JSON pages for this specific application.\n\
            The manual must explain features, workflows, and step-by-step user operations.\n\
            IMPORTANT RULES FOR TASKS & LAYOUT:\n\
            - index.md is required. You MUST add at least one screenshot update task with kind=screenshot to index.md; this is mandatory and must not be omitted or replaced with a static image link.\n\
            - Put the task immediately after the short introduction and before navigation. Use <!-- ai:task id=overview-screenshot kind=screenshot\\nDescribe the target application's real overview screen and the controls to show\\n--> . This task appears in ModuleLoom's 「更新対象アセット」 list so the instruction can be copied for an agent with access to the target application and the resulting PNG can be registered.\n\
            - The screenshot prompt must name a real UI view and relevant controls from the UI Map; do not invent controls or give a generic instruction.\n\
            - Divide into 2 to 3 core chapters matching the application's actual workflows (e.g. quickstart.md for initial setup, features.md for main operations).\n\
            - Write detailed explanatory text, feature overviews, and step-by-step guides DIRECTLY as markdown body text (DO NOT use kind=text tasks, write the actual Japanese text directly into the markdown body).\n\
            - Add more screenshot or diagram tasks only when they help explain a real operation or dependency.\n\
            - Return exactly 3 to 4 pages total. Keep the draft concise, clean, and fast to generate.\n\n\
            {}\n\n\
            Brief:\n{}",
            app_context.prompt_summary,
            brief
        )
    };

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

    if template_type == "manual" {
        let index_content = valid_pages
            .iter()
            .find(|(path, _)| path == "index.md")
            .map(|(_, content)| content.as_str())
            .unwrap_or_default();
        let mut ids = std::collections::HashSet::new();
        let tags = parse_page_tags("index.md", index_content, &mut ids)?;
        if !tags
            .iter()
            .any(|tag| matches!(tag, PageTag::Task { task, .. } if task.kind == "screenshot"))
        {
            return Err(format!(
                "{agent} manual draft must include an index.md screenshot ai:task for the 更新対象アセット list"
            ));
        }
    }

    fs::create_dir_all(templates).map_err(|e| e.to_string())?;
    for (rel_path, content) in &valid_pages {
        let dest = templates.join(rel_path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&dest, format!("{}\n", content.trim_end())).map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn finish_generated_template(root: &Path, templates: &Path, output_dir_name: &str) {
    // 生成されたタスクのうち diagram と text の回答を自動生成して保存
    if let Ok(task_list) = super::task::tasks(templates) {
        let generated = root.join("manual").join("ai");
        for t in &task_list {
            if t.kind == "diagram" {
                if super::author::generate_task(root, &t.id, "", "").is_err() {
                    let fallback_diagram =
                        "```mermaid\ngraph TD\n    Main[メイン処理] --> Sub[主要モジュール]\n```";
                    let _ = super::task::save_answer(&generated, t, fallback_diagram);
                }
            } else if t.kind == "text" {
                let default_body = format!(
                    "{}\n\n本プロジェクトの仕様および構造に基づいた解説です。",
                    t.prompt
                );
                let _ = super::task::save_answer(&generated, t, &default_body);
            }
        }
    }

    let app_context = super::context::build_application_context(root);
    let _ = super::uimap::save_ui_map(root, &app_context.ui_map);
    let _ = super::deps::build_manual_dependency_graph(root, templates);
    let _ = super::builder::build(
        templates,
        &root.join("manual").join("ai"),
        &root.join(output_dir_name),
        true,
        Some(root),
    );
}

fn init_manual_template(root: &Path, templates: &Path, project_name: &str) -> Result<(), String> {
    let index_md = format!(
        r#"# {project_name} 利用マニュアル

このドキュメントでは、{project_name} の主な機能と操作方法について説明します。

<!-- ai:task id=overview-screenshot kind=screenshot
対象アプリのメイン画面を開き、主要な操作領域が見える状態をPNGで撮影する
-->

<!-- ai:task id=overview-intro-text kind=text
本ツールの目的と提供する価値を読者に向けて簡潔に説明する
-->

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
<!-- ai:task id=quickstart-step1-screenshot kind=screenshot
対象アプリの起動直後の画面とプロジェクト選択エリアをPNGで撮影する
-->

アプリケーション起動後、対象のソースコードディレクトリを選択します。自動的に構文解析が実行され、モジュール一覧および依存関係が読み込まれます。

## ステップ 2: 主要機能の実行
<!-- ai:task id=quickstart-step2-screenshot kind=screenshot
対象アプリの解析結果が表示されたメインワークスペースをPNGで撮影する
-->

解析完了後、メインビューにモジュール関係図が表示されます。各ノードをクリックすると詳細なプロパティや接続関係を確認できます。
"#
    );
    fs::write(templates.join("quickstart.md"), quickstart_md).map_err(|e| e.to_string())?;

    let features_md = format!(
        r#"# 主な機能と操作方法

{project_name} に備わっている機能の詳細と活用方法を説明します。

## 主要機能一覧
<!-- ai:task id=features-main-screenshot kind=screenshot
対象アプリの主要機能パネルまたはダイアログをPNGで撮影する
-->

<!-- ai:task id=features-guide-text kind=text
主要機能の操作方法、パラメータ、活用のポイントを解説
-->
"#
    );
    fs::write(templates.join("features.md"), features_md).map_err(|e| e.to_string())?;

    let settings_md = format!(
        r#"# 設定とカスタマイズ

環境設定およびオプション項目について説明します。

<!-- ai:task id=settings-screenshot kind=screenshot
対象アプリの設定ダイアログを開き、設定項目が見える状態をPNGで撮影する
-->

<!-- ai:task id=settings-guide-text kind=text
各設定項目の意味とおすすめの設定値を解説
-->
"#
    );
    fs::write(templates.join("settings.md"), settings_md).map_err(|e| e.to_string())?;

    // text タスクのデフォルト回答を自動生成して保存
    let generated = root.join("manual").join("ai");
    if let Ok(task_list) = super::task::tasks(templates) {
        for t in &task_list {
            if t.kind == "text" {
                let default_body = match t.id.as_str() {
                    "overview-intro-text" => format!("{project_name} は、複雑化しやすいソースコードの構造を視覚化し、アーキテクチャの健全性を保つための支援ツールです。直感的な UI で依存関係の把握や品質測定を容易に行えます。"),
                    "features-guide-text" => "主要パネルでは、モジュール間の依存関係グラフの探索、循環インポートの検出・診断、および詳細レポートの出力が行えます。".to_string(),
                    "settings-guide-text" => "設定画面では、ドキュメントの出力先ディレクトリ、MkDocs テーマ設定、使用する AI エージェントの切り替えが可能です。".to_string(),
                    _ => format!("{} に関する解説です。プロジェクト構成に基づいて自動生成されています。", t.prompt),
                };
                let _ = super::task::save_answer(&generated, t, &default_body);
            }
        }
    }

    Ok(())
}

fn init_api_template(root: &Path, templates: &Path, project_name: &str) -> Result<(), String> {
    let index_md = format!(
        r#"# {project_name} アーキテクチャ & API リファレンス

本ドキュメントは、{project_name} の内部モジュール構造、依存関係、および公開 API に関する技術仕様書です。

## システム全体アーキテクチャ

<!-- ai:task id=system-architecture-diagram kind=diagram
プロジェクト全体の主要モジュール間依存関係をMermaidダイアグラムで生成
-->

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

<!-- ai:task id=package-dependency-diagram kind=diagram
パッケージ間の推移的依存とレイヤー構造をMermaidダイアグラムで生成
-->

## 循環インポート・メトリクス
コード解析によって検出されたモジュール間結合度および循環参照の状況です。
"#
    );
    fs::write(templates.join("architecture.md"), architecture_md).map_err(|e| e.to_string())?;

    // diagram タスクのデフォルト回答を自動生成して保存
    let generated = root.join("manual").join("ai");
    if let Ok(task_list) = super::task::tasks(templates) {
        for t in &task_list {
            if t.kind == "diagram" {
                let default_body = match t.id.as_str() {
                    "system-architecture-diagram" => "```mermaid\ngraph TD\n    Entrypoint[メインエントリポイント] --> Core[コアモジュール群]\n    Core --> Common[共通ユーティリティ・インフラ]\n```".to_string(),
                    "package-dependency-diagram" => "```mermaid\ngraph LR\n    API[インターフェース層] --> Service[ビジネスロジック層]\n    Service --> Data[データアクセス層]\n```".to_string(),
                    _ => "```mermaid\ngraph TD\n    A[モジュール A] --> B[モジュール B]\n```".to_string(),
                };
                let _ = super::task::save_answer(&generated, t, &default_body);
            }
        }
    }

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
