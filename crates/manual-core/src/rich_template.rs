//! Screenshot-backed template candidates. The host owns all input and file writes.
use crate::{
    agent,
    config::{asset_destination, project_path, read_config},
};
use serde_json::{json, Value};
use std::{collections::HashSet, fs, path::Path};

pub(crate) struct Candidate {
    pub pages: Vec<(String, String)>,
    pub screenshots: Vec<Value>,
}

pub(crate) fn guide() -> &'static str {
    include_str!("template_ai_guide.md")
}

fn exchange(
    root: &Path,
    prompt: &str,
    schema: &Value,
    ai: &mut impl FnMut(&str, &Value) -> Result<Value, String>,
) -> Result<Value, String> {
    let prompt = format!("{}\n\n## 今回の依頼と入力\n{prompt}", guide());
    agent::log_exchange(
        root,
        "request",
        "AIへ送信：手順書・雛形・撮影計画の指示",
        &json!({"instruction":prompt,"response_schema":schema}),
    );
    let result = ai(&prompt, schema);
    match &result {
        Ok(value) => agent::log_exchange(root, "response", "AIからの応答：雛形・撮影計画", value),
        Err(error) => agent::log_exchange(
            root,
            "error",
            "AIの応答を取得できませんでした",
            &json!({"error":error}),
        ),
    }
    result
}

fn call_tool(
    root: &Path,
    request: Value,
    tool: &mut impl FnMut(&Value) -> Result<Value, String>,
) -> Result<Value, String> {
    agent::log_exchange(root, "tool_request", "撮影ツールへ送信", &request);
    let result = tool(&request);
    match &result {
        Ok(value) => agent::log_exchange(root, "tool_result", "撮影ツールの実行結果", value),
        Err(error) => agent::log_exchange(
            root,
            "error",
            "撮影ツールが失敗しました",
            &json!({"error":error}),
        ),
    }
    result
}

pub(crate) fn generate(
    root: &Path,
    options: &Value,
    docs: &str,
    filename: Option<&str>,
    instruction: &str,
) -> Result<Candidate, String> {
    let config = read_config(root);
    generate_with(
        root,
        options,
        docs,
        filename,
        instruction,
        |request| crate::terminal_tools::invoke_isolated(root, request),
        |prompt, schema| {
            agent::agent_json_candidate(root, prompt, schema, &config.agent, &config.model)
        },
    )
}

fn generate_with(
    root: &Path,
    options: &Value,
    docs: &str,
    filename: Option<&str>,
    instruction: &str,
    mut tool: impl FnMut(&Value) -> Result<Value, String>,
    mut ai: impl FnMut(&str, &Value) -> Result<Value, String>,
) -> Result<Candidate, String> {
    let checkpoint = agent::cancellation_checkpoint(root);
    let check = || agent::check_cancelled(root, &checkpoint);
    let id = options["window"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("撮影対象のウィンドウを選択してください。")?;
    check()?;
    let windows = call_tool(root, json!({"root":root,"action":"windows"}), &mut tool)?;
    check()?;
    let window = windows
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|window| window["id"].as_str() == Some(id))
        })
        .ok_or("撮影対象が見つかりません。対象画面を開いて選び直してください。")?;
    let private = project_path(root, ".munin")?;
    fs::create_dir_all(&private).map_err(|e| e.to_string())?;
    let temporary = tempfile::Builder::new()
        .prefix("template-capture-")
        .tempdir_in(&private)
        .map_err(|e| e.to_string())?;
    let canonical = root.canonicalize().map_err(|e| e.to_string())?;
    let relative = |path: &Path| {
        path.strip_prefix(&canonical)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .map_err(|e| e.to_string())
    };
    let initial = temporary.path().join("initial.png");
    agent::log_progress(root, "対象アプリの実画面を撮影しています。");
    call_tool(
        root,
        json!({"root":root,"action":"capture","window":id,"output":relative(&initial)?}),
        &mut tool,
    )?;
    check()?;
    let context = crate::context::build_application_context(root);
    let brief = fs::read_to_string(root.join("manual/brief.md"))
        .unwrap_or_else(|_| crate::config::DEFAULT_BRIEF.to_string());
    let mut captures = vec![(
        initial,
        window["title"].as_str().unwrap_or("対象画面").to_string(),
    )];
    if options["automate_steps"] == true {
        let (_, initial_info) =
            markits::raster::read_image(&captures[0].0).map_err(|e| e.to_string())?;
        let observed = json!({"title":window["title"],"bounds":[window["x"],window["y"],window["width"],window["height"]]});
        let schema = crate::operation_script::schema();
        let prompt = format!("Create a MarkIts operation script for the requested manual. Do not execute anything yourself. Use ONLY observed UIMap names and verified application context; never guess coordinates or controls. Stay inside the selected application and requested workflow. Include 1 to 8 screenshots. Copy the observed window title and bounds exactly. Use include_cursor:false. If there is not enough evidence for further input, return a screenshot-only script.\nInput: {}",json!({"instruction":instruction,"brief":brief,"context":context.prompt_summary,"window":observed,"uimap":initial_info.uimap}));
        agent::log_progress(root, "AIが撮影する手順を記述しています。");
        let script = exchange(root, &prompt, &schema, &mut ai)?;
        if script["window"] != observed {
            return Err("AIが撮影対象を変更しました。操作は実行していません。".into());
        }
        let screenshots = script["steps"]
            .as_array()
            .ok_or("操作手順が不正です。")?
            .iter()
            .filter(|step| step["kind"] == "screenshot")
            .count();
        if !(1..=8).contains(&screenshots) {
            return Err("自動操作の撮影枚数は1〜8枚にしてください。".into());
        }
        crate::operation_script::execute(root, "operations-validate", &json!({"script":script}))?;
        check()?;
        agent::log_progress(root, "対象アプリを操作し、手順ごとの画面を撮影しています。");
        let result = call_tool(
            root,
            json!({"root":root,"action":"operations-run","window":id,"output":relative(&temporary.path().join("run"))?,"script":script}),
            &mut tool,
        )?;
        if result["ok"] != true {
            return Err("自動操作の撮影を完了できませんでした。".into());
        }
        captures.clear();
        for item in result["captures"]
            .as_array()
            .filter(|items| !items.is_empty() && items.len() <= 8)
            .ok_or("操作後の撮影画像がありません。")?
        {
            captures.push((
                project_path(root, item["image"].as_str().ok_or("画像パスが不正です。")?)?,
                item["name"].as_str().unwrap_or("撮影画像").to_string(),
            ));
        }
    }
    check()?;
    let mut sources = Vec::new();
    let mut metadata = Vec::new();
    let mut destinations = Vec::new();
    for (index, (path, caption)) in captures.iter().enumerate() {
        let (bytes, info) = markits::raster::read_image(path).map_err(|e| e.to_string())?;
        let name = format!("{}.png", crate::screenshots::new_id("template"));
        let page = project_path(root, &format!("{docs}/{}", filename.unwrap_or("index.md")))?;
        let (destination, _) = asset_destination(root, &page, &name)?;
        metadata.push(json!({"index":index+1,"caption":caption,"reference":format!("{{{{screenshot:{}}}}}",index+1),"width":info.width,"height":info.height,"uimap":info.uimap}));
        destinations.push((destination, name));
        sources.push(bytes);
    }
    let annotation = json!({"type":"object","properties":{"type":{"type":"string","enum":["rect","badge","callout","arrow"]},"target":{"type":"string"},"step":{"type":"integer"},"text":{"type":"string"},"style":{"type":"string"}},"required":["type","target"],"additionalProperties":false});
    let schema = json!({"type":"object","properties":{
        "pages":{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"],"additionalProperties":false}},
        "images":{"type":"array","items":{"type":"object","properties":{"index":{"type":"integer"},"annotations":{"type":"array","items":annotation}},"required":["index","annotations"],"additionalProperties":false}}
    },"required":["pages","images"],"additionalProperties":false});
    let prompt = format!("{instruction}\nCreate a visually rich, factual Japanese template with clear headings, numbered procedures, prerequisites, tables, checklists, troubleshooting and Mermaid diagrams when useful. Return index.md and at most eight pages. Use ordinary Markdown, never AI tags or screenshot tasks. The host has already captured REAL screenshots; do not execute commands or capture anything yourself. Embed each supplied screenshot using its exact reference token, e.g. ![caption]({{{{screenshot:1}}}}). Do not invent image links or UI labels. Return one images entry per screenshot, with rect/badge/arrow/callout annotations targeting only actual UIMap names. Use empty annotations if none are suitable. Do not claim that unexecuted operations were verified.\nInput: {}",json!({"context":context.prompt_summary,"brief":brief,"screenshots":metadata}));
    agent::log_progress(
        root,
        "実画面に合わせた章立て・本文・表・図・注釈を生成しています。",
    );
    let generated = exchange(root, &prompt, &schema, &mut ai)?;
    check()?;
    let mut pages = crate::author::validate_draft_pages(&generated, "AI")?;
    let mut seen = HashSet::new();
    for (path, _) in &pages {
        if !seen.insert(path) {
            return Err("AIの候補ページが重複しています。".into());
        }
        project_path(root, &format!("{docs}/{path}"))?;
    }
    if filename.is_some() && (pages.len() != 1 || pages[0].0 != "index.md") {
        return Err("READMEはindex.md一ページの候補にしてください。".into());
    }
    let marks = generated["images"]
        .as_array()
        .filter(|items| items.len() == sources.len())
        .ok_or("画像ごとの注釈情報が不正です。")?;
    let mut rendered = Vec::new();
    let mut screenshots = Vec::new();
    for (index, bytes) in sources.iter().enumerate() {
        let entries: Vec<_> = marks
            .iter()
            .filter(|item| item["index"].as_u64() == Some((index + 1) as u64))
            .collect();
        if entries.len() != 1 {
            return Err("画像の番号が不正です。".into());
        }
        let annotations = entries[0]["annotations"]
            .as_array()
            .filter(|items| items.len() <= 30)
            .ok_or("画像の注釈が不正です。")?;
        let scene =
            json!({"annotations":crate::selection_capture::normalize_annotations(annotations)});
        let mut image = markits::raster::render_composed_png_bytes(&scene.to_string(), bytes)
            .map_err(|e| format!("注釈を描画できません: {e}"))?;
        for key in ["markits:operations", "markits:operation_group"] {
            if let Some(value) =
                markits::raster::read_png_text_chunk(bytes, key).map_err(|e| e.to_string())?
            {
                image = markits::raster::embed_png_text_chunk(&image, key, &value)
                    .map_err(|e| e.to_string())?;
            }
        }
        rendered.push(image);
        let token = metadata[index]["reference"].as_str().unwrap();
        if !pages.iter().any(|(_, content)| content.contains(token)) {
            pages
                .iter_mut()
                .find(|(path, _)| path == "index.md")
                .unwrap()
                .1
                .push_str(&format!("\n\n![撮影画像{}]({token})\n", index + 1));
        }
        for (path, content) in &mut pages {
            let page = project_path(root, &format!("{docs}/{}", filename.unwrap_or(path)))?;
            let (_, link) = asset_destination(root, &page, &destinations[index].1)?;
            *content = content.replace(token, &link);
        }
        screenshots
            .push(json!({"path":relative(&destinations[index].0)?,"caption":captures[index].1}));
    }
    if pages
        .iter()
        .any(|(_, content)| content.contains("{{screenshot:"))
    {
        return Err("AIが未撮影の画像を指定しました。".into());
    }
    // Check actual image destinations before publishing any assets. This also
    // catches invented screenshot filenames rather than showing broken images.
    for (path, content) in &pages {
        let page = project_path(root, &format!("{docs}/{}", filename.unwrap_or(path)))?;
        for event in pulldown_cmark::Parser::new_ext(content, crate::gfm::options()) {
            if let pulldown_cmark::Event::Start(pulldown_cmark::Tag::Image { dest_url, .. }) = event
            {
                let image = crate::quality::local_path(root, &page, &dest_url)?;
                if !destinations.iter().any(|(planned, _)| *planned == image) && !image.is_file() {
                    return Err(format!("未撮影の画像が参照されています: {dest_url}"));
                }
            }
        }
    }
    check()?;
    let mut written = Vec::new();
    let result: Result<(), String> = (|| {
        for ((destination, _), bytes) in destinations.iter().zip(rendered) {
            check()?;
            fs::create_dir_all(destination.parent().ok_or("画像の保存先が不正です。")?)
                .map_err(|e| e.to_string())?;
            let mut temporary = tempfile::NamedTempFile::new_in(destination.parent().unwrap())
                .map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut temporary, &bytes).map_err(|e| e.to_string())?;
            temporary
                .persist_noclobber(destination)
                .map_err(|e| e.to_string())?;
            written.push(destination);
        }
        Ok(())
    })();
    if let Err(error) = result {
        for path in written {
            let _ = fs::remove_file(path);
        }
        return Err(error);
    }
    agent::log_progress(
        root,
        &format!(
            "{}枚の実画面を含む雛形候補を作成しました。原稿は採用するまで変更しません。",
            screenshots.len()
        ),
    );
    Ok(Candidate { pages, screenshots })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("docs")).unwrap();
        fs::write(root.path().join("docs/index.md"), "Original manuscript").unwrap();
        fs::write(
            root.path().join("manual_setting.json"),
            json!({"docs":"docs","assets":"docs/assets"}).to_string(),
        )
        .unwrap();
        root
    }
    fn windows() -> Value {
        json!([{"id":"fixture","title":"Fixture app","x":100,"y":100,"width":200,"height":120}])
    }
    fn write_capture(path: &Path, operations: bool) {
        let mut buffer = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(200, 120)
            .write_to(&mut buffer, image::ImageFormat::Png)
            .unwrap();
        let mut bytes = markits::raster::embed_png_uimap(
            buffer.get_ref(),
            &[markits::UiElement::new(
                "button", "Save", 30.0, 30.0, 80.0, 30.0,
            )],
        )
        .unwrap();
        if operations {
            bytes = markits::raster::embed_png_text_chunk(
                &bytes,
                "markits:operations",
                "{\"recording\":\"fixture\"}",
            )
            .unwrap();
        }
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    fn tools(root: &Path, request: &Value) -> Result<Value, String> {
        match request["action"].as_str().unwrap() {
            "windows" => Ok(windows()),
            "capture" => {
                assert_eq!(request["window"], "fixture");
                write_capture(
                    &project_path(root, request["output"].as_str().unwrap())?,
                    false,
                );
                Ok(json!({"captured":true}))
            }
            "operations-run" => {
                let image = format!("{}/step-one.png", request["output"].as_str().unwrap());
                write_capture(&project_path(root, &image)?, true);
                Ok(json!({"ok":true,"captures":[{"name":"step-one","image":image}]}))
            }
            _ => panic!("unexpected tool"),
        }
    }
    fn answer() -> Value {
        json!({"pages":[
            {"path":"index.md","content":"# Guide\n\n| Step | Result |\n| --- | --- |\n| Save | Saved |\n\n![Save]({{screenshot:1}})"},
            {"path":"chapter/guide.md","content":"# Save\n\n![Save]({{screenshot:1}})\n\n```mermaid\nflowchart LR\n  A --> B\n```"}
        ],"images":[{"index":1,"annotations":[{"type":"rect","target":"Save","step":1}]}]})
    }

    #[test]
    fn rich_pages_have_real_marked_images_and_correct_nested_links_without_adopting() {
        let root = fixture();
        let result = generate_with(
            root.path(),
            &json!({"window":"fixture"}),
            "docs",
            None,
            "Make a manual",
            |request| tools(root.path(), request),
            |prompt, _| {
                assert!(prompt.contains("REAL screenshots"));
                assert!(prompt.contains("Save"));
                assert!(prompt.contains("AI向け：Manual Studio・MarkIts"));
                Ok(answer())
            },
        )
        .unwrap();
        assert_eq!(result.pages.len(), 2);
        assert_eq!(result.screenshots.len(), 1);
        assert!(result.pages[0].1.contains("assets/template-"));
        assert!(result.pages[1].1.contains("../assets/template-"));
        let path =
            project_path(root.path(), result.screenshots[0]["path"].as_str().unwrap()).unwrap();
        assert!(image::open(path)
            .unwrap()
            .to_rgb8()
            .pixels()
            .any(|pixel| pixel.0 != [0, 0, 0]));
        assert_eq!(
            fs::read_to_string(root.path().join("docs/index.md")).unwrap(),
            "Original manuscript"
        );
        assert!(!root.path().join("docs/chapter/guide.md").exists());
        let logs: Value = serde_json::from_str(&agent::progress(root.path())).unwrap();
        for kind in ["request", "response", "tool_request", "tool_result"] {
            assert!(logs["logs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|event| event["kind"] == kind));
        }
    }

    #[test]
    fn automatic_capture_is_validated_and_preserves_markits_replay_metadata() {
        let root = fixture();
        let mut calls = 0;
        let result = generate_with(root.path(),&json!({"window":"fixture","automate_steps":true}),".",Some("Readme.md"),"Create only index.md",
            |request|tools(root.path(),request),|_,_| {
                calls+=1;
                if calls==1 {Ok(json!({"version":1,"window":{"title":"Fixture app","bounds":[100,100,200,120]},"steps":[{"kind":"screenshot","name":"step-one"}]}))}
                else {let mut result=answer();result["pages"].as_array_mut().unwrap().truncate(1);Ok(result)}
            }).unwrap();
        assert_eq!(calls, 2);
        assert!(result.pages[0].1.contains("docs/assets/template-"));
        let bytes = fs::read(
            project_path(root.path(), result.screenshots[0]["path"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        assert!(
            markits::raster::read_png_text_chunk(&bytes, "markits:operations")
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn invalid_targets_plans_or_image_links_do_not_publish_assets() {
        let root = fixture();
        assert!(generate_with(
            root.path(),
            &json!({"window":"unknown"}),
            "docs",
            None,
            "manual",
            |request| {
                assert_eq!(request["action"], "windows");
                Ok(windows())
            },
            |_, _| panic!("must not ask AI")
        )
        .is_err());
        assert!(generate_with(
            root.path(),
            &json!({"window":"fixture","automate_steps":true}),
            "docs",
            None,
            "manual",
            |request| {
                assert_ne!(request["action"], "operations-run");
                tools(root.path(), request)
            },
            |_, _| Ok(
                json!({"version":1,"window":{"title":"Other app","bounds":[0,0,1,1]},"steps":[]})
            )
        )
        .is_err());
        let error = generate_with(
            root.path(),
            &json!({"window":"fixture"}),
            "docs",
            None,
            "manual",
            |request| tools(root.path(), request),
            |_, _| {
                let mut result = answer();
                result["pages"][0]["content"] = json!("![invented](missing-screen.png)");
                Ok(result)
            },
        )
        .err()
        .unwrap();
        assert!(error.contains("未撮影"));
        assert!(!root.path().join("docs/assets").exists());
        assert_eq!(
            fs::read_to_string(root.path().join("docs/index.md")).unwrap(),
            "Original manuscript"
        );
    }

    #[test]
    fn cancellation_after_window_enumeration_prevents_capture() {
        let root = fixture();
        let result = generate_with(
            root.path(),
            &json!({"window":"fixture"}),
            "docs",
            None,
            "manual",
            |request| {
                assert_eq!(request["action"], "windows");
                agent::cancel(root.path()).unwrap();
                Ok(windows())
            },
            |_, _| panic!("must not ask AI after cancellation"),
        );
        assert!(result.err().unwrap().contains("中断"));
        assert!(!root.path().join("docs/assets").exists());
    }
}
