use crate::model::*;
use petgraph::algo::tarjan_scc;
use petgraph::Directed;
use std::collections::{HashMap, HashSet, VecDeque};

/// Return the shortest directed chain, including both endpoints.
pub fn shortest_chain(edges: &[DependencyEdge], source: &str, target: &str) -> Option<Vec<String>> {
    let pairs: Vec<_> = edges
        .iter()
        .map(|edge| (edge.source.as_str(), edge.target.as_str()))
        .collect();
    shortest_chain_pairs(&pairs, source, target)
}

pub fn shortest_chain_pairs(
    edges: &[(&str, &str)],
    source: &str,
    target: &str,
) -> Option<Vec<String>> {
    let mut queue = VecDeque::from([source.to_string()]);
    let mut previous: HashMap<String, Option<String>> = HashMap::from([(source.to_string(), None)]);
    while let Some(current) = queue.pop_front() {
        if current == target {
            let mut path = Vec::new();
            let mut cursor = Some(current);
            while let Some(node) = cursor {
                cursor = previous.get(&node)?.clone();
                path.push(node);
            }
            path.reverse();
            return Some(path);
        }
        for (_, next) in edges.iter().filter(|(from, _)| *from == current) {
            if !previous.contains_key(*next) {
                previous.insert((*next).to_string(), Some(current.clone()));
                queue.push_back((*next).to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod shortest_chain_tests {
    use super::shortest_chain_pairs;
    #[test]
    fn picks_the_shortest_directed_path() {
        let edges = [("a", "b"), ("b", "c"), ("c", "d"), ("a", "d")];
        assert_eq!(
            shortest_chain_pairs(&edges, "a", "d"),
            Some(vec!["a".into(), "d".into()])
        );
        assert_eq!(shortest_chain_pairs(&edges, "d", "a"), None);
    }
}

pub fn build_graph(modules: &[ModuleInfo]) -> (Vec<DependencyEdge>, Vec<CircularCycle>) {
    let mut module_map = HashMap::new();
    let mut graph = petgraph::Graph::<String, usize, Directed>::new();
    let mut top_level_graph = petgraph::Graph::<String, usize, Directed>::new();
    let mut node_indices = HashMap::new();
    let mut top_node_indices = HashMap::new();

    // Map module ID to ModuleInfo
    for mod_info in modules {
        module_map.insert(mod_info.id.clone(), mod_info);
        let idx = graph.add_node(mod_info.id.clone());
        node_indices.insert(mod_info.id.clone(), idx);
        let top_idx = top_level_graph.add_node(mod_info.id.clone());
        top_node_indices.insert(mod_info.id.clone(), top_idx);
    }

    // edge_map: (source, target) -> (first_line, count, has_top_level)
    let mut edge_map: HashMap<(String, String), (usize, usize, bool)> = HashMap::new();

    for mod_info in modules {
        let from_id = &mod_info.id;

        for imp in &mod_info.imports {
            let target_ids = resolve_import_target(imp, from_id, &module_map);

            for target_id in target_ids {
                if target_id == *from_id {
                    continue; // Skip self import
                }

                if node_indices.contains_key(&target_id) {
                    let entry = edge_map
                        .entry((from_id.clone(), target_id))
                        .or_insert((imp.line, 0, false));
                    entry.1 += 1;
                    if imp.is_top_level {
                        if !entry.2 {
                            entry.0 = imp.line;
                        }
                        entry.2 = true;
                    }
                }
            }
        }
    }

    let mut edges = Vec::new();
    for ((src, tgt), (first_line, count, has_top_level)) in edge_map {
        let from_idx = node_indices[&src];
        let to_idx = node_indices[&tgt];
        graph.add_edge(from_idx, to_idx, first_line);

        if has_top_level {
            let top_from = top_node_indices[&src];
            let top_to = top_node_indices[&tgt];
            top_level_graph.add_edge(top_from, top_to, first_line);
        }

        edges.push(DependencyEdge {
            source: src,
            target: tgt,
            is_circular: false,
            line: first_line,
            import_count: count,
            is_top_level: has_top_level,
        });
    }

    // Detect execution-time cycles using Tarjan's Strongly Connected Components
    // ONLY on top-level imports! Because function-level / deferred imports do NOT
    // execute at module load time and therefore never cause runtime circular import errors (ImportError: partially initialized module).
    let sccs = tarjan_scc(&top_level_graph);
    let mut cycles = Vec::new();
    let mut circular_nodes = HashSet::new();

    for scc in sccs {
        if scc.len() > 1 {
            let cycle_mods: Vec<String> = scc
                .iter()
                .map(|idx| top_level_graph[*idx].clone())
                .collect();

            for m in &cycle_mods {
                circular_nodes.insert(m.clone());
            }
            let path = find_cycle_path(&cycle_mods, &top_level_graph);
            cycles.push(CircularCycle {
                modules: cycle_mods,
                path,
                suggestion: None,
            });
        }
    }

    // Mark edges that connect nodes within circular cycles (only if the edge is top_level)
    for edge in &mut edges {
        if edge.is_top_level
            && circular_nodes.contains(&edge.source)
            && circular_nodes.contains(&edge.target)
        {
            // Check if both nodes are in the same cycle
            let in_same_cycle = cycles
                .iter()
                .any(|c| c.modules.contains(&edge.source) && c.modules.contains(&edge.target));
            if in_same_cycle {
                edge.is_circular = true;
            }
        }
    }

    (edges, cycles)
}

fn find_cycle_path(
    modules: &[String],
    graph: &petgraph::Graph<String, usize, Directed>,
) -> Vec<String> {
    let members: HashSet<&str> = modules.iter().map(String::as_str).collect();
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in graph.raw_edges() {
        let source = graph[edge.source()].as_str();
        let target = graph[edge.target()].as_str();
        if members.contains(source) && members.contains(target) {
            adjacency.entry(source).or_default().push(target);
        }
    }
    for neighbors in adjacency.values_mut() {
        neighbors.sort_unstable();
        neighbors.dedup();
    }

    fn visit<'a>(
        current: &'a str,
        start: &'a str,
        adjacency: &HashMap<&'a str, Vec<&'a str>>,
        path: &mut Vec<&'a str>,
        seen: &mut HashSet<&'a str>,
    ) -> bool {
        for &next in adjacency.get(current).into_iter().flatten() {
            if next == start && path.len() > 1 {
                path.push(start);
                return true;
            }
            if seen.insert(next) {
                path.push(next);
                if visit(next, start, adjacency, path, seen) {
                    return true;
                }
                path.pop();
                seen.remove(next);
            }
        }
        false
    }

    let mut starts: Vec<&str> = members.into_iter().collect();
    starts.sort_unstable();
    for start in starts {
        let mut path = vec![start];
        let mut seen = HashSet::from([start]);
        if visit(start, start, &adjacency, &mut path, &mut seen) {
            return path.into_iter().map(str::to_string).collect();
        }
    }
    Vec::new()
}

/// Returns imports that do not resolve to a module inside the analyzed project.
/// These are usually standard-library or third-party dependencies.
pub fn collect_unresolved_imports(modules: &[ModuleInfo]) -> HashMap<String, Vec<String>> {
    let module_map: HashMap<String, &ModuleInfo> = modules
        .iter()
        .map(|module| (module.id.clone(), module))
        .collect();
    let mut result = HashMap::new();

    for module in modules {
        let mut imports = HashSet::new();
        for import in &module.imports {
            if resolve_import_target(import, &module.id, &module_map).is_empty() {
                let name = if import.module.is_empty() {
                    import.imported_names.join(", ")
                } else if import.is_from && !import.imported_names.is_empty() {
                    format!("{} ({})", import.module, import.imported_names.join(", "))
                } else {
                    import.module.clone()
                };
                imports.insert(name);
            }
        }
        if !imports.is_empty() {
            result.insert(module.id.clone(), imports.into_iter().collect());
        }
    }
    result
}

fn resolve_import_target(
    imp: &ImportStmt,
    current_module: &str,
    module_map: &HashMap<String, &ModuleInfo>,
) -> Vec<String> {
    let mut candidates = Vec::new();

    if imp.level == 0 {
        // Absolute import
        // Check exact match
        if module_map.contains_key(&imp.module) {
            candidates.push(imp.module.clone());
        } else {
            // e.g. "from pkg.sub import mod" where imp.module is "pkg.sub" and imported_names has "mod"
            for name in &imp.imported_names {
                let candidate = format!("{}.{}", imp.module, name);
                if module_map.contains_key(&candidate) {
                    candidates.push(candidate);
                }
            }
        }

        // Subproject / source root fallback (e.g. current is "sample_project.main", import is "app.api")
        if candidates.is_empty() {
            let current_parts: Vec<&str> = current_module.split('.').collect();
            for i in 1..current_parts.len() {
                let prefix = current_parts[..i].join(".");
                let prefixed_mod = format!("{}.{}", prefix, imp.module);
                if module_map.contains_key(&prefixed_mod) {
                    candidates.push(prefixed_mod);
                    break;
                }
                for name in &imp.imported_names {
                    let candidate = format!("{}.{}", prefixed_mod, name);
                    if module_map.contains_key(&candidate) {
                        candidates.push(candidate);
                        break;
                    }
                }
                if !candidates.is_empty() {
                    break;
                }
            }
        }
    } else {
        // Relative import: level 1 means sibling/same dir, level 2 means parent, etc.
        let parts: Vec<&str> = current_module.split('.').collect();
        let base_len = if parts.len() >= imp.level {
            parts.len() - imp.level
        } else {
            0
        };
        let base_pkg = parts[..base_len].join(".");

        let target_module = if imp.module.is_empty() {
            base_pkg.clone()
        } else if base_pkg.is_empty() {
            imp.module.clone()
        } else {
            format!("{}.{}", base_pkg, imp.module)
        };

        if module_map.contains_key(&target_module) {
            candidates.push(target_module);
        } else {
            for name in &imp.imported_names {
                let cand = if target_module.is_empty() {
                    name.clone()
                } else {
                    format!("{}.{}", target_module, name)
                };
                if module_map.contains_key(&cand) {
                    candidates.push(cand);
                }
            }
        }
    }

    candidates
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_circular_import_detection() {
        let mod_a = ModuleInfo {
            id: "app.a".to_string(),
            name: "a".to_string(),
            relative_path: "app/a.py".to_string(),
            absolute_path: PathBuf::from("/project/app/a.py"),
            docstring: None,
            loc: 10,
            cyclomatic_complexity: 1,
            class_count: 0,
            classes: vec![],
            function_count: 0,
            functions: vec![],
            symbols: vec![],
            symbol_calls: vec![],
            unused_symbol_candidates: vec![],
            imports: vec![
                ImportStmt {
                    module: "app.b".to_string(),
                    is_from: false,
                    level: 0,
                    line: 8,
                    imported_names: vec!["app.b".to_string()],
                    is_top_level: false,
                },
                ImportStmt {
                    module: "app.b".to_string(),
                    is_from: false,
                    level: 0,
                    line: 2,
                    imported_names: vec!["app.b".to_string()],
                    is_top_level: true,
                },
            ],
            unresolved_imports: vec![],
            afferent_coupling: 0,
            efferent_coupling: 0,
            is_oversized: false,
            diagnostics: vec![],
        };

        let mod_b = ModuleInfo {
            id: "app.b".to_string(),
            name: "b".to_string(),
            relative_path: "app/b.py".to_string(),
            absolute_path: PathBuf::from("/project/app/b.py"),
            docstring: None,
            loc: 15,
            cyclomatic_complexity: 1,
            class_count: 0,
            classes: vec![],
            function_count: 0,
            functions: vec![],
            symbols: vec![],
            symbol_calls: vec![],
            unused_symbol_candidates: vec![],
            imports: vec![ImportStmt {
                module: "app.a".to_string(),
                is_from: false,
                level: 0,
                line: 3,
                imported_names: vec!["app.a".to_string()],
                is_top_level: true,
            }],
            unresolved_imports: vec![],
            afferent_coupling: 0,
            efferent_coupling: 0,
            is_oversized: false,
            diagnostics: vec![],
        };

        let modules = vec![mod_a, mod_b];
        let (edges, cycles) = build_graph(&modules);

        assert_eq!(cycles.len(), 1, "Should detect 1 circular import cycle");
        assert_eq!(cycles[0].modules.len(), 2);
        assert!(cycles[0].modules.contains(&"app.a".to_string()));
        assert!(cycles[0].modules.contains(&"app.b".to_string()));

        assert_eq!(edges.len(), 2);
        assert_eq!(
            edges
                .iter()
                .find(|edge| edge.source == "app.a")
                .unwrap()
                .line,
            2
        );
        assert!(
            edges.iter().all(|e| e.is_circular),
            "Both edges should be marked as circular"
        );
        assert_eq!(cycles[0].path.first(), cycles[0].path.last());
        for pair in cycles[0].path.windows(2) {
            assert!(edges
                .iter()
                .any(|edge| edge.source == pair[0] && edge.target == pair[1]));
        }
    }

    #[test]
    fn representative_path_uses_real_edges_in_branching_component() {
        let mut graph = petgraph::Graph::<String, usize, Directed>::new();
        let a = graph.add_node("a".into());
        let b = graph.add_node("b".into());
        let c = graph.add_node("c".into());
        graph.add_edge(a, b, 1);
        graph.add_edge(b, a, 2);
        graph.add_edge(b, c, 3);
        graph.add_edge(c, b, 4);
        let modules = vec!["a".into(), "b".into(), "c".into()];
        let path = find_cycle_path(&modules, &graph);
        assert_eq!(path, vec!["a", "b", "a"]);
        assert!(path
            .windows(2)
            .all(|pair| graph.raw_edges().iter().any(|edge| {
                graph[edge.source()] == pair[0] && graph[edge.target()] == pair[1]
            })));
    }

    #[test]
    fn test_deferred_function_imports_do_not_cause_circular_cycle() {
        // Module A imports B at top-level
        let mod_a = ModuleInfo {
            id: "app.a".to_string(),
            name: "a".to_string(),
            relative_path: "app/a.py".to_string(),
            absolute_path: PathBuf::from("/project/app/a.py"),
            docstring: None,
            loc: 10,
            cyclomatic_complexity: 1,
            class_count: 0,
            classes: vec![],
            function_count: 1,
            functions: vec![],
            symbols: vec![],
            symbol_calls: vec![],
            unused_symbol_candidates: vec![],
            imports: vec![ImportStmt {
                module: "app.b".to_string(),
                is_from: false,
                level: 0,
                line: 2,
                imported_names: vec!["app.b".to_string()],
                is_top_level: true,
            }],
            unresolved_imports: vec![],
            afferent_coupling: 0,
            efferent_coupling: 0,
            is_oversized: false,
            diagnostics: vec![],
        };

        // Module B imports A INSIDE a function (deferred / 遅延インポート)
        let mod_b = ModuleInfo {
            id: "app.b".to_string(),
            name: "b".to_string(),
            relative_path: "app/b.py".to_string(),
            absolute_path: PathBuf::from("/project/app/b.py"),
            docstring: None,
            loc: 15,
            cyclomatic_complexity: 1,
            class_count: 0,
            classes: vec![],
            function_count: 1,
            functions: vec![],
            symbols: vec![],
            symbol_calls: vec![],
            unused_symbol_candidates: vec![],
            imports: vec![ImportStmt {
                module: "app.a".to_string(),
                is_from: false,
                level: 0,
                line: 8,
                imported_names: vec!["app.a".to_string()],
                is_top_level: false, // Inside function!
            }],
            unresolved_imports: vec![],
            afferent_coupling: 0,
            efferent_coupling: 0,
            is_oversized: false,
            diagnostics: vec![],
        };

        let modules = vec![mod_a, mod_b];
        let (edges, cycles) = build_graph(&modules);

        // Since B's import is inside a function, no runtime cycle error occurs at module load time!
        assert_eq!(
            cycles.len(),
            0,
            "Function-level import must NOT produce circular cycle error"
        );
        assert_eq!(edges.len(), 2, "Edges still exist in dependency graph");
        assert!(
            edges.iter().all(|e| !e.is_circular),
            "Neither edge should be marked as circular error"
        );
    }
}
