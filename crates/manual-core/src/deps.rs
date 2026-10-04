use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use super::config::{project_path, read_config};
use super::task::{
    collect_target_markdown_files, get_code_block_ranges, is_inside_ranges, parse_page_tags,
    utc_now, PageTag,
};
use super::uimap::extract_ui_map;
use crate::analyze_directory;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ManualDependencyGraph {
    pub version: String,
    pub updated_at: String,
    pub pages: HashMap<String, PageDependencies>,
    pub symbol_to_pages: HashMap<String, Vec<String>>,
    pub ui_to_pages: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub file_to_pages: HashMap<String, Vec<String>>,
    pub task_dependencies: HashMap<String, TaskDependencies>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PageDependencies {
    pub path: String,
    pub title: String,
    pub symbols: Vec<String>,
    pub ui_elements: Vec<String>,
    #[serde(default)]
    pub files: Vec<String>,
    pub configs: Vec<String>,
    pub assets: Vec<String>,
    pub tasks: Vec<String>,
    #[serde(default)]
    pub evidence: Vec<DependencyEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DependencyEvidence {
    pub reference: String,
    pub origin: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TaskDependencies {
    pub id: String,
    pub page: String,
    pub kind: String,
    pub symbols: Vec<String>,
    pub ui_elements: Vec<String>,
    #[serde(default)]
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ImpactReport {
    pub git_ref: String,
    pub changed_files: Vec<String>,
    pub affected_symbols: Vec<String>,
    pub affected_ui_elements: Vec<String>,
    pub impacted_pages: Vec<ImpactedPage>,
    pub total_impacted_pages: usize,
    pub total_impacted_tasks: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImpactedPage {
    pub path: String,
    pub reasons: Vec<String>,
    pub impacted_tasks: Vec<String>,
    pub requires_rebuild: bool,
}

pub fn graph_path(root: &Path) -> PathBuf {
    root.join("manual").join("manual_deps.json")
}

pub fn read_dependency_graph(root: &Path) -> Option<ManualDependencyGraph> {
    let path = graph_path(root);
    if !path.is_file() {
        return None;
    }
    let content = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

#[derive(Default)]
struct DependencyHint {
    task_id: Option<String>,
    file: Option<String>,
    symbol: Option<String>,
    ui: Option<String>,
}

fn parse_dependency_hints(page: &str, content: &str) -> Result<Vec<DependencyHint>, String> {
    let hint_re = Regex::new(r"<!--\s*ai:depends(?P<attrs>[^\r\n>]*?)-->").unwrap();
    let attr_re =
        Regex::new(r#"(?:^|\s)(task|file|symbol|ui)=(?:"([^"]+)"|'([^']+)'|([^\s>]+))"#).unwrap();
    let id_re = Regex::new(r"^[a-z][a-z0-9_-]*$").unwrap();
    let code_blocks = get_code_block_ranges(content);
    let mut hints = Vec::new();

    for cap in hint_re.captures_iter(content) {
        let whole = cap.get(0).unwrap();
        if is_inside_ranges(&(whole.start()..whole.end()), &code_blocks) {
            continue;
        }
        let attrs = cap.name("attrs").unwrap().as_str();
        let mut hint = DependencyHint::default();
        let mut cursor = 0;
        for attr in attr_re.captures_iter(attrs) {
            let matched = attr.get(0).unwrap();
            if !attrs[cursor..matched.start()].trim().is_empty() {
                return Err(format!("Invalid ai:depends attribute in {page}"));
            }
            cursor = matched.end();
            let key = &attr[1];
            let value = attr
                .get(2)
                .or_else(|| attr.get(3))
                .or_else(|| attr.get(4))
                .unwrap()
                .as_str()
                .trim();
            if value.is_empty() {
                return Err(format!("Empty ai:depends {key} in {page}"));
            }
            let slot = match key {
                "task" => &mut hint.task_id,
                "file" => &mut hint.file,
                "symbol" => &mut hint.symbol,
                "ui" => &mut hint.ui,
                _ => unreachable!(),
            };
            if slot.is_some() {
                return Err(format!("Duplicate ai:depends {key} in {page}"));
            }
            *slot = Some(value.to_string());
        }
        if !attrs[cursor..].trim().is_empty() {
            return Err(format!("Invalid ai:depends attribute in {page}"));
        }
        if hint.file.is_none() && hint.symbol.is_none() && hint.ui.is_none() {
            return Err(format!("ai:depends requires file, symbol or ui in {page}"));
        }
        if let Some(id) = &hint.task_id {
            if !id_re.is_match(id) {
                return Err(format!("Invalid ai:depends task ID in {page}: {id}"));
            }
        }
        if let Some(file) = &mut hint.file {
            *file = file.replace('\\', "/");
            let path = Path::new(file);
            if path.is_absolute()
                || file.contains(':')
                || !path
                    .components()
                    .all(|part| matches!(part, Component::Normal(_)))
            {
                return Err(format!("Invalid ai:depends file in {page}: {file}"));
            }
        }
        hints.push(hint);
    }
    Ok(hints)
}

pub fn build_manual_dependency_graph(
    root: &Path,
    _docs_path: &Path,
) -> Result<ManualDependencyGraph, String> {
    let mut pages = HashMap::new();
    let mut symbol_to_pages: HashMap<String, Vec<String>> = HashMap::new();
    let mut ui_to_pages: HashMap<String, Vec<String>> = HashMap::new();
    let mut file_to_pages: HashMap<String, Vec<String>> = HashMap::new();
    let mut task_dependencies = HashMap::new();

    // 1. Collect known code symbols from AST
    let mut known_modules = HashSet::new();
    let mut known_classes = HashSet::new();
    let mut known_functions = HashSet::new();

    if let Ok(res) = analyze_directory(root) {
        for m in &res.modules {
            known_modules.insert(m.id.clone());
            for c in &m.classes {
                known_classes.insert(format!("{}.{}", m.id, c.name));
                known_classes.insert(c.name.clone());
            }
            for f in &m.functions {
                known_functions.insert(format!("{}.{}", m.id, f.name));
                known_functions.insert(f.name.clone());
            }
        }
    }

    // 2. Collect known UI elements from UI Map
    let ui_map = extract_ui_map(root);
    let mut known_ui_ids = HashMap::new(); // selector -> element name
    for v in &ui_map.views {
        for el in &v.elements {
            known_ui_ids.insert(el.selector.clone(), el.name.clone());
            known_ui_ids.insert(format!("#{}", el.id), el.name.clone());
        }
    }

    let title_re = Regex::new(r#"(?m)^#\s+(.+)$"#).unwrap();
    let asset_re = Regex::new(r#"!\[[^\]]*\]\(([^)]+)\)"#).unwrap();
    let selector_re = Regex::new(r#"#([a-zA-Z0-9_-]+)"#).unwrap();

    let config = read_config(root);
    let md_files = collect_target_markdown_files(root, &config);

    for (rel_path, file_path) in md_files {
        let Ok(content) = fs::read_to_string(&file_path) else {
            continue;
        };

        let title = title_re
            .captures(&content)
            .map(|c| c[1].trim().to_string())
            .unwrap_or_else(|| rel_path.clone());

        let mut page_symbols = HashSet::new();
        let mut page_ui = HashSet::new();
        let mut page_files = HashSet::new();
        let mut page_configs = HashSet::new();
        let mut page_assets = HashSet::new();
        let mut page_tasks = Vec::new();
        let mut evidence = Vec::new();

        // Assets
        for cap in asset_re.captures_iter(&content) {
            page_assets.insert(cap[1].to_string());
        }

        // Symbols in page content
        for mod_id in &known_modules {
            if content.contains(mod_id) {
                page_symbols.insert(mod_id.clone());
                evidence.push(DependencyEvidence {
                    reference: format!("symbol:{mod_id}"),
                    origin: "text-match".to_string(),
                    task_id: None,
                });
            }
        }
        for cls in &known_classes {
            if cls.len() >= 4 && content.contains(cls) {
                page_symbols.insert(cls.clone());
                evidence.push(DependencyEvidence {
                    reference: format!("symbol:{cls}"),
                    origin: "text-match".to_string(),
                    task_id: None,
                });
            }
        }
        for func in &known_functions {
            if func.len() >= 4 && content.contains(func) {
                page_symbols.insert(func.clone());
                evidence.push(DependencyEvidence {
                    reference: format!("symbol:{func}"),
                    origin: "text-match".to_string(),
                    task_id: None,
                });
            }
        }

        // UI in page content
        for (sel, name) in &known_ui_ids {
            if content.contains(sel) || (name.len() >= 3 && content.contains(name)) {
                page_ui.insert(sel.clone());
                evidence.push(DependencyEvidence {
                    reference: format!("ui:{sel}"),
                    origin: "text-match".to_string(),
                    task_id: None,
                });
            }
        }

        // Check tasks
        let mut ids = HashSet::new();
        if let Ok(tags) = parse_page_tags(&rel_path, &content, &mut ids) {
            for tag in tags {
                let (task_id, kind, prompt) = match tag {
                    PageTag::Task { task, .. } => (task.id, task.kind, task.prompt),
                    PageTag::Generated { task, .. } => (task.id, task.kind, task.prompt),
                };

                page_tasks.push(task_id.clone());

                let mut task_symbols = Vec::new();
                let mut task_ui = Vec::new();

                for cap_sel in selector_re.captures_iter(&prompt) {
                    let sel = format!("#{}", &cap_sel[1]);
                    task_ui.push(sel.clone());
                    page_ui.insert(sel);
                }

                for mod_id in &known_modules {
                    if prompt.contains(mod_id) {
                        task_symbols.push(mod_id.clone());
                        page_symbols.insert(mod_id.clone());
                    }
                }

                task_dependencies.insert(
                    task_id.clone(),
                    TaskDependencies {
                        id: task_id,
                        page: rel_path.clone(),
                        kind,
                        symbols: task_symbols,
                        ui_elements: task_ui,
                        files: Vec::new(),
                    },
                );
            }
        }

        for hint in parse_dependency_hints(&rel_path, &content)? {
            if let Some(task_id) = &hint.task_id {
                if !task_dependencies.contains_key(task_id)
                    || task_dependencies[task_id].page != rel_path
                {
                    return Err(format!("Unknown ai:depends task in {rel_path}: {task_id}"));
                }
            }
            if let Some(file) = hint.file {
                page_files.insert(file.clone());
                evidence.push(DependencyEvidence {
                    reference: format!("file:{file}"),
                    origin: "ai:depends".to_string(),
                    task_id: hint.task_id.clone(),
                });
                if let Some(id) = &hint.task_id {
                    task_dependencies.get_mut(id).unwrap().files.push(file);
                }
            }
            if let Some(symbol) = hint.symbol {
                page_symbols.insert(symbol.clone());
                evidence.push(DependencyEvidence {
                    reference: format!("symbol:{symbol}"),
                    origin: "ai:depends".to_string(),
                    task_id: hint.task_id.clone(),
                });
                if let Some(id) = &hint.task_id {
                    task_dependencies.get_mut(id).unwrap().symbols.push(symbol);
                }
            }
            if let Some(ui) = hint.ui {
                page_ui.insert(ui.clone());
                evidence.push(DependencyEvidence {
                    reference: format!("ui:{ui}"),
                    origin: "ai:depends".to_string(),
                    task_id: hint.task_id.clone(),
                });
                if let Some(id) = &hint.task_id {
                    task_dependencies.get_mut(id).unwrap().ui_elements.push(ui);
                }
            }
        }

        // Configs
        if content.contains("mkdocs") || content.contains("theme") {
            page_configs.insert("mkdocs.theme".to_string());
        }
        if content.contains("language") || content.contains("言語") {
            page_configs.insert("mkdocs.language".to_string());
        }

        // Inverted indexes
        for sym in &page_symbols {
            symbol_to_pages
                .entry(sym.clone())
                .or_default()
                .push(rel_path.clone());
        }
        for ui in &page_ui {
            ui_to_pages
                .entry(ui.clone())
                .or_default()
                .push(rel_path.clone());
        }
        for file in &page_files {
            file_to_pages
                .entry(file.clone())
                .or_default()
                .push(rel_path.clone());
        }

        pages.insert(
            rel_path.clone(),
            PageDependencies {
                path: rel_path,
                title,
                symbols: page_symbols.into_iter().collect(),
                ui_elements: page_ui.into_iter().collect(),
                files: page_files.into_iter().collect(),
                configs: page_configs.into_iter().collect(),
                assets: page_assets.into_iter().collect(),
                tasks: page_tasks,
                evidence,
            },
        );
    }

    let graph = ManualDependencyGraph {
        version: "1.1".to_string(),
        updated_at: utc_now(),
        pages,
        symbol_to_pages,
        ui_to_pages,
        file_to_pages,
        task_dependencies,
    };

    // Save graph
    let dest_dir = root.join("manual");
    let _ = fs::create_dir_all(&dest_dir);
    if let Ok(json) = serde_json::to_string_pretty(&graph) {
        let _ = fs::write(graph_path(root), json);
    }

    Ok(graph)
}

pub fn analyze_git_impact(root: &Path, git_ref_opt: Option<&str>) -> Result<ImpactReport, String> {
    let cfg = read_config(root);
    let docs_path = project_path(root, &cfg.docs)?;
    // The saved graph is a report, not a cache: source, docs and the UI map
    // may all have changed since it was written.
    let graph = build_manual_dependency_graph(root, &docs_path)?;

    let git_ref = git_ref_opt.unwrap_or("HEAD~1").to_string();

    // 1. Get changed files via git
    let mut changed_files = Vec::new();

    let diff_output = Command::new("git")
        .current_dir(root)
        .args(["diff", "--name-only", &git_ref])
        .output()
        .map_err(|error| format!("Failed to run git diff: {error}"))?;
    if !diff_output.status.success() {
        return Err(format!(
            "Failed to compare Git ref {git_ref}: {}",
            String::from_utf8_lossy(&diff_output.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&diff_output.stdout);
    for line in stdout.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            changed_files.push(trimmed.to_string());
        }
    }

    // Also include working tree changes (git status --porcelain)
    let status_output = Command::new("git")
        .current_dir(root)
        .args(["status", "--porcelain"])
        .output()
        .map_err(|error| format!("Failed to run git status: {error}"))?;
    if !status_output.status.success() {
        return Err(format!(
            "Failed to read Git status: {}",
            String::from_utf8_lossy(&status_output.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&status_output.stdout);
    for line in stdout.lines() {
        if line.len() >= 3 {
            let file_path = line[3..].trim();
            if !file_path.is_empty() && !changed_files.contains(&file_path.to_string()) {
                changed_files.push(file_path.to_string());
            }
        }
    }

    let mut affected_symbols = HashSet::new();
    let mut affected_ui_elements = HashSet::new();
    let mut page_impact_map: HashMap<String, (Vec<String>, HashSet<String>)> = HashMap::new();

    for file in &changed_files {
        if let Some(pages) = graph.file_to_pages.get(file) {
            for page in pages {
                let entry = page_impact_map
                    .entry(page.clone())
                    .or_insert_with(|| (Vec::new(), HashSet::new()));
                entry
                    .0
                    .push(format!("明示依存: ファイル `{file}` が変更されました"));
            }
        }
        // Python file changed
        if file.ends_with(".py") {
            let path_parts: Vec<&str> = file.trim_end_matches(".py").split('/').collect();
            let mut candidate_modules = Vec::new();
            for i in 0..path_parts.len() {
                candidate_modules.push(path_parts[i..].join("."));
            }

            for cand in candidate_modules {
                if graph.symbol_to_pages.contains_key(&cand) {
                    affected_symbols.insert(cand.clone());
                    if let Some(pages) = graph.symbol_to_pages.get(&cand) {
                        for p in pages {
                            let entry = page_impact_map
                                .entry(p.clone())
                                .or_insert_with(|| (Vec::new(), HashSet::new()));
                            entry
                                .0
                                .push(format!("コード変更: モジュール `{cand}` ({file})"));
                        }
                    }
                }
            }
        }

        // HTML / UI changed
        if (file.ends_with(".html") || file.ends_with(".ts") || file.ends_with(".vue"))
            && !file.starts_with("manual/")
            && !file.starts_with("docs/")
        {
            let mut source = fs::read_to_string(root.join(file)).unwrap_or_default();
            // Also consider selectors removed by the change.
            if let Ok(previous) = Command::new("git")
                .current_dir(root)
                .args(["show", &format!("{git_ref}:{file}")])
                .output()
            {
                if previous.status.success() {
                    source.push_str(&String::from_utf8_lossy(&previous.stdout));
                }
            }
            for (ui_sel, pages) in &graph.ui_to_pages {
                let clean_id = ui_sel.trim_start_matches('#');
                if source.contains(clean_id) {
                    affected_ui_elements.insert(ui_sel.clone());
                    for p in pages {
                        let entry = page_impact_map
                            .entry(p.clone())
                            .or_insert_with(|| (Vec::new(), HashSet::new()));
                        entry.0.push(format!(
                            "UI 変更: 要素 `{ui_sel}` が {file} で更新されました"
                        ));
                    }
                }
            }
        }
    }

    // Match affected tasks
    for (task_id, t_dep) in &graph.task_dependencies {
        let mut task_affected = false;
        for sym in &t_dep.symbols {
            if affected_symbols.contains(sym) {
                task_affected = true;
                break;
            }
        }
        if !task_affected {
            for ui in &t_dep.ui_elements {
                if affected_ui_elements.contains(ui) {
                    task_affected = true;
                    break;
                }
            }
        }
        if !task_affected {
            task_affected = t_dep.files.iter().any(|file| changed_files.contains(file));
        }

        if task_affected {
            if let Some(entry) = page_impact_map.get_mut(&t_dep.page) {
                entry.1.insert(task_id.clone());
            }
        }
    }

    let mut impacted_pages = Vec::new();
    let mut total_tasks = 0;

    for (page_path, (reasons, tasks)) in page_impact_map {
        let task_list: Vec<String> = tasks.into_iter().collect();
        total_tasks += task_list.len();
        impacted_pages.push(ImpactedPage {
            path: page_path,
            reasons,
            impacted_tasks: task_list,
            requires_rebuild: true,
        });
    }

    let total_impacted_pages = impacted_pages.len();

    Ok(ImpactReport {
        git_ref,
        changed_files,
        affected_symbols: affected_symbols.into_iter().collect(),
        affected_ui_elements: affected_ui_elements.into_iter().collect(),
        impacted_pages,
        total_impacted_pages,
        total_impacted_tasks: total_tasks,
    })
}
