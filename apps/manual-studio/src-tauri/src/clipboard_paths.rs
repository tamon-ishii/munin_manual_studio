use std::path::PathBuf;

/// Clipboard text can contain arbitrary Unicode, native paths or escaped file URLs.
pub fn image_path(text: &str) -> Option<PathBuf> {
    let text = text.trim().trim_matches('"');
    if text.starts_with("file:") {
        return url::Url::parse(text).ok()?.to_file_path().ok();
    }
    let bytes = text.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    if text.starts_with('/') || text.starts_with('\\') || drive {
        Some(PathBuf::from(text))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_text_is_not_sliced_at_byte_boundaries() {
        for text in ["あ", "日本語", "😀", "aあ", "abc"] {
            assert_eq!(image_path(text), None);
        }
    }
    #[test]
    fn native_paths_and_escaped_urls() {
        assert_eq!(
            image_path(r#""C:\My Images\画像.png""#),
            Some(PathBuf::from(r"C:\My Images\画像.png"))
        );
        assert_eq!(
            image_path("C:/Images/test.png"),
            Some(PathBuf::from("C:/Images/test.png"))
        );
        #[cfg(unix)]
        assert_eq!(
            image_path("file:///tmp/my%20image.png"),
            Some(PathBuf::from("/tmp/my image.png"))
        );
        #[cfg(windows)]
        assert_eq!(
            image_path("file:///C:/My%20Images/test.png"),
            Some(PathBuf::from(r"C:\My Images\test.png"))
        );
        assert_eq!(image_path("file://%invalid"), None);
    }
}
