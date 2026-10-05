use base64::Engine;
use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use super::config::{read_config, ManualConfig};

pub fn utc_now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

pub fn source_hash(kind: &str, prompt: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{kind}\n{prompt}").as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn encode_prompt(prompt: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(prompt.as_bytes())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Task {
    pub id: String,
    pub kind: String,
    pub page: String,
    pub prompt: String,
    pub source_sha256: String,
    pub status: String, // "missing", "current", "approved", "stale"
}

pub fn get_code_block_ranges(content: &str) -> Vec<std::ops::Range<usize>> {
    let mut ranges = Vec::new();
    let mut in_fence = false;
    let mut fence_char = ' ';
    let mut fence_len = 0;
    let mut fence_start = 0;

    let mut offset = 0;
    for line in content.split_inclusive('\n') {
        let line_len = line.len();
        let line_end = offset + line_len;
        let trimmed = line.trim_start();
        let indent = line.len() - trimmed.len();

        if indent <= 3 {
            if !in_fence {
                if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                    let ch = trimmed.chars().next().unwrap();
                    let len = trimmed.chars().take_while(|&c| c == ch).count();
                    in_fence = true;
                    fence_char = ch;
                    fence_len = len;
                    fence_start = offset;
                }
            } else {
                let ch = fence_char;
                let count = trimmed.chars().take_while(|&c| c == ch).count();
                let rest = &trimmed[count..];
                if count >= fence_len && rest.trim().is_empty() {
                    ranges.push(fence_start..line_end);
                    in_fence = false;
                }
            }
        }
        offset = line_end;
    }
    if in_fence {
        ranges.push(fence_start..content.len());
    }
    ranges
}

pub fn is_inside_ranges(range: &std::ops::Range<usize>, ranges: &[std::ops::Range<usize>]) -> bool {
    // Only the opening marker determines whether a tag is an example.
    // A real generated section may itself contain fenced code.
    ranges
        .iter()
        .any(|r| range.start >= r.start && range.start < r.end)
}

pub fn get_inline_code_ranges(
    content: &str,
    fenced_ranges: &[std::ops::Range<usize>],
) -> Vec<std::ops::Range<usize>> {
    let mut ranges = Vec::new();
    let bytes = content.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if is_inside_ranges(&(i..i + 1), fenced_ranges) {
            i += 1;
            continue;
        }
        if bytes[i] == b'`' {
            let start = i;
            let mut tick_count = 0;
            while i < bytes.len() && bytes[i] == b'`' {
                tick_count += 1;
                i += 1;
            }
            let mut search = i;
            let mut found_end = None;
            while search < bytes.len() {
                if is_inside_ranges(&(search..search + 1), fenced_ranges) {
                    break;
                }
                if bytes[search] == b'`' {
                    let end_start = search;
                    let mut close_ticks = 0;
                    while search < bytes.len() && bytes[search] == b'`' {
                        close_ticks += 1;
                        search += 1;
                    }
                    if close_ticks == tick_count {
                        found_end = Some(end_start + close_ticks);
                        break;
                    }
                } else {
                    search += 1;
                }
            }
            if let Some(end) = found_end {
                ranges.push(start..end);
                i = end;
            }
        } else {
            i += 1;
        }
    }
    ranges
}

pub fn get_html_code_ranges(content: &str) -> Vec<std::ops::Range<usize>> {
    let mut ranges = Vec::new();
    let re = Regex::new(r"(?is)<(?:pre|code)\b[^>]*>.*?</(?:pre|code)>").unwrap();
    for m in re.find_iter(content) {
        ranges.push(m.start()..m.end());
    }
    ranges
}

pub fn ignored_tag_ranges(content: &str) -> Vec<std::ops::Range<usize>> {
    let mut ranges = get_code_block_ranges(content);
    let inline = get_inline_code_ranges(content, &ranges);
    ranges.extend(inline);
    ranges.extend(get_html_code_ranges(content));
    if let Ok(facts) = crate::fact::comment_ranges(content) {
        ranges.extend(facts);
    }
    ranges
}

pub fn generate_auto_id(
    kind: &str,
    page_rel: &str,
    prompt: &str,
    existing_ids: &HashSet<String>,
) -> String {
    let clean_stem: String = Path::new(page_rel)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("task")
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let clean_stem = clean_stem.trim_matches('-');
    let stem = if clean_stem.is_empty() {
        "task"
    } else {
        clean_stem
    };

    let hash = source_hash(kind, prompt);
    let short_hash = if hash.len() >= 6 { &hash[..6] } else { &hash };

    let base = format!("{kind}-{stem}-{short_hash}");
    if !existing_ids.contains(&base) {
        return base;
    }

    let mut counter = 1;
    loop {
        let candidate = format!("{base}-{counter}");
        if !existing_ids.contains(&candidate) {
            return candidate;
        }
        counter += 1;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PageTag {
    Task {
        range: std::ops::Range<usize>,
        task: Task,
    },
    Generated {
        range: std::ops::Range<usize>,
        task: Task,
        body: String,
    },
}

pub fn task_regex() -> Regex {
    Regex::new(r"(?s)<!--\s*ai:task(?P<attrs>[^\r\n>]*)\r?\n(?P<prompt>.*?)\r?\n-->")
        .expect("valid task regex")
}

/// Unified task blocks keep the instruction in a readable HTML attribute.
pub fn task_block_regex() -> Regex {
    Regex::new(r#"(?s)<!--\s*ai:task\b(?P<attrs>(?:"[^"]*"|'[^']*'|[^>"'])*)-->\r?\n?(?P<body>.*?)<!--\s*/ai:task\s*-->"#).unwrap()
}

pub fn escape_prompt(prompt: &str) -> String {
    prompt
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\r', "&#13;")
        .replace('\n', "&#10;")
}

fn decode_prompt(prompt: &str) -> String {
    prompt
        .replace("&#10;", "\n")
        .replace("&#13;", "\r")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

pub fn render_task_block(task: &Task, body: &str, created: &str, approved: Option<&str>) -> String {
    let approval = approved
        .map(|value| format!(" approved-at={value}"))
        .unwrap_or_default();
    format!("<!-- ai:task id={} kind={} prompt=\"{}\" created-at={created} source-sha256={}{approval} -->\n{}\n<!-- /ai:task -->",
        task.id, task.kind, escape_prompt(&task.prompt), task.source_sha256, body.trim())
}

pub fn generated_regex() -> Regex {
    Regex::new(
        r"(?s)<!--\s*ai:generated(?P<attrs>[^>]*)-->\r?\n(?P<body>.*?)\r?\n<!--\s*/ai:generated\s*-->",
    ).expect("valid generated regex")
}

fn validate_generated_markers(
    page_rel: &str,
    content: &str,
    code_blocks: &[std::ops::Range<usize>],
    task_ranges: &[std::ops::Range<usize>],
) -> Result<(), String> {
    let marker_re = Regex::new(r"<!--\s*(?P<close>/)?ai:generated\b[^>]*-->").unwrap();
    let mut open: Option<usize> = None;
    for marker in marker_re.find_iter(content) {
        let range = marker.start()..marker.end();
        if is_inside_ranges(&range, code_blocks) || is_inside_ranges(&range, task_ranges) {
            continue;
        }
        let is_close = marker_re
            .captures(marker.as_str())
            .and_then(|captures| captures.name("close"))
            .is_some();
        if is_close {
            if open.take().is_none() {
                return Err(format!(
                    "Unmatched ai:generated closing tag in page: {page_rel}"
                ));
            }
        } else if open.replace(marker.start()).is_some() {
            return Err(format!("Nested ai:generated tags in page: {page_rel}"));
        }
    }
    if open.is_some() {
        return Err(format!("Unclosed ai:generated tag in page: {page_rel}"));
    }
    Ok(())
}

pub fn answer_regex() -> Regex {
    Regex::new(
        r"(?s)\A<!-- ai:answer id=(?P<id>[a-z][a-z0-9_-]*) source-sha256=(?P<hash>[a-f0-9]{64}) created-at=(?P<created>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)(?: approved-at=(?P<approved>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z))? -->\n(?P<body>.*)\z",
    ).expect("valid answer regex")
}

pub fn collect_markdown_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in WalkDir::new(dir).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() && entry.path().extension().map_or(false, |ext| ext == "md")
        {
            files.push(entry.path().to_path_buf());
        }
    }
    files.sort();
    files
}

pub fn collect_target_markdown_files(root: &Path, config: &ManualConfig) -> Vec<(String, PathBuf)> {
    let mut files = Vec::new();
    let mut visited_paths = HashSet::new();
    let templates = root.join(&config.docs);

    for target in &config.targets {
        let trimmed = target.trim();
        if trimmed.is_empty() {
            continue;
        }
        let target_path = root.join(trimmed);
        if target_path.is_file() {
            if target_path.extension().map_or(false, |ext| ext == "md") {
                let canon = target_path
                    .canonicalize()
                    .unwrap_or_else(|_| target_path.clone());
                if visited_paths.insert(canon) {
                    let rel = trimmed.replace('\\', "/");
                    files.push((rel, target_path));
                }
            }
        } else if target_path.is_dir() {
            let is_docs_dir = trimmed == config.docs || target_path == templates;
            for entry in WalkDir::new(&target_path)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                if entry.file_type().is_file()
                    && entry.path().extension().map_or(false, |ext| ext == "md")
                {
                    let path = entry.path().to_path_buf();
                    let canon = path.canonicalize().unwrap_or_else(|_| path.clone());
                    if visited_paths.insert(canon) {
                        let rel = if is_docs_dir {
                            path.strip_prefix(&templates)
                                .unwrap_or(&path)
                                .to_string_lossy()
                                .replace('\\', "/")
                        } else {
                            path.strip_prefix(root)
                                .unwrap_or(&path)
                                .to_string_lossy()
                                .replace('\\', "/")
                        };
                        files.push((rel, path));
                    }
                }
            }
        }
    }

    if templates.is_dir() && !config.targets.iter().any(|t| t == &config.docs) {
        for entry in WalkDir::new(&templates).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file()
                && entry.path().extension().map_or(false, |ext| ext == "md")
            {
                let path = entry.path().to_path_buf();
                let canon = path.canonicalize().unwrap_or_else(|_| path.clone());
                if visited_paths.insert(canon) {
                    let rel = path
                        .strip_prefix(&templates)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .replace('\\', "/");
                    files.push((rel, path));
                }
            }
        }
    }

    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}

fn extract_attr<'a>(re: &Regex, s: &'a str) -> Option<&'a str> {
    let attributes =
        Regex::new(r#"(?:^|\s)[a-zA-Z][a-zA-Z0-9_-]*=(?:"[^"]*"|'[^']*'|[^\s>]+)"#).unwrap();
    for token in attributes.find_iter(s) {
        if let Some(cap) = re.captures(token.as_str()) {
            return cap
                .get(1)
                .or_else(|| cap.get(2))
                .or_else(|| cap.get(3))
                .map(|m| m.as_str());
        }
    }
    None
}

pub fn parse_page_tags(
    page_rel: &str,
    content: &str,
    existing_ids: &mut HashSet<String>,
) -> Result<Vec<PageTag>, String> {
    let code_blocks = ignored_tag_ranges(content);
    let marker_re =
        Regex::new(r#"<!--\s*(?P<close>/)?ai:task\b(?P<attrs>(?:"[^"]*"|'[^']*'|[^>"'])*)-->"#)
            .unwrap();
    let mut open: Option<(usize, usize, String)> = None;
    let mut blocks = Vec::new();
    for cap in marker_re.captures_iter(content) {
        let marker = cap.get(0).unwrap();
        if is_inside_ranges(&(marker.start()..marker.end()), &code_blocks) {
            continue;
        }
        if cap.name("close").is_some() {
            let Some((start, body_start, attrs)) = open.take() else {
                return Err(format!("Unmatched ai:task closing tag in page: {page_rel}"));
            };
            blocks.push((
                start..marker.end(),
                attrs,
                content[body_start..marker.start()].trim().to_string(),
            ));
        } else if cap.name("attrs").unwrap().as_str().split('\n').next().unwrap_or("").contains("prompt=") {
            if open.is_some() {
                return Err(format!("Nested ai:task tags in page: {page_rel}"));
            }
            open = Some((
                marker.start(),
                marker.end(),
                cap.name("attrs").unwrap().as_str().to_string(),
            ));
        } else if open.is_some() {
            return Err(format!("Nested ai:task tags in page: {page_rel}"));
        }
    }
    if open.is_some() {
        return Err(format!("Unclosed ai:task tag in page: {page_rel}"));
    }
    let t_re = task_regex();
    let g_re = generated_regex();

    let id_re = Regex::new(r#"(?:^|\s)id=(?:"([^"]+)"|'([^']+)'|([^\s>]+))"#).unwrap();
    let kind_re = Regex::new(r#"(?:^|\s)kind=(?:"([^"]+)"|'([^']+)'|([^\s>]+))"#).unwrap();
    let source_hash_re =
        Regex::new(r#"(?:^|\s)source-sha256=(?:"([a-f0-9]{64})"|'([a-f0-9]{64})'|([a-f0-9]{64}))"#)
            .unwrap();
    let prompt_re = Regex::new(
        r#"(?:^|\s)prompt-b64=(?:"([A-Za-z0-9+/=]+)"|'([A-Za-z0-9+/=]+)'|([A-Za-z0-9+/=]+))"#,
    )
    .unwrap();
    let plain_prompt_re =
        Regex::new(r#"(?:^|\s)prompt=(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#).unwrap();
    let approved_re =
        Regex::new(r#"(?:^|\s)approved-at=(?:"([^"]+)"|'([^']+)'|([^\s>]+))"#).unwrap();
    let valid_id_re = Regex::new(r#"^[a-z][a-z0-9_-]*$"#).unwrap();

    struct RawTask {
        range: std::ops::Range<usize>,
        attrs: String,
        prompt: String,
    }

    struct RawGenerated {
        range: std::ops::Range<usize>,
        attrs: String,
        body: String,
    }

    let mut raw_tasks = Vec::new();
    for cap in t_re.captures_iter(content) {
        let m = cap.get(0).unwrap();
        let range = m.start()..m.end();
        if is_inside_ranges(&range, &code_blocks) {
            continue;
        }
        if blocks
            .iter()
            .any(|(block, _, _)| range.start >= block.start && range.start < block.end)
        {
            continue;
        }
        let attrs = cap
            .name("attrs")
            .map(|a| a.as_str())
            .unwrap_or("")
            .to_string();
        let prompt = cap.name("prompt").unwrap().as_str().trim().to_string();
        if prompt.is_empty() {
            return Err(format!("Empty instruction in page: {page_rel}"));
        }
        raw_tasks.push(RawTask {
            range,
            attrs,
            prompt,
        });
    }

    validate_generated_markers(
        page_rel,
        content,
        &code_blocks,
        &raw_tasks
            .iter()
            .map(|task| task.range.clone())
            .collect::<Vec<_>>(),
    )?;

    let mut raw_gens = Vec::new();
    for cap in g_re.captures_iter(content) {
        let m = cap.get(0).unwrap();
        let range = m.start()..m.end();
        if is_inside_ranges(&range, &code_blocks) {
            continue;
        }
        let attrs = cap
            .name("attrs")
            .map(|a| a.as_str())
            .unwrap_or("")
            .to_string();
        let body = cap.name("body").unwrap().as_str().to_string();
        raw_gens.push(RawGenerated { range, attrs, body });
    }

    for (range, mut attrs, body) in blocks {
        let prompt = decode_prompt(
            extract_attr(&plain_prompt_re, &attrs)
                .ok_or_else(|| format!("Missing prompt in ai:task in page: {page_rel}"))?,
        );
        if prompt.trim().is_empty() {
            return Err(format!("Empty instruction in page: {page_rel}"));
        }
        let kind = extract_attr(&kind_re, &attrs).unwrap_or("text");
        if !matches!(kind, "text" | "screenshot" | "diagram") {
            return Err(format!("Invalid task kind: '{kind}'"));
        }
        if extract_attr(&id_re, &attrs).is_none() {
            let id = generate_auto_id(kind, page_rel, &prompt, existing_ids);
            attrs = format!(" id={id}{attrs}");
        }
        if body.is_empty() {
            raw_tasks.push(RawTask {
                range,
                attrs,
                prompt,
            });
        } else {
            raw_gens.push(RawGenerated { range, attrs, body });
        }
    }

    // An instruction immediately followed by its answer is one updateable asset.
    let mut paired_prompts: HashMap<usize, String> = HashMap::new();
    let mut paired_tasks = HashSet::new();
    for (gen_index, generated) in raw_gens.iter().enumerate() {
        let Some(gen_id) = extract_attr(&id_re, &generated.attrs) else {
            continue;
        };
        if let Some((task_index, source)) = raw_tasks.iter().enumerate().find(|(_, source)| {
            extract_attr(&id_re, &source.attrs) == Some(gen_id)
                && source.range.end <= generated.range.start
                && content[source.range.end..generated.range.start]
                    .trim()
                    .is_empty()
        }) {
            paired_prompts.insert(gen_index, source.prompt.clone());
            paired_tasks.insert(task_index);
        }
    }

    // Pass 1: Validate and register all explicit IDs
    for t in &raw_tasks {
        if let Some(id_str) = extract_attr(&id_re, &t.attrs) {
            if !valid_id_re.is_match(id_str) {
                return Err(format!(
                    "Invalid task ID: '{id_str}' (must match ^[a-z][a-z0-9_-]*$)"
                ));
            }
            if existing_ids.contains(id_str) {
                return Err(format!("Duplicate task ID: {id_str}"));
            }
            existing_ids.insert(id_str.to_string());
        }
    }
    for (gen_index, g) in raw_gens.iter().enumerate() {
        if let Some(id_str) = extract_attr(&id_re, &g.attrs) {
            if !valid_id_re.is_match(id_str) {
                return Err(format!(
                    "Invalid task ID: '{id_str}' (must match ^[a-z][a-z0-9_-]*$)"
                ));
            }
            if existing_ids.contains(id_str) && !paired_prompts.contains_key(&gen_index) {
                return Err(format!("Duplicate task ID: {id_str}"));
            }
            existing_ids.insert(id_str.to_string());
        } else {
            return Err(format!("Missing id in ai:generated in page: {page_rel}"));
        }
    }

    let mut tags = Vec::new();

    // Pass 2: Build Task objects, assigning auto IDs where omitted
    for (task_index, t) in raw_tasks.into_iter().enumerate() {
        if paired_tasks.contains(&task_index) {
            continue;
        }
        let kind = if let Some(k) = extract_attr(&kind_re, &t.attrs) {
            if k != "text" && k != "screenshot" && k != "diagram" {
                return Err(format!(
                    "Invalid task kind: '{k}' (must be text, screenshot, or diagram)"
                ));
            }
            k.to_string()
        } else {
            "text".to_string()
        };

        let task_id = if let Some(id_str) = extract_attr(&id_re, &t.attrs) {
            id_str.to_string()
        } else {
            let auto = generate_auto_id(&kind, page_rel, &t.prompt, existing_ids);
            existing_ids.insert(auto.clone());
            auto
        };

        let hash = source_hash(&kind, &t.prompt);
        let task = Task {
            id: task_id,
            kind,
            page: page_rel.to_string(),
            prompt: t.prompt,
            source_sha256: hash,
            status: "missing".to_string(),
        };
        tags.push(PageTag::Task {
            range: t.range,
            task,
        });
    }

    // Pass 3: Build Generated objects
    for (gen_index, g) in raw_gens.into_iter().enumerate() {
        let id_str = extract_attr(&id_re, &g.attrs).unwrap().to_string();
        let kind = if let Some(k) = extract_attr(&kind_re, &g.attrs) {
            k.to_string()
        } else {
            "text".to_string()
        };
        let approved = approved_re.is_match(&g.attrs);
        let hash = extract_attr(&source_hash_re, &g.attrs)
            .unwrap_or_default()
            .to_string();
        let prompt = if let Some(source_prompt) = paired_prompts.get(&gen_index) {
            source_prompt.clone()
        } else if let Some(plain) = extract_attr(&plain_prompt_re, &g.attrs) {
            decode_prompt(plain)
        } else if let Some(encoded) = extract_attr(&prompt_re, &g.attrs) {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|e| format!("Invalid prompt-b64 in page {page_rel}: {e}"))?;
            String::from_utf8(bytes)
                .map_err(|e| format!("Invalid prompt-b64 in page {page_rel}: {e}"))?
        } else {
            format!("AI生成コンテンツ ({kind})")
        };

        let current_hash = source_hash(&kind, &prompt);
        let status = if approved {
            "approved".to_string()
        } else if !hash.is_empty() && hash != current_hash {
            "stale".to_string()
        } else {
            "current".to_string()
        };
        let task = Task {
            id: id_str,
            kind: kind.clone(),
            page: page_rel.to_string(),
            prompt,
            source_sha256: current_hash,
            status,
        };
        tags.push(PageTag::Generated {
            range: g.range,
            task,
            body: g.body,
        });
    }

    tags.sort_by_key(|t| match t {
        PageTag::Task { range, .. } => range.start,
        PageTag::Generated { range, .. } => range.start,
    });

    Ok(tags)
}

pub fn tasks_for_config(root: &Path, config: &ManualConfig) -> Result<Vec<Task>, String> {
    let mut found = Vec::new();
    let mut ids = HashSet::new();

    for (page_rel, page_path) in collect_target_markdown_files(root, config) {
        let content = fs::read_to_string(&page_path).map_err(|e| e.to_string())?;
        let tags = parse_page_tags(&page_rel, &content, &mut ids)?;
        for tag in tags {
            match tag {
                PageTag::Task { task, .. } => found.push(task),
                PageTag::Generated { task, .. } => found.push(task),
            }
        }
    }
    Ok(found)
}

/// Read AI tasks from one Markdown page, even when the page is not a configured target.
/// The returned page path is relative to the docs directory when the file lives there,
/// and project-relative otherwise, matching the paths used by task updates.
pub fn tasks_for_page(root: &Path, page: &str) -> Result<Vec<Task>, String> {
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let path = super::editor::document_path(root, page)?;
    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let config = read_config(root);
    let docs = super::config::project_path(root, &config.docs)?;
    let page_rel = path
        .strip_prefix(&docs)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .or_else(|_| {
            path.strip_prefix(&canonical_root)
                .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        })
        .map_err(|error| error.to_string())?;
    let mut ids = HashSet::new();
    parse_page_tags(&page_rel, &content, &mut ids).map(|tags| {
        tags.into_iter()
            .map(|tag| match tag {
                PageTag::Task { task, .. } | PageTag::Generated { task, .. } => task,
            })
            .collect()
    })
}

pub fn tasks(templates: &Path) -> Result<Vec<Task>, String> {
    if let Some(parent) = templates.parent() {
        if parent.join("manual_setting.json").is_file()
            || parent.join("manual").join("config.json").is_file()
        {
            let config = read_config(parent);
            return tasks_for_config(parent, &config);
        }
    }
    if !templates.is_dir() {
        return Err(format!(
            "Template directory is missing: {}",
            templates.display()
        ));
    }
    let mut found = Vec::new();
    let mut ids = HashSet::new();

    for page in collect_markdown_files(templates) {
        let content = fs::read_to_string(&page).map_err(|e| e.to_string())?;
        let page_rel = page
            .strip_prefix(templates)
            .unwrap_or(&page)
            .to_string_lossy()
            .replace('\\', "/");

        let tags = parse_page_tags(&page_rel, &content, &mut ids)?;
        for tag in tags {
            match tag {
                PageTag::Task { task, .. } => found.push(task),
                PageTag::Generated { task, .. } => found.push(task),
            }
        }
    }
    Ok(found)
}

pub fn read_answer(path: &Path, task: &Task) -> Result<(String, String, Option<String>), String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let a_re = answer_regex();
    let cap = a_re
        .captures(&content)
        .ok_or_else(|| format!("Invalid answer header: {}", path.display()))?;

    let id = cap.name("id").unwrap().as_str();
    if id != task.id {
        return Err(format!("Invalid answer header: {}", path.display()));
    }
    let hash = cap.name("hash").unwrap().as_str();
    if hash != task.source_sha256 {
        return Err(format!(
            "Stale answer for {}; record it again after reviewing the instruction",
            task.id
        ));
    }
    let body = cap.name("body").unwrap().as_str().trim();
    if body.is_empty() {
        return Err(format!("Empty answer: {}", path.display()));
    }
    let created = cap.name("created").unwrap().as_str().to_string();
    let approved = cap.name("approved").map(|a| a.as_str().to_string());
    Ok((created, body.to_string(), approved))
}

pub fn scan_entries(templates: &Path, generated: &Path) -> Vec<Task> {
    if !templates.is_dir() {
        return Vec::new();
    }
    let mut entries = match tasks(templates) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    for task in &mut entries {
        if task.status == "approved" || task.status == "current" {
            continue;
        }
        let answer_path = generated.join("answers").join(format!("{}.md", task.id));
        if !answer_path.exists() {
            if task.status != "stale" {
                task.status = "missing".to_string();
            }
        } else {
            match read_answer(&answer_path, task) {
                Ok((_, _, approved)) => {
                    task.status = if approved.is_some() {
                        "approved".to_string()
                    } else {
                        "current".to_string()
                    };
                }
                Err(_) => {
                    task.status = "stale".to_string();
                }
            }
        }
    }
    entries
}

pub fn find_task(templates: &Path, task_id: &str) -> Result<Task, String> {
    let all = tasks(templates)?;
    all.into_iter()
        .find(|t| t.id == task_id)
        .ok_or_else(|| format!("Unknown task ID: {task_id}"))
}

pub fn update_task_prompt(templates: &Path, task_id: &str, prompt: &str) -> Result<(), String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(
            "Task instruction must be nonempty".to_string(),
        );
    }
    let task = find_task(templates, task_id)?;
    let page_path = if templates.join(&task.page).is_file() {
        templates.join(&task.page)
    } else {
        templates.parent().unwrap_or(templates).join(&task.page)
    };
    let content = fs::read_to_string(&page_path).map_err(|e| e.to_string())?;
    let mut ids = HashSet::new();
    let tags = parse_page_tags(&task.page, &content, &mut ids)?;
    for tag in &tags {
        let (range, current) = match tag {
            PageTag::Task { range, task } | PageTag::Generated { range, task, .. } => (range, task),
        };
        if current.id != task_id {
            continue;
        }
        let old = &content[range.clone()];
        if let Some(cap) = task_block_regex().captures(old) {
            let attr_re = Regex::new(r#"(?:^|\s)prompt=(?:"[^"]*"|'[^']*'|[^\s>]+)"#).unwrap();
            let attrs = cap.name("attrs").unwrap();
            let next = attr_re.replace(attrs.as_str(), |_: &regex::Captures| {
                format!(" prompt=\"{}\"", escape_prompt(prompt))
            });
            let replacement = format!("{}{}{}", &old[..attrs.start()], next, &old[attrs.end()..]);
            let updated = format!(
                "{}{}{}",
                &content[..range.start],
                replacement,
                &content[range.end..]
            );
            return fs::write(&page_path, updated).map_err(|e| e.to_string());
        }
    }
    if prompt.contains("<!--") || prompt.contains("-->") {
        return Err("Legacy task instruction cannot contain HTML comment markers".to_string());
    }
    let code_blocks = ignored_tag_ranges(&content);
    let id_re = Regex::new(r#"(?:^|\s)id=(?:"([^"]+)"|'([^']+)'|([^\s>]+))"#).unwrap();
    let mut matches = Vec::new();
    for cap in task_regex().captures_iter(&content) {
        let whole = cap.get(0).unwrap();
        if is_inside_ranges(&(whole.start()..whole.end()), &code_blocks) {
            continue;
        }
        let attrs = cap.name("attrs").unwrap().as_str();
        let explicit_id = extract_attr(&id_re, attrs);
        let old_prompt = cap.name("prompt").unwrap().as_str().trim();
        if explicit_id == Some(task_id) || (explicit_id.is_none() && old_prompt == task.prompt) {
            matches.push((whole.start(), whole.end(), attrs.to_string()));
        }
    }
    if matches.len() != 1 {
        return Err(format!(
            "Expected one ai:task instruction for {task_id}; found {}",
            matches.len()
        ));
    }
    let (start, end, attrs) = matches.pop().unwrap();
    let attrs = if extract_attr(&id_re, &attrs).is_some() {
        attrs
    } else {
        format!(" id={task_id}{attrs}")
    };
    let replacement = format!("<!-- ai:task{attrs}\n{prompt}\n-->");
    let mut updated = String::with_capacity(content.len() + replacement.len());
    updated.push_str(&content[..start]);
    updated.push_str(&replacement);
    updated.push_str(&content[end..]);
    fs::write(&page_path, updated).map_err(|e| e.to_string())
}

pub fn extract_single_task_block(content: &str, target_id: &str) -> Result<Option<String>, String> {
    let ignored = ignored_tag_ranges(content);
    let task_re = Regex::new(
        r#"(?s)<!--\s*ai:(?:task|generated)\b(?P<attrs>(?:"[^"]*"|'[^']*'|[^>"'])*)-->\r?\n?(?P<body>.*?)<!--\s*/ai:(?:task|generated)\s*-->"#
    ).unwrap();
    let id_re = Regex::new(r#"(?:^|\s)id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#).unwrap();

    let mut matches = Vec::new();
    for cap in task_re.captures_iter(content) {
        let whole = cap.get(0).unwrap();
        if is_inside_ranges(&(whole.start()..whole.end()), &ignored) {
            continue;
        }
        let attrs = cap.name("attrs").unwrap().as_str();
        let explicit_id = id_re.captures(attrs).and_then(|c| {
            c.get(1).or_else(|| c.get(2)).or_else(|| c.get(3)).map(|m| m.as_str())
        });
        if explicit_id == Some(target_id) {
            let body = cap.name("body").unwrap().as_str();
            matches.push(body.to_string());
        }
    }

    if matches.len() > 1 {
        return Err("AI returned multiple task/generated sections. Return only the requested task's Markdown body; existing document content was preserved.".into());
    }
    if matches.len() == 1 {
        return Ok(Some(matches.into_iter().next().unwrap()));
    }
    Ok(None)
}

pub fn strip_outer_markdown_fence(s: &str) -> String {
    let trimmed = s.trim();
    if (trimmed.starts_with("```markdown")
        || trimmed.starts_with("```md")
        || trimmed.starts_with("```\n")
        || trimmed.starts_with("```\r\n")
        || trimmed == "```")
        && trimmed.ends_with("```")
    {
        let lines: Vec<&str> = trimmed.lines().collect();
        if lines.len() >= 2 && lines.last().map_or(false, |l| l.trim() == "```") {
            return lines[1..lines.len() - 1].join("\n").trim().to_string();
        }
    }
    trimmed.to_string()
}

pub fn clean_generated_body(body: &str) -> String {
    let mut cleaned = body.trim().to_string();
    let gen_wrap = Regex::new(
        r"(?s)\A<!--\s*ai:generated\b[^>]*-->\r?\n?(?P<body>.*?)\r?\n?<!--\s*/ai:generated\s*-->\z",
    )
    .unwrap();
    let task_wrap =
        Regex::new(r"(?s)\A<!--\s*ai:task\b[^\r\n]*\r?\n?(?P<body>.*?)\r?\n?-->\z").unwrap();
    let leading_task = Regex::new(r"(?s)\A<!--\s*ai:task\b.*?-->\r?\n?").unwrap();
    let trailing_task = Regex::new(r"(?s)\r?\n?<!--\s*/ai:task\s*-->\z").unwrap();
    let leading_gen = Regex::new(r"(?s)\A<!--\s*ai:generated\b[^>]*-->\r?\n?").unwrap();
    let trailing_gen = Regex::new(r"(?s)\r?\n?<!--\s*/ai:generated\s*-->\z").unwrap();

    loop {
        let stripped_fence = strip_outer_markdown_fence(&cleaned);
        if stripped_fence != cleaned {
            cleaned = stripped_fence;
            continue;
        }
        if let Some(caps) = task_block_regex().captures(&cleaned) {
            if caps.get(0).unwrap().as_str() == cleaned {
                cleaned = caps.name("body").unwrap().as_str().trim().to_string();
                continue;
            }
        }
        if let Some(caps) = gen_wrap.captures(&cleaned) {
            cleaned = caps.name("body").unwrap().as_str().trim().to_string();
            continue;
        }
        if let Some(caps) = task_wrap.captures(&cleaned) {
            cleaned = caps.name("body").unwrap().as_str().trim().to_string();
            continue;
        }
        if let Some(m) = leading_task.find(&cleaned) {
            cleaned = cleaned[m.end()..].trim().to_string();
            continue;
        }
        if let Some(m) = trailing_task.find(&cleaned) {
            cleaned = cleaned[..m.start()].trim().to_string();
            continue;
        }
        if let Some(m) = leading_gen.find(&cleaned) {
            cleaned = cleaned[m.end()..].trim().to_string();
            continue;
        }
        if let Some(m) = trailing_gen.find(&cleaned) {
            cleaned = cleaned[..m.start()].trim().to_string();
            continue;
        }
        break;
    }
    cleaned
}

pub fn update_task_in_docs(
    templates: &Path,
    task: &Task,
    body: &str,
    approved: Option<&str>,
) -> Result<(), String> {
    let page_path = if templates.join(&task.page).is_file() {
        templates.join(&task.page)
    } else if let Some(parent) = templates.parent() {
        if parent.join(&task.page).is_file() {
            parent.join(&task.page)
        } else {
            templates.join(&task.page)
        }
    } else {
        templates.join(&task.page)
    };
    if !page_path.is_file() {
        return Err(format!("Page file not found: {}", page_path.display()));
    }
    let content = fs::read_to_string(&page_path).map_err(|e| e.to_string())?;
    let task_id = &task.id;
    let created = utc_now();
    let clean_body = clean_generated_body(body);
    let replacement = render_task_block(task, &clean_body, &created, approved);

    let page_rel = task.page.replace('\\', "/");
    let mut ids = HashSet::new();
    let tags = parse_page_tags(&page_rel, &content, &mut ids)?;

    if let Some(target_tag) = tags.iter().find(|t| {
        matches!(t,
            PageTag::Generated { task: t, .. } if t.id == *task_id
        )
    }) {
        let range = match target_tag {
            PageTag::Generated { range, .. } => range,
            PageTag::Task { .. } => unreachable!(),
        };
        let mut new_content = String::with_capacity(content.len() + replacement.len());
        let mut start = range.start;
        let id_re = Regex::new(r#"(?:^|\s)id=(?:"([^"]+)"|'([^']+)'|([^\s>]+))"#).unwrap();
        for cap in task_regex().captures_iter(&content[..range.start]) {
            let source = cap.get(0).unwrap();
            if extract_attr(&id_re, cap.name("attrs").unwrap().as_str()) == Some(task_id)
                && content[source.end()..range.start].trim().is_empty()
            {
                start = source.start();
            }
        }
        new_content.push_str(&content[..start]);
        new_content.push_str(&replacement);
        new_content.push_str(&content[range.end..]);
        fs::write(&page_path, new_content.as_bytes()).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if let Some(PageTag::Task { range, .. }) = tags.iter().find(|t| {
        matches!(t,
            PageTag::Task { task: t, .. } if t.id == *task_id
        )
    }) {
        let mut new_content = String::with_capacity(content.len() + replacement.len());
        new_content.push_str(&content[..range.start]);
        new_content.push_str(&replacement);
        new_content.push_str(&content[range.end..]);
        fs::write(&page_path, new_content.as_bytes()).map_err(|e| e.to_string())?;
        return Ok(());
    }

    Err(format!(
        "AI task {task_id} is no longer present in {}; reload the document before generating",
        task.page
    ))
}

pub fn save_answer(generated: &Path, task: &Task, body: &str) -> Result<(), String> {
    let clean_body = clean_generated_body(body);
    let body = clean_body.trim();
    if body.is_empty() {
        return Err("Answer body is empty".to_string());
    }
    let dest = generated.join("answers").join(format!("{}.md", task.id));
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let header = format!(
        "<!-- ai:answer id={} source-sha256={} created-at={} -->\n",
        task.id,
        task.source_sha256,
        utc_now(),
    );
    fs::write(&dest, format!("{header}{body}\n")).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn approve_task(templates: &Path, generated: &Path, task_id: &str) -> Result<(), String> {
    let task = find_task(templates, task_id)?;
    let page_path = templates.join(&task.page);
    let content = fs::read_to_string(&page_path).map_err(|e| e.to_string())?;
    let now = utc_now();

    let page_rel = task.page.replace('\\', "/");
    let mut ids = HashSet::new();
    let tags = parse_page_tags(&page_rel, &content, &mut ids)?;

    if let Some(target_tag) = tags.iter().find(|t| match t {
        PageTag::Generated { task: t, .. } => t.id == task_id,
        _ => false,
    }) {
        if let PageTag::Generated { range, .. } = target_tag {
            let old_block = &content[range.start..range.end];
            let header_end = old_block.find("-->").ok_or("Missing task header")?;
            let header = &old_block[..header_end];
            let re_attr = Regex::new(r#"\s+approved-at=(?:"[^"]*"|'[^']*'|[^\s>]+)"#).unwrap();
            let tokens =
                Regex::new(r#"(?:^|\s)[a-zA-Z][a-zA-Z0-9_-]*=(?:"[^"]*"|'[^']*'|[^\s>]+)"#)
                    .unwrap();
            let header = tokens.replace_all(header, |cap: &regex::Captures| {
                let token = cap.get(0).unwrap().as_str();
                if re_attr.is_match(token) {
                    String::new()
                } else {
                    token.to_string()
                }
            });
            let replacement = format!(
                "{} approved-at={now} {}",
                header.trim_end(),
                &old_block[header_end..]
            );
            let updated = format!(
                "{}{}{}",
                &content[..range.start],
                replacement,
                &content[range.end..]
            );
            fs::write(&page_path, updated).map_err(|e| e.to_string())?;
        }
    }

    let answer_path = generated.join("answers").join(format!("{task_id}.md"));
    if answer_path.is_file() {
        if let Ok((created, body, _)) = read_answer(&answer_path, &task) {
            let new_ans = format!(
                "<!-- ai:answer id={task_id} source-sha256={} created-at={created} approved-at={now} -->\n{body}\n",
                task.source_sha256
            );
            let _ = fs::write(&answer_path, new_ans);
        }
    }

    Ok(())
}

#[cfg(test)]
mod approval_regressions {
    use super::*;

    #[test]
    fn quoted_metadata_preserves_prompt_and_approval_over_hash_mismatch() {
        use base64::Engine;
        for kind in ["text", "diagram", "screenshot"] {
            let prompt = "この指示文は変更しない";
            let encoded = base64::engine::general_purpose::STANDARD.encode(prompt);
            let content = format!("<!-- ai:generated id=confirmed kind={kind} prompt-b64=\"{encoded}\" source-sha256=\"{}\" approved-at=\"2026-10-05T12:00:00.000Z\" -->\n確定済み本文\n<!-- /ai:generated -->", "0".repeat(64));
            let tags = parse_page_tags("index.md", &content, &mut HashSet::new()).unwrap();
            let PageTag::Generated { task, .. } = &tags[0] else {
                panic!("generated tag expected")
            };
            assert_eq!(task.prompt, prompt);
            assert_eq!(task.status, "approved");
            let unapproved = content.replace(" approved-at=\"2026-10-05T12:00:00.000Z\"", "");
            let tags = parse_page_tags("index.md", &unapproved, &mut HashSet::new()).unwrap();
            let PageTag::Generated { task, .. } = &tags[0] else {
                panic!("generated tag expected")
            };
            assert_eq!(task.status, "stale");
        }
    }
}

#[cfg(all(test, unix))]
mod path_regressions {
    use super::*;
    #[test]
    fn page_tasks_accepts_an_aliased_project_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(
            root.join("Readme.md"),
            "<!-- ai:task id=readme-task kind=text\nDescribe\n-->\n",
        )
        .unwrap();
        let alias = temp.path().join("project-alias");
        std::os::unix::fs::symlink(&root, &alias).unwrap();
        let tasks = tasks_for_page(&alias, "Readme.md").unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].page, "Readme.md");
    }
}

#[cfg(test)]
mod replacement_regressions {
    use super::*;
    #[test]
    fn repeated_generation_replaces_the_answer_and_keeps_manual_text() {
        let temp = tempfile::tempdir().unwrap();
        let docs = temp.path().join("docs");
        fs::create_dir_all(&docs).unwrap();
        let page = docs.join("index.md");
        let original = "# Manual intro\n\n<!-- ai:task id=guide kind=text\nExplain\n-->\n\nKeep this manual note.\n";
        fs::write(&page, original).unwrap();
        for number in 1..=3 {
            let task = find_task(&docs, "guide").unwrap();
            update_task_in_docs(
                &docs,
                &task,
                &format!("Answer version {number}\n\n```sh\nmunin --help\n```"),
                None,
            )
            .unwrap();
            let saved = fs::read_to_string(&page).unwrap();
            assert_eq!(saved.matches("<!-- /ai:task -->").count(), 1);
            assert_eq!(saved.matches("Answer version ").count(), 1);
            assert!(saved.contains(&format!("Answer version {number}")));
            assert!(saved.starts_with("# Manual intro"));
            assert!(saved.contains("Keep this manual note."));
            assert_eq!(saved.matches("<!-- ai:task id=guide ").count(), 1);
        }
        let mut stale_task = find_task(&docs, "guide").unwrap();
        stale_task.id = "deleted-task".into();
        let before = fs::read(&page).unwrap();
        assert!(update_task_in_docs(&docs, &stale_task, "Unwanted duplicate", None).is_err());
        assert_eq!(fs::read(&page).unwrap(), before);
    }
}

#[cfg(test)]
mod unified_task_tests {
    use super::*;
    fn parse(content: &str) -> Result<Vec<PageTag>, String> {
        parse_page_tags("index.md", content, &mut HashSet::new())
    }
    #[test]
    fn unified_instruction_body_and_metadata_round_trip() {
        let temp = tempfile::tempdir().unwrap();
        let page = temp.path().join("index.md");
        fs::write(&page, "# Before\n\n<!-- ai:task id=guide kind=text prompt=\"初心者向け &quot;保存&quot;&#10;approved-at=fake を説明\" -->\n\n<!-- /ai:task -->\n\nKeep me").unwrap();
        let task = find_task(temp.path(), "guide").unwrap();
        assert_eq!(task.status, "missing");
        assert_eq!(task.prompt, "初心者向け \"保存\"\napproved-at=fake を説明");
        let body = "本文\n\n```mermaid\ngraph TD\n A --> B\n```";
        update_task_in_docs(temp.path(), &task, body, None).unwrap();
        let task = find_task(temp.path(), "guide").unwrap();
        assert_eq!(task.status, "current");
        approve_task(temp.path(), &temp.path().join("ai"), "guide").unwrap();
        let approved = find_task(temp.path(), "guide").unwrap();
        assert_eq!(approved.prompt, task.prompt);
        assert_eq!(approved.status, "approved");
        update_task_in_docs(temp.path(), &approved, body, None).unwrap();
        let saved = fs::read_to_string(&page).unwrap();
        assert!(!saved.contains("ai:generated"));
        assert!(saved.contains(body));
        assert!(saved.ends_with("Keep me"));
        update_task_prompt(temp.path(), "guide", "新しい指示\n二行目 & \"引用\"").unwrap();
        let task = find_task(temp.path(), "guide").unwrap();
        assert_eq!(task.status, "stale");
        assert_eq!(task.prompt, "新しい指示\n二行目 & \"引用\"");
        assert!(fs::read_to_string(&page).unwrap().contains(body));
        approve_task(temp.path(), &temp.path().join("ai"), "guide").unwrap();
        assert_eq!(find_task(temp.path(), "guide").unwrap().status, "approved");
    }
    #[test]
    fn unified_blocks_validate_structure_and_ignore_fenced_examples() {
        for content in [
            "<!-- ai:task id=x prompt=\"説明\" -->\n本文",
            "<!-- /ai:task -->",
            "<!-- ai:task id=x prompt=\"説明\" --><!-- ai:task id=y prompt=\"説明\" --><!-- /ai:task --><!-- /ai:task -->",
            "<!-- ai:task id=x prompt=\"\" --><!-- /ai:task -->",
            "<!-- ai:task id=x kind=invalid prompt=\"説明\" --><!-- /ai:task -->",
            "<!-- ai:task id=x prompt=\"説明\" --><!-- /ai:task -->\n<!-- ai:task id=x prompt=\"説明\" --><!-- /ai:task -->",
        ] { assert!(parse(content).is_err(), "{content}"); }
        assert!(parse(
            "```html\n<!-- ai:task id=x prompt=\"説明\" -->\n本文\n<!-- /ai:task -->\n```"
        )
        .unwrap()
        .is_empty());
        let parsed =
            parse("<!-- ai:task id=x prompt=\"説明 > 補足\" -->\n編集済み本文\n<!-- /ai:task -->")
                .unwrap();
        let PageTag::Generated { task, body, .. } = &parsed[0] else {
            panic!()
        };
        assert_eq!(task.prompt, "説明 > 補足");
        assert_eq!(body, "編集済み本文");
    }
    #[test]
    fn closing_markers_in_code_examples_do_not_truncate_the_body() {
        let body = "Example:\n```html\n<!-- ai:task id=example prompt=\"説明\" -->\n本文\n<!-- /ai:task -->\n```\nAfter example";
        let content =
            format!("<!-- ai:task id=guide prompt=\"説明\" -->\n{body}\n<!-- /ai:task -->");
        let tags = parse(&content).unwrap();
        assert_eq!(tags.len(), 1);
        let PageTag::Generated {
            body: parsed_body, ..
        } = &tags[0]
        else {
            panic!()
        };
        assert_eq!(parsed_body, body);
    }
    #[test]
    fn legacy_pair_migrates_without_duplicate_instruction() {
        let temp = tempfile::tempdir().unwrap();
        let page = temp.path().join("index.md");
        fs::write(&page, "<!-- ai:task id=guide kind=text\n説明\n-->\n\n<!-- ai:generated id=guide kind=text -->\n旧本文\n<!-- /ai:generated -->\nKeep").unwrap();
        let task = find_task(temp.path(), "guide").unwrap();
        update_task_in_docs(temp.path(), &task, "新本文", None).unwrap();
        let saved = fs::read_to_string(page).unwrap();
        assert_eq!(saved.matches("<!-- ai:task ").count(), 1);
        assert!(!saved.contains("ai:generated"));
        assert!(saved.contains("prompt=\"説明\""));
        assert_eq!(parse(&saved).unwrap().len(), 1);
    }
}
