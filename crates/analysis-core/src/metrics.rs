use crate::duplicate_filter::{actionable_lines, enrich_duplicate_blocks, is_generated_file};
use crate::model::*;
use crate::quality::{FunctionMetric, QualityData};
use std::collections::{HashMap, HashSet};
use std::fs;

const DUPLICATE_WINDOW: usize = 6;

pub fn project_complexity(
    modules: &[ModuleInfo],
    edges: &[DependencyEdge],
    cycles: &[CircularCycle],
) -> ComplexitySummary {
    if modules.is_empty() {
        return ComplexitySummary::default();
    }

    let (duplicated, mut duplicate_blocks) = detect_duplicates(modules);
    enrich_duplicate_blocks(&mut duplicate_blocks, modules);
    let duplicate_lines: usize = duplicated.iter().map(HashSet::len).sum();
    let total_loc: usize = modules.iter().map(|module| module.loc).sum();
    let cycle_ids: HashSet<_> = cycles.iter().flat_map(|cycle| &cycle.modules).collect();
    let edge_pairs: HashSet<_> = edges
        .iter()
        .map(|edge| (&edge.source, &edge.target))
        .collect();
    let mutual_ids: HashSet<_> = edges
        .iter()
        .filter(|edge| edge_pairs.contains(&(&edge.target, &edge.source)))
        .flat_map(|edge| [&edge.source, &edge.target])
        .collect();
    let import_risk_count = cycle_ids.union(&mutual_ids).count();
    let high_coupling = modules
        .iter()
        .filter(|module| module.afferent_coupling + module.efferent_coupling >= 10)
        .count();
    let imports = percent(import_risk_count, modules.len())
        .saturating_add(percent(high_coupling, modules.len()) / 3)
        .min(100);
    let size = percent(
        modules.iter().filter(|module| module.is_oversized).count(),
        modules.len(),
    );
    let code = modules.iter().map(code_risk).sum::<usize>() / modules.len();
    let duplication = percent(duplicate_lines, total_loc);
    let score = (imports * 35 + size * 25 + code * 20 + duplication * 20) / 100;

    let mut hotspots: Vec<_> = modules
        .iter()
        .enumerate()
        .map(|(index, module)| {
            let cycle = cycle_ids.contains(&module.id);
            let mutual_import = mutual_ids.contains(&module.id);
            let duplicate_lines = duplicated[index].len();
            let coupling = module.afferent_coupling + module.efferent_coupling;
            let score = (if cycle {
                35
            } else if mutual_import {
                20
            } else {
                0
            }) + (if module.is_oversized { 25 } else { 0 })
                + code_risk(module) / 5
                + percent(duplicate_lines, module.loc) / 5
                + (coupling * 2).min(10);
            ComplexityHotspot {
                module: module.id.clone(),
                score: score.min(100),
                cycle,
                mutual_import,
                oversized: module.is_oversized,
                cyclomatic_complexity: module.cyclomatic_complexity,
                max_function_complexity: None,
                max_function_name: None,
                max_function_line: None,
                duplicate_lines,
                imports: module.efferent_coupling,
                imported_by: module.afferent_coupling,
            }
        })
        .filter(|item| item.score > 0)
        .collect();
    hotspots.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.module.cmp(&b.module)));
    hotspots.truncate(10);

    ComplexitySummary {
        score,
        imports,
        size,
        code,
        duplication,
        duplicate_lines,
        duplicate_blocks,
        function_complexities: Vec::new(),
        hotspots,
        code_source: "ModuleLoom".into(),
        duplication_source: "ModuleLoom".into(),
        magic_source: String::new(),
        literal_findings: Vec::new(),
        quality_warnings: Vec::new(),
        quality_ran: false,
    }
}

pub fn apply_quality(result: &mut AnalysisResult, quality: QualityData) {
    result.complexity.quality_ran = true;
    for (index, diagnostic) in quality.type_diagnostics {
        if let Some(module) = result.modules.get_mut(index) {
            module.diagnostics.push(diagnostic);
        }
    }
    let modules = &result.modules;
    if modules.is_empty() {
        return;
    }
    let functions = &quality.functions;
    let code_risks: Vec<_> = modules
        .iter()
        .map(|module| {
            functions
                .get(&module.id)
                .and_then(|items| items.iter().max_by_key(|item| item.ccn))
                .map(|item| (item.ccn.saturating_sub(1) * 10).min(100))
                .unwrap_or_else(|| code_risk(module))
        })
        .collect();
    let mut function_complexities: Vec<_> = modules
        .iter()
        .flat_map(|module| {
            functions
                .get(&module.id)
                .into_iter()
                .flatten()
                .map(|item| FunctionComplexity {
                    module: module.id.clone(),
                    file: module.relative_path.clone(),
                    name: item.name.clone(),
                    line: item.line,
                    ccn: item.ccn,
                    source: quality.function_source.clone(),
                })
        })
        .collect();
    function_complexities.sort_by(|a, b| a.file.cmp(&b.file).then_with(|| a.line.cmp(&b.line)));
    let (duplicated, mut blocks) = if let Some(clones) = quality.clones {
        result.complexity.duplication_source = "jscpd".into();
        (clones.duplicated, clones.blocks)
    } else {
        detect_duplicates(modules)
    };
    enrich_duplicate_blocks(&mut blocks, modules);
    result.complexity.code_source = quality.function_source;
    result.complexity.function_complexities = function_complexities;
    result.complexity.magic_source = quality.magic_source;
    result.complexity.literal_findings = quality.literals;
    result.complexity.quality_warnings = quality.warnings;
    result.complexity.code = code_risks.iter().sum::<usize>() / modules.len();
    result.complexity.duplicate_lines = duplicated.iter().map(HashSet::len).sum();
    result.complexity.duplicate_blocks = blocks;
    result.complexity.duplication = percent(result.complexity.duplicate_lines, result.total_loc);
    result.complexity.score = (result.complexity.imports * 35
        + result.complexity.size * 25
        + result.complexity.code * 20
        + result.complexity.duplication * 20)
        / 100;

    let cycle_ids: HashSet<_> = result
        .cycles
        .iter()
        .flat_map(|cycle| &cycle.modules)
        .collect();
    let pairs: HashSet<_> = result
        .edges
        .iter()
        .map(|edge| (&edge.source, &edge.target))
        .collect();
    let mutual_ids: HashSet<_> = result
        .edges
        .iter()
        .filter(|edge| pairs.contains(&(&edge.target, &edge.source)))
        .flat_map(|edge| [&edge.source, &edge.target])
        .collect();
    let mut hotspots: Vec<_> = modules
        .iter()
        .enumerate()
        .map(|(index, module)| {
            let cycle = cycle_ids.contains(&module.id);
            let mutual_import = mutual_ids.contains(&module.id);
            let duplicate_lines = duplicated[index].len();
            let coupling = module.afferent_coupling + module.efferent_coupling;
            let function: Option<&FunctionMetric> = functions
                .get(&module.id)
                .and_then(|items| items.iter().max_by_key(|item| item.ccn));
            let score = (if cycle {
                35
            } else if mutual_import {
                20
            } else {
                0
            }) + if module.is_oversized { 25 } else { 0 }
                + code_risks[index] / 5
                + percent(duplicate_lines, module.loc) / 5
                + (coupling * 2).min(10);
            ComplexityHotspot {
                module: module.id.clone(),
                score: score.min(100),
                cycle,
                mutual_import,
                oversized: module.is_oversized,
                cyclomatic_complexity: module.cyclomatic_complexity,
                max_function_complexity: function.map(|item| item.ccn),
                max_function_name: function.map(|item| item.name.clone()),
                max_function_line: function.map(|item| item.line),
                duplicate_lines,
                imports: module.efferent_coupling,
                imported_by: module.afferent_coupling,
            }
        })
        .filter(|item| item.score > 0)
        .collect();
    hotspots.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.module.cmp(&b.module)));
    hotspots.truncate(10);
    result.complexity.hotspots = hotspots;

    for block in &result.complexity.duplicate_blocks {
        for (module_id, line, other_id, other_line) in [
            (
                &block.first_module,
                block.first_line,
                &block.second_module,
                block.second_line,
            ),
            (
                &block.second_module,
                block.second_line,
                &block.first_module,
                block.first_line,
            ),
        ] {
            if let Some(module) = result.modules.iter_mut().find(|item| &item.id == module_id) {
                module.diagnostics.push(Diagnostic {
                    severity: DiagnosticSeverity::Warning,
                    message: format!(
                        "{}: {other_id}:{other_line} と {} 行{}{}",
                        if block.kind == "renamed" {
                            "類似コード"
                        } else {
                            "重複コード"
                        },
                        block.lines,
                        if block.kind == "renamed" {
                            "の構造が類似"
                        } else {
                            "一致"
                        },
                        if block.lines >= 10 {
                            "。共通関数化を検討"
                        } else {
                            ""
                        }
                    ),
                    line: Some(line),
                    rule: Some(
                        if block.kind == "renamed" {
                            "similar-code"
                        } else {
                            "duplicate-code"
                        }
                        .into(),
                    ),
                });
            }
        }
    }
}

fn percent(part: usize, whole: usize) -> usize {
    if whole == 0 {
        0
    } else {
        part.saturating_mul(100).saturating_div(whole).min(100)
    }
}

fn code_risk(module: &ModuleInfo) -> usize {
    let definitions = module.function_count.max(1);
    let average = module.cyclomatic_complexity.saturating_sub(1) / definitions;
    (average * 10).min(100)
}

fn detect_duplicates(modules: &[ModuleInfo]) -> (Vec<HashSet<usize>>, Vec<DuplicateBlock>) {
    let mut seen: HashMap<Vec<String>, (usize, Vec<usize>)> = HashMap::new();
    let mut duplicated = vec![HashSet::new(); modules.len()];
    let mut actionable_by_module = vec![Vec::new(); modules.len()];
    let mut blocks: Vec<DuplicateBlock> = Vec::new();
    for (module_index, module) in modules.iter().enumerate() {
        let Ok(source) = fs::read_to_string(&module.absolute_path) else {
            continue;
        };
        if is_generated_file(std::path::Path::new(&module.relative_path), &source) {
            continue;
        }
        actionable_by_module[module_index] = actionable_lines(&source);
        let actionable = &actionable_by_module[module_index];
        let lines: Vec<_> = source
            .lines()
            .enumerate()
            .filter_map(|(index, line)| {
                let normalized = line.trim();
                (!normalized.is_empty() && !normalized.starts_with('#'))
                    .then(|| (index + 1, normalized.to_string()))
            })
            .collect();
        for window in lines.windows(DUPLICATE_WINDOW) {
            if window
                .iter()
                .filter(|(line, _)| actionable[*line - 1])
                .count()
                < DUPLICATE_WINDOW - 1
            {
                continue;
            }
            let key: Vec<_> = window.iter().map(|(_, line)| line.clone()).collect();
            let first_line = window[0].0;
            if let Some((other_index, other_lines)) = seen.get(&key) {
                let other_index = *other_index;
                let other_line = other_lines[0];
                if module_index == other_index && first_line.abs_diff(other_line) < DUPLICATE_WINDOW
                {
                    continue;
                }
                for (line, _) in window {
                    if actionable[*line - 1] {
                        duplicated[module_index].insert(*line);
                    }
                }
                for line in other_lines {
                    if actionable_by_module[other_index]
                        .get(*line - 1)
                        .copied()
                        .unwrap_or(false)
                    {
                        duplicated[other_index].insert(*line);
                    }
                }
                if let Some(previous) = blocks.last_mut() {
                    if previous.first_module == modules[other_index].id
                        && previous.second_module == module.id
                        && other_line <= previous.first_line + previous.lines
                        && first_line <= previous.second_line + previous.lines
                    {
                        previous.lines = (other_line + DUPLICATE_WINDOW - previous.first_line)
                            .max(first_line + DUPLICATE_WINDOW - previous.second_line);
                        continue;
                    }
                }
                if blocks.len() < 20 {
                    blocks.push(DuplicateBlock {
                        first_module: modules[other_index].id.clone(),
                        first_line: other_line,
                        second_module: module.id.clone(),
                        second_line: first_line,
                        lines: DUPLICATE_WINDOW,
                        kind: "exact".into(),
                        first_function: None,
                        second_function: None,
                        first_signature: None,
                        second_signature: None,
                    });
                }
            } else {
                seen.insert(
                    key,
                    (module_index, window.iter().map(|(line, _)| *line).collect()),
                );
            }
        }
    }
    (duplicated, blocks)
}

pub struct BloatThresholds {
    pub max_loc: usize,
    pub max_functions: usize,
    pub max_classes: usize,
}

impl Default for BloatThresholds {
    fn default() -> Self {
        Self {
            max_loc: 300,
            max_functions: 20,
            max_classes: 10,
        }
    }
}

pub fn check_bloat(mod_info: &ModuleInfo, thresholds: &BloatThresholds) -> Option<Diagnostic> {
    let mut reasons = Vec::new();

    if mod_info.loc > thresholds.max_loc {
        reasons.push(format!(
            "行数超過 (LOC: {} > {})",
            mod_info.loc, thresholds.max_loc
        ));
    }
    if mod_info.function_count > thresholds.max_functions {
        reasons.push(format!(
            "関数定義数超過 ({} > {})",
            mod_info.function_count, thresholds.max_functions
        ));
    }
    if mod_info.class_count > thresholds.max_classes {
        reasons.push(format!(
            "クラス定義数超過 ({} > {})",
            mod_info.class_count, thresholds.max_classes
        ));
    }

    if !reasons.is_empty() {
        Some(Diagnostic {
            severity: DiagnosticSeverity::Warning,
            message: format!("モジュール肥大化警告: {}", reasons.join(", ")),
            line: Some(1),
            rule: Some("module-bloat".to_string()),
        })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_bloat_detection() {
        let normal_mod = ModuleInfo {
            id: "normal".to_string(),
            name: "normal".to_string(),
            relative_path: "normal.py".to_string(),
            absolute_path: PathBuf::from("normal.py"),
            docstring: None,
            loc: 100,
            cyclomatic_complexity: 1,
            class_count: 2,
            classes: vec![],
            function_count: 5,
            functions: vec![],
            symbols: vec![],
            symbol_calls: vec![],
            unused_symbol_candidates: vec![],
            imports: vec![],
            unresolved_imports: vec![],
            afferent_coupling: 0,
            efferent_coupling: 0,
            is_oversized: false,
            diagnostics: vec![],
        };

        let bloated_mod = ModuleInfo {
            id: "bloated".to_string(),
            name: "bloated".to_string(),
            relative_path: "bloated.py".to_string(),
            absolute_path: PathBuf::from("bloated.py"),
            docstring: None,
            loc: 500,
            cyclomatic_complexity: 1,
            class_count: 15,
            classes: vec![],
            function_count: 30,
            functions: vec![],
            symbols: vec![],
            symbol_calls: vec![],
            unused_symbol_candidates: vec![],
            imports: vec![],
            unresolved_imports: vec![],
            afferent_coupling: 0,
            efferent_coupling: 0,
            is_oversized: true,
            diagnostics: vec![],
        };

        let thresholds = BloatThresholds::default();
        assert!(check_bloat(&normal_mod, &thresholds).is_none());

        let diag = check_bloat(&bloated_mod, &thresholds);
        assert!(diag.is_some());
        let msg = diag.unwrap().message;
        assert!(msg.contains("LOC: 500"));
        assert!(msg.contains("30 > 20"));
    }
}
