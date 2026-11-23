//! Project-shared terminology glossary for consistent human/AI authoring and checks.
use crate::{
    capture_resources,
    config::{project_path, read_config},
    task::{get_code_block_ranges, is_inside_ranges},
};
use pulldown_cmark::{Event, Options, Parser, Tag};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write as _,
    ops::Range,
    path::Path,
};
use walkdir::WalkDir;

const GLOSSARY_PATH: &str = ".munin/glossary.json";
const MAX_TERMS: usize = 500;

fn default_version() -> u32 {
    1
}

fn default_category() -> String {
    "term".into()
}

fn default_source() -> String {
    "manual".into()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct GlossaryTerm {
    pub id: String,
    pub preferred: String,
    #[serde(default)]
    pub avoid: Vec<String>,
    #[serde(default = "default_category")]
    pub category: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub note: String,
    #[serde(default = "default_source")]
    pub source: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct GlossaryFile {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub terms: Vec<GlossaryTerm>,
}

impl Default for GlossaryFile {
    fn default() -> Self {
        Self {
            version: 1,
            terms: Vec::new(),
        }
    }
}

fn normalize_id(raw: &str, fallback_index: usize) -> String {
    let mut cleaned: String = raw
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    while cleaned.contains("--") {
        cleaned = cleaned.replace("--", "-");
    }
    let cleaned = cleaned.trim_matches('-').to_string();
    if cleaned.is_empty() {
        format!("term-{}", fallback_index + 1)
    } else if cleaned.len() > 64 {
        cleaned.chars().take(64).collect()
    } else {
        cleaned
    }
}

fn normalize_and_validate(file: &GlossaryFile) -> Result<GlossaryFile, String> {
    if file.terms.len() > MAX_TERMS {
        return Err(format!("用語集は最大{MAX_TERMS}件まで登録できます。"));
    }
    let mut used_ids = BTreeSet::new();
    let mut terms = Vec::with_capacity(file.terms.len());
    for (index, item) in file.terms.iter().enumerate() {
        let preferred = item.preferred.trim().to_string();
        if preferred.is_empty() {
            return Err("正式表記は空にできません。".into());
        }
        if preferred.chars().count() > 160 {
            return Err(format!("正式表記が長すぎます: {preferred}"));
        }
        let category = match item.category.trim() {
            "ui" | "term" | "style" => item.category.trim().to_string(),
            "" => default_category(),
            other => return Err(format!("不明なカテゴリです: {other}")),
        };
        let source = match item.source.trim() {
            "uimap" => "uimap".to_string(),
            _ => "manual".to_string(),
        };
        let note = item.note.trim().to_string();
        if note.chars().count() > 500 {
            return Err(format!("補足メモが長すぎます: {preferred}"));
        }

        let mut base_id = normalize_id(
            if item.id.trim().is_empty() {
                &preferred
            } else {
                &item.id
            },
            index,
        );
        let mut suffix = 2usize;
        while !used_ids.insert(base_id.clone()) {
            base_id = format!("{}-{}", normalize_id(&item.id, index), suffix);
            suffix += 1;
        }

        let mut seen_avoid = BTreeSet::new();
        let mut avoid = Vec::new();
        for raw in &item.avoid {
            let candidate = raw.trim();
            if candidate.is_empty() {
                continue;
            }
            if candidate.chars().count() > 160 {
                return Err(format!("NG表記が長すぎます: {candidate}"));
            }
            let same_as_preferred = if item.case_sensitive {
                candidate == preferred
            } else {
                candidate.to_lowercase() == preferred.to_lowercase()
            };
            if same_as_preferred {
                continue;
            }
            let key = if item.case_sensitive {
                candidate.to_string()
            } else {
                candidate.to_lowercase()
            };
            if seen_avoid.insert(key) {
                avoid.push(candidate.to_string());
            }
        }

        terms.push(GlossaryTerm {
            id: base_id,
            preferred,
            avoid,
            category,
            case_sensitive: item.case_sensitive,
            note,
            source,
        });
    }
    Ok(GlossaryFile { version: 1, terms })
}

pub fn load(root: &Path) -> Result<GlossaryFile, String> {
    let path = project_path(root, GLOSSARY_PATH)?;
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(GlossaryFile::default());
        }
        Err(error) => return Err(error.to_string()),
    };
    let parsed: GlossaryFile = serde_json::from_slice(&bytes)
        .map_err(|error| format!("{GLOSSARY_PATH} の形式が不正です: {error}"))?;
    normalize_and_validate(&parsed)
}

pub fn save(root: &Path, input: &GlossaryFile) -> Result<GlossaryFile, String> {
    let normalized = normalize_and_validate(input)?;
    let path = project_path(root, GLOSSARY_PATH)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(&normalized).map_err(|error| error.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().ok_or("保存先が不正です。")?)
        .map_err(|error| error.to_string())?;
    temp.write_all(&bytes).map_err(|error| error.to_string())?;
    temp.as_file().sync_all().map_err(|error| error.to_string())?;
    temp.persist(&path).map_err(|error| error.to_string())?;
    Ok(normalized)
}

pub fn query(root: &Path, search: &str, category: Option<&str>) -> Result<Value, String> {
    let file = load(root)?;
    let needle = search.trim().to_lowercase();
    let category = category.map(str::trim).filter(|c| !c.is_empty());
    let terms: Vec<&GlossaryTerm> = file
        .terms
        .iter()
        .filter(|term| category.is_none_or(|c| term.category == c))
        .filter(|term| {
            needle.is_empty()
                || term.preferred.to_lowercase().contains(&needle)
                || term.note.to_lowercase().contains(&needle)
                || term
                    .avoid
                    .iter()
                    .any(|item| item.to_lowercase().contains(&needle))
        })
        .collect();
    Ok(json!({
        "version": file.version,
        "total": file.terms.len(),
        "terms": terms
    }))
}

/// Safely add a term or merge avoid variants/note into an existing term without deleting anything.
pub fn upsert_term(
    root: &Path,
    preferred: &str,
    avoid: &[String],
    category: Option<&str>,
    note: Option<&str>,
    case_sensitive: Option<bool>,
) -> Result<Value, String> {
    let preferred_clean = preferred.trim();
    if preferred_clean.is_empty() {
        return Err("正式表記（preferred）を指定してください。".into());
    }
    let mut file = load(root)?;
    let mut updated = false;
    if let Some(existing) = file
        .terms
        .iter_mut()
        .find(|t| t.preferred.eq_ignore_ascii_case(preferred_clean) || t.preferred == preferred_clean)
    {
        for item in avoid {
            let clean = item.trim();
            if !clean.is_empty() && !existing.avoid.iter().any(|a| a == clean) {
                existing.avoid.push(clean.to_string());
            }
        }
        if let Some(cat) = category.map(str::trim).filter(|c| !c.is_empty()) {
            existing.category = cat.to_string();
        }
        if let Some(n) = note.map(str::trim).filter(|s| !s.is_empty()) {
            existing.note = n.to_string();
        }
        if let Some(cs) = case_sensitive {
            existing.case_sensitive = cs;
        }
        updated = true;
    } else {
        file.terms.push(GlossaryTerm {
            id: String::new(),
            preferred: preferred_clean.to_string(),
            avoid: avoid.to_vec(),
            category: category
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .unwrap_or("term")
                .to_string(),
            case_sensitive: case_sensitive.unwrap_or(false),
            note: note.map(str::trim).unwrap_or_default().to_string(),
            source: "manual".to_string(),
        });
    }
    let saved = save(root, &file)?;
    let term = saved
        .terms
        .iter()
        .find(|t| t.preferred == preferred_clean || t.preferred.eq_ignore_ascii_case(preferred_clean))
        .cloned();
    Ok(json!({
        "updated": updated,
        "total": saved.terms.len(),
        "term": term
    }))
}

/// Build a revision-verified batch replacement plan for all glossary violations across manuscripts.
pub fn replace_plan(root: &Path, only_page: Option<&str>) -> Result<Value, String> {
    let glossary_file = load(root)?;
    if glossary_file.terms.is_empty() {
        return Ok(json!({ "total_replacements": 0, "documents": [] }));
    }
    let config = read_config(root);
    let pages = crate::task::collect_target_markdown_files(root, &config);
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let filter_page = only_page.map(|p| p.trim().replace('\\', "/"));

    let mut documents = Vec::new();
    let mut total_replacements = 0usize;

    for (page, path) in pages {
        let rel = path
            .canonicalize()
            .ok()
            .and_then(|p| p.strip_prefix(&canonical_root).ok().map(Path::to_path_buf))
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| page.clone());
        if let Some(target) = &filter_page {
            if target != &page && target != &rel && !rel.ends_with(&format!("/{target}")) {
                continue;
            }
        }
        let Ok(doc) = crate::editor::read_raw(root, &rel) else {
            continue;
        };
        let content = &doc.content;
        let excluded = excluded_ranges(content);

        // Collect exact byte ranges + preferred replacements, preventing overlaps.
        struct Hit {
            start: usize,
            end: usize,
            line: usize,
            matched: String,
            preferred: String,
            term_id: String,
        }
        let mut hits: Vec<Hit> = Vec::new();
        for term in &glossary_file.terms {
            for avoid in &term.avoid {
                for range in find_matches(content, avoid, term.case_sensitive) {
                    if overlaps(&range, &excluded)
                        || !boundary_ok(content, &range, avoid)
                        || is_part_of_preferred(content, &range, &term.preferred, term.case_sensitive)
                    {
                        continue;
                    }
                    let line = content[..range.start]
                        .bytes()
                        .filter(|b| *b == b'\n')
                        .count()
                        + 1;
                    hits.push(Hit {
                        start: range.start,
                        end: range.end,
                        line,
                        matched: content[range.clone()].to_string(),
                        preferred: term.preferred.clone(),
                        term_id: term.id.clone(),
                    });
                }
            }
        }
        // Sort by start asc, longer match first on ties, then filter non-overlapping.
        hits.sort_by(|a, b| a.start.cmp(&b.start).then_with(|| (b.end - b.start).cmp(&(a.end - a.start))));
        let mut selected: Vec<Hit> = Vec::new();
        let mut last_end = 0usize;
        for hit in hits {
            if hit.start >= last_end {
                last_end = hit.end;
                selected.push(hit);
            }
        }
        if selected.is_empty() {
            continue;
        }
        let mut after = content.clone();
        for hit in selected.iter().rev() {
            after.replace_range(hit.start..hit.end, &hit.preferred);
        }
        if after == *content {
            continue;
        }
        total_replacements += selected.len();
        let replacements: Vec<Value> = selected
            .iter()
            .map(|h| {
                json!({
                    "line": h.line,
                    "matched": h.matched,
                    "preferred": h.preferred,
                    "term_id": h.term_id
                })
            })
            .collect();
        documents.push(json!({
            "page": doc.page,
            "revision": doc.revision,
            "before": doc.content,
            "after": after,
            "count": replacements.len(),
            "replacements": replacements
        }));
    }

    Ok(json!({
        "total_replacements": total_replacements,
        "documents": documents
    }))
}

pub fn extract_uimap_candidates(root: &Path) -> Result<Value, String> {
    let existing = load(root)?;
    let registered_names: BTreeSet<String> = existing
        .terms
        .iter()
        .map(|term| term.preferred.to_lowercase())
        .collect();

    #[derive(Default)]
    struct Acc {
        name: String,
        roles: BTreeSet<String>,
        sources: BTreeSet<String>,
        count: usize,
    }
    let mut found: BTreeMap<String, Acc> = BTreeMap::new();
    let mut scanned_images = 0usize;

    let mut scan_png = |path: &Path, label: String| {
        let Ok(bytes) = fs::read(path) else { return };
        let Some(elements) = markits::raster::extract_png_uimap(&bytes) else {
            return;
        };
        scanned_images += 1;
        for element in elements {
            let name = element.name.trim();
            if name.is_empty() || name.chars().count() < 2 || name.chars().count() > 80 {
                continue;
            }
            if name.chars().all(|c| !c.is_alphanumeric() && !is_cjk(c)) {
                continue;
            }
            let key = name.to_lowercase();
            let entry = found.entry(key).or_insert_with(|| Acc {
                name: name.to_string(),
                ..Default::default()
            });
            entry.count += 1;
            if !element.role.trim().is_empty() {
                entry.roles.insert(element.role.trim().to_string());
            }
            entry.sources.insert(label.clone());
        }
    };

    if let Ok(resources) = capture_resources::catalog(root) {
        for resource in resources {
            if let Ok(source_path) = capture_resources::source(root, &resource.id) {
                scan_png(&source_path, resource.name.clone());
            }
            for derived in &resource.derived {
                if let Ok(editing_path) = project_path(root, &derived.editing) {
                    scan_png(&editing_path, derived.path.clone());
                }
            }
        }
    }

    let config = read_config(root);
    if let Ok(assets_dir) = project_path(root, &config.assets) {
        if assets_dir.is_dir() {
            for entry in WalkDir::new(&assets_dir)
                .max_depth(4)
                .into_iter()
                .filter_map(Result::ok)
            {
                if entry.file_type().is_file()
                    && entry
                        .path()
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
                {
                    let label = entry
                        .path()
                        .strip_prefix(root)
                        .unwrap_or(entry.path())
                        .to_string_lossy()
                        .replace('\\', "/");
                    scan_png(entry.path(), label);
                }
            }
        }
    }

    let mut candidates: Vec<Value> = found
        .into_iter()
        .map(|(key, acc)| {
            json!({
                "name": acc.name,
                "roles": acc.roles.into_iter().collect::<Vec<_>>(),
                "sources": acc.sources.into_iter().take(5).collect::<Vec<_>>(),
                "count": acc.count,
                "registered": registered_names.contains(&key),
            })
        })
        .collect();
    candidates.sort_by(|a, b| {
        a["registered"]
            .as_bool()
            .cmp(&b["registered"].as_bool())
            .then_with(|| b["count"].as_u64().cmp(&a["count"].as_u64()))
            .then_with(|| {
                a["name"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(b["name"].as_str().unwrap_or(""))
            })
    });
    candidates.truncate(200);
    Ok(json!({
        "scanned_images": scanned_images,
        "candidates": candidates,
    }))
}

/// Build a compact glossary instruction block for AI authoring/proofreading prompts.
pub fn prompt_section(root: &Path, context_text: &str) -> String {
    let Ok(file) = load(root) else {
        return String::new();
    };
    if file.terms.is_empty() {
        return String::new();
    }
    let lowered = context_text.to_lowercase();
    let mut relevant = Vec::new();
    let mut general = Vec::new();
    for term in &file.terms {
        let hit = lowered.contains(&term.preferred.to_lowercase())
            || term
                .avoid
                .iter()
                .any(|item| lowered.contains(&item.to_lowercase()));
        if hit {
            relevant.push(term);
        } else {
            general.push(term);
        }
    }
    let mut selected: Vec<&GlossaryTerm> = relevant.into_iter().take(30).collect();
    if selected.len() < 30 {
        let remaining = 30 - selected.len();
        selected.extend(general.into_iter().take(remaining));
    }
    if selected.is_empty() {
        return String::new();
    }
    let mut lines = vec![
        "Project glossary (follow these preferred terms and avoid listed variants):".to_string(),
    ];
    for term in selected {
        let avoid_part = if term.avoid.is_empty() {
            String::new()
        } else {
            format!(" | avoid: {}", term.avoid.join(", "))
        };
        let note_part = if term.note.is_empty() {
            String::new()
        } else {
            format!(" | note: {}", term.note)
        };
        lines.push(format!(
            "- [{}] {}{}{}",
            term.category, term.preferred, avoid_part, note_part
        ));
    }
    lines.join("\n")
}

fn is_cjk(c: char) -> bool {
    matches!(
        c as u32,
        0x3040..=0x309F | 0x30A0..=0x30FF | 0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0xFF00..=0xFFEF
    )
}

fn is_ascii_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn excluded_ranges(content: &str) -> Vec<Range<usize>> {
    let mut ranges = get_code_block_ranges(content);
    let mut in_link_dest = false;
    for (event, range) in Parser::new_ext(content, Options::all()).into_offset_iter() {
        match event {
            Event::Code(_) | Event::Html(_) | Event::InlineHtml(_) => ranges.push(range),
            Event::Start(Tag::Link { .. } | Tag::Image { .. }) => {
                // Exclude link/image destination URLs such as `(path/to/file.md)`.
                if let Some(open_paren) = content[range.clone()].rfind("](") {
                    let url_start = range.start + open_paren + 1;
                    if url_start < range.end {
                        ranges.push(url_start..range.end);
                    }
                }
                in_link_dest = false;
            }
            _ => {
                let _ = in_link_dest;
            }
        }
    }
    ranges
}

fn overlaps(range: &Range<usize>, excluded: &[Range<usize>]) -> bool {
    is_inside_ranges(range, excluded)
        || excluded
            .iter()
            .any(|item| range.start < item.end && item.start < range.end)
}

fn find_matches(haystack: &str, needle: &str, case_sensitive: bool) -> Vec<Range<usize>> {
    if needle.is_empty() {
        return Vec::new();
    }
    let mut matches = Vec::new();
    if case_sensitive {
        for (start, matched) in haystack.match_indices(needle) {
            matches.push(start..start + matched.len());
        }
        return matches;
    }
    let needle_chars: Vec<char> = needle.to_lowercase().chars().collect();
    if needle_chars.is_empty() {
        return matches;
    }
    let indexed: Vec<(usize, char)> = haystack.char_indices().collect();
    let mut i = 0usize;
    while i + needle_chars.len() <= indexed.len() {
        let mut ok = true;
        for (offset, target) in needle_chars.iter().enumerate() {
            let ch = indexed[i + offset].1;
            let mut lower = ch.to_lowercase();
            if lower.next() != Some(*target) || lower.next().is_some() {
                ok = false;
                break;
            }
        }
        if ok {
            let start = indexed[i].0;
            let end = if i + needle_chars.len() < indexed.len() {
                indexed[i + needle_chars.len()].0
            } else {
                haystack.len()
            };
            matches.push(start..end);
            i += needle_chars.len();
        } else {
            i += 1;
        }
    }
    matches
}

fn boundary_ok(content: &str, range: &Range<usize>, term: &str) -> bool {
    let starts_ascii = term.chars().next().is_some_and(is_ascii_word);
    let ends_ascii = term.chars().last().is_some_and(is_ascii_word);
    if starts_ascii {
        if let Some(prev) = content[..range.start].chars().next_back() {
            if is_ascii_word(prev) {
                return false;
            }
        }
    }
    if ends_ascii {
        if let Some(next) = content[range.end..].chars().next() {
            if is_ascii_word(next) {
                return false;
            }
        }
    }
    true
}

fn is_part_of_preferred(content: &str, range: &Range<usize>, preferred: &str, case_sensitive: bool) -> bool {
    let pref_len = preferred.len();
    if pref_len <= range.len() {
        return false;
    }
    let search_start = content[..range.start]
        .char_indices()
        .rev()
        .take(preferred.chars().count())
        .last()
        .map(|(idx, _)| idx)
        .unwrap_or(0);
    let search_end = content[range.end..]
        .char_indices()
        .nth(preferred.chars().count())
        .map(|(idx, _)| range.end + idx)
        .unwrap_or(content.len());
    let window = &content[search_start..search_end];
    find_matches(window, preferred, case_sensitive)
        .into_iter()
        .any(|m| {
            let abs_start = search_start + m.start;
            let abs_end = search_start + m.end;
            abs_start <= range.start && abs_end >= range.end
        })
}

pub fn check_text(page: &str, content: &str, terms: &[GlossaryTerm]) -> Vec<Value> {
    if terms.is_empty() {
        return Vec::new();
    }
    let excluded = excluded_ranges(content);
    let mut issues = Vec::new();
    let mut reported_ranges: Vec<Range<usize>> = Vec::new();

    for term in terms {
        for avoid in &term.avoid {
            for range in find_matches(content, avoid, term.case_sensitive) {
                if overlaps(&range, &excluded) {
                    continue;
                }
                if !boundary_ok(content, &range, avoid) {
                    continue;
                }
                if is_part_of_preferred(content, &range, &term.preferred, term.case_sensitive) {
                    continue;
                }
                if reported_ranges
                    .iter()
                    .any(|r| r.start == range.start && r.end == range.end)
                {
                    continue;
                }
                reported_ranges.push(range.clone());
                let matched = &content[range.clone()];
                let line = content[..range.start]
                    .bytes()
                    .filter(|b| *b == b'\n')
                    .count()
                    + 1;
                let start_utf16 = content[..range.start].encode_utf16().count();
                let end_utf16 = content[..range.end].encode_utf16().count();
                let mut message = format!(
                    "用語集の表記ルール: 「{matched}」は「{}」に統一してください。",
                    term.preferred
                );
                if !term.note.is_empty() {
                    message.push_str(&format!("（{}）", term.note));
                }
                issues.push(json!({
                    "page": page,
                    "kind": "glossary_violation",
                    "severity": "warning",
                    "line": line,
                    "start": start_utf16,
                    "end": end_utf16,
                    "snippet": matched,
                    "message": message,
                    "details": {
                        "term_id": term.id,
                        "preferred": term.preferred,
                        "matched": matched,
                        "category": term.category,
                        "note": term.note
                    }
                }));
            }
        }
    }
    issues.sort_by_key(|item| item["start"].as_u64().unwrap_or(0));
    issues
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_loads_and_queries_glossary() {
        let root = tempfile::tempdir().unwrap();
        let saved = save(
            root.path(),
            &GlossaryFile {
                version: 1,
                terms: vec![GlossaryTerm {
                    id: "".into(),
                    preferred: "フォルダー".into(),
                    avoid: vec!["フォルダ".into(), "フォルダ".into(), "フォルダー".into()],
                    category: "style".into(),
                    case_sensitive: false,
                    note: "長音ありで統一".into(),
                    source: "manual".into(),
                }],
            },
        )
        .unwrap();
        assert_eq!(saved.terms.len(), 1);
        assert_eq!(saved.terms[0].avoid, vec!["フォルダ"]);
        let loaded = load(root.path()).unwrap();
        assert_eq!(loaded, saved);
        let queried = query(root.path(), "フォルダ", Some("style")).unwrap();
        assert_eq!(queried["terms"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn checks_glossary_ignoring_code_urls_and_preferred_substrings() {
        let terms = vec![
            GlossaryTerm {
                id: "folder".into(),
                preferred: "フォルダー".into(),
                avoid: vec!["フォルダ".into()],
                category: "style".into(),
                case_sensitive: false,
                note: String::new(),
                source: "manual".into(),
            },
            GlossaryTerm {
                id: "cli".into(),
                preferred: "CLI".into(),
                avoid: vec!["cli".into()],
                category: "term".into(),
                case_sensitive: true,
                note: String::new(),
                source: "manual".into(),
            },
        ];
        let md = "# 手順\n\nフォルダーを開きます。\n対象フォルダを選びます。\n\n```sh\nフォルダ cli\n```\n\n`フォルダ` と [説明](folder/フォルダ.md) と client と cli を確認。\n";
        let issues = check_text("docs/index.md", md, &terms);
        assert_eq!(issues.len(), 2, "{issues:?}");
        assert_eq!(issues[0]["snippet"], "フォルダ");
        assert_eq!(issues[0]["line"], 4);
        assert_eq!(issues[1]["snippet"], "cli");
        assert_eq!(issues[1]["line"], 10);
    }

    #[test]
    fn extracts_uimap_candidates_from_project_pngs() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs/assets")).unwrap();
        let png_path = root.path().join("docs/assets/sample.png");
        let mut buf = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(100, 80)
            .write_to(&mut buf, image::ImageFormat::Png)
            .unwrap();
        let tagged = markits::raster::embed_png_uimap(
            &buf.into_inner(),
            &[
                markits::UiElement::new("button", "撮影するアプリを登録", 10., 10., 80., 24.),
                markits::UiElement::new("button", "保存", 10., 40., 40., 24.),
            ],
        )
        .unwrap();
        fs::write(&png_path, tagged).unwrap();
        save(
            root.path(),
            &GlossaryFile {
                version: 1,
                terms: vec![GlossaryTerm {
                    id: "save".into(),
                    preferred: "保存".into(),
                    avoid: vec![],
                    category: "ui".into(),
                    case_sensitive: false,
                    note: String::new(),
                    source: "uimap".into(),
                }],
            },
        )
        .unwrap();

        let extracted = extract_uimap_candidates(root.path()).unwrap();
        assert_eq!(extracted["scanned_images"], 1);
        let candidates = extracted["candidates"].as_array().unwrap();
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0]["name"], "撮影するアプリを登録");
        assert_eq!(candidates[0]["registered"], false);
        assert_eq!(candidates[1]["name"], "保存");
        assert_eq!(candidates[1]["registered"], true);
    }

    #[test]
    fn upsert_term_merges_without_deleting_and_replace_plan_builds_safe_diffs() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs")).unwrap();
        fs::write(
            root.path().join("docs/index.md"),
            "# テスト\n\nフォルダとディレクトリを確認。\n\n```sh\nフォルダ\n```\n",
        )
        .unwrap();

        let first = upsert_term(
            root.path(),
            "フォルダー",
            &["フォルダ".into()],
            Some("style"),
            Some("長音あり"),
            Some(false),
        )
        .unwrap();
        assert_eq!(first["updated"], false);
        assert_eq!(first["total"], 1);

        let second = upsert_term(
            root.path(),
            "フォルダー",
            &["ディレクトリ".into()],
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(second["updated"], true);
        assert_eq!(second["total"], 1);
        assert_eq!(second["term"]["avoid"], json!(["フォルダ", "ディレクトリ"]));

        let plan = replace_plan(root.path(), None).unwrap();
        assert_eq!(plan["total_replacements"], 2);
        let docs = plan["documents"].as_array().unwrap();
        assert_eq!(docs.len(), 1);
        let after = docs[0]["after"].as_str().unwrap();
        assert!(after.contains("フォルダーとフォルダーを確認。"));
        assert!(after.contains("```sh\nフォルダ\n```"));
    }
}
