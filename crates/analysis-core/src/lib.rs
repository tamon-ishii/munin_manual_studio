//! Python module analyzer core
//! High-speed Python AST parsing, dependency extraction, circular import detection, and metrics calculation.

pub mod architecture;
pub mod dependencies;
pub mod diagnostics;
mod duplicate_filter;
pub mod graph;
pub mod metrics;
pub mod mkdocs;
pub mod model;
pub mod parser;
pub mod quality;
pub mod skill;
pub mod suggestions;

use model::{
    AcyclicSiblingsRule, AnalysisConfig, AnalysisResult, ForbiddenImportRule, IndependenceRule,
    LayerRule, ProtectedRule,
};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

pub fn analyze_directory(root: &Path) -> Result<AnalysisResult, String> {
    let config = load_config(root)?;
    analyze_directory_with_config(root, &config)
}

/// Run optional third-party quality tools for an explicitly requested detailed scan.
pub fn enrich_quality(result: &mut AnalysisResult) {
    let quality = quality::collect(&result.root_path, &result.modules, None);
    metrics::apply_quality(result, quality);
}

/// Run detailed quality checks using an application-bundled jscpd executable.
pub fn enrich_quality_with_jscpd(result: &mut AnalysisResult, jscpd_path: &Path) {
    let quality = quality::collect(&result.root_path, &result.modules, Some(jscpd_path));
    metrics::apply_quality(result, quality);
}

pub fn analyze_directory_with_config(
    root: &Path,
    config: &AnalysisConfig,
) -> Result<AnalysisResult, String> {
    let (modules, analysis_errors) = parser::scan_directory_with_config(root, config)?;
    Ok(assemble_result(root, config, modules, analysis_errors))
}

/// Reparse only changed Python files, then rebuild project-wide relationships from cached modules.
/// Configuration changes and unknown paths fall back to a full scan.
pub fn analyze_directory_incremental(
    root: &Path,
    previous: &AnalysisResult,
    changed_files: &[PathBuf],
) -> Result<AnalysisResult, String> {
    if previous.root_path != root || changed_files.is_empty() {
        return analyze_directory(root);
    }
    let config = load_config(root)?;
    let paths: Vec<PathBuf> = changed_files
        .iter()
        .map(|path| {
            if path.is_absolute() {
                path.clone()
            } else {
                root.join(path)
            }
        })
        .collect();
    if paths.iter().any(|path| {
        !path.starts_with(root)
            || path.file_name().and_then(|name| name.to_str()) == Some("moduleloom.toml")
            || path.extension().and_then(|ext| ext.to_str()) != Some("py")
    }) {
        return analyze_directory_with_config(root, &config);
    }

    let mut modules = previous.modules.clone();
    let mut errors = previous.analysis_errors.clone();
    for path in &paths {
        modules.retain(|module| module.absolute_path != *path);
        let prefix = format!("{}:", path.display());
        errors.retain(|error| !error.starts_with(&prefix));
        if path.is_file() {
            match parser::parse_python_file_with_config(path, root, &config) {
                Ok(module) => modules.push(module),
                Err(error) => errors.push(format!("{}: {}", path.display(), error)),
            }
        }
    }
    modules.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(assemble_result(root, &config, modules, errors))
}

fn assemble_result(
    root: &Path,
    config: &AnalysisConfig,
    modules: Vec<model::ModuleInfo>,
    analysis_errors: Vec<String>,
) -> AnalysisResult {
    let (edges, mut cycles) = graph::build_graph(&modules);
    suggestions::annotate_cycles(&mut cycles, &modules, &edges);
    let architecture_violations =
        architecture::check_architecture(&modules, &edges, &config.architecture);
    let symbol_edges = build_symbol_edges(&modules);
    let cross_file_references = build_cross_file_reference_index(&symbol_edges);
    let package_dependencies = dependencies::scan_package_dependencies(root);
    let dependency_issues = dependencies::check_package_dependencies(root, &modules);
    let unresolved_imports = graph::collect_unresolved_imports(&modules);
    let total_loc: usize = modules.iter().map(|m| m.loc).sum();

    let mut modules = modules;
    for module in &mut modules {
        module.efferent_coupling = edges.iter().filter(|edge| edge.source == module.id).count();
        module.afferent_coupling = edges.iter().filter(|edge| edge.target == module.id).count();
        module.unresolved_imports = unresolved_imports
            .get(&module.id)
            .cloned()
            .unwrap_or_default();
        let referenced_locally: std::collections::HashSet<String> = module
            .symbol_calls
            .iter()
            .map(|call| call.callee.clone())
            .collect();
        let referenced_cross_file = cross_file_references
            .get(&module.id)
            .cloned()
            .unwrap_or_default();
        module.unused_symbol_candidates = module
            .symbols
            .iter()
            .filter(|symbol| symbol.name != "__init__" && !symbol.name.ends_with(".__init__"))
            .filter(|symbol| {
                let short_name = symbol.name.rsplit('.').next().unwrap_or(&symbol.name);
                !referenced_locally.contains(short_name)
                    && !referenced_locally.contains(&symbol.name)
                    && !referenced_cross_file.contains(&symbol.name)
            })
            .map(|symbol| symbol.name.clone())
            .collect();
    }

    let complexity = metrics::project_complexity(&modules, &edges, &cycles);

    AnalysisResult {
        root_path: root.to_path_buf(),
        modules,
        edges,
        cycles,
        total_loc,
        complexity,
        analysis_errors,
        architecture_violations,
        symbol_edges,
        package_dependencies,
        dependency_issues,
    }
}

fn build_symbol_edges(modules: &[model::ModuleInfo]) -> Vec<model::SymbolEdge> {
    let mut symbol_index: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for module in modules {
        for symbol in &module.symbols {
            let candidate = (module.id.clone(), symbol.name.clone());
            symbol_index
                .entry(symbol.name.clone())
                .or_default()
                .push(candidate.clone());
            if let Some(short_name) = symbol.name.rsplit('.').next() {
                if short_name != symbol.name {
                    symbol_index
                        .entry(short_name.to_string())
                        .or_default()
                        .push(candidate);
                }
            }
        }
    }

    let mut result = Vec::new();
    for source in modules {
        for call in &source.symbol_calls {
            let candidates = symbol_index.get(&call.callee).into_iter().flatten();
            let unique_candidates: HashSet<(String, String)> = candidates.cloned().collect();
            let unique_modules: HashSet<&str> = unique_candidates
                .iter()
                .map(|(module, _)| module.as_str())
                .collect();
            if unique_modules.len() == 1 {
                let (target_module, target_symbol) = unique_candidates.into_iter().next().unwrap();
                result.push(model::SymbolEdge {
                    source_module: source.id.clone(),
                    source_symbol: call.caller.clone(),
                    target_module,
                    target_symbol,
                    line: call.line,
                });
            }
        }
    }
    result
}

fn build_cross_file_reference_index(
    symbol_edges: &[model::SymbolEdge],
) -> HashMap<String, HashSet<String>> {
    let mut references = HashMap::new();
    for edge in symbol_edges {
        references
            .entry(edge.target_module.clone())
            .or_insert_with(HashSet::new)
            .insert(edge.target_symbol.clone());
    }
    references
}

pub fn load_config(root: &Path) -> Result<AnalysisConfig, String> {
    let config_path = root.join("moduleloom.toml");
    if !config_path.exists() {
        return Ok(AnalysisConfig::default());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read {}: {}", config_path.display(), e))?;
    let mut config = AnalysisConfig::default();
    let mut in_thresholds = false;

    for (line_number, raw_line) in content.lines().enumerate() {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            in_thresholds = &line[1..line.len() - 1] == "thresholds";
            continue;
        }
        if !in_thresholds {
            continue;
        }

        let Some((key, value)) = line.split_once('=') else {
            return Err(format!(
                "Invalid config at {}:{}",
                config_path.display(),
                line_number + 1
            ));
        };
        let parsed = value.trim().parse::<usize>().map_err(|_| {
            format!(
                "Invalid numeric value at {}:{}",
                config_path.display(),
                line_number + 1
            )
        })?;
        match key.trim() {
            "max_loc" => config.max_loc = parsed,
            "max_functions" => config.max_functions = parsed,
            "max_classes" => config.max_classes = parsed,
            "max_cyclomatic_complexity" => config.max_cyclomatic_complexity = parsed,
            _ => {}
        }
    }

    parse_architecture_config(&content, &mut config)?;
    Ok(config)
}

fn parse_architecture_config(content: &str, config: &mut AnalysisConfig) -> Result<(), String> {
    let document: toml::Value = content
        .parse()
        .map_err(|error| format!("Invalid moduleloom.toml: {error}"))?;
    let Some(architecture) = document.get("architecture") else {
        return Ok(());
    };
    config.architecture.ignore_imports = value_list(architecture.get("ignore_imports"));
    if let Some(rules) = architecture
        .get("forbidden")
        .and_then(toml::Value::as_table)
    {
        for (name, value) in rules {
            if let (Some(source), Some(target)) = (
                value.get("source").and_then(toml::Value::as_str),
                value.get("target").and_then(toml::Value::as_str),
            ) {
                config.architecture.forbidden.push(ForbiddenImportRule {
                    name: name.clone(),
                    source: source.into(),
                    target: target.into(),
                });
            }
        }
    }
    if let Some(rules) = architecture
        .get("independence")
        .and_then(toml::Value::as_table)
    {
        for (name, value) in rules {
            config.architecture.independence.push(IndependenceRule {
                name: name.clone(),
                modules: value_list(value.get("modules")),
            });
        }
    }
    if let Some(rules) = architecture.get("layers").and_then(toml::Value::as_table) {
        for (name, value) in rules {
            config.architecture.layers.push(LayerRule {
                name: name.clone(),
                layers: value_list(value.get("layers")),
                closed: value_list(value.get("closed")),
            });
        }
    }
    if let Some(rules) = architecture
        .get("protected")
        .and_then(toml::Value::as_table)
    {
        for (name, value) in rules {
            if let Some(module) = value.get("module").and_then(toml::Value::as_str) {
                config.architecture.protected.push(ProtectedRule {
                    name: name.clone(),
                    module: module.into(),
                    allowed: value_list(value.get("allowed")),
                });
            }
        }
    }
    if let Some(rules) = architecture
        .get("acyclic_siblings")
        .and_then(toml::Value::as_table)
    {
        for (name, value) in rules {
            if let Some(parent) = value.get("parent").and_then(toml::Value::as_str) {
                config
                    .architecture
                    .acyclic_siblings
                    .push(AcyclicSiblingsRule {
                        name: name.clone(),
                        parent: parent.into(),
                    });
            }
        }
    }
    Ok(())
}

fn value_list(value: Option<&toml::Value>) -> Vec<String> {
    match value {
        Some(toml::Value::Array(items)) => items
            .iter()
            .filter_map(toml::Value::as_str)
            .map(str::to_string)
            .collect(),
        Some(toml::Value::String(value)) => value
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustpython_parser::{ast, Parse};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn test_parse_sample_python() {
        let source = "import os\nfrom sys import path\n\ndef hello():\n    return 'world'\n";
        let parsed = ast::Suite::parse(source, "<embedded>");
        assert!(parsed.is_ok(), "Python parsing should succeed");
    }

    #[test]
    fn test_analyze_directory_e2e() {
        let dir = tempdir().unwrap();
        let app_dir = dir.path().join("app");
        fs::create_dir(&app_dir).unwrap();

        let mod_a = app_dir.join("a.py");
        let mod_b = app_dir.join("b.py");

        fs::write(
            &mod_a,
            "from app.b import func_b\ndef func_a():\n    pass\n",
        )
        .unwrap();
        fs::write(
            &mod_b,
            "from app.a import func_a\ndef func_b():\n    pass\n",
        )
        .unwrap();

        let res = analyze_directory(dir.path()).expect("Analysis should succeed");
        assert_eq!(res.modules.len(), 2);
        assert_eq!(
            res.cycles.len(),
            1,
            "Should detect circular import between a and b"
        );
        assert!(res.edges.iter().all(|e| e.is_circular));
    }

    #[test]
    fn test_project_config_overrides_bloat_thresholds() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("moduleloom.toml"),
            "[thresholds]\nmax_loc = 2\nmax_functions = 50\nmax_classes = 50\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("module.py"),
            "line_one = 1\nline_two = 2\nline_three = 3\n",
        )
        .unwrap();

        let res = analyze_directory(dir.path()).unwrap();
        assert!(res.modules[0].is_oversized);
        assert!(res.modules[0]
            .diagnostics
            .iter()
            .any(|d| d.rule.as_deref() == Some("module-bloat")));
    }

    #[test]
    fn test_architecture_rules_are_reported() {
        let dir = tempdir().unwrap();
        let api = dir.path().join("app/api");
        let db = dir.path().join("app/db");
        fs::create_dir_all(&api).unwrap();
        fs::create_dir_all(&db).unwrap();
        fs::write(
            dir.path().join("moduleloom.toml"),
            "[architecture.forbidden.api_db]\nsource = \"app.api\"\ntarget = \"app.db\"\n",
        )
        .unwrap();
        fs::write(api.join("routes.py"), "from app.db import models\n").unwrap();
        fs::write(db.join("models.py"), "value = 1\n").unwrap();

        let res = analyze_directory(dir.path()).unwrap();
        assert_eq!(res.architecture_violations.len(), 1);
        assert_eq!(
            res.architecture_violations[0].rule,
            "architecture-forbidden"
        );
    }

    #[test]
    fn incremental_analysis_updates_changed_modules_and_global_cycles() {
        let dir = tempdir().unwrap();
        let a = dir.path().join("a.py");
        let b = dir.path().join("b.py");
        fs::write(
            &a,
            "from __future__ import annotations\nfrom b import B\ndef use(value: B):\n    pass\n",
        )
        .unwrap();
        fs::write(&b, "from a import use\nclass B:\n    pass\n").unwrap();
        let initial = analyze_directory(dir.path()).unwrap();
        assert_eq!(initial.cycles.len(), 1);
        assert_eq!(
            initial.cycles[0].suggestion.as_ref().unwrap().kind,
            model::CycleSuggestionKind::TypeOnly
        );

        fs::write(&a, "from b import B\ndef use():\n    return B()\n").unwrap();
        let updated = analyze_directory_incremental(dir.path(), &initial, &[a.clone()]).unwrap();
        assert_eq!(
            updated.cycles[0].suggestion.as_ref().unwrap().kind,
            model::CycleSuggestionKind::Runtime
        );
        assert_eq!(updated.modules.len(), 2);

        fs::write(&b, "class B:\n    pass\n").unwrap();
        let resolved = analyze_directory_incremental(dir.path(), &updated, &[b.clone()]).unwrap();
        let full = analyze_directory(dir.path()).unwrap();
        assert!(resolved.cycles.is_empty());
        assert_eq!(resolved.edges.len(), full.edges.len());
        assert_eq!(
            resolved
                .modules
                .iter()
                .map(|module| module.loc)
                .sum::<usize>(),
            full.total_loc
        );

        let c = dir.path().join("c.py");
        fs::write(&c, "from a import use\n").unwrap();
        let added = analyze_directory_incremental(dir.path(), &resolved, &[c.clone()]).unwrap();
        assert_eq!(added.modules.len(), 3);
        fs::remove_file(&c).unwrap();
        let removed = analyze_directory_incremental(dir.path(), &added, &[c]).unwrap();
        assert_eq!(removed.modules.len(), 2);

        fs::write(
            dir.path().join("moduleloom.toml"),
            "[thresholds]\nmax_loc = 1\n",
        )
        .unwrap();
        let configured = analyze_directory_incremental(
            dir.path(),
            &removed,
            &[dir.path().join("moduleloom.toml")],
        )
        .unwrap();
        assert!(configured.modules.iter().all(|module| module.is_oversized));
    }
}
