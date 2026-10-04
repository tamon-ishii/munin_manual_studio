use base64::Engine;
use image::GenericImageView;
use regex::Regex;
use serde_json::json;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::tempdir;

use super::agent::{agent_json, log_progress};
use super::builder::build;
use super::config::{project_path, read_config, DEFAULT_BRIEF};
use super::task::{
    collect_markdown_files, find_task, parse_page_tags, read_answer, save_answer, tasks_for_page,
    update_task_in_docs, utc_now,
};

pub fn draft(root: &Path) -> Result<(), String> {
    log_progress(root, "既存の原稿を確認し、下書きの準備をしています");
    let config = read_config(root);
    let templates = project_path(root, &config.docs)?;
    let generated = root.join("manual").join("ai");
    let output = project_path(root, &config.output)?;

    if templates.is_dir() {
        let existing = collect_markdown_files(&templates);
        if !existing.is_empty() {
            let backup_dir = root
                .join("manual")
                .join(".backup")
                .join(utc_now().replace(':', "-"));
            fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;
            for old_file in existing {
                let rel = old_file.strip_prefix(&templates).unwrap_or(&old_file);
                let dest = backup_dir.join(rel);
                if let Some(parent) = dest.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let _ = fs::copy(&old_file, &dest);
            }
        }
    }

    let brief_path = root.join("manual").join("brief.md");
    if !brief_path.is_file() {
        if let Some(parent) = brief_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(&brief_path, DEFAULT_BRIEF).map_err(|e| e.to_string())?;
    }
    let brief = fs::read_to_string(&brief_path).map_err(|e| e.to_string())?;

    log_progress(root, "プロジェクトの構造と画面情報を調べています");
    let app_context = super::context::build_application_context(root);

    let draft_prompt = format!(
        "Read the application context, AST module structure, UI Map, and manual brief below. \
        Create a comprehensive Japanese MkDocs manual outline as JSON pages for this specific application. \
        Use Markdown files, with index.md required. \
        Insert unique <!-- ai:task id=... kind=text|screenshot|diagram\\n...\\n--> tags for work requiring AI, real screenshots, or Mermaid diagrams.\n\
        IMPORTANT RULES FOR TASKS & LAYOUT:\n\
        - You MUST include at least one kind=screenshot ai:task in index.md. Do not omit it or replace it with a static image link. Put it immediately after the short introduction and before navigation.\n\
        - The screenshot task prompt must describe a real screen of the TARGET application and the controls that should be visible. It appears in ModuleLoom's 「更新対象アセット」 list, where the instruction can be copied for an agent with access to the target application and the resulting PNG can be registered.\n\
        - kind=screenshot tasks must describe only real screens of the target application. ModuleLoom can capture a selected window on Linux/X11, macOS, and Windows; Wayland uses the system screenshot chooser. A desktop scenario can launch and operate the target application on supported desktops. Do not request a screenshot of ModuleLoom or assume a DOM selector from ModuleLoom refers to the target application.\n\
        - kind=diagram tasks must ONLY request generating the pure Mermaid dependency graph via ModuleLoom CLI for key modules.\n\
        - If an explanation, annotation, walkthrough, or caption of a screenshot or diagram is needed, create a separate dedicated kind=text task directly before or after it.\n\
        - Design chapters directly matching the application's actual modules, UI features, and workflows.\n\
        - For each page, add an <!-- ai:audience user -->, <!-- ai:audience developer -->, or <!-- ai:audience maintainer --> directive when it serves one reader group; omit the directive for shared pages.\n\
        - Add <!-- ai:depends task=TASK_ID file=PROJECT_RELATIVE_PATH --> for known source-to-task links. Do not guess file paths.\n\
        - For workflows suitable for repeatable Web or desktop UI testing, describe the steps in the task prompt. A scenario file can later be linked with <!-- ai:scenario file=manual/scenarios/NAME.json -->.\n\
        Do not invent non-existent UI labels. Return at most 8 pages.\n\n\
        {}\n\n\
        Brief:\n{brief}",
        app_context.prompt_summary
    );

    let schema = json!({
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

    log_progress(root, "AIに章立てと原稿案を依頼しています");
    let result = agent_json(root, &draft_prompt, &schema, &config.agent, &config.model)?;
    log_progress(root, "AIの回答を検査し、原稿ファイルを準備しています");
    let pages = result
        .get("pages")
        .and_then(|p| p.as_array())
        .ok_or_else(|| format!("{} returned an invalid page list", config.agent))?;

    if pages.is_empty() || pages.len() > 8 {
        return Err(format!("{} returned an invalid page list", config.agent));
    }

    let mut validated = Vec::new();
    let mut has_index = false;

    for p in pages {
        let path_str = p.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let content = p.get("content").and_then(|v| v.as_str()).unwrap_or("");
        let rel = Path::new(path_str);
        if rel.is_absolute()
            || path_str.contains("..")
            || rel.extension().is_none_or(|ext| ext != "md")
            || path_str.is_empty()
        {
            return Err(format!("Invalid draft page path: {path_str}"));
        }
        if path_str == "index.md" {
            has_index = true;
        }
        validated.push((path_str.to_string(), content.to_string()));
    }

    if !has_index {
        return Err(format!("{} draft must include index.md", config.agent));
    }

    fs::create_dir_all(&templates).map_err(|e| e.to_string())?;

    let tmp = tempdir().map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(brief.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    let now = utc_now();

    for (rel_path, content) in &validated {
        let dest = tmp.path().join(rel_path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let wrapped = format!(
            "<!-- ai:draft created-at={now} agent={} brief-sha256={digest} -->\n{}\n<!-- /ai:draft -->\n",
            config.agent,
            content.trim_end()
        );
        fs::write(&dest, wrapped).map_err(|e| e.to_string())?;
    }

    // 書式チェック
    let generated_tasks = super::task::tasks(tmp.path())?;
    if !generated_tasks
        .iter()
        .any(|task| task.page == "index.md" && task.kind == "screenshot")
    {
        return Err(format!(
            "{} manual draft must include an index.md screenshot ai:task for the 更新対象アセット list",
            config.agent
        ));
    }

    log_progress(
        root,
        &format!("検査を通過した{}ページを保存しています", validated.len()),
    );
    for (rel_path, _) in &validated {
        let src = tmp.path().join(rel_path);
        let dest = templates.join(rel_path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    }

    // 自動で下書きサイトをビルド
    log_progress(root, "下書きサイトをビルドしています");
    let _ = build(&templates, &generated, &output, true, Some(root));

    // UI Map と Manual Dependency Graph を自動構築・保存
    log_progress(root, "画面一覧と依存関係を更新しています");
    let _ = super::uimap::save_ui_map(root, &app_context.ui_map);
    let _ = super::deps::build_manual_dependency_graph(root, &templates);

    Ok(())
}

pub fn generate_task(root: &Path, task_id: &str, cli: &str, feedback: &str) -> Result<(), String> {
    let config = read_config(root);
    let templates = project_path(root, &config.docs)?;
    let generated = root.join("manual").join("ai");
    let task = find_task(&templates, task_id)?;
    let body = generate_task_body(root, &task, cli, feedback)?;
    update_task_in_docs(&templates, &task, &body, None)?;
    save_answer(&generated, &task, &body)?;
    log_progress(
        root,
        &format!("タスク {task_id} の回答を原稿へ保存しました"),
    );
    Ok(())
}

pub(crate) fn generate_task_body(
    root: &Path,
    task: &super::task::Task,
    cli: &str,
    feedback: &str,
) -> Result<String, String> {
    let task_id = &task.id;
    let config = read_config(root);
    let templates = project_path(root, &config.docs)?;
    let generated = root.join("manual").join("ai");
    if task.kind == "screenshot" {
        return Err("Screenshot tasks require a real captured image; use the manual skill in an interactive agent".to_string());
    }

    if task.status == "approved" && feedback.trim().is_empty() {
        return Err(format!(
            "Approved task is locked: {task_id}. Edit the markdown file directly or provide feedback to revise it"
        ));
    }
    if task.kind == "diagram" {
        log_progress(root, &format!("タスク {task_id} の依存図を作成しています"));
        return diagram_body(task, cli, root);
    }

    let page_hint = if templates.join(&task.page).is_file() {
        format!("{}/{}", config.docs.trim_end_matches('/'), task.page)
    } else {
        task.page.clone()
    };
    let mut prompt = format!(
        "Answer this manual task in concise, professional Japanese Markdown. \
        Read {page_hint} as the primary context. Inspect only the source files needed to verify concrete claims; avoid repository-wide exploration unless the instruction requires it. \
        Verify UI names from source. Return only the pure documentation content. Do not wrap your answer in <!-- ai:generated --> or <!-- ai:task --> tags, and do not place documentation text inside comments. Do not copy existing generated sections or other tasks' answers; return only this task's new body. \
        For concrete UI or source claims, add a compact HTML comment immediately after the claim in the form <!-- ai:fact {{\"claim\":\"...\",\"ui\":\"#actual-id\"}} --> or <!-- ai:fact {{\"claim\":\"...\",\"file\":\"relative/path\",\"contains\":\"actual source text\"}} -->. Use only evidence you verified; omit the comment when there is no evidence. \
        Do not include meta notes, disclaimers, notes about AI generation, or source attributions.\n\
        Task ID: {task_id}\nInstruction: {}",
        task.prompt
    );

    let answer_path = generated.join("answers").join(format!("{task_id}.md"));
    if answer_path.is_file() {
        if let Ok((_, prev_body, _)) = read_answer(&answer_path, &task) {
            if !prev_body.trim().is_empty() {
                prompt.push_str(&format!(
                    "\n\nPrevious draft for reference:\n```markdown\n{}\n```",
                    prev_body.trim()
                ));
            }
        }
    }

    if !feedback.trim().is_empty() {
        prompt.push_str(&format!(
            "\n\nUser revision instruction / feedback:\n{}\nPlease address this feedback directly in your response.",
            feedback.trim()
        ));
    }

    let schema = json!({
        "type": "object",
        "properties": {
            "markdown": {"type": "string"}
        },
        "required": ["markdown"],
        "additionalProperties": false
    });

    log_progress(
        root,
        &format!("タスク {task_id} の文章をAIで生成しています"),
    );
    let result = agent_json(root, &prompt, &schema, &config.agent, &config.model)?;
    log_progress(root, &format!("タスク {task_id} の回答を検証しています"));
    let body = result
        .get("markdown")
        .and_then(|m| m.as_str())
        .map(|s| s.trim())
        .ok_or_else(|| "AI agent returned an empty answer".to_string())?;

    if body.is_empty() {
        return Err("AI agent returned an empty answer".to_string());
    }

    let body = checked_generated_body(root, body)?;
    Ok(body)
}

pub fn generate_page(root: &Path, page: &str, cli: &str) -> Result<serde_json::Value, String> {
    let config = read_config(root);
    let templates = project_path(root, &config.docs)?;
    let generated = root.join("manual").join("ai");
    generate_page_at(root, page, cli, &templates, &generated, true, true, "")
}

pub(crate) fn generate_page_at(
    root: &Path,
    page: &str,
    cli: &str,
    templates: &Path,
    generated: &Path,
    capture: bool,
    include_generated: bool,
    feedback: &str,
) -> Result<Value, String> {
    let config = read_config(root);
    let page_tasks: Vec<_> = tasks_for_page(root, page)?
        .into_iter()
        .filter(|task| {
            task.status != "approved"
                && (task.kind == "text" || task.kind == "diagram" || task.kind == "screenshot")
        })
        .collect();
    let selected: Vec<_> = page_tasks
        .iter()
        .filter(|task| include_generated && (task.kind == "text" || task.kind == "diagram"))
        .cloned()
        .collect();
    let screenshot_tasks: Vec<_> = page_tasks
        .into_iter()
        .filter(|task| task.kind == "screenshot")
        .collect();
    if selected.is_empty() && screenshot_tasks.is_empty() {
        return Err(format!("No AI tasks in {page}"));
    }
    let text_tasks: Vec<_> = selected.iter().filter(|task| task.kind == "text").collect();
    let diagram_tasks: Vec<_> = selected
        .iter()
        .filter(|task| task.kind == "diagram")
        .collect();
    let mut updated = Vec::new();

    if !text_tasks.is_empty() {
        let instructions: Vec<_> = text_tasks
            .iter()
            .map(|task| json!({ "id": task.id, "instruction": task.prompt }))
            .collect();
        let mut prompt = format!(
            "Answer the following tasks for the same Markdown page in one pass, in concise professional Japanese Markdown. \
            Read {page} as the primary context. Inspect only source files needed to verify concrete claims; avoid repository-wide exploration unless a task requires it. \
            Return one answer for every ID, with no extra IDs. Do not copy existing generated sections or other tasks' answers. Verify UI names from source. \
            Do not wrap answers in <!-- ai:generated --> or <!-- ai:task --> tags, and do not place documentation text inside comments. \
            For concrete UI or source claims, add a compact HTML comment immediately after the claim in the form \
            <!-- ai:fact {{\"claim\":\"...\",\"file\":\"relative/path\",\"contains\":\"actual source text\"}} -->. \
            Use only evidence you verified. Return only documentation content in each markdown field.\nTasks: {}",
            serde_json::to_string(&instructions).map_err(|error| error.to_string())?
        );
        if !feedback.trim().is_empty() {
            prompt.push_str(&format!("\nUser revision instruction: {}", feedback.trim()));
        }
        let schema = json!({
            "type": "object",
            "properties": { "answers": { "type": "array", "items": {
                "type": "object",
                "properties": { "id": { "type": "string" }, "markdown": { "type": "string" } },
                "required": ["id", "markdown"], "additionalProperties": false
            } } },
            "required": ["answers"], "additionalProperties": false
        });
        log_progress(
            root,
            &format!(
                "{page} の文章タスク{}件を1回のAI実行で生成しています",
                text_tasks.len()
            ),
        );
        let result = agent_json(root, &prompt, &schema, &config.agent, &config.model)?;
        let answers = result
            .get("answers")
            .and_then(|value| value.as_array())
            .ok_or("AI returned no answer list")?;
        if answers.len() != text_tasks.len() {
            return Err(format!(
                "AI returned {} answers for {} tasks",
                answers.len(),
                text_tasks.len()
            ));
        }
        let mut checked = Vec::new();
        for task in &text_tasks {
            let matching: Vec<_> = answers
                .iter()
                .filter(|answer| answer.get("id").and_then(|id| id.as_str()) == Some(&task.id))
                .collect();
            if matching.len() != 1 {
                return Err(format!(
                    "AI returned an invalid answer for task {}",
                    task.id
                ));
            }
            let body = matching[0]
                .get("markdown")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim();
            if body.is_empty() {
                return Err(format!("AI returned an empty answer for task {}", task.id));
            }
            let body = checked_generated_body(root, body)?;
            checked.push((task, body));
        }
        log_progress(
            root,
            &format!(
                "{page} の回答{}件を検証しました。原稿へ保存しています",
                checked.len()
            ),
        );
        for (task, body) in checked {
            update_task_in_docs(&templates, task, &body, None)?;
            save_answer(&generated, task, &body)?;
            updated.push(task.id.clone());
        }
    }
    for task in diagram_tasks {
        log_progress(
            root,
            &format!("{page} の依存図 {} を作成しています", task.id),
        );
        record_diagram_task(&templates, &generated, &task, cli, root)?;
        updated.push(task.id.clone());
    }
    let mut captured = Vec::new();
    let mut capture_errors = Vec::new();
    if capture && !screenshot_tasks.is_empty() {
        log_progress(
            root,
            &format!(
                "{page} の撮影指示{}件を確認しています",
                screenshot_tasks.len()
            ),
        );
        let mut sources = super::capture_source::read(root)?;
        for task in &screenshot_tasks {
            if sources
                .get(&task.id)
                .is_some_and(|source| super::capture_source::targets_manual_studio(root, source))
            {
                capture_errors.push(json!({
                    "id": task.id,
                    "reason": "保存済み撮影元がManual Studio自身です。対象アプリのウィンドウを開き、撮影元を選び直してください。"
                }));
            }
        }
        let assignment_needed: Vec<_> = screenshot_tasks
            .iter()
            .filter(|task| !sources.contains_key(&task.id))
            .map(|task| task.id.clone())
            .collect();
        if !assignment_needed.is_empty() {
            log_progress(root, &format!("{page} の撮影元を確認・設定しています"));
            match super::capture_source::auto_assign_page(root, page) {
                Ok(_) => {
                    sources = super::capture_source::read(root)?;
                    for task_id in &assignment_needed {
                        let still_missing = !sources.contains_key(task_id);
                        let unusable = sources.get(task_id).is_some_and(|source| {
                            super::capture_source::targets_manual_studio(root, source)
                        });
                        if still_missing || unusable {
                            let reason = if unusable {
                                "AIが撮影元にManual Studioを選びました。対象アプリのウィンドウを開き、撮影元を選び直してください。"
                            } else {
                                "AIが撮影元を設定できませんでした。対象アプリを開き、「撮影元を選ぶ」で登録してください。"
                            };
                            capture_errors.push(json!({ "id": task_id, "reason": reason }));
                        }
                    }
                }
                Err(error) => {
                    log_progress(root, &format!("撮影元の自動設定に失敗しました: {error}"));
                    for task_id in assignment_needed {
                        capture_errors.push(json!({ "id": task_id, "reason": error.clone() }));
                    }
                }
            }
        }
        for task in screenshot_tasks {
            if capture_errors
                .iter()
                .any(|failure| failure["id"] == task.id)
            {
                continue;
            }
            log_progress(root, &format!("{} の画面を撮影しています", task.id));
            match super::capture_source::recapture_task(root, &task) {
                Ok(_) => {
                    captured.push(task.id);
                }
                Err(error) => {
                    log_progress(root, &format!("{} の撮影に失敗しました: {error}", task.id));
                    capture_errors.push(json!({ "id": task.id, "reason": error }));
                }
            }
        }
    }
    log_progress(
        root,
        &format!(
            "{page} のAI出力{}件・撮影{}件を完了しました",
            updated.len(),
            captured.len()
        ),
    );
    Ok(json!({ "updated": updated, "captured": captured, "capture_errors": capture_errors }))
}

pub fn record_screenshot(root: &Path, task_id: &str, image: &Path) -> Result<(), String> {
    let config = read_config(root);
    let templates = project_path(root, &config.docs)?;
    let task = find_task(&templates, task_id)?;
    record_screenshot_task(root, &task, image)
}

pub(crate) fn record_screenshot_task(
    root: &Path,
    task: &super::task::Task,
    image: &Path,
) -> Result<(), String> {
    let config = read_config(root);
    let templates = project_path(root, &config.docs)?;
    if task.kind != "screenshot" {
        return Err(format!("Task is not a screenshot: {}", task.id));
    }

    let abs_image = if image.is_absolute() {
        image.to_path_buf()
    } else {
        root.join(image)
    };

    let ext = abs_image
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext != "png" || !abs_image.is_file() {
        return Err("Screenshot must be a PNG file".to_string());
    }

    // Keep the MarkIts scene from the current generated image and paint it onto
    // the new capture. A plain recapture otherwise replaces the image and drops
    // every manually placed annotation.
    let previous_scene = previous_markits_scene(root, &templates, &task)?;

    let file_name = abs_image
        .file_name()
        .ok_or("Invalid image filename")?
        .to_string_lossy()
        .into_owned();

    let docs_assets = templates.join("assets");
    fs::create_dir_all(&docs_assets).map_err(|e| e.to_string())?;
    let dest_image = docs_assets.join(&file_name);
    if dest_image != abs_image {
        if let Some(mut scene) = previous_scene {
            let capture = fs::read(&abs_image).map_err(|e| e.to_string())?;
            let dimensions = image::load_from_memory(&capture)
                .map_err(|e| format!("撮影画像を読み込めません: {e}"))?
                .dimensions();
            let (width, height) = dimensions;
            scale_markits_scene(&mut scene, width, height)?;
            let scene_json = serde_json::to_string(&scene).map_err(|e| e.to_string())?;
            let mut rendered = markits::raster::render_composed_png_bytes(&scene_json, &capture)
                .map_err(|e| format!("MarkIts注釈を再適用できません: {e}"))?;
            let source_url = format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&capture)
            );
            rendered = markits::raster::embed_png_text_chunk(
                &rendered,
                "markits:annotations",
                &scene_json,
            )
            .map_err(|e| e.to_string())?;
            rendered = markits::raster::embed_png_text_chunk(
                &rendered,
                "markits:source_image",
                &source_url,
            )
            .map_err(|e| e.to_string())?;
            fs::write(&dest_image, rendered).map_err(|e| e.to_string())?;
            log_progress(
                root,
                &format!(
                    "{} の前回のMarkIts注釈を新しい撮影画像へ再適用しました",
                    task.id
                ),
            );
        } else {
            fs::copy(&abs_image, &dest_image).map_err(|e| e.to_string())?;
        }
    }

    let legacy_assets = root.join("manual").join("ai").join("assets");
    fs::create_dir_all(&legacy_assets).map_err(|e| e.to_string())?;
    let legacy_dest = legacy_assets.join(&file_name);
    if legacy_dest != abs_image {
        let _ = fs::copy(&abs_image, &legacy_dest);
    }

    let page_parts = Path::new(&task.page).components().count();
    let depth = page_parts.saturating_sub(1);
    let prefix = "../".repeat(depth);
    let asset_path = if templates.join(&task.page).is_file() {
        format!("{prefix}assets/{file_name}")
    } else {
        let output = config.output.replace('\\', "/");
        format!("{prefix}{output}/assets/{file_name}")
    };
    let alt_text = &task.id;
    let body = format!("![{alt_text}]({asset_path})");

    update_task_in_docs(&templates, &task, &body, None)?;
    save_answer(&root.join("manual").join("ai"), &task, &body)?;
    Ok(())
}

fn previous_markits_scene(
    root: &Path,
    templates: &Path,
    task: &super::task::Task,
) -> Result<Option<Value>, String> {
    let page_path = if templates.join(&task.page).is_file() {
        templates.join(&task.page)
    } else {
        templates.parent().unwrap_or(templates).join(&task.page)
    };
    let Ok(content) = fs::read_to_string(&page_path) else {
        return Ok(None);
    };
    let tags = parse_page_tags(&task.page, &content, &mut Default::default())?;
    let Some(body) = tags.into_iter().find_map(|tag| match tag {
        super::task::PageTag::Generated {
            task: generated,
            body,
            ..
        } if generated.id == task.id => Some(body),
        _ => None,
    }) else {
        return Ok(None);
    };
    let image_link = Regex::new(r"!\[[^\]]*\]\((?P<path>[^)]+)\)").map_err(|e| e.to_string())?;
    let Some(link) = image_link
        .captures(&body)
        .and_then(|capture| capture.name("path"))
    else {
        return Ok(None);
    };
    let linked = Path::new(link.as_str());
    if linked.is_absolute()
        || linked.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Ok(None);
    }
    let old_image = page_path.parent().unwrap_or(root).join(linked);
    let Ok(bytes) = fs::read(old_image) else {
        return Ok(None);
    };
    let Some(scene) = markits::raster::read_png_text_chunk(&bytes, "markits:annotations")
        .map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    let scene: Value = serde_json::from_str(&scene)
        .map_err(|e| format!("保存済みMarkIts注釈を読み込めません: {e}"))?;
    Ok(Some(scene))
}

fn scale_markits_scene(scene: &mut Value, width: u32, height: u32) -> Result<(), String> {
    let canvas = scene
        .get("canvas")
        .and_then(Value::as_object)
        .ok_or("MarkIts注釈にcanvas情報がありません")?;
    let old_width = canvas
        .get("width")
        .and_then(Value::as_f64)
        .filter(|value| *value > 0.0)
        .ok_or("MarkIts注釈のcanvas幅が不正です")?;
    let old_height = canvas
        .get("height")
        .and_then(Value::as_f64)
        .filter(|value| *value > 0.0)
        .ok_or("MarkIts注釈のcanvas高さが不正です")?;
    let sx = width as f64 / old_width;
    let sy = height as f64 / old_height;
    let root = scene.as_object_mut().ok_or("MarkIts注釈の形式が不正です")?;
    root.insert("canvas".into(), json!({"width": width, "height": height}));
    if let Some(annotations) = root.get_mut("annotations").and_then(Value::as_array_mut) {
        for annotation in annotations {
            let Some(fields) = annotation.as_object_mut() else {
                continue;
            };
            for key in ["target"] {
                if let Some(values) = fields.get_mut(key).and_then(Value::as_array_mut) {
                    if values.len() == 4 {
                        for (index, factor) in [sx, sy, sx, sy].into_iter().enumerate() {
                            if let Some(value) = values[index].as_f64() {
                                values[index] = json!(value * factor);
                            }
                        }
                    }
                }
            }
            for key in ["start", "control", "end"] {
                if let Some(values) = fields.get_mut(key).and_then(Value::as_array_mut) {
                    if values.len() == 2 {
                        for (index, factor) in [sx, sy].into_iter().enumerate() {
                            if let Some(value) = values[index].as_f64() {
                                values[index] = json!(value * factor);
                            }
                        }
                    }
                }
            }
            for (key, factor) in [
                ("stroke_width", sx.min(sy)),
                ("rx", sx),
                ("ry", sy),
                ("max_width", sx),
            ] {
                if let Some(value) = fields.get(key).and_then(Value::as_f64) {
                    fields.insert(key.into(), json!(value * factor));
                }
            }
        }
    }
    Ok(())
}

pub fn record_diagram(
    templates: &Path,
    generated: &Path,
    task_id: &str,
    cli: &str,
    project: &Path,
) -> Result<(), String> {
    let task = find_task(templates, task_id)?;
    record_diagram_task(templates, generated, &task, cli, project)
}

pub(crate) fn record_diagram_task(
    templates: &Path,
    generated: &Path,
    task: &super::task::Task,
    cli: &str,
    project: &Path,
) -> Result<(), String> {
    let body = diagram_body(task, cli, project)?;
    update_task_in_docs(templates, task, &body, None)?;
    save_answer(generated, task, &body)?;
    Ok(())
}

fn diagram_body(task: &super::task::Task, cli: &str, project: &Path) -> Result<String, String> {
    if task.kind != "diagram" {
        return Err(format!("Task is not a diagram: {}", task.id));
    }
    if !project.is_dir() {
        return Err(format!("Diagram project is missing: {}", project.display()));
    }

    let tmp = tempdir().map_err(|e| e.to_string())?;
    let output_dir = tmp.path().join("moduleloom");

    if cli.is_empty() {
        let result = crate::analyze_directory(project)?;
        crate::mkdocs::generate_with_lang(&result, &output_dir, "ja")?;
    } else {
        let status = Command::new(cli)
            .args([
                "--mkdocs",
                &output_dir.to_string_lossy(),
                "--lang",
                "ja",
                &project
                    .canonicalize()
                    .unwrap_or_else(|_| project.to_path_buf())
                    .to_string_lossy(),
            ])
            .output()
            .map_err(|e| format!("ModuleLoom CLI failed to execute: {e}"))?;

        if !status.status.success() {
            let err = String::from_utf8_lossy(&status.stderr);
            return Err(format!("ModuleLoom CLI failed: {}", err.trim()));
        }
    }

    let page = fs::read_to_string(output_dir.join("docs").join("index.md"))
        .map_err(|e| format!("ModuleLoom CLI docs/index.md not found: {e}"))?;

    let re = Regex::new(r"(?s)```mermaid\n(?P<diagram>.*?)\n```").unwrap();
    let cap = re
        .captures(&page)
        .ok_or_else(|| "ModuleLoom CLI did not produce a Mermaid diagram".to_string())?;

    let diagram_raw = cap.name("diagram").unwrap().as_str();
    let lines: Vec<&str> = diagram_raw
        .lines()
        .filter(|line| !line.trim_start().starts_with("click "))
        .collect();
    let diagram = lines.join("\n");
    let body = format!("```mermaid\n{diagram}\n```");

    Ok(body)
}

fn checked_generated_body(root: &Path, body: &str) -> Result<String, String> {
    let normalized = super::fact::normalize_generated_facts(body)?;
    let cleaned = super::task::clean_generated_body(&normalized);
    if cleaned.is_empty() {
        return Err("AI agent returned an empty answer".into());
    }
    let fences = super::task::get_code_block_ranges(&cleaned);
    let marker = regex::Regex::new(r"<!--\s*/?ai:(?:task|generated)\b").unwrap();
    if marker
        .find_iter(&cleaned)
        .any(|found| !super::task::is_inside_ranges(&(found.start()..found.end()), &fences))
    {
        return Err("AI returned multiple task/generated sections. Return only the requested task's Markdown body; existing document content was preserved.".into());
    }
    super::fact::verify_generated_body(root, &cleaned)?;
    Ok(cleaned)
}

#[cfg(test)]
mod answer_regressions {
    use super::*;
    #[test]
    fn a_single_wrapper_is_unwrapped_but_multiple_results_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let single = "<!-- ai:generated id=guide kind=text -->\nNew guide\n<!-- /ai:generated -->";
        assert_eq!(
            checked_generated_body(root.path(), single).unwrap(),
            "New guide"
        );
        let multiple = format!("{single}\n\n{single}");
        assert!(checked_generated_body(root.path(), &multiple)
            .unwrap_err()
            .contains("multiple task/generated"));
        let example = "Example:\n```html\n<!-- ai:generated id=sample -->\nExample content\n<!-- /ai:generated -->\n```";
        assert_eq!(
            checked_generated_body(root.path(), example).unwrap(),
            example
        );
    }
}
