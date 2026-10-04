use crate::duplicate_filter::{actionable_line_count, actionable_lines, is_generated_file};
use crate::model::{Diagnostic, DiagnosticSeverity, DuplicateBlock, LiteralFinding, ModuleInfo};
use rustpython_ast::{self as ast, Visitor};
use rustpython_parser::{source_code::LineIndex, Parse};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const TOOL_TIMEOUT: Duration = Duration::from_secs(20);
const LIZARD_SCRIPT: &str = r#"
import json, sys
import lizard
files = json.load(sys.stdin)
result = []
for path in files:
    info = lizard.analyze_file(path)
    result.append({"path": path, "functions": [
        {"name": item.name, "line": item.start_line,
         "ccn": item.cyclomatic_complexity} for item in info.function_list]})
json.dump(result, sys.stdout)
"#;

#[derive(Clone)]
pub struct FunctionMetric {
    pub name: String,
    pub line: usize,
    pub ccn: usize,
}

pub struct CloneReport {
    pub duplicated: Vec<HashSet<usize>>,
    pub blocks: Vec<DuplicateBlock>,
}

pub struct QualityData {
    pub functions: HashMap<String, Vec<FunctionMetric>>,
    pub function_source: String,
    pub clones: Option<CloneReport>,
    pub literals: Vec<LiteralFinding>,
    pub warnings: Vec<String>,
    pub magic_source: String,
    pub type_diagnostics: Vec<(usize, Diagnostic)>,
}

pub fn collect(root: &Path, modules: &[ModuleInfo], jscpd_override: Option<&Path>) -> QualityData {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut warnings = Vec::new();
    let (functions, function_source) = match run_lizard(&root, modules, &mut warnings) {
        Some(functions) => (functions, "Lizard".to_string()),
        None => (builtin_function_metrics(modules), "ModuleLoom".to_string()),
    };
    let clones = run_jscpd(&root, modules, jscpd_override, &mut warnings);
    let mut literals = repeated_literals(modules);
    let magic = run_ruff(&root, modules, &mut warnings);
    let type_diagnostics = run_ty(&root, modules, &mut warnings);
    let magic_source = if magic.is_some() {
        "Ruff".to_string()
    } else {
        String::new()
    };
    literals.extend(magic.unwrap_or_default());
    literals.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.module.cmp(&b.module)));
    literals.truncate(30);
    QualityData {
        functions,
        function_source,
        clones,
        literals,
        warnings,
        magic_source,
        type_diagnostics,
    }
}

#[derive(Deserialize)]
struct TyIssue {
    description: String,
    check_name: String,
    severity: String,
    location: TyLocation,
}

#[derive(Deserialize)]
struct TyLocation {
    path: String,
    lines: Option<TyLines>,
    positions: Option<TyPositions>,
}

#[derive(Deserialize)]
struct TyLines {
    begin: usize,
}

#[derive(Deserialize)]
struct TyPositions {
    begin: TyPosition,
}

#[derive(Deserialize)]
struct TyPosition {
    line: usize,
}

fn map_ty_report(
    root: &Path,
    modules: &[ModuleInfo],
    bytes: &[u8],
) -> Option<Vec<(usize, Diagnostic)>> {
    let issues: Vec<TyIssue> = serde_json::from_slice(bytes).ok()?;
    let indexes = module_paths(modules);
    Some(
        issues
            .into_iter()
            .filter_map(|issue| {
                let index = module_index(root, &issue.location.path, &indexes)?;
                let line = issue.location.lines.map(|lines| lines.begin).or_else(|| {
                    issue
                        .location
                        .positions
                        .map(|positions| positions.begin.line)
                })?;
                Some((
                    index,
                    Diagnostic {
                        severity: match issue.severity.as_str() {
                            "blocker" | "critical" | "major" => DiagnosticSeverity::Error,
                            "info" => DiagnosticSeverity::Info,
                            _ => DiagnosticSeverity::Warning,
                        },
                        message: issue.description,
                        line: Some(line),
                        rule: Some(format!("ty/{}", issue.check_name)),
                    },
                ))
            })
            .collect(),
    )
}

fn run_ty(
    root: &Path,
    modules: &[ModuleInfo],
    warnings: &mut Vec<String>,
) -> Vec<(usize, Diagnostic)> {
    let Some(executable) = executable(root, "ty") else {
        warnings.push("ty was not found; type checking was skipped".into());
        return Vec::new();
    };
    let mut command = Command::new(executable);
    command
        .current_dir(root)
        .args(["check", "--output-format", "gitlab", "--no-progress"])
        .arg(root);
    let Some(bytes) = run_command(command, None, &[0, 1]) else {
        warnings.push("ty type checking did not complete".into());
        return Vec::new();
    };
    match map_ty_report(root, modules, &bytes) {
        Some(diagnostics) => diagnostics,
        None => {
            warnings.push("ty GitLab report could not be read".into());
            Vec::new()
        }
    }
}

fn executable(root: &Path, name: &str) -> Option<PathBuf> {
    if name == "jscpd" {
        if let Some(path) = std::env::var_os("MODULELOOM_JSCPD_PATH").map(PathBuf::from) {
            if path.is_file() {
                return Some(path);
            }
        }
        let filename = if cfg!(windows) { "jscpd.exe" } else { "jscpd" };
        if let Some(path) = std::env::current_exe()
            .ok()
            .and_then(|binary| binary.parent().map(|directory| directory.join(filename)))
            .filter(|path| path.is_file())
        {
            return Some(path);
        }
    }
    let names = if cfg!(windows) {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    };
    for project in std::iter::once(root).chain(root.parent()) {
        for base in [
            project.join(".venv/bin"),
            project.join("venv/bin"),
            project.join(".venv/Scripts"),
            project.join("venv/Scripts"),
            project.join("node_modules/.bin"),
        ] {
            for candidate in &names {
                let path = base.join(candidate);
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|path| path.is_file())
}

fn run_command(mut command: Command, input: Option<&[u8]>, accepted: &[i32]) -> Option<Vec<u8>> {
    let mut output = tempfile::tempfile().ok()?;
    command
        .stdout(Stdio::from(output.try_clone().ok()?))
        .stderr(Stdio::null());
    if let Some(input) = input {
        let mut stdin = tempfile::tempfile().ok()?;
        stdin.write_all(input).ok()?;
        stdin.seek(SeekFrom::Start(0)).ok()?;
        command.stdin(Stdio::from(stdin));
    } else {
        command.stdin(Stdio::null());
    }
    let mut child = command.spawn().ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !accepted.contains(&status.code().unwrap_or(-1)) {
                    return None;
                }
                output.seek(SeekFrom::Start(0)).ok()?;
                let mut bytes = Vec::new();
                output.read_to_end(&mut bytes).ok()?;
                return Some(bytes);
            }
            Ok(None) if started.elapsed() < TOOL_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn module_paths(modules: &[ModuleInfo]) -> HashMap<PathBuf, usize> {
    modules
        .iter()
        .enumerate()
        .filter_map(|(index, module)| Some((module.absolute_path.canonicalize().ok()?, index)))
        .collect()
}

fn module_index(root: &Path, path: &str, paths: &HashMap<PathBuf, usize>) -> Option<usize> {
    let path = Path::new(path);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    paths.get(&absolute.canonicalize().ok()?).copied()
}

#[derive(Deserialize)]
struct LizardFile {
    path: String,
    functions: Vec<LizardFunction>,
}
#[derive(Deserialize)]
struct LizardFunction {
    name: String,
    line: usize,
    ccn: usize,
}

struct FunctionCollector<'a> {
    index: &'a LineIndex,
    context: Vec<String>,
    metrics: Vec<FunctionMetric>,
}

impl FunctionCollector<'_> {
    fn record(&mut self, name: &str, line: usize, body: &[ast::Stmt]) {
        let mut visitor = FunctionBodyComplexity { ccn: 1 };
        for statement in body {
            visitor.visit_stmt(statement.clone());
        }
        let name = if self.context.is_empty() {
            name.to_string()
        } else {
            format!("{}.{}", self.context.join("."), name)
        };
        self.metrics.push(FunctionMetric {
            name,
            line,
            ccn: visitor.ccn,
        });
    }
}

impl Visitor for FunctionCollector<'_> {
    fn visit_stmt_class_def(&mut self, node: ast::StmtClassDef) {
        self.context.push(node.name.to_string());
        self.generic_visit_stmt_class_def(node);
        self.context.pop();
    }

    fn visit_stmt_function_def(&mut self, node: ast::StmtFunctionDef) {
        let line = self.index.line_index(node.range.start()).get() as usize;
        self.record(node.name.as_str(), line, &node.body);
        self.context.push(node.name.to_string());
        self.generic_visit_stmt_function_def(node);
        self.context.pop();
    }

    fn visit_stmt_async_function_def(&mut self, node: ast::StmtAsyncFunctionDef) {
        let line = self.index.line_index(node.range.start()).get() as usize;
        self.record(node.name.as_str(), line, &node.body);
        self.context.push(node.name.to_string());
        self.generic_visit_stmt_async_function_def(node);
        self.context.pop();
    }
}

struct FunctionBodyComplexity {
    ccn: usize,
}

impl Visitor for FunctionBodyComplexity {
    fn visit_stmt_function_def(&mut self, _node: ast::StmtFunctionDef) {}
    fn visit_stmt_async_function_def(&mut self, _node: ast::StmtAsyncFunctionDef) {}
    fn visit_stmt_class_def(&mut self, _node: ast::StmtClassDef) {}
    fn visit_stmt_if(&mut self, node: ast::StmtIf) {
        self.ccn += 1;
        self.generic_visit_stmt_if(node);
    }
    fn visit_stmt_for(&mut self, node: ast::StmtFor) {
        self.ccn += 1;
        self.generic_visit_stmt_for(node);
    }
    fn visit_stmt_async_for(&mut self, node: ast::StmtAsyncFor) {
        self.ccn += 1;
        self.generic_visit_stmt_async_for(node);
    }
    fn visit_stmt_while(&mut self, node: ast::StmtWhile) {
        self.ccn += 1;
        self.generic_visit_stmt_while(node);
    }
    fn visit_stmt_try(&mut self, node: ast::StmtTry) {
        self.ccn += node.handlers.len();
        self.generic_visit_stmt_try(node);
    }
    fn visit_expr_bool_op(&mut self, node: ast::ExprBoolOp) {
        self.ccn += node.values.len().saturating_sub(1);
        self.generic_visit_expr_bool_op(node);
    }
}

fn builtin_function_metrics(modules: &[ModuleInfo]) -> HashMap<String, Vec<FunctionMetric>> {
    let mut result = HashMap::new();
    for module in modules {
        let Ok(source) = fs::read_to_string(&module.absolute_path) else {
            continue;
        };
        let Ok(suite) = ast::Suite::parse(&source, &module.relative_path) else {
            continue;
        };
        let index = LineIndex::from_source_text(&source);
        let mut collector = FunctionCollector {
            index: &index,
            context: Vec::new(),
            metrics: Vec::new(),
        };
        for statement in suite {
            collector.visit_stmt(statement);
        }
        result.insert(module.id.clone(), collector.metrics);
    }
    result
}

fn run_lizard(
    root: &Path,
    modules: &[ModuleInfo],
    warnings: &mut Vec<String>,
) -> Option<HashMap<String, Vec<FunctionMetric>>> {
    let interpreters: Vec<_> = ["python", "python3"]
        .iter()
        .filter_map(|name| executable(root, name))
        .collect();
    if interpreters.is_empty() {
        warnings
            .push("Python interpreter was not found; built-in complexity estimate was used".into());
        return None;
    }
    let paths: Vec<_> = modules
        .iter()
        .filter_map(|module| module.absolute_path.canonicalize().ok())
        .collect();
    let input = serde_json::to_vec(&paths).ok()?;
    let indexes = module_paths(modules);
    for python in interpreters {
        let mut command = Command::new(python);
        command.current_dir(root).args(["-I", "-c", LIZARD_SCRIPT]);
        if let Some(bytes) = run_command(command, Some(&input), &[0]) {
            if let Ok(files) = serde_json::from_slice::<Vec<LizardFile>>(&bytes) {
                let mut result: HashMap<String, Vec<FunctionMetric>> = HashMap::new();
                for file in files {
                    let Some(index) = module_index(root, &file.path, &indexes) else {
                        continue;
                    };
                    let id = modules[index].id.clone();
                    for function in file.functions {
                        if function.line == 0 {
                            continue;
                        }
                        result.entry(id.clone()).or_default().push(FunctionMetric {
                            name: function.name.clone(),
                            line: function.line,
                            ccn: function.ccn,
                        });
                    }
                }
                return Some(result);
            }
        }
    }
    warnings.push("Lizard could not be loaded from the available Python environments".into());
    None
}

#[derive(Deserialize)]
struct JscpdPosition {
    name: String,
    start: usize,
}
#[derive(Deserialize)]
struct JscpdDuplicate {
    lines: usize,
    #[serde(default)]
    kind: String,
    #[serde(rename = "firstFile")]
    first: JscpdPosition,
    #[serde(rename = "secondFile")]
    second: JscpdPosition,
}
#[derive(Deserialize)]
struct JscpdReport {
    duplicates: Vec<JscpdDuplicate>,
}

fn run_jscpd(
    root: &Path,
    modules: &[ModuleInfo],
    jscpd_override: Option<&Path>,
    warnings: &mut Vec<String>,
) -> Option<CloneReport> {
    let Some(executable) = jscpd_override
        .filter(|path| path.is_file())
        .map(Path::to_path_buf)
        .or_else(|| executable(root, "jscpd"))
    else {
        warnings.push("jscpd was not found; built-in duplicate detection was used".into());
        return None;
    };
    let mut version_command = Command::new(&executable);
    version_command.arg("--version");
    let version = run_command(version_command, None, &[0])
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default();
    if !version.trim().starts_with("jscpd 5.") {
        warnings.push("jscpd v5 was not available; built-in duplicate detection was used".into());
        return None;
    }
    let output_dir = tempfile::tempdir().ok()?;
    let mut command = Command::new(executable);
    command
        .current_dir(root)
        .args(["--reporters", "json", "--output"])
        .arg(output_dir.path())
        .args([
            "--format",
            "python",
            "--min-lines",
            "6",
            "--min-tokens",
            "30",
            "--ignore-identifiers",
            "--silent",
            "--absolute",
        ])
        .arg(root);
    if run_command(command, None, &[0, 1]).is_none() {
        warnings.push("jscpd did not complete; built-in duplicate detection was used".into());
        return None;
    }
    let report = fs::read(output_dir.path().join("jscpd-report.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<JscpdReport>(&bytes).ok());
    let Some(report) = report else {
        warnings.push(
            "jscpd JSON report could not be read; built-in duplicate detection was used".into(),
        );
        return None;
    };
    Some(map_jscpd_report(root, modules, report))
}

fn map_jscpd_report(root: &Path, modules: &[ModuleInfo], report: JscpdReport) -> CloneReport {
    let indexes = module_paths(modules);
    let actionable: Vec<Vec<bool>> = modules
        .iter()
        .map(|module| {
            fs::read_to_string(&module.absolute_path)
                .map(|source| {
                    if is_generated_file(Path::new(&module.relative_path), &source) {
                        vec![false; source.lines().count()]
                    } else {
                        actionable_lines(&source)
                    }
                })
                .unwrap_or_default()
        })
        .collect();
    let mut duplicated = vec![HashSet::new(); modules.len()];
    let mut blocks = Vec::new();
    let mut duplicates = report.duplicates;
    duplicates.sort_by(|a, b| b.lines.cmp(&a.lines));
    for item in duplicates {
        let (Some(first), Some(second)) = (
            module_index(root, &item.first.name, &indexes),
            module_index(root, &item.second.name, &indexes),
        ) else {
            continue;
        };
        if item.lines == 0 || item.first.start == 0 || item.second.start == 0 {
            continue;
        }
        if first == second && item.first.start.abs_diff(item.second.start) < item.lines {
            continue;
        }
        if actionable_line_count(&actionable[first], item.first.start, item.lines) < 5
            || actionable_line_count(&actionable[second], item.second.start, item.lines) < 5
        {
            continue;
        }
        for (index, start) in [(first, item.first.start), (second, item.second.start)] {
            for line in start
                ..start
                    .saturating_add(item.lines)
                    .min(actionable[index].len() + 1)
            {
                if actionable[index][line - 1] {
                    duplicated[index].insert(line);
                }
            }
        }
        if blocks.len() < 20 {
            blocks.push(DuplicateBlock {
                first_module: modules[first].id.clone(),
                first_line: item.first.start,
                second_module: modules[second].id.clone(),
                second_line: item.second.start,
                lines: item.lines,
                kind: if item.kind == "renamed" {
                    "renamed"
                } else {
                    "exact"
                }
                .into(),
                first_function: None,
                second_function: None,
                first_signature: None,
                second_signature: None,
            });
        }
    }
    CloneReport { duplicated, blocks }
}

#[derive(Deserialize)]
struct RuffLocation {
    row: usize,
}
#[derive(Deserialize)]
struct RuffIssue {
    code: String,
    message: String,
    filename: String,
    location: RuffLocation,
}

fn run_ruff(
    root: &Path,
    modules: &[ModuleInfo],
    warnings: &mut Vec<String>,
) -> Option<Vec<LiteralFinding>> {
    let Some(executable) = executable(root, "ruff") else {
        warnings.push("Ruff was not found; comparison magic numbers were not checked".into());
        return None;
    };
    let mut command = Command::new(executable);
    command
        .current_dir(root)
        .args([
            "check",
            "--select",
            "PLR2004",
            "--output-format",
            "json",
            "--no-cache",
        ])
        .arg(root);
    let Some(bytes) = run_command(command, None, &[0, 1]) else {
        warnings.push("Ruff magic-value analysis did not complete".into());
        return None;
    };
    let Ok(issues) = serde_json::from_slice::<Vec<RuffIssue>>(&bytes) else {
        warnings.push("Ruff JSON report could not be read".into());
        return None;
    };
    let indexes = module_paths(modules);
    Some(
        issues
            .into_iter()
            .filter_map(|issue| {
                if issue.code != "PLR2004" {
                    return None;
                }
                let index = module_index(root, &issue.filename, &indexes)?;
                Some(LiteralFinding {
                    kind: "magic-number".into(),
                    module: modules[index].id.clone(),
                    line: issue.location.row,
                    value: issue.message,
                    count: 1,
                })
            })
            .collect(),
    )
}

struct LiteralCollector<'a> {
    index: &'a LineIndex,
    values: Vec<(String, String, usize)>,
}
impl Visitor for LiteralCollector<'_> {
    fn visit_expr_constant(&mut self, node: ast::ExprConstant) {
        let literal = match node.value {
            ast::Constant::Str(value) if value.chars().count() >= 8 && !value.trim().is_empty() => {
                Some(("repeated-string".to_string(), value))
            }
            ast::Constant::Int(value) if value.to_string() != "0" && value.to_string() != "1" => {
                Some(("repeated-number".to_string(), value.to_string()))
            }
            ast::Constant::Float(value) if value != 0.0 && value != 1.0 => {
                Some(("repeated-number".to_string(), value.to_string()))
            }
            _ => None,
        };
        if let Some((kind, value)) = literal {
            self.values.push((
                kind,
                value,
                self.index.line_index(node.range.start()).get() as usize,
            ));
        }
    }
}

fn repeated_literals(modules: &[ModuleInfo]) -> Vec<LiteralFinding> {
    let mut groups: HashMap<(String, String), Vec<(String, usize)>> = HashMap::new();
    for module in modules {
        let Ok(source) = fs::read_to_string(&module.absolute_path) else {
            continue;
        };
        let Ok(ast) = ast::Suite::parse(&source, &module.relative_path) else {
            continue;
        };
        let index = LineIndex::from_source_text(&source);
        let mut visitor = LiteralCollector {
            index: &index,
            values: Vec::new(),
        };
        for statement in ast {
            visitor.visit_stmt(statement);
        }
        for (kind, value, line) in visitor.values {
            groups
                .entry((kind, value))
                .or_default()
                .push((module.id.clone(), line));
        }
    }
    let mut findings = Vec::new();
    for ((kind, value), locations) in groups {
        if locations.len() < 3 {
            continue;
        }
        for (module, line) in locations.iter().take(5) {
            findings.push(LiteralFinding {
                kind: kind.clone(),
                module: module.clone(),
                line: *line,
                value: value.chars().take(80).collect(),
                count: locations.len(),
            });
        }
    }
    findings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_ty_diagnostics_to_analyzed_files() {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("example.py"),
            "def answer() -> int:\n    return 'wrong'\n",
        )
        .unwrap();
        let modules = crate::analyze_directory(root.path()).unwrap().modules;
        let report = br#"[{"description":"Return type mismatch","check_name":"invalid-return-type","severity":"major","location":{"path":"example.py","positions":{"begin":{"line":2,"column":5}}}},{"description":"Outside project","check_name":"invalid-return-type","severity":"major","location":{"path":"outside.py","lines":{"begin":1}}}]"#;
        let diagnostics = map_ty_report(root.path(), &modules, report).unwrap();
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].0, 0);
        assert_eq!(diagnostics[0].1.line, Some(2));
        assert_eq!(
            diagnostics[0].1.rule.as_deref(),
            Some("ty/invalid-return-type")
        );
        assert_eq!(diagnostics[0].1.severity, DiagnosticSeverity::Error);
    }

    #[test]
    fn repeated_numbers_skip_common_constants() {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("values.py"),
            "A = 42\nB = 42\nC = 42\nX = 0\nY = 0\nZ = 0\n",
        )
        .unwrap();
        let modules = crate::analyze_directory(root.path()).unwrap().modules;
        let findings = repeated_literals(&modules);
        assert!(findings
            .iter()
            .any(|item| item.kind == "repeated-number" && item.value == "42" && item.count == 3));
        assert!(!findings.iter().any(|item| item.value == "0"));
    }

    #[test]
    fn maps_jscpd_json_locations_to_analyzed_modules() {
        let root = tempfile::tempdir().unwrap();
        let source = "def first():\n    a = 1\n    b = 2\n    c = 3\n    d = 4\n    e = 5\n    return a + b + c + d + e\n";
        fs::write(root.path().join("a.py"), source).unwrap();
        fs::write(root.path().join("b.py"), source).unwrap();
        let modules = crate::analyze_directory(root.path()).unwrap().modules;
        let report: JscpdReport = serde_json::from_value(serde_json::json!({
            "duplicates": [{
                "lines": 6,
                "kind": "renamed",
                "firstFile": {"name": "a.py", "start": 2, "end": 7},
                "secondFile": {"name": "b.py", "start": 2, "end": 7}
            }, {
                "lines": 6,
                "kind": "renamed",
                "firstFile": {"name": "a.py", "start": 1, "end": 6},
                "secondFile": {"name": "a.py", "start": 2, "end": 7}
            }]
        }))
        .unwrap();
        let mapped = map_jscpd_report(root.path(), &modules, report);
        assert_eq!(mapped.blocks.len(), 1);
        assert_eq!(mapped.blocks[0].first_module, "a");
        assert_eq!(mapped.blocks[0].second_module, "b");
        assert_eq!(mapped.blocks[0].kind, "renamed");
        assert_eq!(
            mapped.duplicated.iter().map(HashSet::len).sum::<usize>(),
            12
        );
    }

    #[test]
    fn ignores_jscpd_import_only_matches() {
        let root = tempfile::tempdir().unwrap();
        let source = "from pathlib import (\n    Path,\n    PurePath,\n)\nimport os\nimport sys\nvalue = 1\n";
        fs::write(root.path().join("a.py"), source).unwrap();
        fs::write(root.path().join("b.py"), source).unwrap();
        let modules = crate::analyze_directory(root.path()).unwrap().modules;
        let report: JscpdReport = serde_json::from_value(serde_json::json!({
            "duplicates": [{
                "lines": 6,
                "kind": "exact",
                "firstFile": {"name": "a.py", "start": 1, "end": 6},
                "secondFile": {"name": "b.py", "start": 1, "end": 6}
            }]
        }))
        .unwrap();
        let mapped = map_jscpd_report(root.path(), &modules, report);
        assert!(mapped.blocks.is_empty());
        assert!(mapped.duplicated.iter().all(HashSet::is_empty));
    }
}
