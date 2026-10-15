//! Literal manuscript search, guarded multi-file edits and CommonMark outlines.
use crate::{editor, workflow};
use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeSet, path::Path};
use walkdir::WalkDir;

const MAX_CONTENT: usize = 3_000_000;
const MAX_RESULTS: usize = 1000;

pub(crate) fn search(root: &Path, options: &Value) -> Result<Value, String> {
    let query = options["query"]
        .as_str()
        .ok_or("検索する文字を指定してください。")?;
    if query.is_empty() || query.len() > 4096 {
        return Err("検索文字は1文字以上、4096バイト以内で指定してください。".into());
    }
    let sensitive = options["case_sensitive"].as_bool().unwrap_or(true);
    let expression = regex::RegexBuilder::new(&regex::escape(query))
        .case_insensitive(!sensitive)
        .build()
        .map_err(|e| e.to_string())?;
    let mut documents = Vec::new();
    let mut matches = Vec::new();
    let mut skipped = Vec::new();
    let mut bytes = 0;
    let mut examined = 0;
    let mut truncated = false;
    for entry in WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || (!e.file_name().to_string_lossy().starts_with('.')
                    && !matches!(
                        e.file_name().to_str(),
                        Some("node_modules" | "target" | "dist" | "__pycache__")
                    ))
        })
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                skipped.push(json!({"page":error.path().map(|p|p.strip_prefix(root).unwrap_or(p).to_string_lossy()),"message":error.to_string()}));
                continue;
            }
        };
        if !entry.file_type().is_file() || entry.path().extension().is_none_or(|e| e != "md") {
            continue;
        }
        examined += 1;
        if examined > 2000 {
            truncated = true;
            break;
        }
        let page = entry
            .path()
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let read = || -> Result<editor::Document, String> {
            if entry.metadata().map_err(|e| e.to_string())?.len() > MAX_CONTENT as u64 {
                return Err("原稿が検索上限の3MBを超えています。".into());
            }
            editor::read(root, &page)
        };
        let document = match read() {
            Ok(value) => value,
            Err(message) => {
                skipped.push(json!({"page":page,"message":message}));
                continue;
            }
        };
        let mut found = Vec::new();
        for m in expression.find_iter(&document.content) {
            if matches.len() + found.len() >= MAX_RESULTS {
                truncated = true;
                break;
            }
            let before = &document.content[..m.start()];
            let line_start = before.rfind('\n').map_or(0, |i| i + 1);
            let line_end = document.content[m.end()..]
                .find('\n')
                .map_or(document.content.len(), |i| m.end() + i);
            let excerpt: String = document.content[line_start..line_end]
                .chars()
                .take(240)
                .collect();
            found.push(json!({"page":page,"start":before.encode_utf16().count(),"end":document.content[..m.end()].encode_utf16().count(),"text":m.as_str(),"line":before.bytes().filter(|b|*b==b'\n').count()+1,"column":document.content[line_start..m.start()].encode_utf16().count()+1,"excerpt":excerpt}));
        }
        if !found.is_empty() {
            bytes += document.content.len();
            if bytes > MAX_CONTENT {
                truncated = true;
                break;
            }
            documents.push(document);
            matches.extend(found);
        }
        if truncated {
            break;
        }
    }
    Ok(json!({"documents":documents,"matches":matches,"skipped":skipped,"truncated":truncated}))
}

#[derive(Deserialize)]
struct BatchDocument {
    page: String,
    revision: String,
    content: String,
}

pub(crate) fn batch_save(root: &Path, options: &Value) -> Result<Value, String> {
    let changes: Vec<BatchDocument> =
        serde_json::from_value(options["documents"].clone()).map_err(|e| e.to_string())?;
    if changes.is_empty()
        || changes.len() > 200
        || changes.iter().map(|d| d.content.len()).sum::<usize>() > MAX_CONTENT
    {
        return Err("置換対象は1〜200原稿、合計3MB以内で指定してください。".into());
    }
    let mut paths = BTreeSet::new();
    let mut lock_names = Vec::new();
    for change in &changes {
        let path = editor::document_path(root, &change.page)?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if !paths.insert(path.clone()) {
            return Err("同じ原稿が重複しています。".into());
        }
        lock_names.push(
            path.strip_prefix(root.canonicalize().map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/"),
        );
    }
    lock_names.sort();
    let _locks = lock_names
        .iter()
        .map(|name| workflow::resource_lock(root, name))
        .collect::<Result<Vec<_>, _>>()?;
    let originals = changes
        .iter()
        .map(|change| {
            let document = editor::read_raw(root, &change.page)?;
            if document.revision != change.revision {
                return Err(format!(
                    "{} は変更されています。原稿を読み直し、変更候補を確認し直してください。",
                    change.page
                ));
            }
            Ok(document)
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut saved: Vec<editor::Document> = Vec::new();
    for (change, original) in changes.iter().zip(&originals) {
        match editor::save_exact(
            root,
            &change.page,
            &change.content,
            Some(&original.revision),
        ) {
            Ok(document) => saved.push(document),
            Err(error) => {
                let mut failed = Vec::new();
                for (before, after) in originals.iter().zip(&saved).rev() {
                    if editor::save_exact(
                        root,
                        &before.page,
                        &before.content,
                        Some(&after.revision),
                    )
                    .is_err()
                    {
                        failed.push(before.page.clone());
                    }
                }
                return Err(if failed.is_empty() {
                    format!("置換を中止し、変更を元に戻しました: {error}")
                } else {
                    format!(
                        "置換に失敗しました。復元できなかった原稿: {}。{error}",
                        failed.join(", ")
                    )
                });
            }
        }
    }
    Ok(json!({"before":originals,"documents":saved}))
}

pub(crate) fn outline(content: &str) -> Value {
    let mut headings = Vec::new();
    let mut depth = 0usize;
    let mut heading: Option<(usize, usize, String)> = None;
    for (event, range) in Parser::new(content).into_offset_iter() {
        match event {
            Event::Start(tag) => {
                if let Tag::Heading { level, .. } = tag {
                    if depth == 0 {
                        heading = Some((range.start, level as usize, String::new()));
                    }
                }
                depth += 1;
            }
            Event::End(tag) => {
                depth = depth.saturating_sub(1);
                if matches!(tag, TagEnd::Heading(_)) && depth == 0 {
                    if let Some((start, level, label)) = heading.take() {
                        headings.push(json!({"start":content[..start].encode_utf16().count(),"heading_end":content[..range.end].encode_utf16().count(),"level":level,"label":label}));
                    }
                }
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some((_, _, label)) = &mut heading {
                    label.push_str(&text);
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                if let Some((_, _, label)) = &mut heading {
                    label.push(' ');
                }
            }
            _ => {}
        }
    }
    for index in 0..headings.len() {
        let level = headings[index]["level"].as_u64().unwrap();
        let end = headings[index + 1..]
            .iter()
            .find(|h| h["level"].as_u64().unwrap() <= level)
            .map_or(content.encode_utf16().count(), |h| {
                h["start"].as_u64().unwrap() as usize
            });
        let parent = (0..index)
            .rev()
            .find(|i| headings[*i]["level"].as_u64().unwrap() < level);
        headings[index]["end"] = json!(end);
        headings[index]["parent"] = json!(parent);
    }
    json!({"headings":headings})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn project() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("docs")).unwrap();
        fs::write(
            root.path().join("manual_setting.json"),
            r#"{"docs":"docs"}"#,
        )
        .unwrap();
        root
    }

    #[test]
    fn search_unicode_filters_and_case() {
        let root = project();
        fs::write(
            root.path().join("docs/index.md"),
            "# 😀 日本語\n😀 target TARGET\n",
        )
        .unwrap();
        for dir in [".git", ".munin", "node_modules", "target"] {
            fs::create_dir(root.path().join(dir)).unwrap();
            fs::write(root.path().join(dir).join("ignored.md"), "target").unwrap();
        }
        let result = search(
            root.path(),
            &json!({"query":"target","case_sensitive":false}),
        )
        .unwrap();
        assert_eq!(result["matches"].as_array().unwrap().len(), 2);
        assert_eq!(result["matches"][0]["start"], 12);
        assert_eq!(result["matches"][0]["column"], 4);
        assert_eq!(result["matches"][0]["page"], "docs/index.md");
        assert_eq!(
            search(root.path(), &json!({"query":"target"})).unwrap()["matches"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn batch_rejects_stale_and_aliases_before_any_write_and_supports_undo() {
        let root = project();
        for name in ["a.md", "b.md"] {
            fs::write(root.path().join("docs").join(name), "old 😀\n").unwrap();
        }
        let a = editor::read(root.path(), "a.md").unwrap();
        let b = editor::read(root.path(), "b.md").unwrap();
        let changes = json!({"documents":[{"page":a.page,"revision":a.revision,"content":"new A"},{"page":b.page,"revision":"stale","content":"new B"}]});
        assert!(batch_save(root.path(), &changes).is_err());
        assert_eq!(
            editor::read(root.path(), "a.md").unwrap().content,
            a.content
        );
        assert!(batch_save(root.path(),&json!({"documents":[{"page":"a.md","revision":a.revision,"content":"a"},{"page":"docs/a.md","revision":a.revision,"content":"b"}]})).is_err());
        let result = batch_save(root.path(),&json!({"documents":[{"page":"a.md","revision":a.revision,"content":"new A"},{"page":"b.md","revision":b.revision,"content":"new B"}]})).unwrap();
        let undo: Vec<Value> = result["before"].as_array().unwrap().iter().zip(result["documents"].as_array().unwrap()).map(|(before,after)|json!({"page":before["page"],"revision":after["revision"],"content":before["content"]})).collect();
        batch_save(root.path(), &json!({"documents":undo})).unwrap();
        assert_eq!(
            editor::read(root.path(), "a.md").unwrap().content,
            a.content
        );
        assert_eq!(
            editor::read(root.path(), "b.md").unwrap().content,
            b.content
        );
    }

    #[test]
    fn outline_commonmark_ranges() {
        let content = "# 😀 Top\r\n\r\n```md\r\n# code\r\n```\r\n\r\n## Same\r\n![x](a.png)\r\n\r\n### Child\r\ntext\r\n\r\nSame\r\n----\r\nlast";
        let headings = outline(content)["headings"].as_array().unwrap().clone();
        assert_eq!(headings.len(), 4);
        assert_eq!(headings[0]["label"], "😀 Top");
        assert_eq!(headings[2]["parent"], 1);
        assert_eq!(headings[1]["end"], headings[3]["start"]);
        assert_eq!(headings[3]["end"], content.encode_utf16().count());
        assert_eq!(
            outline("> # quoted\n\n- ## list\n")["headings"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn batch_rolls_back_when_a_later_directory_is_read_only() {
        use std::os::unix::fs::PermissionsExt;
        let root = project();
        fs::create_dir(root.path().join("docs/locked")).unwrap();
        fs::write(root.path().join("docs/a.md"), "before A").unwrap();
        fs::write(root.path().join("docs/locked/b.md"), "before B").unwrap();
        let a = editor::read(root.path(), "a.md").unwrap();
        let b = editor::read(root.path(), "locked/b.md").unwrap();
        let path = root.path().join("docs/locked");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o555)).unwrap();
        let result = batch_save(
            root.path(),
            &json!({"documents":[{"page":a.page,"revision":a.revision,"content":"changed A"},{"page":b.page,"revision":b.revision,"content":"changed B"}]}),
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(result.is_err());
        assert_eq!(
            editor::read(root.path(), "a.md").unwrap().content,
            "before A"
        );
        assert_eq!(
            editor::read(root.path(), "locked/b.md").unwrap().content,
            "before B"
        );
    }
}
