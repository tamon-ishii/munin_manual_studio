use pulldown_cmark::{Event, Options, Parser, Tag};
use serde_json::{json, Value};
use std::path::Path;

pub(crate) fn capabilities(root: &Path, page: &str, options: &str) -> Result<String, String> {
    let options: Value = serde_json::from_str(options).map_err(|e| e.to_string())?;
    let document = crate::editor::read_for_ai(root, page,&options)?;
    let (reviewed, _) = review_range(&document.content, &options["range"])?;
    let config = crate::config::read_config(root);
    let supports_images = config.connection_type == "api" || config.connection_type == "local_llm";
    let count = image_paths(reviewed).into_iter().collect::<std::collections::HashSet<_>>().len();
    serde_json::to_string(&json!({"supports_images":supports_images,"images":count,"connection":config.connection_type,"agent":config.agent,"note":if supports_images{"画像入力を送信できます（PNG・JPEG・WebP、最大6枚・各8MB）。モデルが画像を読めたかは結果で確認します。"}else{"現在のCLI接続は画像入力に非対応です。画像と説明の整合チェックはできません。文章のレビュー・校正は実行できます。"}})).map_err(|e| e.to_string())
}

#[cfg(test)]
fn replacement_requests(issues: &[Value]) -> Vec<Value> {
    issues.iter().enumerate().filter(|(_, issue)| {
        issue["category"] != "image"
            && (issue["replacement"].as_str().is_none() || issue["replacement"] == issue["quote"])
    }).map(|(id, issue)| json!({"id":id,"quote":issue["quote"],"message":issue["message"],"suggestion":issue["suggestion"]})).collect()
}

#[cfg(test)]
fn merge_replacements(issues: &mut [Value], requested: &[Value], answer: &Value) -> Result<(), String> {
    let replacements = answer["replacements"].as_array().ok_or("修正文の形式が不正です。")?;
    let mut seen = std::collections::HashSet::new();
    for replacement in replacements {
        let id = replacement["id"].as_u64().ok_or("修正文の対象が不正です。")? as usize;
        if !requested.iter().any(|item| item["id"] == id) || !seen.insert(id)
            || (!replacement["replacement"].is_null() && !replacement["replacement"].is_string()) {
            return Err("修正文の対象または形式が不正です。".into());
        }
    }
    if seen.len() != requested.len() { return Err("一部の指摘の修正文がありません。".into()); }
    for replacement in replacements {
        issues[replacement["id"].as_u64().unwrap() as usize]["replacement"] = replacement["replacement"].clone();
    }
    Ok(())
}

fn review_range<'a>(content: &'a str, range: &Value) -> Result<(&'a str, usize), String> {
    if range.is_null() {
        return Ok((content, 0));
    }
    let start = range["start"].as_u64().ok_or("レビュー範囲が不正です。")? as usize;
    let end = range["end"].as_u64().ok_or("レビュー範囲が不正です。")? as usize;
    if start >= end {
        return Err("レビューする文章を選択してください。".into());
    }
    let byte_at = |offset| {
        let mut units = 0;
        for (byte, ch) in content.char_indices() {
            if units == offset {
                return Some(byte);
            }
            units += ch.len_utf16();
        }
        if units == offset {
            Some(content.len())
        } else {
            None
        }
    };
    let left = byte_at(start).ok_or("レビュー範囲が不正です。")?;
    let right = byte_at(end).ok_or("レビュー範囲が不正です。")?;
    Ok((&content[left..right], start))
}
fn image_paths(content: &str) -> Vec<String> {
    let html = regex::Regex::new(r#"(?i)<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']"#).unwrap();
    let mut paths = Vec::new();
    for event in Parser::new_ext(content, Options::all()) {
        match event {
            Event::Start(Tag::Image { dest_url, .. }) => paths.push(dest_url.to_string()),
            Event::Html(raw) | Event::InlineHtml(raw) => paths.extend(
                html.captures_iter(&raw)
                    .map(|cap| crate::quality::decode_html_attr(&cap[1])),
            ),
            _ => {}
        }
    }
    paths
}
#[cfg(test)]
fn validate_findings(
    content: &str,
    result: &Value,
    images: &[Value],
) -> Result<Vec<Value>, String> {
    let findings = result["issues"]
        .as_array()
        .ok_or("AIレビューの形式が不正です。")?;
    if findings.len() > 200 {
        return Err("AIの指摘が多すぎます。".into());
    }
    let mut validated = Vec::new();
    for finding in findings {
        let category = finding["category"]
            .as_str()
            .ok_or("指摘の分類が不正です。")?;
        if !["reader", "proofreading", "image"].contains(&category)
            || !["problem", "suggestion"].contains(&finding["severity"].as_str().unwrap_or(""))
        {
            return Err("指摘の分類が不正です。".into());
        }
        let quote = finding["quote"]
            .as_str()
            .filter(|q| !q.is_empty())
            .ok_or("指摘の引用がありません。")?;
        let occurrence = finding["occurrence"]
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or("指摘の位置が不正です。")? as usize;
        let (offset, _) = content
            .match_indices(quote)
            .nth(occurrence - 1)
            .ok_or("AIの指摘箇所を原稿内で特定できませんでした。再実行してください。")?;
        if finding["message"]
            .as_str()
            .is_none_or(|s| s.trim().is_empty())
            || finding["suggestion"].as_str().is_none()
            || (!finding["replacement"].is_null() && !finding["replacement"].is_string())
        {
            return Err("指摘の内容が不正です。".into());
        }
        if category == "image"
            && !images.iter().any(|image| {
                image["status"] == "submitted"
                    && image["path"] == finding["image"]
                    && result["checked_images"]
                        .as_array()
                        .is_some_and(|checked| checked.contains(&image["path"]))
            })
        {
            continue;
        }
        let mut finding = finding.clone();
        finding["start"] = json!(content[..offset].encode_utf16().count());
        finding["end"] = json!(content[..offset + quote.len()].encode_utf16().count());
        validated.push(finding);
    }
    Ok(validated)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completes_only_missing_text_corrections_and_merges_atomically() {
        let mut issues = vec![
            json!({"category":"reader","quote":"before","replacement":null}),
            json!({"category":"proofreading","quote":"same","replacement":"same"}),
            json!({"category":"proofreading","quote":"old","replacement":"correct"}),
            json!({"category":"image","quote":"image","replacement":null}),
        ];
        let pending = replacement_requests(&issues);
        assert_eq!(pending.len(), 2);
        let original = issues.clone();
        assert!(merge_replacements(&mut issues, &pending, &json!({"replacements":[{"id":0,"replacement":"after"},{"id":2,"replacement":"wrong"}]})).is_err());
        assert_eq!(issues, original);
        assert!(merge_replacements(&mut issues, &pending, &json!({"replacements":[{"id":0,"replacement":"after"}]})).is_err());
        assert_eq!(issues, original);
        merge_replacements(&mut issues, &pending, &json!({"replacements":[{"id":1,"replacement":""},{"id":0,"replacement":"after"}]})).unwrap();
        assert_eq!(issues[0]["replacement"], "after");
        assert_eq!(issues[1]["replacement"], "");
        assert_eq!(issues[2]["replacement"], "correct");
        assert!(issues[3]["replacement"].is_null());
    }
    #[test]
    fn selection_uses_utf16_boundaries() {
        assert_eq!(
            review_range("😀本文。", &json!({"start":2,"end":4})).unwrap(),
            ("本文", 2)
        );
        assert!(review_range("😀本文", &json!({"start":1,"end":3})).is_err());
    }
    #[test]
    fn ignores_code_example_images() {
        assert_eq!(image_paths("```html\n<img src='fake.png'>\n```\n\n`![x](fake.png)`\n\n![x](real.png)\n\n<img src='html.png'>"),vec!["real.png","html.png"]);
    }
    #[test]
    fn anchors_repeated_unicode_quotes() {
        let result = json!({"issues":[{"category":"proofreading","severity":"problem","quote":"本文","occurrence":2,"message":"修正","suggestion":"修正文","replacement":"修正後の本文","image":""}],"checked_images":[]});
        let findings = validate_findings("😀本文\n本文", &result, &[]).unwrap();
        assert_eq!(findings[0]["replacement"], "修正後の本文");
        assert_eq!(findings[0]["start"], 5);
        assert!(validate_findings("別の原稿", &result, &[]).is_err());
    }
    #[test]
    fn cannot_claim_an_unseen_image() {
        let result = json!({"issues":[{"category":"image","severity":"problem","quote":"画面","occurrence":1,"message":"違う","suggestion":"","image":"x.png"}],"checked_images":["x.png"]});
        assert!(validate_findings(
            "画面",
            &result,
            &[json!({"path":"x.png","status":"unverified"})]
        )
        .unwrap()
        .is_empty());
    }
}
