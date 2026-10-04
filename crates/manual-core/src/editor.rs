use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use pulldown_cmark::{html, Options, Parser};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;

use super::config::{project_path, read_config};
use super::task::collect_target_markdown_files;

#[derive(Debug, Serialize, Deserialize)]
pub struct SavedAsset {
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct Document {
    pub page: String,
    pub content: String,
    pub revision: String,
}

fn revision(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

pub(crate) fn document_path(root: &Path, page: &str) -> Result<PathBuf, String> {
    if page.trim().is_empty()
        || Path::new(page).is_absolute()
        || Path::new(page)
            .extension()
            .is_none_or(|extension| extension != "md")
    {
        return Err("Markdownページの相対パスを指定してください。".into());
    }
    let config = read_config(root);
    let direct_path = project_path(root, page)?;
    if direct_path.is_file() {
        return Ok(direct_path);
    }
    if let Some((_, path)) = collect_target_markdown_files(root, &config)
        .into_iter()
        .find(|(name, _)| name == page)
    {
        let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
        return project_path(root, &relative.to_string_lossy());
    }
    if config.targets.iter().any(|target| {
        target == page && Path::new(target).extension().is_some_and(|ext| ext == "md")
    }) {
        return project_path(root, page);
    }
    let docs = project_path(root, &config.docs)?;
    project_path(&docs, page)
}

pub fn create_folder(root: &Path, folder: &str) -> Result<String, String> {
    let clean = folder.trim().replace('\\', "/");
    let relative = Path::new(&clean);
    if clean.is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err("原稿フォルダー内の相対パスを指定してください。".into());
    }
    let config = read_config(root);
    let docs = config
        .docs
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_end_matches('/')
        .to_string();
    let project_relative = format!("{docs}/{clean}");
    let path = project_path(root, &project_relative)?;
    if path.exists() {
        return Err("同じ名前のファイルまたはフォルダーが既にあります。".into());
    }
    fs::create_dir_all(&path)
        .map_err(|error| format!("フォルダーを作成できませんでした: {error}"))?;
    Ok(project_relative)
}

pub fn read(root: &Path, page: &str) -> Result<Document, String> {
    let path = document_path(root, page)?;
    let bytes = fs::read(&path).map_err(|error| format!("原稿を開けません: {error}"))?;
    let revision = revision(&bytes);
    let content = String::from_utf8(bytes).map_err(|error| error.to_string())?;
    Ok(Document {
        page: page.to_string(),
        content,
        revision,
    })
}

pub fn save(
    root: &Path,
    page: &str,
    content: &str,
    expected_revision: Option<&str>,
) -> Result<Document, String> {
    let path = document_path(root, page)?;
    let existing = match fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    if existing.as_deref().map(revision).as_deref() != expected_revision {
        return Err("別の画面やツールで原稿が更新されています。編集内容をコピーしてから原稿を読み直してください。".into());
    }
    let parent = path.parent().ok_or("Invalid Markdown path")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut temporary = NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    if let Ok(metadata) = fs::metadata(&path) {
        temporary
            .as_file()
            .set_permissions(metadata.permissions())
            .map_err(|error| error.to_string())?;
    }
    temporary
        .write_all(content.as_bytes())
        .map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    if let Some(bytes) = existing {
        if fs::read(&path).map_err(|error| error.to_string())? != bytes {
            return Err("保存中に原稿が更新されました。原稿を読み直してください。".into());
        }
        temporary
            .persist(&path)
            .map_err(|error| error.to_string())?;
    } else {
        temporary
            .persist_noclobber(&path)
            .map_err(|error| error.to_string())?;
    }
    Ok(Document {
        page: page.to_string(),
        content: content.to_string(),
        revision: revision(content.as_bytes()),
    })
}

pub fn save_asset(root: &Path, target_path: &str, data: &str) -> Result<SavedAsset, String> {
    let clean_path = target_path.trim().replace('\\', "/");
    if clean_path.is_empty() {
        return Err("保存先パスを指定してください。".into());
    }
    let ext = Path::new(&clean_path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if !["png", "jpg", "jpeg", "gif", "svg", "webp"].contains(&ext.as_str()) {
        return Err(format!("対応していない画像形式です: {ext}"));
    }
    let abs_path = project_path(root, &clean_path)?;
    let parent = abs_path.parent().ok_or("Invalid asset directory")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("ディレクトリを作成できませんでした: {error}"))?;

    let base64_str = if let Some(idx) = data.find(',') {
        &data[idx + 1..]
    } else {
        data
    };
    let bytes = BASE64
        .decode(base64_str.trim().as_bytes())
        .map_err(|error| format!("画像データのデコードに失敗しました: {error}"))?;

    let mut temporary = NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    temporary
        .write_all(&bytes)
        .map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temporary
        .persist(&abs_path)
        .map_err(|error| error.to_string())?;

    Ok(SavedAsset { path: clean_path })
}

pub fn render_html(root: &Path, page: &str, content: &str) -> Result<String, String> {
    document_path(root, page)?;
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES;
    let parser = Parser::new_ext(content, options);
    let mut body = String::new();
    html::push_html(&mut body, parser);
    // Markdown images and literal HTML <img> tags both reach this HTML output.
    // Embed local project images because the iframe intentionally permits data: images only.
    let image_tags = regex::Regex::new(r#"(?i)<img\b[^>]*\bsrc=["'](?P<src>[^"']+)["'][^>]*>"#)
        .map_err(|error| error.to_string())?;
    let mut inlined_body = String::with_capacity(body.len());
    let mut last_end = 0;
    for captures in image_tags.captures_iter(&body) {
        let source = captures.name("src").unwrap();
        inlined_body.push_str(&body[last_end..source.start()]);
        let replacement = if !source.as_str().contains("://")
            && !source.as_str().starts_with('/')
            && !source.as_str().starts_with("data:")
        {
            super::preview::preview_asset(root, page, source.as_str()).ok()
        } else {
            None
        };
        inlined_body.push_str(replacement.as_deref().unwrap_or(source.as_str()));
        last_end = source.end();
    }
    inlined_body.push_str(&body[last_end..]);
    Ok(format!(
        r#"<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>body{{font:16px/1.8 system-ui,sans-serif;color:#26342f;background:#fff;max-width:850px;margin:32px auto;padding:0 28px}}h1,h2,h3{{line-height:1.4}}h1{{font-size:30px}}h2{{border-bottom:1px solid #dbe4df;padding-bottom:8px}}a{{color:#246b54}}pre,code{{font-family:ui-monospace,monospace;background:#f2f5f3}}code{{padding:2px 4px}}pre{{padding:16px;overflow:auto}}img{{max-width:100%;height:auto}}table{{border-collapse:collapse;width:100%}}td,th{{border:1px solid #dbe4df;padding:8px;text-align:left}}blockquote{{border-left:3px solid #74a58a;margin-left:0;padding-left:18px;color:#52665a}}</style></head><body>{inlined_body}</body></html>"#
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editing_preserves_tags_and_detects_external_changes() {
        let root = tempfile::tempdir().unwrap();
        let original = "# Guide\n<!-- ai:task id=shot kind=screenshot\nCapture\n-->\n";
        let created = save(root.path(), "guide.md", original, None).unwrap();
        assert_eq!(read(root.path(), "guide.md").unwrap().content, original);
        let updated = save(
            root.path(),
            "guide.md",
            &(original.to_string() + "Updated\n"),
            Some(&created.revision),
        )
        .unwrap();
        assert!(updated.content.contains("ai:task"));
        fs::write(root.path().join("docs/guide.md"), "External edit").unwrap();
        assert!(save(
            root.path(),
            "guide.md",
            "Overwrite",
            Some(&updated.revision)
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(root.path().join("docs/guide.md")).unwrap(),
            "External edit"
        );
        assert!(save(root.path(), "guide.md", "Overwrite", None).is_err());
        assert!(save(root.path(), "../outside.md", "Escape", None).is_err());
        assert!(save(root.path(), "image.png", "Not Markdown", None).is_err());
    }

    #[test]
    fn preview_supports_markdown_and_blocks_script_execution() {
        let root = tempfile::tempdir().unwrap();
        let html = render_html(
            root.path(),
            "new.md",
            "# Hello\n\n**Bold**\n\n| A | B |\n|---|---|\n| 1 | 2 |\n",
        )
        .unwrap();
        assert!(html.contains("<strong>Bold</strong>"));
        assert!(html.contains("<table>"));
        assert!(html.contains("default-src 'none'"));
    }

    #[test]
    fn preview_embeds_images_from_external_readme_and_nested_docs() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs/images")).unwrap();
        fs::write(root.path().join("README.md"), "# Images").unwrap();
        let image = BASE64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==").unwrap();
        fs::write(root.path().join("markits.png"), &image).unwrap();
        fs::write(root.path().join("docs/images/example.png"), &image).unwrap();

        let html = render_html(
            root.path(),
            "README.md",
            "<img src=\"markits.png\" alt=\"logo\">\n\n![Example](docs/images/example.png)",
        )
        .unwrap();
        assert_eq!(html.matches("src=\"data:image/png;base64,").count(), 2);
        assert!(!html.contains("src=\"markits.png\""));
        assert!(!html.contains("src=\"docs/images/example.png\""));
    }

    #[test]
    fn save_asset_persists_image_and_validates_path_and_extension() {
        let root = tempfile::tempdir().unwrap();
        let tiny_png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        let data_uri = format!("data:image/png;base64,{tiny_png}");

        let saved = save_asset(root.path(), "docs/assets/test.png", &data_uri).unwrap();
        assert_eq!(saved.path, "docs/assets/test.png");
        assert!(root.path().join("docs/assets/test.png").is_file());

        // Without data URI prefix
        let saved_raw = save_asset(root.path(), "docs/assets/raw.png", tiny_png).unwrap();
        assert_eq!(saved_raw.path, "docs/assets/raw.png");
        assert!(root.path().join("docs/assets/raw.png").is_file());

        // Reject invalid extensions
        assert!(save_asset(root.path(), "docs/assets/script.sh", tiny_png).is_err());
        assert!(save_asset(root.path(), "docs/assets/page.md", tiny_png).is_err());

        // Reject escaping paths
        assert!(save_asset(root.path(), "../escape.png", tiny_png).is_err());
    }
}
