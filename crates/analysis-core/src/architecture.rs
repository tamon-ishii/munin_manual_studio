use crate::model::*;
use petgraph::algo::tarjan_scc;
use petgraph::graph::NodeIndex;
use petgraph::{Directed, Graph};
use std::collections::HashMap;
use std::collections::HashSet;

pub fn check_architecture(
    modules: &[ModuleInfo],
    edges: &[DependencyEdge],
    config: &ArchitectureConfig,
) -> Vec<ArchitectureViolation> {
    let mut violations = Vec::new();
    let mut matched_ignores = HashSet::new();

    for edge in edges {
        let mut ignored = false;
        for pattern in &config.ignore_imports {
            if ignore_matches(pattern, edge) {
                matched_ignores.insert(pattern.as_str());
                ignored = true;
            }
        }
        if ignored {
            continue;
        }
        for rule in &config.forbidden {
            if matches_prefix(&edge.source, &rule.source)
                && matches_prefix(&edge.target, &rule.target)
            {
                violations.push(ArchitectureViolation {
                    rule: "architecture-forbidden".to_string(),
                    name: rule.name.clone(),
                    source: edge.source.clone(),
                    target: edge.target.clone(),
                    line: edge.line,
                    message: format!("禁止された依存: {} -> {}", edge.source, edge.target),
                    suggestion: "依存方向を反転するか、共通インターフェースを下位モジュールへ抽出してください".to_string(),
                });
            }
        }

        for rule in &config.protected {
            if matches_prefix(&edge.target, &rule.module)
                && !matches_prefix(&edge.source, &rule.module)
                && !rule.allowed.iter().any(|allowed| {
                    matches_prefix(&edge.source, allowed) || wildcard_matches(allowed, &edge.source)
                })
            {
                violations.push(ArchitectureViolation {
                    rule: "architecture-protected".into(),
                    name: rule.name.clone(),
                    source: edge.source.clone(),
                    target: edge.target.clone(),
                    line: edge.line,
                    message: format!(
                        "保護されたモジュールへの依存: {} -> {}",
                        edge.source, edge.target
                    ),
                    suggestion: "公開インターフェースを使うか、許可リストを見直してください".into(),
                });
            }
        }

        for rule in &config.independence {
            let source_group = matching_group(&edge.source, &rule.modules);
            let target_group = matching_group(&edge.target, &rule.modules);
            if source_group.is_some() && target_group.is_some() && source_group != target_group {
                violations.push(ArchitectureViolation {
                    rule: "architecture-independence".to_string(),
                    name: rule.name.clone(),
                    source: edge.source.clone(),
                    target: edge.target.clone(),
                    line: edge.line,
                    message: format!("独立性ルール違反: {} -> {}", edge.source, edge.target),
                    suggestion:
                        "共有処理を別パッケージへ移すか、依存性注入で直接依存をなくしてください"
                            .to_string(),
                });
            }
        }

        for rule in &config.layers {
            let source_layer = layer_index(&edge.source, &rule.layers);
            let target_layer = layer_index(&edge.target, &rule.layers);
            if let (Some(source), Some(target)) = (source_layer, target_layer) {
                // The list is ordered from high level to low level. Low levels
                // must not import higher levels.
                if source > target {
                    violations.push(ArchitectureViolation {
                        rule: "architecture-layers".to_string(),
                        name: rule.name.clone(),
                        source: edge.source.clone(),
                        target: edge.target.clone(),
                        line: edge.line,
                        message: format!("レイヤー違反: {} -> {}", edge.source, edge.target),
                        suggestion: "下位レイヤーから上位レイヤーへの依存を取り除いてください"
                            .to_string(),
                    });
                }
                if source < target
                    && rule.closed.iter().any(|closed| {
                        layer_index(closed, &rule.layers)
                            .is_some_and(|middle| source < middle && middle < target)
                    })
                {
                    violations.push(ArchitectureViolation {
                        rule: "architecture-closed-layer".into(),
                        name: rule.name.clone(),
                        source: edge.source.clone(),
                        target: edge.target.clone(),
                        line: edge.line,
                        message: format!(
                            "閉じたレイヤーを飛ばす依存: {} -> {}",
                            edge.source, edge.target
                        ),
                        suggestion: "中間レイヤーの公開インターフェースを経由してください".into(),
                    });
                }
            }
        }
    }

    for pattern in &config.ignore_imports {
        if !matched_ignores.contains(pattern.as_str()) {
            violations.push(ArchitectureViolation {
                rule: "architecture-unused-ignore".into(),
                name: "ignore_imports".into(),
                source: pattern.clone(),
                target: String::new(),
                line: 0,
                message: format!("一致する import がない例外指定: {pattern}"),
                suggestion: "不要になった例外指定を削除してください".into(),
            });
        }
    }

    for rule in &config.acyclic_siblings {
        let sibling = |module: &str| -> Option<String> {
            let rest = module.strip_prefix(&format!("{}.", rule.parent))?;
            Some(format!("{}.{}", rule.parent, rest.split('.').next()?))
        };
        let sibling_edges: Vec<_> = edges
            .iter()
            .filter_map(|edge| {
                if config
                    .ignore_imports
                    .iter()
                    .any(|pattern| ignore_matches(pattern, edge))
                {
                    return None;
                }
                let (source, target) = (sibling(&edge.source)?, sibling(&edge.target)?);
                (source != target).then_some((source, target, edge))
            })
            .collect();
        let mut graph = Graph::<String, (), Directed>::new();
        let mut indices: HashMap<String, NodeIndex> = HashMap::new();
        for (source, target, _) in &sibling_edges {
            let from = *indices
                .entry(source.clone())
                .or_insert_with(|| graph.add_node(source.clone()));
            let to = *indices
                .entry(target.clone())
                .or_insert_with(|| graph.add_node(target.clone()));
            graph.add_edge(from, to, ());
        }
        let mut component_of = HashMap::new();
        for (component, members) in tarjan_scc(&graph).into_iter().enumerate() {
            for member in members {
                component_of.insert(graph[member].clone(), component);
            }
        }
        let mut reported = HashSet::new();
        for (source, target, edge) in &sibling_edges {
            if reported.insert((source.clone(), target.clone()))
                && component_of.get(source) == component_of.get(target)
            {
                violations.push(ArchitectureViolation {
                    rule: "architecture-acyclic-siblings".into(),
                    name: rule.name.clone(),
                    source: edge.source.clone(),
                    target: edge.target.clone(),
                    line: edge.line,
                    message: format!("兄弟パッケージ間の循環: {source} -> {target}"),
                    suggestion: "共有処理を親または別パッケージへ抽出してください".into(),
                });
            }
        }
    }

    let _ = modules;
    violations
}

fn ignore_matches(pattern: &str, edge: &DependencyEdge) -> bool {
    let Some((source, target)) = pattern.split_once("->") else {
        return false;
    };
    wildcard_matches(source.trim(), &edge.source) && wildcard_matches(target.trim(), &edge.target)
}

fn wildcard_matches(pattern: &str, module: &str) -> bool {
    let pattern: Vec<_> = pattern.split('.').collect();
    let module: Vec<_> = module.split('.').collect();
    fn matches(pattern: &[&str], module: &[&str]) -> bool {
        match pattern.split_first() {
            None => module.is_empty(),
            Some((&"**", rest)) => (0..=module.len()).any(|n| matches(rest, &module[n..])),
            Some((&"*", rest)) => !module.is_empty() && matches(rest, &module[1..]),
            Some((head, rest)) => {
                !module.is_empty() && *head == module[0] && matches(rest, &module[1..])
            }
        }
    }
    matches(&pattern, &module)
}

fn matches_prefix(module: &str, prefix: &str) -> bool {
    module == prefix || module.starts_with(&format!("{}.", prefix))
}

fn matching_group(module: &str, groups: &[String]) -> Option<usize> {
    groups
        .iter()
        .position(|group| matches_prefix(module, group))
}

fn layer_index(module: &str, layers: &[String]) -> Option<usize> {
    matching_group(module, layers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_forbidden_dependency() {
        let modules = vec![];
        let edges = vec![DependencyEdge {
            source: "app.api.routes".into(),
            target: "app.db.models".into(),
            is_circular: false,
            line: 4,
            import_count: 1,
            is_top_level: true,
        }];
        let config = ArchitectureConfig {
            forbidden: vec![ForbiddenImportRule {
                name: "api-db".into(),
                source: "app.api".into(),
                target: "app.db".into(),
            }],
            ..Default::default()
        };
        assert_eq!(check_architecture(&modules, &edges, &config).len(), 1);
    }

    #[test]
    fn checks_protected_closed_and_ignored_imports() {
        let edge = |source: &str, target: &str| DependencyEdge {
            source: source.into(),
            target: target.into(),
            is_circular: false,
            line: 2,
            import_count: 1,
            is_top_level: true,
        };
        let edges = vec![
            edge("app.api", "app.private"),
            edge("app.web", "app.domain"),
            edge("app.legacy", "app.private"),
        ];
        let config = ArchitectureConfig {
            protected: vec![ProtectedRule {
                name: "private".into(),
                module: "app.private".into(),
                allowed: vec!["app.trusted".into()],
            }],
            layers: vec![LayerRule {
                name: "app".into(),
                layers: vec!["app.web".into(), "app.service".into(), "app.domain".into()],
                closed: vec!["app.service".into()],
            }],
            ignore_imports: vec![
                "app.legacy -> app.private".into(),
                "app.stale -> app.private".into(),
            ],
            ..Default::default()
        };
        let violations = check_architecture(&[], &edges, &config);
        assert_eq!(
            violations
                .iter()
                .filter(|v| v.rule == "architecture-protected")
                .count(),
            1
        );
        assert_eq!(
            violations
                .iter()
                .filter(|v| v.rule == "architecture-closed-layer")
                .count(),
            1
        );
        assert_eq!(
            violations
                .iter()
                .filter(|v| v.rule == "architecture-unused-ignore")
                .count(),
            1
        );
    }

    #[test]
    fn checks_cycles_between_sibling_packages() {
        let edge = |source: &str, target: &str| DependencyEdge {
            source: source.into(),
            target: target.into(),
            is_circular: false,
            line: 1,
            import_count: 1,
            is_top_level: true,
        };
        let mut config = ArchitectureConfig {
            acyclic_siblings: vec![AcyclicSiblingsRule {
                name: "siblings".into(),
                parent: "app".into(),
            }],
            ..Default::default()
        };
        let edges = vec![
            edge("app.api.a", "app.domain.b"),
            edge("app.domain.c", "app.api.d"),
        ];
        assert!(check_architecture(&[], &edges, &config)
            .iter()
            .any(|v| v.rule == "architecture-acyclic-siblings"));
        config.ignore_imports = vec!["app.domain.c -> app.api.d".into()];
        assert!(!check_architecture(&[], &edges, &config)
            .iter()
            .any(|v| v.rule == "architecture-acyclic-siblings"));
    }
}
