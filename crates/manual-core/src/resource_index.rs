//! Disposable, project-local indexes. Metadata is rechecked on every request;
//! unavailable/corrupt caches fall back to reading the project normally.
use crate::{config::project_path, task};
use pulldown_cmark::{Event, Parser, Tag};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

#[derive(Clone, Default, Serialize, Deserialize)]
struct Directory {
    stamp: String,
    entries: Vec<Entry>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct Entry {
    name: String,
    directory: bool,
    file: bool,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct ImageReference {
    pub url: String,
    pub line: usize,
    pub start: usize,
    pub end: usize,
    pub snippet: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct Document {
    stamp: String,
    pub images: Vec<ImageReference>,
    pub screenshots: Vec<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct Index {
    version: u32,
    directories: BTreeMap<String, Directory>,
    documents: BTreeMap<String, Document>,
}

pub(crate) fn stamp(metadata: &fs::Metadata) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|t| t.as_nanos());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{:?}:{}:{}:{}:{}:{}",
            modified,
            metadata.len(),
            metadata.ctime(),
            metadata.ctime_nsec(),
            metadata.dev(),
            metadata.ino()
        )
    }
    #[cfg(not(unix))]
    {
        format!(
            "{:?}:{}:{:?}",
            modified,
            metadata.len(),
            metadata.created().ok()
        )
    }
}

pub(crate) fn cache_path(root: &Path, name: &str) -> Option<PathBuf> {
    project_path(root, &format!(".munin/cache/resources-v1/{name}")).ok()
}
pub(crate) fn read_cache<T: serde::de::DeserializeOwned>(root: &Path, name: &str) -> Option<T> {
    let path = cache_path(root, name)?;
    if fs::metadata(&path).ok()?.len() > 32_000_000 {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}
pub(crate) fn write_cache<T: Serialize>(root: &Path, name: &str, value: &T) {
    let Some(path) = cache_path(root, name) else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    let save = || -> Option<()> {
        fs::create_dir_all(parent).ok()?;
        // Recheck after creating the directory, before opening a file in it.
        let path = cache_path(root, name)?;
        let mut file = tempfile::NamedTempFile::new_in(path.parent()?).ok()?;
        file.write_all(&serde_json::to_vec(value).ok()?).ok()?;
        file.persist(path).ok()?;
        Some(())
    };
    let _ = save();
}

pub(crate) struct ProjectIndex {
    root: PathBuf,
    old: Index,
    next: Index,
    pub files: Vec<PathBuf>,
    #[cfg(test)]
    pub directories_read: usize,
    #[cfg(test)]
    pub documents_read: usize,
}
impl ProjectIndex {
    pub fn scan(root: &Path) -> Result<Self, String> {
        let old = read_cache::<Index>(root, "index.json")
            .filter(|v| v.version == 1)
            .unwrap_or_default();
        let documents = old.documents.clone();
        let mut index = Self {
            root: root.to_path_buf(),
            old,
            next: Index {
                version: 1,
                documents,
                ..Index::default()
            },
            files: Vec::new(),
            #[cfg(test)]
            directories_read: 0,
            #[cfg(test)]
            documents_read: 0,
        };
        index.visit("")?;
        Ok(index)
    }
    fn visit(&mut self, relative: &str) -> Result<(), String> {
        let directory = if relative.is_empty() {
            self.root.clone()
        } else {
            project_path(&self.root, relative)?
        };
        let metadata = fs::metadata(&directory).map_err(|e| e.to_string())?;
        let fingerprint = stamp(&metadata);
        let cached = self
            .old
            .directories
            .get(relative)
            .filter(|v| v.stamp == fingerprint);
        let entries = if let Some(cached) = cached {
            cached.entries.clone()
        } else {
            #[cfg(test)]
            {
                self.directories_read += 1;
            }
            let mut entries = fs::read_dir(&directory)
                .map_err(|e| e.to_string())?
                .filter_map(|entry| {
                    let entry = entry.ok()?;
                    let kind = entry.file_type().ok()?;
                    Some(Entry {
                        name: entry.file_name().to_string_lossy().into_owned(),
                        directory: kind.is_dir(),
                        file: kind.is_file(),
                    })
                })
                .collect::<Vec<_>>();
            entries.sort_by(|a, b| a.name.cmp(&b.name));
            entries
        };
        self.next.directories.insert(
            relative.into(),
            Directory {
                stamp: fingerprint,
                entries: entries.clone(),
            },
        );
        for entry in entries {
            let name = entry.name;
            // Cache files are untrusted hints, never paths to traverse.
            if name.starts_with('.')
                || matches!(
                    name.as_str(),
                    "node_modules" | "target" | "dist" | "__pycache__" | "site"
                )
                || Path::new(&name).components().count() != 1
                || name.contains(['/', '\\'])
            {
                continue;
            }
            let path = directory.join(&name);
            let child = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            if entry.directory {
                let _ = self.visit(&child);
            } else if entry.file
                && (path.extension().is_some_and(|ext| ext == "md")
                    || crate::resources::image_extension(&path))
            {
                self.files.push(self.root.join(&child));
            }
        }
        Ok(())
    }
    pub fn document(&mut self, path: &Path) -> Result<Document, String> {
        let relative = path
            .strip_prefix(&self.root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let path = project_path(&self.root, &relative)?;
        let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
        let fingerprint = stamp(&metadata);
        let document = if let Some(cached) = self
            .old
            .documents
            .get(&relative)
            .filter(|d| d.stamp == fingerprint)
        {
            cached.clone()
        } else {
            #[cfg(test)]
            {
                self.documents_read += 1;
            }
            let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
            let mut document = Document {
                stamp: fingerprint,
                ..Document::default()
            };
            let html_images =
                regex::Regex::new(r#"(?is)<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>"#).unwrap();
            for (event, range) in Parser::new(&text).into_offset_iter() {
                let images: Vec<_> = match event {
                    Event::Start(Tag::Image { dest_url, .. }) => {
                        vec![(dest_url.to_string(), range)]
                    }
                    Event::Html(html) | Event::InlineHtml(html) => html_images
                        .captures_iter(&html)
                        .map(|cap| {
                            let m = cap.get(0).unwrap();
                            (
                                crate::quality::decode_html_attr(&cap[1]),
                                range.start + m.start()..range.start + m.end(),
                            )
                        })
                        .collect(),
                    _ => Vec::new(),
                };
                for (url, range) in images {
                    document.images.push(ImageReference {
                        url,
                        line: text[..range.start].bytes().filter(|b| *b == b'\n').count() + 1,
                        start: text[..range.start].encode_utf16().count(),
                        end: text[..range.end].encode_utf16().count(),
                        snippet: text[range].into(),
                    });
                }
            }
            let ignored = task::ignored_tag_ranges(&text);
            let markers =
                regex::Regex::new(r"<!--\s*screenshot:ref\s+id=([a-z0-9-]+)\s*-->").unwrap();
            document.screenshots = markers
                .captures_iter(&text)
                .filter(|cap| !task::is_inside_ranges(&cap.get(0).unwrap().range(), &ignored))
                .map(|cap| cap[1].to_string())
                .collect();
            document
        };
        self.next.documents.insert(relative, document.clone());
        Ok(document)
    }
    pub fn save(&self) {
        let mut next = self.next.clone();
        next.documents
            .retain(|path, _| project_path(&self.root, path).is_ok_and(|p| p.is_file()));
        write_cache(&self.root, "index.json", &next);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn warm_index_only_reads_changed_documents_and_directories() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("docs")).unwrap();
        let first = root.path().join("docs/a.md");
        let second = root.path().join("docs/b.md");
        fs::write(&first, "![A](a.png)").unwrap();
        fs::write(&second, "![B](b.png)").unwrap();
        let mut cold = ProjectIndex::scan(root.path()).unwrap();
        cold.document(&first).unwrap();
        cold.document(&second).unwrap();
        assert_eq!(cold.documents_read, 2);
        cold.save();
        // Creating the optional cache directory changes the project root once.
        let warmup = ProjectIndex::scan(root.path()).unwrap();
        warmup.save();
        let mut warm = ProjectIndex::scan(root.path()).unwrap();
        warm.document(&first).unwrap();
        warm.document(&second).unwrap();
        assert_eq!(warm.directories_read, 0);
        assert_eq!(warm.documents_read, 0);
        fs::write(&second, "![changed](other.png)").unwrap();
        let mut changed = ProjectIndex::scan(root.path()).unwrap();
        assert_eq!(changed.document(&first).unwrap().images[0].url, "a.png");
        assert_eq!(
            changed.document(&second).unwrap().images[0].url,
            "other.png"
        );
        assert_eq!(changed.documents_read, 1);
        changed.save();
        fs::create_dir(root.path().join("docs/new")).unwrap();
        fs::write(root.path().join("docs/new/c.md"), "new").unwrap();
        fs::remove_file(&first).unwrap();
        let updated = ProjectIndex::scan(root.path()).unwrap();
        assert!(!updated.files.contains(&first));
        assert!(updated.files.contains(&root.path().join("docs/new/c.md")));
    }
    #[test]
    fn corrupt_cache_and_project_move_rebuild_without_changing_references() {
        let parent = tempfile::tempdir().unwrap();
        let before = parent.path().join("before");
        fs::create_dir(&before).unwrap();
        fs::write(before.join("a.md"), "😀 ![image](b.png)\n```md\n<!-- screenshot:ref id=ignored -->\n```\n<!-- screenshot:ref id=shot-one -->").unwrap();
        let mut index = ProjectIndex::scan(&before).unwrap();
        let document = index.document(&before.join("a.md")).unwrap();
        assert_eq!(document.screenshots, vec!["shot-one"]);
        assert_eq!(document.images[0].start, 3);
        index.save();
        let after = parent.path().join("after");
        fs::rename(&before, &after).unwrap();
        let mut moved = ProjectIndex::scan(&after).unwrap();
        assert_eq!(
            moved.document(&after.join("a.md")).unwrap().images[0].url,
            "b.png"
        );
        fs::write(cache_path(&after, "index.json").unwrap(), b"broken").unwrap();
        let mut rebuilt = ProjectIndex::scan(&after).unwrap();
        assert_eq!(
            rebuilt.document(&after.join("a.md")).unwrap().images[0].url,
            "b.png"
        );
    }
    #[cfg(unix)]
    #[test]
    fn index_preserves_project_path_spelling_for_aliased_roots() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("project");
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("docs/page.md"), "![A](a.png)").unwrap();
        let alias = parent.path().join("alias");
        std::os::unix::fs::symlink(&root, &alias).unwrap();
        let mut index = ProjectIndex::scan(&alias).unwrap();
        assert_eq!(index.files, vec![alias.join("docs/page.md")]);
        assert_eq!(
            index.document(&index.files[0].clone()).unwrap().images[0].url,
            "a.png"
        );
    }
    #[cfg(unix)]
    #[test]
    fn cached_files_replaced_with_symlinks_are_not_read() {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let page = root.path().join("page.md");
        fs::write(&page, "![safe](a.png)").unwrap();
        let mut index = ProjectIndex::scan(root.path()).unwrap();
        index.document(&page).unwrap();
        index.save();
        fs::write(external.path().join("private.md"), "private").unwrap();
        fs::remove_file(&page).unwrap();
        std::os::unix::fs::symlink(external.path().join("private.md"), &page).unwrap();
        let mut next = ProjectIndex::scan(root.path()).unwrap();
        assert!(!next.files.contains(&page));
        assert!(next.document(&page).is_err());
    }
}
