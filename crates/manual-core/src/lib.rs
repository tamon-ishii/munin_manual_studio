//! Documentation authoring, capture, scenarios, and publication shared by independent hosts.
pub use moduleloom_analysis::{analyze_directory, mkdocs};

pub mod agent;
pub mod audience;
pub mod author;
pub mod builder;
pub mod capture_source;
pub mod capture_settings;
pub mod capture_validation;
pub mod config;
mod operation_settings;
pub mod context;
pub mod deps;
mod desktop_scenario;
pub mod semantic_target;
pub mod visual_target;
pub mod editor;
mod gfm;
mod manuscript_tools;
mod file_move;
mod manuscript_git;
pub mod fact;
mod legacy_ai;
mod selection_ai;
mod document_review;
mod draft_review;
mod screenshot_ai;
pub mod platform;
pub mod preview;
pub mod pty;
pub mod quality;
pub mod scenario;
pub mod screenshots;
mod image_generation;
pub mod resources;
mod resource_index;
pub mod task;
pub mod template;
pub mod window_capture;
pub mod workflow;
mod workspace;

#[cfg(test)]
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(test)]
use serde::Serialize;

use config::{project_path, read_config, save_settings};
use preview::{get_state, preview_asset, preview_html, preview_page};

fn crop_margin(crop: bool, margin: Option<&str>) -> Result<Option<u32>, String> {
    if !crop {
        if margin.is_some() {
            return Err("--crop-margin requires --crop".to_string());
        }
        return Ok(None);
    }
    margin
        .unwrap_or("32")
        .parse::<u32>()
        .map(Some)
        .map_err(|_| "--crop-margin must be a non-negative integer".to_string())
}

pub fn run(root: &Path, action: &str, options: &[(&str, &str)]) -> Result<String, String> {
    let _depth = markits::ui_elements::capture_depth_scope(capture_settings::read(root)?.max_depth);
    if matches!(action, "scan" | "generate-task" | "generate-page" | "generate-review" | "generation-input" | "generation-history" | "generation-history-entry" | "generate-page-captures" | "update-task" | "generate-text-all" | "generate-diagram-all" | "generate-api" | "approve" | "record" | "record-screenshot" | "record-diagram" | "page-tasks" | "impact-plan" | "generate-impacted" | "execution-begin" | "execution-checkpoint" | "execution-finish" | "execution-resume" | "execution-rollback") {
        return Err(format!("AIタグ機能は廃止されました: {action}"));
    }
    let raw_json: serde_json::Value = serde_json::from_str(
        options
            .iter()
            .find(|(key, _)| *key == "--json")
            .map(|(_, value)| *value)
            .unwrap_or("{}"),
    )
    .map_err(|e| e.to_string())?;
    let timeout = raw_json["limits"]["timeout_seconds"].as_u64();
    if timeout.is_some_and(|seconds| !(5..=1800).contains(&seconds)) {
        return Err("制限時間は5〜1800秒で指定してください。".into());
    }
    let _timeout_scope = agent::request_timeout(timeout);
    if action == "editor-save" {
        let page = options
            .iter()
            .find(|(key, _)| *key == "--page")
            .map(|(_, value)| *value)
            .ok_or("原稿を指定してください。")?;
        let _lock = workflow::page_lock(root, page)?;
        return run_inner(root, action, options);
    }
    run_inner(root, action, options)
}

fn run_inner(root: &Path, action: &str, options: &[(&str, &str)]) -> Result<String, String> {
    let allowed = [
        "screenshot-ai-application",
        "screenshot-ai-plan",
        "screenshot-ai-capture",
        "screenshot-ai-annotate",
        "document-review",
        "document-review-capabilities",
        "draft-propose",
        "draft-apply",
        "selection-generate",
        "screenshots-migration-plan",
        "screenshots-migrate",
        "screenshots-list",
        "image-generation-settings",
        "image-generate",
        "image-generation-history",
        "image-generation-cancel",
        "image-generation-capabilities",
        "resources-list",
        "resources-image",
        "resources-thumbnail",
        "resources-detail",
        "resources-copy",
        "resources-replace",
        "resources-restore",
        "screenshots-templates",
        "screenshots-diagnose",
        "screenshots-register",
        "screenshots-change",
        "screenshots-image",
        "screenshots-reference",
        "screenshots-recapture-plan",
        "screenshots-recapture",
        "screenshots-recapture-history",
        "state",
        "agent-progress",
        "agent-progress-clear",
        "agent-cancel",
        "models",
        "preview-page",
        "preview-html",
        "preview-asset",
        "save",
        "draft",
        "init-template",
        "build",
        "build-mkdocs",
        "deps",
        "impact",
        "context",
        "markits-render",
        "markits-capture",
        "list-windows",
        "list-accessible-windows",
        "inspect-window",
        "activate-window",
        "editor-read",
        "editor-save",
        "editor-preview",
        "project-search",
        "project-move-file",
        "editor-batch-save",
        "editor-outline",
        "manuscript-git-status",
        "manuscript-git-init",
        "manuscript-git-history",
        "manuscript-git-version",
        "manuscript-git-commit",
        "create-folder",
        "save-asset",
        "scenario-run",
        "scenario-save",
        "scenario-load",
        "scenario-test",
        "e2e",
        "pty-spawn",
        "pty-write",
        "pty-read",
        "pty-resize",
        "pty-kill",
        "pty-close-owner",
    ];
    if !allowed.contains(&action) {
        return Err(format!("Unsupported manual action: {action}"));
    }
    if !root.is_dir() {
        return Err(format!("Manual project does not exist: {}", root.display()));
    }

    if action.starts_with("pty-") {
        let mut map = serde_json::Map::new();
        for (k, v) in options {
            let key = k.trim_start_matches('-').replace('-', "_");
            if let Ok(json_val) = serde_json::from_str::<serde_json::Value>(v) {
                map.insert(key, json_val);
            } else {
                map.insert(key, serde_json::Value::String(v.to_string()));
            }
        }
        return pty::handle_pty_request(action, root, &serde_json::Value::Object(map));
    }

    let mut docs_opt: Option<&str> = None;
    let mut output_opt: Option<&str> = None;
    let mut brief_opt: Option<&str> = None;
    let mut agent_opt: Option<&str> = None;
    let mut model_opt: Option<&str> = None;
    let mut id_opt: Option<&str> = None;
    let mut page_opt: Option<&str> = None;
    let mut asset_opt: Option<&str> = None;
    let mut image_opt: Option<&str> = None;
    let mut draft_flag = false;
    let mut format_opt: Option<&str> = None;
    let mut mkdocs_settings_opt: Option<&str> = None;
    let mut body_opt: Option<&str> = None;
    let mut ref_opt: Option<&str> = None;
    let mut json_opt: Option<&str> = None;
    let mut input_opt: Option<&str> = None;
    let mut window_opt: Option<&str> = None;
    let mut targets_opt: Option<&str> = None;
    let mut template_opt: Option<&str> = None;
    let mut clear_flag = false;
    let mut audience_opt: Option<&str> = None;
    let mut path_opt: Option<&str> = None;
    let mut data_opt: Option<&str> = None;
    let mut detect_ui_flag = false;
    let mut crop_flag = false;
    let mut crop_margin_opt: Option<&str> = None;
    let mut uimap_opt: Option<&str> = None;
    let mut target_opt: Option<&str> = None;
    let mut mark_opt: Option<&str> = None;
    let mut text_opt: Option<&str> = None;
    let mut step_opt: Option<&str> = None;
    let mut style_opt: Option<&str> = None;
    let mut position_opt: Option<&str> = None;
    let mut x_opt: Option<&str> = None;
    let mut y_opt: Option<&str> = None;
    let mut width_opt: Option<&str> = None;
    let mut height_opt: Option<&str> = None;
    let mut connection_type_opt: Option<&str> = None;
    let mut endpoint_url_opt: Option<&str> = None;
    let mut api_key_opt: Option<&str> = None;
    let mut assets_opt: Option<&str> = None;

    for (key, value) in options {
        match *key {
            "--docs" => docs_opt = Some(*value),
            "--output" => output_opt = Some(*value),
            "--targets" => targets_opt = Some(*value),
            "--template" => template_opt = Some(*value),
            "--clear" => clear_flag = true,
            "--detect-ui" => detect_ui_flag = true,
            "--crop" => crop_flag = true,
            "--crop-margin" => crop_margin_opt = Some(*value),
            "--uimap" => uimap_opt = Some(*value),
            "--target" => target_opt = Some(*value),
            "--mark" => mark_opt = Some(*value),
            "--text" => text_opt = Some(*value),
            "--step" => step_opt = Some(*value),
            "--style" => style_opt = Some(*value),
            "--position" => position_opt = Some(*value),
            "-x" | "--x" => x_opt = Some(*value),
            "-y" | "--y" => y_opt = Some(*value),
            "--width" => width_opt = Some(*value),
            "--height" => height_opt = Some(*value),
            "--brief" => brief_opt = Some(*value),
            "--agent" => agent_opt = Some(*value),
            "--model" => model_opt = Some(*value),
            "--connection-type" => connection_type_opt = Some(*value),
            "--endpoint-url" => endpoint_url_opt = Some(*value),
            "--api-key" => api_key_opt = Some(*value),
            "--id" => id_opt = Some(*value),
            "--page" => page_opt = Some(*value),
            "--asset" => asset_opt = Some(*value),
            "--image" => image_opt = Some(*value),
            "--draft" => draft_flag = true,
            "--format" => format_opt = Some(*value),
            "--mkdocs-settings" => mkdocs_settings_opt = Some(*value),
            "--body" => body_opt = Some(*value),
            "--git-ref" | "--ref" => ref_opt = Some(*value),
            "--json" => json_opt = Some(*value),
            "--input" => input_opt = Some(*value),
            "--window" => window_opt = Some(*value),
            "--audience" => audience_opt = Some(*value),
            "--path" => path_opt = Some(*value),
            "--data" => data_opt = Some(*value),
            "--assets" => assets_opt = Some(*value),
            _ => return Err(format!("Unsupported manual option: {key}")),
        }
    }

    let _api_key_scope = agent::request_api_key(api_key_opt);

    let cfg = read_config(root);
    let templates_path = if let Some(d) = docs_opt {
        project_path(root, d)?
    } else {
        project_path(root, &cfg.docs)?
    };
    let output_path = if let Some(o) = output_opt {
        project_path(root, o)?
    } else if matches!(action, "build" | "build-mkdocs") {
        if let Some(audience) = audience_opt {
            project_path(root, &format!("{}/{audience}", cfg.output))?
        } else {
            project_path(root, &cfg.output)?
        }
    } else {
        project_path(root, &cfg.output)?
    };
    let generated_path = root.join("manual").join("ai");

    match action {
        "screenshots-migration-plan" => Ok(screenshots::migration_plan(root)?.to_string()),
        "screenshots-migrate" => Ok(screenshots::migrate_page(
            root,
            page_opt.ok_or("原稿を選択してください。")?,
            &serde_json::from_str::<serde_json::Value>(json_opt.unwrap_or("{}"))
                .map_err(|e| e.to_string())?,
        )?
        .to_string()),
        "screenshots-recapture-plan" => Ok(screenshots::plan_recapture(root, id_opt)?.to_string()),
        "screenshots-recapture-history" => Ok(screenshots::recapture_history(root)?.to_string()),
        "screenshots-recapture" => Ok(screenshots::recapture(
            root,
            &serde_json::from_str::<serde_json::Value>(json_opt.unwrap_or("{}"))
                .map_err(|e| e.to_string())?,
        )?
        .to_string()),
        "resources-list" => Ok(resources::list(root)?.to_string()),
        "resources-thumbnail" => resources::preview_thumbnail(root, asset_opt.ok_or("画像を選択してください。")?),
        "resources-detail" => Ok(resources::detail(root, asset_opt.ok_or("画像を選択してください。")?)?.to_string()),
        "resources-image" => resources::image_data(root, asset_opt.ok_or("画像を選択してください。")?),
        "resources-copy" => Ok(resources::copy(root, asset_opt.ok_or("画像を選択してください。")?)?.to_string()),
        "resources-restore" => Ok(resources::restore(root, &serde_json::from_str::<serde_json::Value>(json_opt.unwrap_or("{}")).map_err(|e|e.to_string())?)?.to_string()),
        "resources-replace" => Ok(resources::replace(root, &serde_json::from_str::<serde_json::Value>(json_opt.unwrap_or("{}")).map_err(|e|e.to_string())?)?.to_string()),
        "image-generation-history" => Ok(image_generation::history(root)?.to_string()),
        "image-generation-cancel" => Ok(image_generation::cancel(root, id_opt.ok_or("作画の実行IDを指定してください。")?)?.to_string()),
        "image-generation-capabilities" => Ok(image_generation::capabilities(&serde_json::from_str::<serde_json::Value>(json_opt.unwrap_or("{}")).map_err(|e|e.to_string())?).to_string()),
        "image-generation-settings" => Ok(image_generation::settings(root, &serde_json::from_str::<serde_json::Value>(json_opt.unwrap_or("{}" )).map_err(|e|e.to_string())?)?.to_string()),
        "image-generate" => Ok(image_generation::generate(root, &serde_json::from_str::<serde_json::Value>(json_opt.unwrap_or("{}" )).map_err(|e|e.to_string())?)?.to_string()),
        "screenshots-templates" => Ok(screenshots::templates(root)?.to_string()),
        "screenshots-diagnose" => Ok(screenshots::diagnose(root)?.to_string()),
        "screenshots-list" => Ok(screenshots::list(root)?.to_string()),
        "screenshots-register" => Ok(screenshots::register(
            root,
            &serde_json::from_str::<serde_json::Value>(json_opt.unwrap_or("{}"))
                .map_err(|e| e.to_string())?,
        )?
        .to_string()),
        "screenshots-change" => Ok(screenshots::change(
            root,
            id_opt.ok_or("画像を選択してください。")?,
            &serde_json::from_str::<serde_json::Value>(json_opt.unwrap_or("{}"))
                .map_err(|e| e.to_string())?,
        )?
        .to_string()),
        "screenshots-image" => {
            let value: serde_json::Value =
                serde_json::from_str(json_opt.unwrap_or("{}")).map_err(|e| e.to_string())?;
            if value["latest"] == true && value["revision"].as_str().is_none() && value["original"] != true {
                return Ok(screenshots::latest_image(root, id_opt.ok_or("画像を選択してください。")?)?.to_string());
            }
            Ok(screenshots::image(
                root,
                id_opt.ok_or("画像を選択してください。")?,
                value["revision"].as_str(),
                value["original"] == true,
            )?
            .to_string())
        }
        "screenshots-reference" => Ok(screenshots::reference(
            root,
            id_opt.ok_or("画像を選択してください。")?,
            page_opt.ok_or("文書を選択してください。")?,
        )?),
        "agent-cancel" => {
            agent::cancel(root)?;
            Ok("{}".into())
        }
        "agent-progress" => Ok(agent::progress(root)),
        "agent-progress-clear" => {
            agent::clear_progress(root);
            Ok(String::new())
        }
        "manuscript-git-status" | "manuscript-git-init" | "manuscript-git-history" | "manuscript-git-version" | "manuscript-git-commit" => {
            let value: serde_json::Value = serde_json::from_str(json_opt.unwrap_or("{}")).map_err(|e|e.to_string())?;
            serde_json::to_string(&manuscript_git::handle(root,action,&value)?).map_err(|e|e.to_string())
        }
        "project-move-file" => {
            let value: serde_json::Value = serde_json::from_str(json_opt.unwrap_or("{}")).map_err(|e|e.to_string())?;
            Ok(file_move::execute(root,&value)?.to_string())
        }
        "project-search" | "editor-batch-save" | "editor-outline" => {
            let value: serde_json::Value = serde_json::from_str(json_opt.unwrap_or("{}")).map_err(|e|e.to_string())?;
            let result = match action {
                "project-search" => manuscript_tools::search(root, &value)?,
                "editor-batch-save" => manuscript_tools::batch_save(root, &value)?,
                _ => manuscript_tools::outline(value["content"].as_str().ok_or("原稿の内容を指定してください。")?),
            };
            serde_json::to_string(&result).map_err(|e|e.to_string())
        }
        "editor-read" => serde_json::to_string(&editor::read(
            root,
            page_opt.ok_or("editor-read requires --page")?,
        )?)
        .map_err(|error| error.to_string()),
        "editor-save" => {
            let value: serde_json::Value =
                serde_json::from_str(json_opt.ok_or("editor-save requires --json")?)
                    .map_err(|error| error.to_string())?;
            let content = value
                .get("content")
                .and_then(serde_json::Value::as_str)
                .ok_or("editor-save requires content")?;
            let revision = value.get("revision").and_then(serde_json::Value::as_str);
            serde_json::to_string(&editor::save(
                root,
                page_opt.ok_or("editor-save requires --page")?,
                content,
                revision,
            )?)
            .map_err(|error| error.to_string())
        }
        "editor-preview" => editor::render_html(
            root,
            page_opt.ok_or("editor-preview requires --page")?,
            body_opt.ok_or("editor-preview requires --body")?,
        ),
        "create-folder" => {
            let options: serde_json::Value = serde_json::from_str(json_opt.unwrap_or("{}"))
                .map_err(|error| error.to_string())?;
            let folder = path_opt.ok_or("create-folder requires --path")?;
            if options["project_relative"] == true { editor::create_folder_at(root, folder, true) }
            else { editor::create_folder(root, folder) }
        },
        "save-asset" => {
            let path_str = path_opt.ok_or("save-asset requires --path")?;
            let data_str = data_opt.ok_or("save-asset requires --data")?;
            serde_json::to_string(&editor::save_asset(root, path_str, data_str)?)
                .map_err(|error| error.to_string())
        }
        "list-windows" => serde_json::to_string(&window_capture::list_windows()?)
            .map_err(|error| error.to_string()),
        "list-accessible-windows" => desktop_scenario::list_accessible_windows(),
        "inspect-window" => {
            desktop_scenario::inspect_window(window_opt.ok_or("inspect-window requires --window")?)
        }
        "activate-window" => {
            let window_id = window_opt.ok_or("activate-window requires --window")?;
            serde_json::to_string(&window_capture::activate_window(window_id)?)
                .map_err(|error| error.to_string())
        }
        "scenario-run" => {
            let input = input_opt.ok_or("scenario-run requires --input")?;
            scenario::run(root, input)
        }
        "scenario-save" => {
            let input = input_opt.ok_or("scenario-save requires --input")?;
            let json = json_opt.ok_or("scenario-save requires --json")?;
            scenario::save(root, input, json)
        }
        "scenario-load" => {
            let input = input_opt.ok_or("scenario-load requires --input")?;
            scenario::load(root, input)
        }
        "scenario-test" => {
            let input = input_opt.ok_or("scenario-test requires --input")?;
            scenario::test(root, input)
        }
        "e2e" => scenario::test_manual(root),
        "state" => {
            let options: serde_json::Value = serde_json::from_str(json_opt.unwrap_or("{}"))
                .map_err(|error| error.to_string())?;
            let state_val = if options["editor"] == true { preview::get_editor_state(root)? } else { get_state(root)? };
            serde_json::to_string(&state_val).map_err(|e| e.to_string())
        }
        "models" => {
            let target_agent = agent_opt.unwrap_or(&cfg.agent);
            let models_val = agent::get_models(root, target_agent)?;
            serde_json::to_string_pretty(&models_val).map_err(|e| e.to_string())
        }
        "preview-page" => {
            let page = page_opt.unwrap_or("index.md");
            preview_page(root, page)
        }
        "preview-html" => {
            let page = page_opt.unwrap_or("index.md");
            preview_html(root, page)
        }
        "preview-asset" => {
            let page = page_opt.unwrap_or("index.md");
            let asset = asset_opt.ok_or("preview-asset requires --asset")?;
            preview_asset(root, page, asset)
        }
        "save" => {
            let brief = brief_opt.unwrap_or("");
            let docs = docs_opt.unwrap_or(&cfg.docs);
            let output = output_opt.unwrap_or(&cfg.output);
            let agent = agent_opt.unwrap_or(&cfg.agent);
            let model = model_opt.unwrap_or(&cfg.model);
            let doc_format = format_opt.unwrap_or(&cfg.format);
            let mkdocs_raw = mkdocs_settings_opt.unwrap_or("");
            let targets_vec = targets_opt.map(|t| {
                t.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
            });
            let connection_type = connection_type_opt.or(Some(&cfg.connection_type));
            let endpoint_url = endpoint_url_opt.or(Some(&cfg.endpoint_url));
            let assets = assets_opt.or(Some(&cfg.assets));
            save_settings(
                root,
                docs,
                output,
                brief,
                agent,
                model,
                doc_format,
                mkdocs_raw,
                targets_vec.as_deref(),
                connection_type,
                endpoint_url,
                assets,
            )?;
            let state_val = get_state(root)?;
            serde_json::to_string(&state_val).map_err(|e| e.to_string())
        }
        "screenshot-ai-application" | "screenshot-ai-plan" | "screenshot-ai-capture" | "screenshot-ai-annotate" => {
            let options:serde_json::Value=serde_json::from_str(json_opt.unwrap_or("{}")).map_err(|e|e.to_string())?;
            match action {"screenshot-ai-application"=>screenshot_ai::application(root,&options),"screenshot-ai-plan"=>screenshot_ai::plan(root,&options),"screenshot-ai-capture"=>screenshot_ai::capture(root,&options),_=>screenshot_ai::annotate(root,&options)}
        }
        "document-review" => document_review::review(root, page_opt.ok_or("原稿を指定してください。")?, json_opt.unwrap_or("{}")),
        "document-review-capabilities" => document_review::capabilities(root, page_opt.ok_or("原稿を指定してください。")?, json_opt.unwrap_or("{}")),
        "draft-propose" => draft_review::propose(root),
        "draft-apply" => draft_review::apply(root, json_opt.unwrap_or("{}")),
        "selection-generate" => selection_ai::generate(root, page_opt.ok_or("原稿を指定してください。")?, json_opt.unwrap_or("{}")),
        "draft" => {
            author::draft(root)?;
            let state_val = get_state(root)?;
            serde_json::to_string(&state_val).map_err(|e| e.to_string())
        }
        "init-template" => {
            let tmpl_type = template_opt.unwrap_or("manual");
            template::init_template(
                root, tmpl_type, clear_flag, docs_opt, output_opt, agent_opt, model_opt,
            )?;
            let state_val = get_state(root)?;
            serde_json::to_string(&state_val).map_err(|e| e.to_string())
        }
        "build" | "build-mkdocs" => {
            let result = if let Some(audience) = audience_opt {
                audience::build(
                    root,
                    &templates_path,
                    &generated_path,
                    &output_path,
                    draft_flag,
                    audience,
                )
            } else {
                builder::build(
                    &templates_path,
                    &generated_path,
                    &output_path,
                    draft_flag,
                    Some(root),
                )
            }?;
            if action == "build-mkdocs" && result.contains("MkDocs site build skipped:") {
                return Err("MkDocsが見つかりません。プロジェクトのPython環境へ mkdocs-material をインストールしてください。HTMLは作成されていません。".into());
            }
            Ok(result)
        }
        "deps" => {
            let graph = deps::build_manual_dependency_graph(root, &templates_path)?;
            serde_json::to_string_pretty(&graph).map_err(|e| e.to_string())
        }
        "impact" => {
            let report = deps::analyze_git_impact(root, ref_opt)?;
            serde_json::to_string_pretty(&report).map_err(|e| e.to_string())
        }
        "context" => {
            let ctx = context::build_application_context(root);
            serde_json::to_string_pretty(&ctx).map_err(|e| e.to_string())
        }
        "markits-render" => {
            let mut json_content = if let Some(j) = json_opt {
                j.to_string()
            } else if let Some(inp) = input_opt {
                let p = if Path::new(inp).is_absolute() {
                    PathBuf::from(inp)
                } else {
                    root.join(inp)
                };
                fs::read_to_string(&p)
                    .map_err(|e| format!("Failed to read {}: {e}", p.display()))?
            } else {
                return Err("markits-render requires --json or --input".to_string());
            };
            if let Some(uimap_path_str) = uimap_opt {
                let uimap_path = if Path::new(uimap_path_str).is_absolute() {
                    PathBuf::from(uimap_path_str)
                } else {
                    root.join(uimap_path_str)
                };
                let elements = markits::raster::load_uimap_from_path(&uimap_path)
                    .map_err(|e| e.to_string())?;
                json_content = markits::raster::with_image_canvas_and_uimap(
                    &json_content,
                    0,
                    0,
                    Some(&elements),
                )
                .map_err(|e| e.to_string())?;
            }
            if let Some(image_file) = image_opt {
                let output_file =
                    output_opt.ok_or("markits-render with --image requires --output")?;
                let image_path = if Path::new(image_file).is_absolute() {
                    PathBuf::from(image_file)
                } else {
                    root.join(image_file)
                };
                let output_path = if Path::new(output_file).is_absolute() {
                    PathBuf::from(output_file)
                } else {
                    root.join(output_file)
                };
                let margin = crop_margin(crop_flag, crop_margin_opt)?;
                let (image_bytes, _) =
                    markits::raster::read_image(&image_path).map_err(|e| e.to_string())?;
                let png_bytes = markits::raster::render_composed_png_bytes_with_crop(
                    &json_content,
                    &image_bytes,
                    margin,
                )
                .map_err(|e| e.to_string())?;
                if let Some(parent) = output_path.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                fs::write(&output_path, &png_bytes).map_err(|e| e.to_string())?;
                let output_info =
                    markits::raster::inspect_image(&output_path).map_err(|e| e.to_string())?;
                serde_json::to_string_pretty(&serde_json::json!({
                    "output": output_path.to_string_lossy(),
                    "width": output_info.width,
                    "height": output_info.height,
                    "ui_elements": output_info.uimap.as_ref().map_or(0, Vec::len),
                }))
                .map_err(|e| e.to_string())
            } else {
                if crop_flag || crop_margin_opt.is_some() {
                    return Err("markits-render cropping requires --image and --output".to_string());
                }
                markits::render_from_json(&json_content).map_err(|e| e.to_string())
            }
        }
        "markits-capture" => {
            let margin = crop_margin(crop_flag, crop_margin_opt)?;
            if crop_flag && target_opt.is_none() {
                return Err("markits-capture --crop requires --target".to_string());
            }
            let output_file = output_opt.ok_or("markits-capture requires --output")?;
            let output_path = if Path::new(output_file).is_absolute() {
                PathBuf::from(output_file)
            } else {
                root.join(output_file)
            };
            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let x = x_opt.and_then(|v| v.parse::<u32>().ok());
            let y = y_opt.and_then(|v| v.parse::<u32>().ok());
            let w = width_opt.and_then(|v| v.parse::<u32>().ok());
            let h = height_opt.and_then(|v| v.parse::<u32>().ok());

            let captured = if let (Some(x), Some(y), Some(w), Some(h)) = (x, y, w, h) {
                markits::capture::capture_region(x, y, w, h).map_err(|e| e.to_string())?
            } else {
                markits::capture::capture_primary_screen().map_err(|e| e.to_string())?
            };

            let mut effective_uimap = None;
            if let Some(uimap_path_str) = uimap_opt {
                let u_path = if Path::new(uimap_path_str).is_absolute() {
                    PathBuf::from(uimap_path_str)
                } else {
                    root.join(uimap_path_str)
                };
                effective_uimap = Some(
                    markits::raster::load_uimap_from_path(&u_path).map_err(|e| e.to_string())?,
                );
            } else if detect_ui_flag {
                let bounds = if let (Some(x), Some(y), Some(w), Some(h)) = (x, y, w, h) {
                    Some((x as f64, y as f64, w as f64, h as f64))
                } else {
                    None
                };
                let detected =
                    markits::ui_elements::capture_desktop_detailed_elements(0, 0, bounds);
                let elements: Vec<markits::UiElement> =
                    if let (Some(x), Some(y), Some(w), Some(h)) = (x, y, w, h) {
                        markits::ui_elements::filter_elements_for_crop(
                            &detected, x as f64, y as f64, w as f64, h as f64,
                        )
                        .into_iter()
                        .map(Into::into)
                        .collect()
                    } else {
                        detected.into_iter().map(Into::into).collect()
                    };
                effective_uimap = Some(elements);
            }

            let png_bytes = if let Some(ref elements) = effective_uimap {
                markits::raster::embed_png_uimap(&captured.raw_png, elements)
                    .map_err(|e| e.to_string())?
            } else {
                captured.raw_png
            };

            if let Some(target_str) = target_opt {
                let target_val: serde_json::Value = if target_str.starts_with('[') {
                    serde_json::from_str(target_str)
                        .map_err(|e| format!("Invalid target coordinate array: {e}"))?
                } else {
                    serde_json::Value::String(target_str.to_string())
                };
                let mut anno_obj = serde_json::Map::new();
                anno_obj.insert(
                    "type".to_string(),
                    serde_json::Value::String(mark_opt.unwrap_or("rect").to_string()),
                );
                anno_obj.insert("target".to_string(), target_val);
                anno_obj.insert(
                    "style".to_string(),
                    serde_json::Value::String(style_opt.unwrap_or("primary").to_string()),
                );
                anno_obj.insert(
                    "position".to_string(),
                    serde_json::Value::String(position_opt.unwrap_or("top").to_string()),
                );
                if let Some(t) = text_opt {
                    anno_obj.insert("text".to_string(), serde_json::Value::String(t.to_string()));
                }
                if let Some(val) = step_opt.and_then(|v| v.parse::<u32>().ok()) {
                    anno_obj.insert("step".to_string(), serde_json::json!(val));
                }
                let mut scene_obj = serde_json::Map::new();
                scene_obj.insert(
                    "canvas".to_string(),
                    serde_json::json!({"width": captured.width, "height": captured.height}),
                );
                if let Some(ref elements) = effective_uimap {
                    scene_obj.insert(
                        "uimap".to_string(),
                        serde_json::to_value(elements).map_err(|e| e.to_string())?,
                    );
                }
                scene_obj.insert(
                    "annotations".to_string(),
                    serde_json::Value::Array(vec![serde_json::Value::Object(anno_obj)]),
                );
                let scene_json = serde_json::to_string(&serde_json::Value::Object(scene_obj))
                    .map_err(|e| e.to_string())?;
                let rendered_bytes = markits::raster::render_composed_png_bytes_with_crop(
                    &scene_json,
                    &png_bytes,
                    margin,
                )
                .map_err(|e| e.to_string())?;
                fs::write(&output_path, rendered_bytes).map_err(|e| e.to_string())?;
            } else {
                fs::write(&output_path, png_bytes).map_err(|e| e.to_string())?;
            }
            let output_info =
                markits::raster::inspect_image(&output_path).map_err(|e| e.to_string())?;
            let res = serde_json::json!({
                "output": output_path.to_string_lossy(),
                "width": output_info.width,
                "height": output_info.height,
                "ui_elements": output_info.uimap.as_ref().map_or(0, Vec::len),
            });
            serde_json::to_string_pretty(&res).map_err(|e| e.to_string())
        }
        _ => unreachable!(),
    }
}

/// JSON request shared by the independent desktop app and its development bridge.
pub fn request(request: serde_json::Value) -> Result<String, String> {
    let root = request
        .get("root")
        .and_then(serde_json::Value::as_str)
        .ok_or("Project root is required")?;
    let action = request
        .get("action")
        .and_then(serde_json::Value::as_str)
        .ok_or("Action is required")?;
    let project = Path::new(root);
    let _depth = markits::ui_elements::capture_depth_scope(capture_settings::read(project)?.max_depth);
    let options = &request["options"];
    let id = || options["id"].as_str().ok_or("実行IDを指定してください。");
    let page = || options["page"].as_str().ok_or("原稿を指定してください。");
    if matches!(action,"execution-begin"|"execution-checkpoint"|"execution-finish"|"execution-resume"){return Err(format!("AIタグ機能は廃止されました: {action}"));}
    let workflow_result = match action {
        "execution-begin" => Some(workflow::begin(project, page()?, &options["json"])),
        "execution-checkpoint" => Some(workflow::checkpoint(project, id()?, &options["json"])),
        "execution-finish" => Some(workflow::finish(
            project,
            id()?,
            options["rollback"].as_bool().unwrap_or(false),
        )),
        "execution-history" => Some(workflow::history(project, options["page"].as_str())),
        "execution-resume" => Some(workflow::resume(project, id()?)),
        "execution-entry" => Some(
            workflow::load(project, id()?)
                .and_then(|run| serde_json::to_value(run).map_err(|e| e.to_string())),
        ),
        "capture-expectations-read" => Some(
            capture_validation::read(project, id()?)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        ),
        "capture-expectations-save" => Some(
            serde_json::from_value(options["json"].clone())
                .map_err(|e| e.to_string())
                .and_then(|v| capture_validation::save(project, id()?, v))
                .map(|_| serde_json::json!({})),
        ),
        "quality-check" => Some(quality::check(project)),
        _ => None,
    };
    if let Some(result) = workflow_result {
        return result.map(|v| v.to_string());
    }
    match action {
        "capture-settings-read" => return serde_json::to_string(&capture_settings::read(project)?).map_err(|e|e.to_string()),
        "capture-settings-save" => return serde_json::to_string(&capture_settings::save(project, &options["json"])?).map_err(|e|e.to_string()),
        "workspace-paths-read" => return Ok(operation_settings::paths(project).to_string()),
        "workspace-paths-save" => return operation_settings::save_paths(project, &options["json"]).map(|v|v.to_string()),
        "operation-timings-read" => return operation_settings::history(project).map(|v|v.to_string()),
        "operation-timings-record" => return operation_settings::record(project, &options["json"]).map(|v|v.to_string()),
        _ => {}
    }
    if action == "create-workspace" {
        return workspace::create(Path::new(root), &request["options"]);
    }
    if action == "validate-workspace" {
        return workspace::validate(Path::new(root), &request["options"]);
    }
    if action.starts_with("pty-") {
        return pty::handle_pty_request(action, Path::new(root), &request["options"]);
    }
    let timeout = options["json"]["limits"]["timeout_seconds"].as_u64();
    if timeout.is_some_and(|seconds| !(5..=1800).contains(&seconds)) {
        return Err("制限時間は5〜1800秒で指定してください。".into());
    }
    let _timeout_scope = agent::request_timeout(timeout);
    let mut owned = Vec::new();
    if let Some(options) = request
        .get("options")
        .and_then(serde_json::Value::as_object)
    {
        for (key, value) in options {
            if value == &serde_json::Value::Bool(false) || value.is_null() {
                continue;
            }
            let key = format!("--{}", key.replace('_', "-"));
            let value = match value {
                serde_json::Value::String(text) => text.clone(),
                serde_json::Value::Bool(true) => String::new(),
                _ => value.to_string(),
            };
            owned.push((key, value));
        }
    }
    let options: Vec<_> = owned
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    run(Path::new(root), action, &options)
}

#[cfg(test)]
#[derive(Serialize)]
struct ImpactPlan {
    impact: deps::ImpactReport,
    generate_tasks: Vec<String>,
    manual_tasks: Vec<String>,
    approved_tasks: Vec<String>,
    page_only: Vec<String>,
}

#[cfg(test)]
fn plan_impacted_tasks(impact: deps::ImpactReport, all_tasks: &[task::Task]) -> ImpactPlan {
    let affected: HashSet<&str> = impact
        .impacted_pages
        .iter()
        .flat_map(|page| page.impacted_tasks.iter().map(String::as_str))
        .collect();
    let mut generate_tasks = Vec::new();
    let mut manual_tasks = Vec::new();
    let mut approved_tasks = Vec::new();
    for task in all_tasks {
        if !affected.contains(task.id.as_str()) {
            continue;
        }
        if task.status == "approved" {
            approved_tasks.push(task.id.clone());
        } else if task.kind == "screenshot" {
            manual_tasks.push(task.id.clone());
        } else if task.kind == "text" || task.kind == "diagram" {
            generate_tasks.push(task.id.clone());
        } else {
            manual_tasks.push(task.id.clone());
        }
    }
    let mut page_only: Vec<String> = impact
        .impacted_pages
        .iter()
        .filter(|page| page.impacted_tasks.is_empty())
        .map(|page| page.path.clone())
        .collect();
    generate_tasks.sort();
    manual_tasks.sort();
    approved_tasks.sort();
    page_only.sort();
    ImpactPlan {
        impact,
        generate_tasks,
        manual_tasks,
        approved_tasks,
        page_only,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::{update_task_in_docs,approve_task};
    use tempfile::tempdir;

    #[test]
    fn test_config_save_and_read() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::create_dir_all(root.join("manual")).unwrap();

        save_settings(
            root,
            "docs",
            "manual",
            "テスト指示",
            "codex",
            "gpt-4o",
            "mkdocs",
            r#"{"site_name": "Test Site"}"#,
            Some(&["docs".to_string(), "README.md".to_string()]),
            Some("local_llm"),
            Some("http://localhost:11434/v1"),
            Some("docs/assets"),
        )
        .unwrap();

        let setting_file = root.join("manual_setting.json");
        assert!(setting_file.is_file());

        let cfg = read_config(root);
        assert_eq!(cfg.docs, "docs");
        assert_eq!(cfg.output, "manual");
        assert_eq!(cfg.agent, "codex");
        assert_eq!(cfg.model, "gpt-4o");
        assert_eq!(cfg.connection_type, "local_llm");
        assert_eq!(cfg.endpoint_url, "http://localhost:11434/v1");
        assert_eq!(cfg.assets, "docs/assets");
        assert_eq!(cfg.mkdocs.site_name, "Test Site");
        assert_eq!(cfg.targets, vec!["docs", "README.md"]);
    }

    #[test]
    fn test_run_save_and_read_with_connection_settings() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::create_dir_all(root.join("manual")).unwrap();

        let options = [
            ("--connection-type", "api"),
            ("--endpoint-url", "https://api.openai.com/v1"),
            ("--model", "gpt-4o-mini"),
            ("--api-key", "test-secret-key"),
            ("--assets", "custom_assets"),
        ];
        let result = run(root, "save", &options);
        assert!(result.is_ok());

        let cfg = read_config(root);
        assert_eq!(cfg.connection_type, "api");
        assert_eq!(cfg.endpoint_url, "https://api.openai.com/v1");
        assert_eq!(cfg.model, "gpt-4o-mini");
        assert_eq!(cfg.assets, "custom_assets");
        assert_ne!(
            std::env::var("MUNIN_AI_API_KEY").ok().as_deref(),
            Some("test-secret-key")
        );

        // Verify api_key is NOT written to manual_setting.json
        let raw_setting = fs::read_to_string(root.join("manual_setting.json")).unwrap();
        assert!(!raw_setting.contains("test-secret-key"));
    }

    #[test]
    fn test_manual_targets_readme() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        fs::create_dir_all(&docs).unwrap();

        let readme = root.join("README.md");
        fs::write(
            &readme,
            "# My Project\n\n<!-- ai:task id=readme-intro kind=text\nREADME用の概要文\n-->\n",
        )
        .unwrap();

        let doc_page = docs.join("index.md");
        fs::write(
            &doc_page,
            "# Manual Top\n\n<!-- ai:task id=doc-intro kind=text\nドキュメントの紹介\n-->\n",
        )
        .unwrap();

        save_settings(
            root,
            "docs",
            "manual",
            "",
            "codex",
            "",
            "mkdocs",
            "",
            Some(&["docs".to_string(), "README.md".to_string()]),
            None,
            None,
            None,
        )
        .unwrap();

        let state = get_state(root).unwrap();
        let pages = state["pages"].as_array().unwrap();
        assert!(pages.iter().any(|p| p.as_str() == Some("README.md")));
        assert!(pages.iter().any(|p| p.as_str() == Some("index.md")));

        assert!(state.get("tasks").is_none());

        // update_task_in_docs for README.md
        let readme_task = task::find_task(&docs, "readme-intro").unwrap();
        assert_eq!(readme_task.page, "README.md");
        update_task_in_docs(
            &docs,
            &readme_task,
            "これは素晴らしいプロジェクトです。",
            None,
        )
        .unwrap();

        let updated_readme = fs::read_to_string(&readme).unwrap();
        assert!(updated_readme.contains("<!-- ai:task id=readme-intro"));
        assert!(updated_readme.contains("これは素晴らしいプロジェクトです。"));
    }

    #[test]
    fn page_tasks_reads_case_sensitive_root_readme_outside_targets() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(
            root.join("Readme.md"),
            "# Keep this\n\n<!-- ai:task id=readme-task kind=text\nSummarize\n-->\n",
        )
        .unwrap();
        fs::write(root.join("docs/index.md"), "# Docs\n").unwrap();
        save_settings(
            root,
            "docs",
            "manual",
            "",
            "codex",
            "",
            "mkdocs",
            "",
            Some(&["docs".to_string()]),
            None,
            None,
            None,
        )
        .unwrap();

        assert!(task::tasks_for_config(root, &read_config(root))
            .unwrap()
            .is_empty());
        let direct = task::tasks_for_page(root, "Readme.md").unwrap();
        assert_eq!(direct.len(), 1);
        assert_eq!(direct[0].page, "Readme.md");
        assert!(run(root, "page-tasks", &[("--page", "Readme.md")]).unwrap_err().contains("廃止"));

        let task = direct[0].clone();
        update_task_in_docs(&root.join("docs"), &task, "Generated body", None).unwrap();
        let updated = fs::read_to_string(root.join("Readme.md")).unwrap();
        assert!(updated.starts_with("# Keep this\n\n<!-- ai:task"));
        assert!(updated.contains("Generated body"));
    }

    #[test]
    fn page_tasks_rejects_duplicate_and_malformed_explicit_ids() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs")).unwrap();
        save_settings(
            root,
            "docs",
            "manual",
            "",
            "codex",
            "",
            "mkdocs",
            "",
            Some(&["docs".to_string()]),
            None,
            None,
            None,
        )
        .unwrap();

        let page = root.join("Readme.md");
        fs::write(
            &page,
            "<!-- ai:task id=same kind=text\nOne\n-->\n<!-- ai:task id=same kind=text\nTwo\n-->\n",
        )
        .unwrap();
        assert!(task::tasks_for_page(root, "Readme.md")
            .unwrap_err()
            .contains("Duplicate task ID"));

        fs::write(&page, "<!-- ai:task id=BAD kind=text\nPrompt\n-->\n").unwrap();
        assert!(task::tasks_for_page(root, "Readme.md")
            .unwrap_err()
            .contains("Invalid task ID"));

        fs::write(
            &page,
            "<!-- ai:generated kind=text -->\nBody\n<!-- /ai:generated -->\n",
        )
        .unwrap();
        assert!(task::tasks_for_page(root, "Readme.md")
            .unwrap_err()
            .contains("Missing id"));
    }

    #[test]
    fn test_init_template_manual() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();

        template::init_template(root, "manual", false, None, None, None, None).unwrap();

        let setting = root.join("manual_setting.json");
        assert!(setting.is_file());

        let docs = root.join("docs");
        assert!(docs.join("index.md").is_file());
        assert!(docs.join("quickstart.md").is_file());
        assert!(docs.join("features.md").is_file());
        assert!(docs.join("settings.md").is_file());

        let state = get_state(root).unwrap();
        assert!(state.get("tasks").is_none());
        assert!(!fs::read_to_string(docs.join("index.md")).unwrap().contains("ai:task"));
    }

    #[test]
    fn test_init_template_action_passes_options_and_returns_state() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();

        let raw = run(
            root,
            "init-template",
            &[
                ("--template", "manual"),
                ("--docs", "guide"),
                ("--output", "published"),
                ("--agent", "claude"),
                ("--model", "test-model"),
            ],
        )
        .unwrap();
        let state: serde_json::Value = serde_json::from_str(&raw).unwrap();

        assert_eq!(state["has_config"], true);
        assert_eq!(state["config"]["docs"], "guide");
        assert_eq!(state["config"]["output"], "published");
        assert_eq!(state["config"]["agent"], "claude");
        assert_eq!(state["config"]["model"], "test-model");
        assert!(root.join("guide/index.md").is_file());
        assert!(state.get("tasks").is_none());
        assert!(!fs::read_to_string(root.join("guide/index.md")).unwrap().contains("ai:task"));
    }

    #[test]
    fn test_init_template_without_clear_preserves_existing_files() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        fs::create_dir_all(&docs).unwrap();
        fs::write(docs.join("index.md"), "Handwritten guide").unwrap();
        fs::write(root.join("README.md"), "Project readme").unwrap();

        let err = run(root, "init-template", &[("--template", "manual")]).unwrap_err();

        assert_eq!(err, "EXISTING_DOCS_CONFIRM_REQUIRED");
        assert_eq!(
            fs::read_to_string(docs.join("index.md")).unwrap(),
            "Handwritten guide"
        );
        assert_eq!(
            fs::read_to_string(root.join("README.md")).unwrap(),
            "Project readme"
        );
        assert!(!root.join("manual_setting.json").exists());
    }

    #[test]
    fn test_init_template_rejects_overlapping_or_escaping_paths() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        for (docs, output) in [
            ("manual", "manual"),
            ("manual/docs", "manual"),
            ("docs", "docs/site"),
        ] {
            let err = template::init_template(
                root,
                "manual",
                false,
                Some(docs),
                Some(output),
                None,
                None,
            )
            .unwrap_err();
            assert!(err.contains("directories must be separate"));
        }
        let err = template::init_template(
            root,
            "manual",
            false,
            Some("missing/../../outside"),
            None,
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("stay inside the project"));
        assert!(!root.join("manual_setting.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn test_init_template_rejects_linked_docs_directory() {
        use std::os::unix::fs::symlink;

        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let real_docs = root.join("real_docs");
        fs::create_dir_all(&real_docs).unwrap();
        fs::write(real_docs.join("index.md"), "Original guide").unwrap();
        symlink(&real_docs, root.join("linked_docs")).unwrap();

        let err =
            template::init_template(root, "manual", true, Some("linked_docs"), None, None, None)
                .unwrap_err();

        assert!(err.contains("symbolic link"));
        assert_eq!(
            fs::read_to_string(real_docs.join("index.md")).unwrap(),
            "Original guide"
        );
    }

    #[test]
    fn test_init_template_api_and_clear() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();

        // 1回目: manual テンプレート
        template::init_template(root, "manual", false, None, None, None, None).unwrap();
        assert!(root.join("docs").join("quickstart.md").is_file());

        // 2回目: clear=false では上書き拒否（確認必要）
        let err = template::init_template(root, "api", false, None, None, None, None).unwrap_err();
        assert_eq!(err, "EXISTING_DOCS_CONFIRM_REQUIRED");

        // 3回目: clear=true で再生成
        template::init_template(root, "api", true, None, None, None, None).unwrap();
        let docs = root.join("docs");
        assert!(docs.join("index.md").is_file());
        assert!(docs.join("architecture.md").is_file());
        assert!(docs.join("api.md").is_file());
        // quickstart.md はクリアされていること
        assert!(!docs.join("quickstart.md").is_file());

        let state = get_state(root).unwrap();
        assert!(state.get("tasks").is_none());
        assert!(!fs::read_to_string(docs.join("architecture.md")).unwrap().contains("ai:task"));

        // バックアップが存在すること
        let backup_dir = root.join("manual").join(".backup");
        assert!(backup_dir.is_dir());
    }

    #[test]
    fn test_init_template_clear_backs_up_nested_docs_and_keeps_assets() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        fs::create_dir_all(docs.join("chapters")).unwrap();
        fs::create_dir_all(docs.join("assets")).unwrap();
        fs::write(docs.join("index.md"), "Original index").unwrap();
        fs::write(docs.join("chapters/usage.md"), "Original usage").unwrap();
        fs::write(docs.join("assets/figure.png"), b"image bytes").unwrap();
        fs::write(root.join("README.md"), "Project readme").unwrap();
        fs::create_dir_all(root.join("manual")).unwrap();
        fs::write(root.join("manual/brief.md"), "Custom brief").unwrap();
        fs::create_dir_all(root.join("manual/ai/answers")).unwrap();
        fs::write(root.join("manual/ai/answers/custom.md"), "Saved answer").unwrap();
        fs::write(root.join("manual/stale.html"), "Old site page").unwrap();

        run(
            root,
            "init-template",
            &[("--template", "api"), ("--clear", "true")],
        )
        .unwrap();

        let backup_root = root.join("manual/.backup");
        let backups: Vec<_> = fs::read_dir(backup_root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            fs::read_to_string(backups[0].join("index.md")).unwrap(),
            "Original index"
        );
        assert_eq!(
            fs::read_to_string(backups[0].join("chapters/usage.md")).unwrap(),
            "Original usage"
        );
        assert!(!docs.join("chapters/usage.md").exists());
        assert!(docs.join("api.md").is_file());
        assert_eq!(
            fs::read(docs.join("assets/figure.png")).unwrap(),
            b"image bytes"
        );
        assert_eq!(
            fs::read_to_string(root.join("README.md")).unwrap(),
            "Project readme"
        );
        assert_eq!(
            fs::read_to_string(root.join("manual/brief.md")).unwrap(),
            "Custom brief"
        );
        assert_eq!(
            fs::read_to_string(root.join("manual/ai/answers/custom.md")).unwrap(),
            "Saved answer"
        );
        assert_eq!(
            fs::read_to_string(root.join("manual/stale.html")).unwrap(),
            "Old site page"
        );
    }

    #[test]
    fn test_init_template_clear_keeps_docs_when_backup_fails() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        fs::create_dir_all(&docs).unwrap();
        fs::write(docs.join("index.md"), "Original content").unwrap();
        fs::write(root.join("blocked_output"), "This is a file").unwrap();

        let err =
            template::init_template(root, "api", true, None, Some("blocked_output"), None, None)
                .unwrap_err();

        assert!(err.contains("Failed to create backup directory"));
        assert_eq!(
            fs::read_to_string(docs.join("index.md")).unwrap(),
            "Original content"
        );
        assert!(!root.join("manual_setting.json").exists());
    }

    #[test]
    fn test_init_template_clear_keeps_docs_for_invalid_agent() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        fs::create_dir_all(&docs).unwrap();
        fs::write(docs.join("index.md"), "Original content").unwrap();

        let err = template::init_template(root, "api", true, None, None, Some("unsupported"), None)
            .unwrap_err();

        assert!(err.contains("Unsupported AI agent"));
        assert_eq!(
            fs::read_to_string(docs.join("index.md")).unwrap(),
            "Original content"
        );
        assert!(!root.join("manual_setting.json").exists());
    }

    #[test]
    fn test_ai_draft_failure_keeps_existing_docs_and_settings() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        fs::create_dir_all(&docs).unwrap();
        fs::write(docs.join("index.md"), "Original guide").unwrap();
        fs::write(root.join("manual_setting.json"), "Existing settings").unwrap();

        let err = template::init_template_with_response(
            root,
            "manual",
            true,
            Ok(serde_json::json!({"pages": [{"path": "../outside.md", "content": "Invalid"}]})),
        )
        .unwrap_err();

        assert!(err.contains("must include index.md"));
        assert_eq!(
            fs::read_to_string(docs.join("index.md")).unwrap(),
            "Original guide"
        );
        assert_eq!(
            fs::read_to_string(root.join("manual_setting.json")).unwrap(),
            "Existing settings"
        );
        assert!(!root.join("outside.md").exists());
    }

    #[test]
    fn test_ai_cli_failure_keeps_existing_docs() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        fs::create_dir_all(&docs).unwrap();
        fs::write(docs.join("index.md"), "Original guide").unwrap();

        let err = template::init_template_with_response(
            root,
            "manual",
            true,
            Err("AI CLI failed".to_string()),
        )
        .unwrap_err();

        assert_eq!(err, "AI CLI failed");
        assert_eq!(
            fs::read_to_string(docs.join("index.md")).unwrap(),
            "Original guide"
        );
        assert!(!root.join("manual_setting.json").exists());
    }

    #[test]
    fn test_ai_draft_response_replaces_docs_after_validation() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        fs::create_dir_all(&docs).unwrap();
        fs::write(docs.join("index.md"), "Original guide").unwrap();

        template::init_template_with_response(
            root,
            "manual",
            true,
            Ok(serde_json::json!({"pages": [
                {"path": "index.md", "content": "# New guide\n\n<!-- ai:task id=overview-screenshot kind=screenshot\nトップページの概要画面を撮影\n-->"},
                {"path": "chapters/start.md", "content": "# Getting started"}
            ]})),
        )
        .unwrap();

        let index=fs::read_to_string(docs.join("index.md")).unwrap();
        assert!(index.contains("# New guide"));
        assert!(!index.contains("ai:task"));
        assert_eq!(
            fs::read_to_string(docs.join("chapters/start.md")).unwrap(),
            "# Getting started\n"
        );
        assert!(root.join("manual/.backup").is_dir());
    }

    #[test]
    fn test_ai_manual_draft_accepts_plain_manuscript() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        fs::create_dir_all(&docs).unwrap();
        fs::write(docs.join("index.md"), "Original guide").unwrap();

        template::init_template_with_response(
            root,
            "manual",
            true,
            Ok(serde_json::json!({"pages": [
                {"path": "index.md", "content": "# New guide"},
                {"path": "quickstart.md", "content": "# Quickstart"}
            ]})),
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(docs.join("index.md")).unwrap(),
            "# New guide\n"
        );
        assert!(root.join("manual_setting.json").exists());
        assert!(root.join("manual/.backup").is_dir());
    }

    #[test]
    fn test_build_without_mkdocs_keeps_existing_output() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        let output = root.join("manual");
        fs::create_dir_all(&docs).unwrap();
        fs::create_dir_all(&output).unwrap();
        fs::write(docs.join("index.md"), "# Guide").unwrap();
        fs::write(output.join("index.html"), "Existing preview").unwrap();
        fs::write(output.join("notes.txt"), "User note").unwrap();

        let result = builder::build_without_mkdocs(&docs, &output.join("ai"), &output).unwrap();

        assert!(result.contains("MkDocs site build skipped"));
        assert_eq!(
            fs::read_to_string(output.join("index.html")).unwrap(),
            "Existing preview"
        );
        assert_eq!(
            fs::read_to_string(output.join("notes.txt")).unwrap(),
            "User note"
        );
    }

    #[test]
    fn test_init_template_custom_dirs() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();

        // docs="my_docs", output="dist_site", agent="claude", model="claude-3-7-sonnet"
        template::init_template(
            root,
            "manual",
            false,
            Some("my_docs"),
            Some("dist_site"),
            Some("claude"),
            Some("claude-3-7-sonnet"),
        )
        .unwrap();

        let setting = root.join("manual_setting.json");
        assert!(setting.is_file());
        let cfg = config::read_config(root);
        assert_eq!(cfg.docs, "my_docs");
        assert_eq!(cfg.output, "dist_site");
        assert_eq!(cfg.agent, "claude");
        assert_eq!(cfg.model, "claude-3-7-sonnet");
        assert!(cfg.targets.contains(&"my_docs".to_string()));

        let custom_docs = root.join("my_docs");
        assert!(custom_docs.join("index.md").is_file());
        assert!(custom_docs.join("quickstart.md").is_file());

        assert!(root.join("manual").join("brief.md").is_file());
    }

    #[test]
    fn test_has_config_state() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();

        // 初期状態: 設定なし
        assert!(!config::has_config(root));
        let state = get_state(root).unwrap();
        assert_eq!(state["has_config"], false);

        // manual_setting.json 作成後
        fs::write(root.join("manual_setting.json"), "{}").unwrap();
        assert!(config::has_config(root));
        let state2 = get_state(root).unwrap();
        assert_eq!(state2["has_config"], true);
    }

    #[test]
    fn test_task_scan_and_approval() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        let gen = root.join("manual").join("ai");
        fs::create_dir_all(&docs).unwrap();

        let page1 = docs.join("index.md");
        fs::write(
            &page1,
            "# Top\n\n<!-- ai:task id=generate_core_module_diagram kind=text\nこのアプリの紹介文を書く\n-->\n",
        )
        .unwrap();

        let t = task::tasks(&docs).unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].id, "generate_core_module_diagram");
        assert_eq!(t[0].kind, "text");
        assert_eq!(t[0].status, "missing");

        // 回答を保存
        task::save_answer(&gen, &t[0], "ModuleLoomへようこそ。").unwrap();
        task::update_task_in_docs(&docs, &t[0], "ModuleLoomへようこそ。", None).unwrap();

        let scanned = task::scan_entries(&docs, &gen);
        assert_eq!(scanned[0].status, "current");

        // 承認
        approve_task(&docs, &gen, "generate_core_module_diagram").unwrap();
        let approved = task::scan_entries(&docs, &gen);
        assert_eq!(approved[0].status, "approved");
    }

    #[test]
    fn test_single_responsibility_record_screenshot() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        fs::create_dir_all(&docs).unwrap();

        let page1 = docs.join("index.md");
        fs::write(
            &page1,
            "# Top\n\n<!-- ai:task id=top-shot kind=screenshot\nツールウィンドウの全体画面\n-->\n",
        )
        .unwrap();

        // ダミーPNGを作成
        let img = root.join("screen.png");
        image::RgbImage::new(2, 2).save(&img).unwrap();

        author::record_screenshot(root, "top-shot", &img).unwrap();

        let updated = fs::read_to_string(&page1).unwrap();
        assert!(updated.contains("![top-shot](assets/screen.png)"));
        assert!(updated.contains("<!-- ai:task id=top-shot kind=screenshot"));
        assert_eq!(
            task::find_task(&docs, "top-shot").unwrap().prompt,
            "ツールウィンドウの全体画面"
        );
        assert_eq!(
            preview::get_state(root).unwrap()["image_assets"]["top-shot"],
            "assets/screen.png"
        );
        // 不要な出典や定型文が一切含まれていないことを検証
        assert!(!updated.contains("実際の PyCharm"));
        assert!(!updated.contains("図の生成元"));
    }

    #[test]
    fn test_record_screenshot_reapplies_existing_markits_annotations() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        fs::create_dir_all(docs.join("assets")).unwrap();
        let old_asset = docs.join("assets/marked.png");
        let old_background =
            image::RgbaImage::from_pixel(100, 80, image::Rgba([255, 255, 255, 255]));
        let mut old_png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(old_background)
            .write_to(&mut old_png, image::ImageFormat::Png)
            .unwrap();
        let scene = r#"{"canvas":{"width":100,"height":80},"annotations":[{"type":"rect","target":[10,10,30,20],"style":"danger"}]}"#;
        let marked = markits::raster::render_composed_png_bytes(scene, old_png.get_ref()).unwrap();
        let marked =
            markits::raster::embed_png_text_chunk(&marked, "markits:annotations", scene).unwrap();
        fs::write(&old_asset, marked).unwrap();
        fs::write(docs.join("index.md"), "<!-- ai:generated id=top-shot kind=screenshot -->\n![画面](assets/marked.png)\n<!-- /ai:generated -->\n").unwrap();
        let new_capture = root.join("capture.png");
        let fresh_background =
            image::RgbaImage::from_pixel(100, 80, image::Rgba([255, 255, 255, 255]));
        image::DynamicImage::ImageRgba8(fresh_background)
            .save(&new_capture)
            .unwrap();

        author::record_screenshot(root, "top-shot", &new_capture).unwrap();

        let output = fs::read(docs.join("assets/capture.png")).unwrap();
        let annotations = markits::raster::read_png_text_chunk(&output, "markits:annotations")
            .unwrap()
            .unwrap();
        let annotations: serde_json::Value = serde_json::from_str(&annotations).unwrap();
        let target = annotations["annotations"][0]["target"].as_array().unwrap();
        assert_eq!(
            target
                .iter()
                .map(|value| value.as_f64().unwrap())
                .collect::<Vec<_>>(),
            vec![10.0, 10.0, 30.0, 20.0]
        );
        assert!(
            markits::raster::read_png_text_chunk(&output, "markits:source_image")
                .unwrap()
                .is_some()
        );
        let pixels = image::load_from_memory(&output).unwrap().to_rgba8();
        assert_ne!(pixels.get_pixel(15, 15), &image::Rgba([255, 255, 255, 255]));
        let markdown = fs::read_to_string(docs.join("index.md")).unwrap();
        let preview = editor::render_html(root, "docs/index.md", &markdown).unwrap();
        assert!(preview.contains("data:image/png;base64,"));
    }

    #[test]
    fn test_record_screenshot_restores_spotlight_from_prompt_or_nested_asset() {
        for embedded in [false, true] {
            let tmp = tempdir().unwrap();
            let root = tmp.path();
            fs::create_dir_all(root.join("docs/sub")).unwrap();
            fs::create_dir_all(root.join("media")).unwrap();
            fs::write(
                root.join("manual_setting.json"),
                r#"{"docs":"docs","assets":"media","targets":["docs"]}"#,
            )
            .unwrap();
            let scene = r#"{"canvas":{"width":100,"height":80},"annotations":[{"type":"spotlight","target":[10,10,30,20],"style":"primary"}]}"#;
            let old_image = root.join("media/old.png");
            image::RgbaImage::from_pixel(100, 80, image::Rgba([255, 255, 255, 255]))
                .save(&old_image)
                .unwrap();
            let prompt = if embedded {
                let bytes = fs::read(&old_image).unwrap();
                fs::write(
                    &old_image,
                    markits::raster::embed_png_text_chunk(&bytes, "markits:annotations", scene)
                        .unwrap(),
                )
                .unwrap();
                "Capture the app".to_string()
            } else {
                format!("Capture the app\n\nMarkIts アノテーション仕様:\n```json\n{scene}\n```")
            };
            let manuscript = format!("<!-- ai:task id=spot kind=screenshot prompt=\"{}\" -->\n![spot](../../media/old.png)\n<!-- /ai:task -->\n", task::escape_prompt(&prompt));
            fs::write(root.join("docs/sub/index.md"), manuscript).unwrap();
            let fresh = root.join("fresh.png");
            image::RgbaImage::from_pixel(200, 160, image::Rgba([255, 255, 255, 255]))
                .save(&fresh)
                .unwrap();
            author::record_screenshot(root, "spot", &fresh).unwrap();
            let output = fs::read(root.join("media/fresh.png")).unwrap();
            let image = image::load_from_memory(&output).unwrap().to_rgb8();
            assert!(
                image.get_pixel(40, 40).0[0] > 240,
                "inside spotlight stays bright"
            );
            assert!(
                image.get_pixel(180, 120).0[0] < 200,
                "outside spotlight must be darkened"
            );
            let metadata = markits::raster::read_png_text_chunk(&output, "markits:annotations")
                .unwrap()
                .unwrap();
            let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
            assert_eq!(
                metadata["annotations"][0]["target"],
                serde_json::json!([20.0, 20.0, 60.0, 40.0])
            );
            assert!(fs::read_to_string(root.join("docs/sub/index.md"))
                .unwrap()
                .contains("../../media/fresh.png"));
        }
    }

    #[test]
    fn test_invalid_spotlight_prompt_preserves_existing_screenshot() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs/assets")).unwrap();
        let prompt = "MarkIts アノテーション仕様:\n```json\n{\"canvas\":{\"w。。idth\":100,\"height\":80},\"annotations\":[{\"type\":\"spotlight\",\"target\":[10,10,30,20]}]}\n```";
        let manuscript = format!("<!-- ai:task id=spot kind=screenshot prompt=\"{}\" -->\n![spot](assets/old.png)\n<!-- /ai:task -->\n", task::escape_prompt(prompt));
        let document = root.join("docs/index.md");
        fs::write(&document, &manuscript).unwrap();
        let old_image = root.join("docs/assets/old.png");
        image::RgbaImage::from_pixel(100, 80, image::Rgba([255, 255, 255, 255]))
            .save(&old_image)
            .unwrap();
        let original_image = fs::read(&old_image).unwrap();
        let capture = root.join("capture.png");
        image::RgbaImage::from_pixel(100, 80, image::Rgba([255, 255, 255, 255]))
            .save(&capture)
            .unwrap();
        let error = author::record_screenshot(root, "spot", &capture).unwrap_err();
        assert!(error.contains("canvas幅"));
        assert_eq!(fs::read_to_string(document).unwrap(), manuscript);
        assert_eq!(fs::read(old_image).unwrap(), original_image);
        assert!(!root.join("docs/assets/capture.png").exists());
    }

    #[test]
    fn test_record_screenshot_in_readme_links_to_source_assets() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(
            root.join("manual_setting.json"),
            r#"{"docs":"docs","output":"manual","targets":["docs","README.md"]}"#,
        )
        .unwrap();
        fs::write(
            root.join("README.md"),
            "# Project\n\n<!-- ai:task id=readme-shot kind=screenshot\nプロジェクトの画面を撮影\n-->\n",
        )
        .unwrap();
        let image = root.join("screen.png");
        image::RgbImage::new(2, 2).save(&image).unwrap();

        author::record_screenshot(root, "readme-shot", &image).unwrap();

        let readme = fs::read_to_string(root.join("README.md")).unwrap();
        assert!(readme.contains("![readme-shot](docs/assets/screen.png)"));
        assert!(root.join("docs/assets/screen.png").is_file());
    }

    #[test]
    fn test_context_building() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();

        fs::write(
            root.join("pyproject.toml"),
            "[project]\nname = \"sample_app\"\ndescription = \"Test app\"\n",
        )
        .unwrap();
        fs::write(
            root.join("README.md"),
            "# Sample App\nThis is a sample project for testing.\n",
        )
        .unwrap();

        let pkg = root.join("sample_app");
        fs::create_dir_all(&pkg).unwrap();
        fs::write(pkg.join("__init__.py"), "").unwrap();
        fs::write(
            pkg.join("service.py"),
            "class AppService:\n    def run(self):\n        pass\n",
        )
        .unwrap();

        let ctx = context::build_application_context(root);
        assert_eq!(ctx.name, "sample_app");
        assert!(ctx.readme_summary.contains("Sample App"));
        assert!(ctx.key_modules.iter().any(|m| m.contains("service")));
        assert!(ctx.prompt_summary.contains("sample_app"));
    }

    #[test]
    fn removed_ui_map_actions_are_rejected_and_legacy_data_is_preserved() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("manual")).unwrap();
        let legacy = root.path().join("manual/ui_map.json");
        fs::write(&legacy, "legacy user data").unwrap();
        for action in ["ui-map", "ui-map-import", "ui-explore", "ui-map-from-image", "ui-map-from-desktop"] {
            assert!(run(root.path(), action, &[]).unwrap_err().contains("Unsupported manual action"));
        }
        let context = serde_json::to_value(context::build_application_context(root.path())).unwrap();
        assert!(context.get("ui_map").is_none());
        let state: serde_json::Value = serde_json::from_str(&run(root.path(), "state", &[]).unwrap()).unwrap();
        assert!(state.get("ui_map").is_none());
        assert_eq!(fs::read_to_string(legacy).unwrap(), "legacy user data");
    }

    #[test]
    fn test_dependency_graph_building() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        fs::create_dir_all(&docs).unwrap();

        let pkg = root.join("myapp");
        fs::create_dir_all(&pkg).unwrap();
        fs::write(
            pkg.join("engine.py"),
            "class Engine:\n    def start(self):\n        pass\n",
        )
        .unwrap();

        fs::write(
            root.join("index.html"),
            r#"<button id="btn-engine">Start Engine</button>"#,
        )
        .unwrap();

        let page = docs.join("guide.md");
        fs::write(
            &page,
            "# User Guide\n\nRefer to `myapp.engine` and click #btn-engine.\n\n<!-- ai:task id=shot-engine kind=screenshot\n#btn-engine の操作画面\n-->\n",
        )
        .unwrap();

        let graph = deps::build_manual_dependency_graph(root, &docs).unwrap();
        assert!(graph.pages.contains_key("guide.md"));

        let page_dep = graph.pages.get("guide.md").unwrap();
        assert_eq!(page_dep.title, "User Guide");
        assert!(page_dep.symbols.contains(&"myapp.engine".to_string()));
        assert!(page_dep
            .ui_elements
            .iter()
            .any(|u| u.contains("btn-engine")));
        assert!(page_dep.tasks.contains(&"shot-engine".to_string()));

        assert!(graph.symbol_to_pages.contains_key("myapp.engine"));
        assert!(graph.task_dependencies.contains_key("shot-engine"));
    }

    #[test]
    fn test_impact_rebuilds_graph_after_docs_change() {
        use std::process::Command;

        let tmp = tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("app.py"), "def run():\n    return 1\n").unwrap();
        fs::write(root.join("docs/guide.md"), "# Guide\n\nNo code links.\n").unwrap();
        fs::write(
            root.join("index.html"),
            "<button id=\"run-button\">Run</button>",
        )
        .unwrap();

        let git = |args: &[&str]| {
            let output = Command::new("git")
                .current_dir(root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-q"]);
        git(&["add", "."]);
        git(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "initial",
        ]);

        let stale = deps::build_manual_dependency_graph(root, &root.join("docs")).unwrap();
        assert!(!stale.symbol_to_pages.contains_key("app"));
        fs::write(root.join("docs/guide.md"), "# Guide\n\nCall `app.run`.\n").unwrap();
        fs::write(root.join("app.py"), "def run():\n    return 2\n").unwrap();
        fs::create_dir_all(root.join("manual")).unwrap();
        fs::write(
            root.join("manual/index.html"),
            "<button id=\"run-button\">Run</button>",
        )
        .unwrap();

        let impact = deps::analyze_git_impact(root, Some("HEAD")).unwrap();
        assert_eq!(impact.total_impacted_pages, 1);
        assert_eq!(impact.impacted_pages[0].path, "guide.md");
        assert!(impact.affected_symbols.contains(&"app".to_string()));
        assert!(impact.affected_ui_elements.is_empty());
    }

    #[test]
    fn test_explicit_file_dependency_impacts_rust_task() {
        use std::process::Command;

        let tmp = tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/settings.rs"), "pub fn open() {}\n").unwrap();
        fs::write(
            root.join("docs/guide.md"),
            "# Guide\n\n<!-- ai:task id=settings-shot kind=screenshot\n設定画面を撮影する。\n-->\n\n<!-- ai:depends task=settings-shot file=src/settings.rs ui=#settings -->\n\n```md\n<!-- ai:depends file=src/example.rs -->\n```\n",
        )
        .unwrap();

        let graph = deps::build_manual_dependency_graph(root, &root.join("docs")).unwrap();
        let page = &graph.pages["guide.md"];
        assert_eq!(page.files, vec!["src/settings.rs"]);
        assert_eq!(
            graph.task_dependencies["settings-shot"].files,
            vec!["src/settings.rs"]
        );
        assert!(page.evidence.iter().any(|e| {
            e.reference == "file:src/settings.rs"
                && e.origin == "ai:depends"
                && e.task_id.as_deref() == Some("settings-shot")
        }));
        assert!(!graph.file_to_pages.contains_key("src/example.rs"));

        let git = |args: &[&str]| {
            let output = Command::new("git")
                .current_dir(root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-q"]);
        git(&["add", "."]);
        git(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "initial",
        ]);
        fs::write(
            root.join("src/settings.rs"),
            "pub fn open() { println!(\"open\"); }\n",
        )
        .unwrap();

        let impact = deps::analyze_git_impact(root, Some("HEAD")).unwrap();
        assert_eq!(impact.total_impacted_pages, 1);
        assert_eq!(
            impact.impacted_pages[0].impacted_tasks,
            vec!["settings-shot"]
        );
        assert!(impact.impacted_pages[0]
            .reasons
            .iter()
            .any(|r| r.contains("src/settings.rs")));
        assert!(run(root,"impact-plan", &[("--ref","HEAD")]).unwrap_err().contains("廃止"));
        assert!(deps::analyze_git_impact(root, Some("no-such-ref"))
            .unwrap_err()
            .contains("Failed to compare Git ref"));
    }

    #[test]
    fn test_explicit_dependency_rejects_invalid_file_path() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(
            root.join("docs/guide.md"),
            "# Guide\n\n<!-- ai:depends file=../outside.rs -->\n",
        )
        .unwrap();
        let error = deps::build_manual_dependency_graph(root, &root.join("docs")).unwrap_err();
        assert!(error.contains("Invalid ai:depends file"));
    }

    #[test]
    fn test_impact_plan_limits_generation_and_preserves_manual_review() {
        let impact = deps::ImpactReport {
            impacted_pages: vec![
                deps::ImpactedPage {
                    path: "guide.md".into(),
                    reasons: vec!["changed".into()],
                    impacted_tasks: vec![
                        "write-guide".into(),
                        "capture-guide".into(),
                        "locked-guide".into(),
                    ],
                    requires_rebuild: true,
                },
                deps::ImpactedPage {
                    path: "overview.md".into(),
                    reasons: vec!["changed".into()],
                    impacted_tasks: vec![],
                    requires_rebuild: true,
                },
            ],
            ..Default::default()
        };
        let make_task = |id: &str, kind: &str, status: &str| task::Task {
            id: id.into(),
            name: String::new(),
            kind: kind.into(),
            page: "guide.md".into(),
            prompt: String::new(),
            source_sha256: String::new(),
            status: status.into(),
        };
        let tasks = vec![
            make_task("write-guide", "text", "current"),
            make_task("capture-guide", "screenshot", "current"),
            make_task("locked-guide", "text", "approved"),
            make_task("unrelated", "text", "current"),
        ];
        let plan = plan_impacted_tasks(impact, &tasks);
        assert_eq!(plan.generate_tasks, vec!["write-guide"]);
        assert_eq!(plan.manual_tasks, vec!["capture-guide"]);
        assert_eq!(plan.approved_tasks, vec!["locked-guide"]);
        assert_eq!(plan.page_only, vec!["overview.md"]);
    }

    #[test]
    fn test_scenario_rejects_non_screenshot_task_before_browser_launch() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(
            root.join("docs/index.md"),
            "<!-- ai:task id=intro kind=text\n説明を書く\n-->\n",
        )
        .unwrap();
        fs::write(
            root.join("scenario.json"),
            r##"{"version":1,"base_url":"http://localhost:3000","steps":[{"screenshot":{"task":"intro","selector":"#dialog"}}]}"##,
        )
        .unwrap();
        let error = run(root, "scenario-run", &[("--input", "scenario.json")]).unwrap_err();
        assert!(error.contains("not a screenshot"));
        assert!(!root.join("docs/assets/intro.png").exists());
    }

    #[test]
    fn test_markits_render() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let scene_json = r#"{
            "canvas": { "width": 800, "height": 600 },
            "annotations": [
                {
                    "type": "callout",
                    "target": [100.0, 100.0, 200.0, 50.0],
                    "text": "保存ボタン",
                    "style": "primary"
                }
            ]
        }"#;

        let res = run(root, "markits-render", &[("--json", scene_json)]).unwrap();
        assert!(res.contains("<svg"));
        assert!(res.contains("保存ボタン"));
    }

    #[test]
    fn test_markits_render_crops_image_and_translates_uimap() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let image = image::RgbaImage::new(400, 300);
        let mut source = Vec::new();
        image
            .write_to(
                &mut std::io::Cursor::new(&mut source),
                image::ImageFormat::Png,
            )
            .unwrap();
        let elements = vec![
            markits::UiElement::new("button", "保存", 100.0, 100.0, 80.0, 30.0),
            markits::UiElement::new("button", "設定", 300.0, 250.0, 50.0, 20.0),
        ];
        let source = markits::raster::embed_png_uimap(&source, &elements).unwrap();
        fs::write(root.join("screen.png"), source).unwrap();
        let scene = r#"{"annotations":[{"type":"rect","target":"保存"}]}"#;
        let result = run(
            root,
            "markits-render",
            &[
                ("--json", scene),
                ("--image", "screen.png"),
                ("--output", "assets/save.png"),
                ("--crop", ""),
                ("--crop-margin", "10"),
            ],
        )
        .unwrap();
        let result: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(result["width"], 100);
        assert_eq!(result["height"], 50);
        assert_eq!(result["ui_elements"], 1);
        let info = markits::raster::inspect_image(&root.join("assets/save.png")).unwrap();
        let saved = info.uimap.unwrap();
        assert_eq!(saved[0].name, "保存");
        assert_eq!((saved[0].x, saved[0].y), (10.0, 10.0));
    }

    #[test]
    fn test_optional_id_auto_assignment() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        let gen = root.join("manual").join("ai");
        fs::create_dir_all(&docs).unwrap();
        fs::create_dir_all(&gen).unwrap();

        let page1 = docs.join("guide.md");
        fs::write(
            &page1,
            "# ガイド\n\n<!-- ai:task kind=screenshot\nメイン画面を撮影\n-->\n\n<!-- ai:task kind=diagram id=explicit-diag\n依存図\n-->\n",
        )
        .unwrap();

        let t = task::tasks(&docs).unwrap();
        assert_eq!(t.len(), 2);

        // 1つ目はid省略のため自動付与されている
        let auto_task = t.iter().find(|task| task.kind == "screenshot").unwrap();
        assert!(auto_task.id.starts_with("screenshot-guide-"));
        let valid_id_re = regex::Regex::new(r"^[a-z][a-z0-9_-]*$").unwrap();
        assert!(valid_id_re.is_match(&auto_task.id));

        // 2つ目は明示指定ID
        let explicit_task = t.iter().find(|task| task.kind == "diagram").unwrap();
        assert_eq!(explicit_task.id, "explicit-diag");

        // 自動付与されたタスクに対して更新を実行
        let answer_body = "![guide-screenshot](assets/guide.png)";
        task::save_answer(&gen, auto_task, answer_body).unwrap();
        task::update_task_in_docs(&docs, auto_task, answer_body, None).unwrap();

        let updated_content = fs::read_to_string(&page1).unwrap();
        assert!(updated_content.contains(&format!("<!-- ai:task id={}", auto_task.id)));
        assert!(updated_content.contains("![guide-screenshot](assets/guide.png)"));
        assert!(
            updated_content.contains(&format!("<!-- ai:task id={} kind=screenshot", auto_task.id))
        );

        // 再スキャンしてもステータスが維持される
        let scanned = task::scan_entries(&docs, &gen);
        let found = scanned.iter().find(|s| s.id == auto_task.id).unwrap();
        assert_eq!(found.status, "current");
    }

    #[test]
    fn test_code_block_examples_ignored() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        fs::create_dir_all(&docs).unwrap();

        let page = docs.join("preview.md");
        let content = r#"# ドキュメント記法

以下はマニュアル内で AI タスクを書く書き方の例です：

```markdown
<!-- ai:task id=<一意のID> kind=<screenshot|diagram|text>
<指示文 / プロンプト>
-->
```

本物のタスクはここだけです：

<!-- ai:task id=real-task kind=text
本物の指示文です
-->
"#;
        fs::write(&page, content).unwrap();

        let t = task::tasks(&docs).unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].id, "real-task");
    }

    #[test]
    fn test_update_task_instruction_keeps_generated_result_and_marks_it_stale() {
        let tmp = tempdir().unwrap();
        let docs = tmp.path().join("docs");
        let gen = tmp.path().join("manual/ai");
        fs::create_dir_all(&docs).unwrap();
        let page = docs.join("index.md");
        fs::write(&page, "<!-- ai:task id=intro kind=text\n古い指示\n-->\n").unwrap();
        let original = task::find_task(&docs, "intro").unwrap();
        task::save_answer(&gen, &original, "既存の本文").unwrap();
        task::update_task_in_docs(&docs, &original, "既存の本文", None).unwrap();

        task::update_task_prompt(&docs, "intro", "新しい指示\n二行目").unwrap();
        let content = fs::read_to_string(&page).unwrap();
        assert!(content.contains("prompt=\"新しい指示&#10;二行目\""));
        assert!(content.contains("既存の本文"));
        let changed = task::find_task(&docs, "intro").unwrap();
        assert_eq!(changed.status, "stale");
        assert_eq!(
            changed.source_sha256,
            task::source_hash("text", "新しい指示\n二行目")
        );
        assert_eq!(task::scan_entries(&docs, &gen)[0].status, "stale");

        task::update_task_in_docs(&docs, &changed, "更新した本文", None).unwrap();
        assert_eq!(task::scan_entries(&docs, &gen)[0].status, "current");
    }

    #[test]
    fn test_update_task_instruction_assigns_stable_id_to_implicit_task() {
        let tmp = tempdir().unwrap();
        let docs = tmp.path().join("docs");
        fs::create_dir_all(&docs).unwrap();
        let page = docs.join("index.md");
        fs::write(&page, "<!-- ai:task kind=text\n元の指示\n-->\n").unwrap();
        let original = task::tasks(&docs).unwrap().remove(0);
        task::update_task_prompt(&docs, &original.id, "変更後の指示").unwrap();
        let updated = task::tasks(&docs).unwrap().remove(0);
        assert_eq!(updated.id, original.id);
        assert_eq!(updated.prompt, "変更後の指示");
        assert!(fs::read_to_string(&page)
            .unwrap()
            .contains(&format!("id={}", original.id)));
    }

    #[test]
    fn test_clean_generated_body_unwraps_tags() {
        assert_eq!(
            task::clean_generated_body("普通の文章です。"),
            "普通の文章です。"
        );
        assert_eq!(
            task::clean_generated_body(
                "<!-- ai:generated id=foo kind=text -->\n生成された本文\n<!-- /ai:generated -->"
            ),
            "生成された本文"
        );
        assert_eq!(
            task::clean_generated_body("<!-- ai:task id=foo kind=text\n指示内の本文\n-->"),
            "指示内の本文"
        );
        // Nested unwrapping
        assert_eq!(
            task::clean_generated_body(
                "<!-- ai:generated id=foo -->\n<!-- ai:task id=foo -->\n二重の本文\n<!-- /ai:generated -->"
            ),
            "二重の本文"
        );
    }

    #[test]
    fn test_update_task_in_docs_unwraps_wrapped_ai_answers() {
        let tmp = tempdir().unwrap();
        let docs = tmp.path().join("docs");
        fs::create_dir_all(&docs).unwrap();
        let page = docs.join("guide.md");
        fs::write(
            &page,
            "# ガイド\n\n<!-- ai:task id=guide-text kind=text\nガイドの説明文\n-->\n",
        )
        .unwrap();
        let target_task = task::find_task(&docs, "guide-text").unwrap();

        // AI accidentally wraps its answer in <!-- ai:generated -->
        let wrapped_answer = "<!-- ai:generated id=guide-text kind=text -->\nAIが作成した可視のガイド本文です。\n<!-- /ai:generated -->";
        update_task_in_docs(&docs, &target_task, wrapped_answer, None).unwrap();

        let updated = fs::read_to_string(&page).unwrap();
        // The visible text must NOT be nested inside duplicate comment tags
        assert!(updated.contains("<!-- ai:task id=guide-text"));
        assert!(updated.contains("AIが作成した可視のガイド本文です。"));
        // The unified task has one opening and one closing tag
        assert_eq!(updated.matches("<!-- ai:task").count(), 1);
        assert_eq!(updated.matches("<!-- /ai:task -->").count(), 1);
    }
}
