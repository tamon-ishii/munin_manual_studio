//! Derivative document generation (FAQ, release notes, quickstart) and differential translation sync.
use crate::{
    config::{project_path, read_config},
    glossary,
};
use regex::Regex;
use serde_json::{json, Value};
use std::{fs, path::Path, process::Command};

fn resolve_page_rel(root: &Path, page: &str) -> String {
    let config = read_config(root);
    let clean = page.trim().replace('\\', "/");
    if project_path(root, &clean).is_ok_and(|p| p.is_file()) || config.docs == "." {
        clean
    } else {
        format!("{}/{}", config.docs.trim_end_matches('/'), clean)
    }
}

fn extract_alerts(content: &str) -> Vec<(String, String)> {
    let re = Regex::new(r"(?m)^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n((?:>.*\n?)+)").unwrap();
    let mut items = Vec::new();
    for cap in re.captures_iter(content) {
        let kind = cap[1].to_string();
        let body: String = cap[2]
            .lines()
            .map(|l| l.trim_start_matches('>').trim())
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if !body.is_empty() {
            items.push((kind, body));
        }
    }
    items
}

fn extract_headings_and_steps(content: &str) -> (String, Vec<String>, Vec<String>) {
    let mut title = String::new();
    let mut headings = Vec::new();
    let mut steps = Vec::new();
    let step_re = Regex::new(r"^\s*\d+\.\s+(.+)$").unwrap();
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(h1) = trimmed.strip_prefix("# ") {
            if title.is_empty() {
                title = h1.trim().to_string();
            }
        } else if let Some(h2) = trimmed.strip_prefix("## ") {
            headings.push(h2.trim().to_string());
        } else if let Some(cap) = step_re.captures(trimmed) {
            steps.push(cap[1].trim().to_string());
        }
    }
    (title, headings, steps)
}

/// Generate a deterministic or AI-refined derivative manual draft from selected pages.
pub fn generate_derivative(
    root: &Path,
    kind: &str,
    pages: &[String],
    use_ai: bool,
) -> Result<Value, String> {
    if pages.is_empty() {
        return Err("対象となる原稿を1件以上選んでください。".into());
    }
    if !matches!(kind, "faq" | "release-notes" | "quickstart") {
        return Err(format!("未対応の派生種別です: {kind}（faq / release-notes / quickstart）"));
    }

    let mut source_blocks = Vec::new();
    let mut markdown = String::new();

    match kind {
        "faq" => markdown.push_str("# FAQ・よくある質問とトラブルシューティング\n\n"),
        "release-notes" => markdown.push_str("# リリースノート要点\n\n"),
        "quickstart" => markdown.push_str("# クイックスタートガイド\n\n"),
        _ => unreachable!(),
    }

    for raw_page in pages {
        let rel = resolve_page_rel(root, raw_page);
        let path = project_path(root, &rel)?;
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("原稿を読み込めません ({rel}): {e}"))?;
        let (title, headings, steps) = extract_headings_and_steps(&content);
        let alerts = extract_alerts(&content);
        let label = if title.is_empty() { rel.clone() } else { title };
        source_blocks.push(json!({
            "page": rel,
            "title": label,
            "headings": headings,
            "alerts": alerts,
            "excerpt": content.chars().take(2500).collect::<String>()
        }));

        match kind {
            "faq" => {
                markdown.push_str(&format!("## {label} に関する質問\n\n"));
                if !alerts.is_empty() {
                    for (alert_kind, body) in &alerts {
                        markdown.push_str(&format!(
                            "### Q. [{alert_kind}] {label} で注意すべき点はありますか？\n\n{body}\n\n"
                        ));
                    }
                } else if !headings.is_empty() {
                    for h in headings.iter().take(4) {
                        markdown.push_str(&format!(
                            "### Q. {h} はどのように行いますか？\n\n詳細は [{label}]({rel}) を参照してください。\n\n"
                        ));
                    }
                } else {
                    markdown.push_str(&format!(
                        "### Q. {label} の使い方は？\n\n[{label}]({rel}) の手順を参照してください。\n\n"
                    ));
                }
            }
            "release-notes" => {
                markdown.push_str(&format!("## {label}\n\n"));
                if headings.is_empty() {
                    markdown.push_str(&format!("- `{rel}` のドキュメントを更新しました。\n\n"));
                } else {
                    for h in headings.iter().take(6) {
                        markdown.push_str(&format!("- **{h}**（参照: `{rel}`）\n"));
                    }
                    markdown.push('\n');
                }
            }
            "quickstart" => {
                markdown.push_str(&format!("## {label}\n\n"));
                if steps.is_empty() {
                    for (i, h) in headings.iter().take(5).enumerate() {
                        markdown.push_str(&format!("{}. **{h}** を確認します。\n", i + 1));
                    }
                    if headings.is_empty() {
                        markdown.push_str(&format!("1. [{label}]({rel}) の内容を確認します。\n"));
                    }
                } else {
                    for (i, s) in steps.iter().take(6).enumerate() {
                        markdown.push_str(&format!("{}. {s}\n", i + 1));
                    }
                }
                markdown.push('\n');
            }
            _ => unreachable!(),
        }
    }

    let mut ai_refined = false;
    if use_ai {
        let config = read_config(root);
        if config.connection_type != "none" {
            let glossary_hint = glossary::prompt_section(root, &markdown);
            let prompt = format!(
                "Generate a concise, accurate Japanese {kind} Markdown document based ONLY on the supplied source pages. Do not invent product features. Return only the Markdown in the content field.\n{glossary_hint}\nInput JSON: {}",
                json!({ "kind": kind, "baseline": markdown, "sources": source_blocks })
            );
            let schema = json!({
                "type": "object",
                "properties": { "content": { "type": "string" } },
                "required": ["content"],
                "additionalProperties": false
            });
            if let Ok(answer) =
                crate::agent::agent_json(root, &prompt, &schema, &config.agent, &config.model)
            {
                if let Some(polished) = answer["content"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && s.len() <= 200_000)
                {
                    markdown = format!("{polished}\n");
                    ai_refined = true;
                }
            }
        }
    }

    let suggested_filename = match kind {
        "faq" => "faq.md",
        "release-notes" => "release-notes.md",
        "quickstart" => "quickstart.md",
        _ => "derived.md",
    };

    Ok(json!({
        "kind": kind,
        "suggested_page": suggested_filename,
        "source_pages": pages,
        "markdown": markdown,
        "ai_refined": ai_refined
    }))
}

fn split_sections(content: &str) -> Vec<(String, String)> {
    let mut sections = Vec::new();
    let mut current_heading = "(冒頭)".to_string();
    let mut current_body = String::new();
    for line in content.lines() {
        if line.starts_with("## ") || line.starts_with("# ") {
            if !current_body.trim().is_empty() || current_heading != "(冒頭)" {
                sections.push((current_heading, current_body.trim().to_string()));
            }
            current_heading = line.trim().to_string();
            current_body = String::new();
        } else {
            current_body.push_str(line);
            current_body.push('\n');
        }
    }
    if !current_body.trim().is_empty() || !sections.is_empty() {
        sections.push((current_heading, current_body.trim().to_string()));
    }
    sections
}

/// Extract differential changes from a source-language page to synchronize a target translation page.
pub fn translation_diff_plan(
    root: &Path,
    source_page: &str,
    target_page: &str,
    base_ref: Option<&str>,
    target_language: Option<&str>,
    use_ai: bool,
) -> Result<Value, String> {
    let src_rel = resolve_page_rel(root, source_page);
    let dst_rel = resolve_page_rel(root, target_page);
    let src_path = project_path(root, &src_rel)?;
    let dst_path = project_path(root, &dst_rel)?;

    let src_content = fs::read_to_string(&src_path)
        .map_err(|e| format!("基準言語の原稿を読み込めません ({src_rel}): {e}"))?;
    let dst_content = fs::read_to_string(&dst_path).unwrap_or_default();
    let base = base_ref.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("HEAD~1");
    let lang = target_language
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("English");

    let git_diff = Command::new("git")
        .args(["diff", "-U2", base, "--", &src_rel])
        .current_dir(root)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();

    let src_sections = split_sections(&src_content);
    let dst_sections = split_sections(&dst_content);

    let mut changed_headings = Vec::new();
    if !git_diff.is_empty() {
        for (heading, body) in &src_sections {
            let key = heading.trim_start_matches('#').trim();
            if (!key.is_empty() && git_diff.contains(key))
                || body
                    .lines()
                    .any(|l| !l.trim().is_empty() && git_diff.contains(&format!("+{}", l)))
            {
                changed_headings.push(heading.clone());
            }
        }
    }

    let prompt = format!(
        "基準言語原稿 `{src_rel}` の変更差分だけを翻訳先 `{dst_rel}`（言語: {lang}）へ反映してください。\n\
         全文を再翻訳せず、変更された箇所だけを対応付けて既存の翻訳表現・リンク・画像パスを維持してください。\n\
         反映時は直接上書きせず MCP の `preview-edit` を使用してください。\n\n\
         基準差分 (`git diff {base} -- {src_rel}`):\n```diff\n{}\n```",
        if git_diff.trim().is_empty() {
            "(Git差分なし：セクション構成を比較して不足箇所を同期してください)".to_string()
        } else {
            git_diff.chars().take(6000).collect::<String>()
        }
    );

    let mut proposed_after: Option<String> = None;
    if use_ai {
        let config = read_config(root);
        if config.connection_type != "none" && !dst_content.trim().is_empty() {
            let ai_prompt = format!(
                "Update ONLY the sections of target_content corresponding to the diff in source_diff, translating into {lang}. Keep untouched sections verbatim. Preserve Markdown links, images, and code blocks. Return the complete updated target Markdown in the content field.\nInput JSON: {}",
                json!({
                    "source_page": src_rel,
                    "target_page": dst_rel,
                    "target_language": lang,
                    "source_diff": git_diff,
                    "source_content": src_content,
                    "target_content": dst_content
                })
            );
            let schema = json!({
                "type": "object",
                "properties": { "content": { "type": "string" } },
                "required": ["content"],
                "additionalProperties": false
            });
            if let Ok(answer) =
                crate::agent::agent_json(root, &ai_prompt, &schema, &config.agent, &config.model)
            {
                if let Some(updated) = answer["content"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty() && s.len() <= 250_000)
                {
                    proposed_after = Some(updated.to_string());
                }
            }
        }
    }

    Ok(json!({
        "source_page": src_rel,
        "target_page": dst_rel,
        "target_language": lang,
        "base_ref": base,
        "has_git_diff": !git_diff.trim().is_empty(),
        "git_diff": git_diff,
        "changed_headings": changed_headings,
        "source_section_count": src_sections.len(),
        "target_section_count": dst_sections.len(),
        "target_before": dst_content,
        "proposed_after": proposed_after,
        "handoff_prompt": prompt
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_faq_and_quickstart_derivatives() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs")).unwrap();
        fs::write(
            root.path().join("docs/setup.md"),
            "# 初期設定\n\n## インストール\n1. アプリを起動します。\n2. フォルダーを開きます。\n\n> [!WARNING]\n> APIキーは外部へ共有しないでください。\n",
        )
        .unwrap();

        let faq = generate_derivative(root.path(), "faq", &["docs/setup.md".into()], false).unwrap();
        assert_eq!(faq["suggested_page"], "faq.md");
        assert!(faq["markdown"].as_str().unwrap().contains("APIキーは外部へ共有しないでください"));

        let quick = generate_derivative(root.path(), "quickstart", &["docs/setup.md".into()], false).unwrap();
        assert_eq!(quick["suggested_page"], "quickstart.md");
        assert!(quick["markdown"].as_str().unwrap().contains("1. アプリを起動します。"));
    }

    #[test]
    fn extracts_git_diff_for_differential_translation_sync() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs/ja")).unwrap();
        fs::create_dir_all(root.path().join("docs/en")).unwrap();

        let git = |args: &[&str]| {
            assert!(Command::new("git")
                .args(args)
                .current_dir(root.path())
                .status()
                .unwrap()
                .success());
        };
        git(&["init"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Tester"]);
        fs::write(root.path().join("docs/ja/guide.md"), "# ガイド\n\n## 保存\nCtrl+Sで保存します。\n").unwrap();
        fs::write(root.path().join("docs/en/guide.md"), "# Guide\n\n## Save\nPress Ctrl+S to save.\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "initial"]);

        fs::write(
            root.path().join("docs/ja/guide.md"),
            "# ガイド\n\n## 保存\nCtrl+Sまたは自動保存で保存します。\n",
        )
        .unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "mention autosave"]);

        let plan = translation_diff_plan(
            root.path(),
            "docs/ja/guide.md",
            "docs/en/guide.md",
            Some("HEAD~1"),
            Some("English"),
            false,
        )
        .unwrap();
        assert_eq!(plan["has_git_diff"], true);
        assert!(plan["git_diff"].as_str().unwrap().contains("自動保存"));
        assert!(plan["changed_headings"]
            .as_array()
            .unwrap()
            .contains(&json!("## 保存")));
    }
}
