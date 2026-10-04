use crate::model::*;
use rustpython_ast::{self as ast, Visitor};
use rustpython_ast::{Stmt, StmtAsyncFunctionDef, StmtFunctionDef};
use rustpython_parser::source_code::LineIndex;

pub fn check_ast_diagnostics(ast: &[Stmt], index: &LineIndex, diagnostics: &mut Vec<Diagnostic>) {
    for stmt in ast {
        check_stmt_diagnostics(stmt, index, diagnostics);
    }
}

pub fn check_security_diagnostics(
    ast_nodes: &[Stmt],
    index: &LineIndex,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let mut visitor = SecurityVisitor { index, diagnostics };
    for stmt in ast_nodes {
        visitor.visit_stmt(stmt.clone());
    }
}

struct SecurityVisitor<'a> {
    index: &'a LineIndex,
    diagnostics: &'a mut Vec<Diagnostic>,
}

impl<'a> Visitor for SecurityVisitor<'a> {
    fn visit_expr_call(&mut self, node: ast::ExprCall) {
        let callee = match node.func.as_ref() {
            ast::Expr::Name(name) => Some(name.id.as_str()),
            ast::Expr::Attribute(attribute) => Some(attribute.attr.as_str()),
            _ => None,
        };
        if let Some(callee) = callee {
            let rule = match callee {
                "eval" => Some((
                    "security-dynamic-exec",
                    "eval は任意コード実行につながる可能性があります",
                )),
                "exec" => Some((
                    "security-dynamic-exec",
                    "exec は任意コード実行につながる可能性があります",
                )),
                "__import__" => Some((
                    "security-dynamic-import",
                    "動的 import は依存関係を静的に追跡できない可能性があります",
                )),
                _ => None,
            };
            if let Some((rule, message)) = rule {
                let line = self.index.line_index(node.range.start()).get() as usize;
                self.diagnostics.push(Diagnostic {
                    severity: DiagnosticSeverity::Warning,
                    message: message.to_string(),
                    line: Some(line),
                    rule: Some(rule.to_string()),
                });
            }
        }
        self.generic_visit_expr_call(node);
    }
}

fn check_stmt_diagnostics(stmt: &Stmt, index: &LineIndex, diagnostics: &mut Vec<Diagnostic>) {
    match stmt {
        Stmt::FunctionDef(fn_def) => {
            check_function_types(fn_def, index, diagnostics);
            for inner in &fn_def.body {
                check_stmt_diagnostics(inner, index, diagnostics);
            }
        }
        Stmt::AsyncFunctionDef(fn_def) => {
            check_async_function_types(fn_def, index, diagnostics);
            for inner in &fn_def.body {
                check_stmt_diagnostics(inner, index, diagnostics);
            }
        }
        Stmt::ClassDef(class_def) => {
            for inner in &class_def.body {
                check_stmt_diagnostics(inner, index, diagnostics);
            }
        }
        _ => {}
    }
}

fn check_function_types(
    func: &StmtFunctionDef,
    index: &LineIndex,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let line = index.line_index(func.range.start()).get() as usize;

    // Check if returns type annotation is missing (except __init__)
    if func.name.as_str() != "__init__" && func.returns.is_none() {
        diagnostics.push(Diagnostic {
            severity: DiagnosticSeverity::Info,
            message: format!(
                "関数 `{}` に戻り値の型アノテーションがありません",
                func.name
            ),
            line: Some(line),
            rule: Some("missing-type-annotation".to_string()),
        });
    }

    // Check args annotations
    for arg in &func.args.args {
        if arg.def.annotation.is_none()
            && arg.def.arg.as_str() != "self"
            && arg.def.arg.as_str() != "cls"
        {
            diagnostics.push(Diagnostic {
                severity: DiagnosticSeverity::Info,
                message: format!(
                    "引数 `{}` に型アノテーションがありません (関数: {})",
                    arg.def.arg, func.name
                ),
                line: Some(line),
                rule: Some("missing-type-annotation".to_string()),
            });
        }
    }
}

fn check_async_function_types(
    func: &StmtAsyncFunctionDef,
    index: &LineIndex,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let line = index.line_index(func.range.start()).get() as usize;
    if func.returns.is_none() {
        diagnostics.push(Diagnostic {
            severity: DiagnosticSeverity::Info,
            message: format!(
                "非同期関数 `{}` に戻り値の型アノテーションがありません",
                func.name
            ),
            line: Some(line),
            rule: Some("missing-type-annotation".to_string()),
        });
    }
}
