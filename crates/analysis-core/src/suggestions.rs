use crate::model::{
    CircularCycle, CycleSuggestion, CycleSuggestionKind, DependencyEdge, ModuleInfo,
};
use rustpython_ast::{self as ast, Ranged, Visitor};
use rustpython_parser::Parse;
use std::fs;

pub fn annotate_cycles(
    cycles: &mut [CircularCycle],
    modules: &[ModuleInfo],
    edges: &[DependencyEdge],
) {
    for cycle in cycles {
        let mut candidates = Vec::new();
        for pair in cycle.path.windows(2) {
            let Some(edge) = edges
                .iter()
                .find(|edge| edge.source == pair[0] && edge.target == pair[1])
            else {
                continue;
            };
            let Some(source) = modules.iter().find(|module| module.id == edge.source) else {
                continue;
            };
            let kind = classify_import_usage(source, edge.line);
            candidates.push((kind, edge));
        }
        candidates.sort_by(|(a_kind, a_edge), (b_kind, b_edge)| {
            rank(a_kind)
                .cmp(&rank(b_kind))
                .then(a_edge.import_count.cmp(&b_edge.import_count))
                .then(a_edge.source.cmp(&b_edge.source))
        });
        cycle.suggestion = candidates.first().map(|(kind, edge)| CycleSuggestion {
            source: edge.source.clone(),
            target: edge.target.clone(),
            line: edge.line,
            kind: kind.clone(),
        });
    }
}

fn rank(kind: &CycleSuggestionKind) -> u8 {
    match kind {
        CycleSuggestionKind::TypeOnly => 0,
        CycleSuggestionKind::Runtime => 1,
        CycleSuggestionKind::Unknown => 2,
    }
}

fn classify_import_usage(module: &ModuleInfo, line: usize) -> CycleSuggestionKind {
    let mut imports = module.imports.iter().filter(|import| {
        import.line == line
            && import.is_top_level
            && import.is_from
            && import.imported_names.len() == 1
    });
    let Some(import) = imports.next() else {
        return CycleSuggestionKind::Unknown;
    };
    if imports.next().is_some() {
        return CycleSuggestionKind::Unknown;
    }
    let local_name = &import.imported_names[0];
    if local_name == "*" {
        return CycleSuggestionKind::Unknown;
    }

    let Ok(content) = fs::read_to_string(&module.absolute_path) else {
        return CycleSuggestionKind::Unknown;
    };
    let Ok(suite) = ast::Suite::parse(&content, &module.relative_path) else {
        return CycleSuggestionKind::Unknown;
    };
    let mut visitor = ReferenceCollector::default();
    for statement in suite {
        visitor.visit_stmt(statement);
    }

    let mut annotation_uses = 0;
    let mut runtime_uses = 0;
    for (name, start, end) in &visitor.names {
        if name != local_name {
            continue;
        }
        if visitor
            .annotations
            .iter()
            .any(|(from, to)| start >= from && end <= to)
        {
            annotation_uses += 1;
        } else {
            runtime_uses += 1;
        }
    }
    if runtime_uses > 0 {
        CycleSuggestionKind::Runtime
    } else if annotation_uses > 0 {
        CycleSuggestionKind::TypeOnly
    } else {
        CycleSuggestionKind::Unknown
    }
}

#[derive(Default)]
struct ReferenceCollector {
    annotations: Vec<(usize, usize)>,
    names: Vec<(String, usize, usize)>,
}

impl ReferenceCollector {
    fn mark(&mut self, annotation: &ast::Expr) {
        self.annotations
            .push((annotation.start().to_usize(), annotation.end().to_usize()));
    }

    fn collect_arguments(&mut self, args: ast::Arguments) {
        for arg in args
            .posonlyargs
            .iter()
            .chain(&args.args)
            .chain(&args.kwonlyargs)
        {
            if let Some(annotation) = &arg.def.annotation {
                self.mark(annotation);
                self.visit_expr((**annotation).clone());
            }
            if let Some(default) = &arg.default {
                self.visit_expr((**default).clone());
            }
        }
        if let Some(arg) = &args.vararg {
            if let Some(annotation) = &arg.annotation {
                self.mark(annotation);
                self.visit_expr((**annotation).clone());
            }
        }
        if let Some(arg) = &args.kwarg {
            if let Some(annotation) = &arg.annotation {
                self.mark(annotation);
                self.visit_expr((**annotation).clone());
            }
        }
    }
}

impl Visitor for ReferenceCollector {
    fn visit_stmt_function_def(&mut self, node: ast::StmtFunctionDef) {
        if let Some(annotation) = &node.returns {
            self.mark(annotation);
        }
        self.generic_visit_stmt_function_def(node);
    }

    fn visit_stmt_async_function_def(&mut self, node: ast::StmtAsyncFunctionDef) {
        if let Some(annotation) = &node.returns {
            self.mark(annotation);
        }
        self.generic_visit_stmt_async_function_def(node);
    }

    fn visit_stmt_ann_assign(&mut self, node: ast::StmtAnnAssign) {
        self.mark(&node.annotation);
        self.generic_visit_stmt_ann_assign(node);
    }

    fn visit_arguments(&mut self, node: ast::Arguments) {
        self.collect_arguments(node);
    }

    fn visit_expr_name(&mut self, node: ast::ExprName) {
        if matches!(node.ctx, ast::ExprContext::Load) {
            self.names.push((
                node.id.to_string(),
                node.start().to_usize(),
                node.end().to_usize(),
            ));
        }
    }
}
