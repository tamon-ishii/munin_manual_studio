use crate::model::*;
use rustpython_ast::{self as ast, Stmt, Visitor};
use rustpython_parser::{source_code::LineIndex, Parse};
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

pub fn scan_directory(root: &Path) -> Result<Vec<ModuleInfo>, String> {
    Ok(scan_directory_with_config(root, &AnalysisConfig::default())?.0)
}

pub fn scan_directory_with_errors(root: &Path) -> Result<(Vec<ModuleInfo>, Vec<String>), String> {
    scan_directory_with_config(root, &AnalysisConfig::default())
}

pub fn scan_directory_with_config(
    root: &Path,
    config: &AnalysisConfig,
) -> Result<(Vec<ModuleInfo>, Vec<String>), String> {
    let mut modules = Vec::new();
    let mut errors = Vec::new();

    for entry in WalkDir::new(root).into_iter().filter_entry(|e| {
        if e.depth() == 0 {
            return true;
        }
        let name = e.file_name().to_string_lossy();
        !name.starts_with('.')
            && name != "__pycache__"
            && name != "venv"
            && name != ".venv"
            && name != "node_modules"
            && name != "target"
    }) {
        let entry = match entry {
            Ok(e) => e,
            Err(err) => return Err(format!("Walkdir error: {}", err)),
        };

        let path = entry.path();
        if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("py") {
            match parse_python_file_with_config(path, root, config) {
                Ok(mod_info) => modules.push(mod_info),
                Err(err) => {
                    eprintln!("Warning: Failed to parse {}: {}", path.display(), err);
                    errors.push(format!("{}: {}", path.display(), err));
                }
            }
        }
    }

    Ok((modules, errors))
}

pub fn parse_python_file(path: &Path, root: &Path) -> Result<ModuleInfo, String> {
    parse_python_file_with_config(path, root, &AnalysisConfig::default())
}

pub fn parse_python_file_with_config(
    path: &Path,
    root: &Path,
    config: &AnalysisConfig,
) -> Result<ModuleInfo, String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    parse_python_source_with_config(&content, path, root, config)
}

pub fn parse_python_source(content: &str, path: &Path, root: &Path) -> Result<ModuleInfo, String> {
    parse_python_source_with_config(content, path, root, &AnalysisConfig::default())
}

pub fn parse_python_source_with_config(
    content: &str,
    path: &Path,
    root: &Path,
    config: &AnalysisConfig,
) -> Result<ModuleInfo, String> {
    let rel_path = path.strip_prefix(root).unwrap_or(path);
    let rel_str = rel_path.to_string_lossy().to_string();
    let mod_id = file_path_to_module_id(rel_path);
    let mod_name = mod_id.split('.').last().unwrap_or(&mod_id).to_string();

    let ast = ast::Suite::parse(content, &rel_str)
        .map_err(|e| format!("Parse error in {}: {:?}", rel_str, e))?;

    let docstring = body_docstring(&ast);

    let index = LineIndex::from_source_text(content);

    let mut imports = Vec::new();
    let mut classes = Vec::new();
    let mut functions = Vec::new();
    let mut class_count = 0;
    let mut function_count = 0;

    for stmt in &ast {
        collect_stmt_info(
            stmt,
            &index,
            &mut imports,
            &mut classes,
            &mut functions,
            &mut class_count,
            &mut function_count,
            true,
            None,
        );
    }

    let loc = content.lines().count();
    let is_oversized = loc > config.max_loc
        || class_count > config.max_classes
        || function_count > config.max_functions;

    let mut diagnostics = Vec::new();
    if is_oversized {
        diagnostics.push(Diagnostic {
            severity: DiagnosticSeverity::Warning,
            message: format!(
                "モジュールの規模が閾値を超過しています (LOC: {}, 関数: {}, クラス: {})",
                loc, function_count, class_count
            ),
            line: Some(1),
            rule: Some("module-bloat".to_string()),
        });
    }

    // Check for common type checking and lint issues in AST
    crate::diagnostics::check_ast_diagnostics(&ast, &index, &mut diagnostics);
    crate::diagnostics::check_security_diagnostics(&ast, &index, &mut diagnostics);
    let (symbols, symbol_calls) = collect_symbol_info(&ast, &index);
    let cyclomatic_complexity = calculate_complexity(&ast);

    Ok(ModuleInfo {
        id: mod_id,
        name: mod_name,
        relative_path: rel_str,
        absolute_path: path.to_path_buf(),
        docstring,
        loc,
        cyclomatic_complexity,
        class_count,
        classes,
        function_count,
        functions,
        symbols,
        symbol_calls,
        unused_symbol_candidates: Vec::new(),
        imports,
        unresolved_imports: Vec::new(),
        afferent_coupling: 0,
        efferent_coupling: 0,
        is_oversized,
        diagnostics,
    })
}

fn body_docstring(body: &[Stmt]) -> Option<String> {
    match body.first() {
        Some(Stmt::Expr(expr)) => match expr.value.as_ref() {
            ast::Expr::Constant(value) => match &value.value {
                ast::Constant::Str(text) => Some(text.clone()),
                _ => None,
            },
            _ => None,
        },
        _ => None,
    }
}

fn format_arg(arg: &ast::Arg, default: Option<&ast::Expr>) -> String {
    let mut value = arg.arg.to_string();
    if let Some(annotation) = &arg.annotation {
        value.push_str(&format!(": {annotation}"));
    }
    if let Some(default) = default {
        value.push_str(&format!(" = {default}"));
    }
    value
}

fn function_signature(args: &ast::Arguments, returns: Option<&ast::Expr>) -> String {
    let mut params = Vec::new();
    for arg in &args.posonlyargs {
        params.push(format_arg(&arg.def, arg.default.as_deref()));
    }
    if !args.posonlyargs.is_empty() {
        params.push("/".into());
    }
    for arg in &args.args {
        params.push(format_arg(&arg.def, arg.default.as_deref()));
    }
    if let Some(arg) = &args.vararg {
        params.push(format!("*{}", format_arg(arg, None)));
    } else if !args.kwonlyargs.is_empty() {
        params.push("*".into());
    }
    for arg in &args.kwonlyargs {
        params.push(format_arg(&arg.def, arg.default.as_deref()));
    }
    if let Some(arg) = &args.kwarg {
        params.push(format!("**{}", format_arg(arg, None)));
    }
    let mut signature = format!("({})", params.join(", "));
    if let Some(returns) = returns {
        signature.push_str(&format!(" -> {returns}"));
    }
    signature
}

fn class_signature(class_def: &ast::StmtClassDef) -> String {
    let mut args: Vec<String> = class_def.bases.iter().map(ToString::to_string).collect();
    args.extend(class_def.keywords.iter().map(|keyword| match &keyword.arg {
        Some(name) => format!("{name}={}", keyword.value),
        None => format!("**{}", keyword.value),
    }));
    if args.is_empty() {
        String::new()
    } else {
        format!("({})", args.join(", "))
    }
}

struct ComplexityVisitor {
    complexity: usize,
}

impl Visitor for ComplexityVisitor {
    fn visit_stmt_if(&mut self, node: ast::StmtIf) {
        self.complexity += 1;
        self.generic_visit_stmt_if(node);
    }
    fn visit_stmt_for(&mut self, node: ast::StmtFor) {
        self.complexity += 1;
        self.generic_visit_stmt_for(node);
    }
    fn visit_stmt_async_for(&mut self, node: ast::StmtAsyncFor) {
        self.complexity += 1;
        self.generic_visit_stmt_async_for(node);
    }
    fn visit_stmt_while(&mut self, node: ast::StmtWhile) {
        self.complexity += 1;
        self.generic_visit_stmt_while(node);
    }
    fn visit_stmt_try(&mut self, node: ast::StmtTry) {
        self.complexity += node.handlers.len();
        self.generic_visit_stmt_try(node);
    }
    fn visit_expr_bool_op(&mut self, node: ast::ExprBoolOp) {
        self.complexity += node.values.len().saturating_sub(1);
        self.generic_visit_expr_bool_op(node);
    }
}

fn calculate_complexity(ast: &[Stmt]) -> usize {
    let mut visitor = ComplexityVisitor { complexity: 1 };
    for stmt in ast {
        visitor.visit_stmt(stmt.clone());
    }
    visitor.complexity
}

struct SymbolCollector<'a> {
    index: &'a LineIndex,
    context: Vec<String>,
    symbols: Vec<SymbolInfo>,
    calls: Vec<SymbolCall>,
}

impl<'a> SymbolCollector<'a> {
    fn current_symbol(&self) -> String {
        self.context
            .last()
            .cloned()
            .unwrap_or_else(|| "<module>".to_string())
    }
}

impl<'a> Visitor for SymbolCollector<'a> {
    fn visit_stmt_class_def(&mut self, node: ast::StmtClassDef) {
        let line = self.index.line_index(node.range.start()).get() as usize;
        self.symbols.push(SymbolInfo {
            name: node.name.to_string(),
            kind: "class".to_string(),
            line,
        });
        self.context.push(node.name.to_string());
        self.generic_visit_stmt_class_def(node);
        self.context.pop();
    }

    fn visit_stmt_function_def(&mut self, node: ast::StmtFunctionDef) {
        let line = self.index.line_index(node.range.start()).get() as usize;
        let name = if self.context.is_empty() {
            node.name.to_string()
        } else {
            format!("{}.{}", self.current_symbol(), node.name)
        };
        self.symbols.push(SymbolInfo {
            name: name.clone(),
            kind: "function".to_string(),
            line,
        });
        self.context.push(name);
        self.generic_visit_stmt_function_def(node);
        self.context.pop();
    }

    fn visit_stmt_async_function_def(&mut self, node: ast::StmtAsyncFunctionDef) {
        let line = self.index.line_index(node.range.start()).get() as usize;
        let name = if self.context.is_empty() {
            node.name.to_string()
        } else {
            format!("{}.{}", self.current_symbol(), node.name)
        };
        self.symbols.push(SymbolInfo {
            name: name.clone(),
            kind: "async_function".to_string(),
            line,
        });
        self.context.push(name);
        self.generic_visit_stmt_async_function_def(node);
        self.context.pop();
    }

    fn visit_expr_call(&mut self, node: ast::ExprCall) {
        if let Some(callee) = expression_name(&node.func) {
            let line = self.index.line_index(node.range.start()).get() as usize;
            self.calls.push(SymbolCall {
                caller: self.current_symbol(),
                callee,
                line,
            });
        }
        self.generic_visit_expr_call(node);
    }
}

fn expression_name(expr: &ast::Expr) -> Option<String> {
    match expr {
        ast::Expr::Name(name) => Some(name.id.to_string()),
        ast::Expr::Attribute(attribute) => Some(attribute.attr.to_string()),
        _ => None,
    }
}

fn collect_symbol_info(ast: &[Stmt], index: &LineIndex) -> (Vec<SymbolInfo>, Vec<SymbolCall>) {
    let mut collector = SymbolCollector {
        index,
        context: Vec::new(),
        symbols: Vec::new(),
        calls: Vec::new(),
    };
    for stmt in ast {
        collector.visit_stmt(stmt.clone());
    }
    (collector.symbols, collector.calls)
}

fn collect_stmt_info(
    stmt: &Stmt,
    index: &LineIndex,
    imports: &mut Vec<ImportStmt>,
    classes: &mut Vec<ClassInfo>,
    functions: &mut Vec<FunctionInfo>,
    class_count: &mut usize,
    function_count: &mut usize,
    is_top_level: bool,
    parent_class_line: Option<usize>,
) {
    match stmt {
        Stmt::Import(import_stmt) => {
            let line = index.line_index(import_stmt.range.start()).get() as usize;
            for alias in &import_stmt.names {
                imports.push(ImportStmt {
                    module: alias.name.to_string(),
                    is_from: false,
                    level: 0,
                    line,
                    imported_names: vec![alias.name.to_string()],
                    is_top_level,
                });
            }
        }
        Stmt::ImportFrom(from_stmt) => {
            let line = index.line_index(from_stmt.range.start()).get() as usize;
            let module_name = from_stmt
                .module
                .as_ref()
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
            let level = from_stmt.level.map(|l| l.to_u32() as usize).unwrap_or(0);
            let imported = from_stmt.names.iter().map(|a| a.name.to_string()).collect();

            imports.push(ImportStmt {
                module: module_name,
                is_from: true,
                level,
                line,
                imported_names: imported,
                is_top_level,
            });
        }
        Stmt::ClassDef(class_def) => {
            *class_count += 1;
            let line = index.line_index(class_def.range.start()).get() as usize;
            classes.push(ClassInfo {
                name: class_def.name.to_string(),
                signature: class_signature(class_def),
                line,
                parent_class_line,
                docstring: body_docstring(&class_def.body),
            });
            for inner in &class_def.body {
                collect_stmt_info(
                    inner,
                    index,
                    imports,
                    classes,
                    functions,
                    class_count,
                    function_count,
                    false,
                    Some(line),
                );
            }
        }
        Stmt::FunctionDef(fn_def) => {
            *function_count += 1;
            functions.push(FunctionInfo {
                name: fn_def.name.to_string(),
                signature: function_signature(&fn_def.args, fn_def.returns.as_deref()),
                line: index.line_index(fn_def.range.start()).get() as usize,
                parent_class_line,
                docstring: body_docstring(&fn_def.body),
            });
            for inner in &fn_def.body {
                collect_stmt_info(
                    inner,
                    index,
                    imports,
                    classes,
                    functions,
                    class_count,
                    function_count,
                    false,
                    parent_class_line,
                );
            }
        }
        Stmt::AsyncFunctionDef(fn_def) => {
            *function_count += 1;
            functions.push(FunctionInfo {
                name: fn_def.name.to_string(),
                signature: function_signature(&fn_def.args, fn_def.returns.as_deref()),
                line: index.line_index(fn_def.range.start()).get() as usize,
                parent_class_line,
                docstring: body_docstring(&fn_def.body),
            });
            for inner in &fn_def.body {
                collect_stmt_info(
                    inner,
                    index,
                    imports,
                    classes,
                    functions,
                    class_count,
                    function_count,
                    false,
                    parent_class_line,
                );
            }
        }
        Stmt::If(if_stmt) => {
            // Explicitly exclude type-checking-only imports (if TYPE_CHECKING / if typing.TYPE_CHECKING)
            if is_type_checking_condition(&if_stmt.test) {
                // Ignore type-checking imports, but traverse else branch if present
                for inner in &if_stmt.orelse {
                    collect_stmt_info(
                        inner,
                        index,
                        imports,
                        classes,
                        functions,
                        class_count,
                        function_count,
                        is_top_level,
                        parent_class_line,
                    );
                }
            } else {
                for inner in &if_stmt.body {
                    collect_stmt_info(
                        inner,
                        index,
                        imports,
                        classes,
                        functions,
                        class_count,
                        function_count,
                        is_top_level,
                        parent_class_line,
                    );
                }
                for inner in &if_stmt.orelse {
                    collect_stmt_info(
                        inner,
                        index,
                        imports,
                        classes,
                        functions,
                        class_count,
                        function_count,
                        is_top_level,
                        parent_class_line,
                    );
                }
            }
        }
        Stmt::Try(try_stmt) => {
            for inner in &try_stmt.body {
                collect_stmt_info(
                    inner,
                    index,
                    imports,
                    classes,
                    functions,
                    class_count,
                    function_count,
                    is_top_level,
                    parent_class_line,
                );
            }
            for handler in &try_stmt.handlers {
                let rustpython_ast::ExceptHandler::ExceptHandler(h) = handler;
                for inner in &h.body {
                    collect_stmt_info(
                        inner,
                        index,
                        imports,
                        classes,
                        functions,
                        class_count,
                        function_count,
                        is_top_level,
                        parent_class_line,
                    );
                }
            }
            for inner in &try_stmt.orelse {
                collect_stmt_info(
                    inner,
                    index,
                    imports,
                    classes,
                    functions,
                    class_count,
                    function_count,
                    is_top_level,
                    parent_class_line,
                );
            }
            for inner in &try_stmt.finalbody {
                collect_stmt_info(
                    inner,
                    index,
                    imports,
                    classes,
                    functions,
                    class_count,
                    function_count,
                    is_top_level,
                    parent_class_line,
                );
            }
        }
        _ => {}
    }
}

fn is_type_checking_condition(expr: &ast::Expr) -> bool {
    match expr {
        ast::Expr::Name(name) => name.id.as_str() == "TYPE_CHECKING",
        ast::Expr::Attribute(attr) => attr.attr.as_str() == "TYPE_CHECKING",
        _ => false,
    }
}

pub fn file_path_to_module_id(rel_path: &Path) -> String {
    let mut components: Vec<String> = rel_path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();

    if let Some(last) = components.last_mut() {
        if last.ends_with(".py") {
            *last = last.trim_end_matches(".py").to_string();
        }
        if last == "__init__" {
            components.pop();
        }
    }

    if components.is_empty() {
        return "root".to_string();
    }
    components.join(".")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_module_docstring_only_comes_from_first_statement() {
        let root = PathBuf::from("/project");
        let file = root.join("module.py");
        let documented =
            parse_python_source("\"\"\"Overview\nDetails\"\"\"\nvalue = 1\n", &file, &root)
                .unwrap();
        assert_eq!(documented.docstring.as_deref(), Some("Overview\nDetails"));

        let undocumented =
            parse_python_source("value = 1\n\"later string\"\n", &file, &root).unwrap();
        assert_eq!(undocumented.docstring, None);
    }

    #[test]
    fn test_parse_imports_and_metrics() {
        let code = r#"
import os
import sys as system
from collections import defaultdict, deque
from .local_mod import helper
from ..parent_pkg import base

class MyClass:
    def method(self):
        pass

def top_function():
    return 42
"#;
        let root = PathBuf::from("/project");
        let file = PathBuf::from("/project/mypkg/service.py");
        let mod_info = parse_python_source(code, &file, &root).expect("Parsing should succeed");

        assert_eq!(mod_info.id, "mypkg.service");
        assert_eq!(mod_info.class_count, 1);
        assert_eq!(
            mod_info.classes,
            vec![ClassInfo {
                name: "MyClass".to_string(),
                signature: "".to_string(),
                line: 8,
                parent_class_line: None,
                docstring: None,
            }]
        );
        assert_eq!(mod_info.function_count, 2); // 1 method + 1 top function
        assert_eq!(
            mod_info.functions,
            vec![
                FunctionInfo {
                    name: "method".to_string(),
                    signature: "(self)".to_string(),
                    line: 9,
                    parent_class_line: Some(8),
                    docstring: None,
                },
                FunctionInfo {
                    name: "top_function".to_string(),
                    signature: "()".to_string(),
                    line: 12,
                    parent_class_line: None,
                    docstring: None,
                },
            ]
        );
        assert_eq!(mod_info.imports.len(), 5);

        // Check relative import
        let local_import = mod_info
            .imports
            .iter()
            .find(|i| i.module == "local_mod")
            .unwrap();
        assert_eq!(local_import.level, 1);
        assert!(local_import.is_from);
    }

    #[test]
    fn test_file_path_to_module_id() {
        assert_eq!(file_path_to_module_id(Path::new("app/main.py")), "app.main");
        assert_eq!(
            file_path_to_module_id(Path::new("app/core/__init__.py")),
            "app.core"
        );
        assert_eq!(file_path_to_module_id(Path::new("main.py")), "main");
    }

    #[test]
    fn test_type_checking_imports_are_excluded() {
        let code = r#"
import os
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.circular_mod import HeavyType

if typing.TYPE_CHECKING:
    import app.another_type

class User:
    pass
"#;
        let root = PathBuf::from("/project");
        let file = PathBuf::from("/project/app/user.py");
        let mod_info = parse_python_source(code, &file, &root).expect("Parsing should succeed");

        // Only "os" and "typing" should be imported; TYPE_CHECKING blocks should be ignored
        assert_eq!(mod_info.imports.len(), 2);
        assert!(mod_info.imports.iter().any(|i| i.module == "os"));
        assert!(mod_info.imports.iter().any(|i| i.module == "typing"));
        assert!(!mod_info
            .imports
            .iter()
            .any(|i| i.module == "app.circular_mod"));
        assert!(!mod_info
            .imports
            .iter()
            .any(|i| i.module == "app.another_type"));
    }

    #[test]
    fn test_function_level_imports_are_not_top_level() {
        let code = r#"
import top_module

def my_func():
    from app.deferred import deferred_func
    import app.helper

class MyClass:
    def method(self):
        import app.method_import
"#;
        let root = PathBuf::from("/project");
        let file = PathBuf::from("/project/app/test.py");
        let mod_info = parse_python_source(code, &file, &root).expect("Parsing should succeed");

        assert_eq!(mod_info.imports.len(), 4);
        let top = mod_info
            .imports
            .iter()
            .find(|i| i.module == "top_module")
            .unwrap();
        assert!(top.is_top_level);

        let def_imp = mod_info
            .imports
            .iter()
            .find(|i| i.module == "app.deferred")
            .unwrap();
        assert!(!def_imp.is_top_level);

        let helper = mod_info
            .imports
            .iter()
            .find(|i| i.module == "app.helper")
            .unwrap();
        assert!(!helper.is_top_level);

        let method_imp = mod_info
            .imports
            .iter()
            .find(|i| i.module == "app.method_import")
            .unwrap();
        assert!(!method_imp.is_top_level);
    }

    #[test]
    fn test_async_functions_are_listed() {
        let root = PathBuf::from("/project");
        let file = root.join("module.py");
        let mod_info = parse_python_source("async def fetch():\n    pass\n", &file, &root).unwrap();
        assert_eq!(
            mod_info.functions,
            vec![FunctionInfo {
                name: "fetch".to_string(),
                signature: "()".to_string(),
                line: 1,
                parent_class_line: None,
                docstring: None,
            }]
        );
    }

    #[test]
    fn test_symbol_calls_are_extracted() {
        let root = PathBuf::from("/project");
        let file = PathBuf::from("/project/app/service.py");
        let module = parse_python_source(
            "def run():\n    helper()\n\ndef helper():\n    print('ok')\n",
            &file,
            &root,
        )
        .unwrap();
        assert!(module.symbols.iter().any(|symbol| symbol.name == "run"));
        assert!(module
            .symbol_calls
            .iter()
            .any(|call| call.caller == "run" && call.callee == "helper" && call.line == 2));
    }

    #[test]
    fn test_cyclomatic_complexity_counts_branches_and_conditions() {
        let root = PathBuf::from("/project");
        let file = PathBuf::from("/project/logic.py");
        let module = parse_python_source("def run(value):\n    if value and value > 0:\n        return 1\n    for item in []:\n        print(item)\n    return 0\n", &file, &root).unwrap();
        assert_eq!(module.cyclomatic_complexity, 4);
    }

    #[test]
    fn test_security_diagnostics_detect_dynamic_execution() {
        let root = PathBuf::from("/project");
        let file = PathBuf::from("/project/risky.py");
        let module =
            parse_python_source("value = eval(source)\nexec(value)\n", &file, &root).unwrap();
        assert_eq!(
            module
                .diagnostics
                .iter()
                .filter(|d| d.rule.as_deref() == Some("security-dynamic-exec"))
                .count(),
            2
        );
    }

    #[test]
    fn test_nested_classes_and_module_functions_have_correct_parents() {
        let root = PathBuf::from("/project");
        let file = root.join("module.py");
        let code = "class Outer:\n    def method(self):\n        pass\n    class Inner:\n        async def nested(self):\n            pass\ndef helper():\n    pass\n";
        let mod_info = parse_python_source(code, &file, &root).unwrap();

        assert_eq!(mod_info.classes[0].parent_class_line, None);
        assert_eq!(mod_info.classes[1].parent_class_line, Some(1));
        assert_eq!(mod_info.functions[0].parent_class_line, Some(1));
        assert_eq!(mod_info.functions[1].parent_class_line, Some(4));
        assert_eq!(mod_info.functions[2].parent_class_line, None);
    }
}
