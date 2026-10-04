use crate::model::{DependencyIssue, ModuleInfo, PackageDependency};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Default)]
struct Manifest {
    direct: HashSet<String>,
    development: HashSet<String>,
    optional: HashSet<String>,
    installed: HashSet<String>,
    packages: Vec<PackageDependency>,
    present: bool,
}

pub fn scan_package_dependencies(root: &Path) -> Vec<PackageDependency> {
    read_manifest(root).packages
}

pub fn check_package_dependencies(root: &Path, modules: &[ModuleInfo]) -> Vec<DependencyIssue> {
    let manifest = read_manifest(root);
    if !manifest.present {
        return Vec::new();
    }
    let (import_map, ignored) = dependency_options(root);
    let internal: HashSet<_> = modules
        .iter()
        .map(|module| module.id.split('.').next().unwrap_or("").to_string())
        .collect();
    let mut imports: HashMap<String, (String, bool)> = HashMap::new();
    for module in modules {
        let development = is_development_file(&module.relative_path);
        for import in &module.imports {
            if import.level != 0 {
                continue;
            }
            let name = import.module.split('.').next().unwrap_or("");
            if name.is_empty() || internal.contains(name) || is_stdlib(name) {
                continue;
            }
            let import_name = normalize(name);
            let package_name = import_map.get(&import_name).cloned().unwrap_or(import_name);
            imports
                .entry(package_name)
                .and_modify(|entry| entry.1 &= development)
                .or_insert((module.id.clone(), development));
        }
    }
    let mut issues = Vec::new();
    for (name, (module, only_development)) in &imports {
        if manifest.direct.contains(name) {
            continue;
        }
        if manifest.development.contains(name) {
            if !only_development {
                issues.push(issue(
                    "DEP004",
                    name,
                    Some(module),
                    "開発用依存を本番コードで使用しています",
                ));
            }
        } else if manifest.installed.contains(name) {
            issues.push(issue(
                "DEP003",
                name,
                Some(module),
                "推移的依存を直接 import しています",
            ));
        } else {
            issues.push(issue(
                "DEP001",
                name,
                Some(module),
                "import されていますが依存宣言にありません",
            ));
        }
    }
    for name in &manifest.direct {
        if is_stdlib(name) {
            issues.push(issue(
                "DEP005",
                name,
                None,
                "標準ライブラリを依存宣言に含めています",
            ));
        } else if !manifest.optional.contains(name) && !imports.contains_key(name) {
            issues.push(issue(
                "DEP002",
                name,
                None,
                "宣言されていますがコードから import されていません",
            ));
        }
    }
    issues.retain(|issue| !ignored.contains(&issue.package));
    issues.sort_by(|a, b| (&a.rule, &a.package).cmp(&(&b.rule, &b.package)));
    issues
}

fn is_development_file(path: &str) -> bool {
    let path = path.replace('\\', "/");
    let parts: Vec<_> = path.split('/').collect();
    let file = parts.last().copied().unwrap_or("");
    parts[..parts.len().saturating_sub(1)]
        .iter()
        .any(|part| matches!(*part, "tests" | "test" | "testing"))
        || file.starts_with("test_")
        || file.ends_with("_test.py")
        || matches!(file, "conftest.py" | "noxfile.py" | "toxfile.py")
}

fn dependency_options(root: &Path) -> (HashMap<String, String>, HashSet<String>) {
    let Ok(content) = fs::read_to_string(root.join("moduleloom.toml")) else {
        return (HashMap::new(), HashSet::new());
    };
    let Ok(doc) = content.parse::<toml::Value>() else {
        return (HashMap::new(), HashSet::new());
    };
    let Some(deps) = doc.get("dependencies") else {
        return (HashMap::new(), HashSet::new());
    };
    let import_map = deps
        .get("import_map")
        .and_then(toml::Value::as_table)
        .map(|table| {
            table
                .iter()
                .filter_map(|(key, value)| Some((normalize(key), normalize(value.as_str()?))))
                .collect()
        })
        .unwrap_or_default();
    let ignored = deps
        .get("ignore")
        .and_then(toml::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(toml::Value::as_str)
                .map(normalize)
                .collect()
        })
        .unwrap_or_default();
    (import_map, ignored)
}

fn issue(rule: &str, package: &str, module: Option<&String>, message: &str) -> DependencyIssue {
    DependencyIssue {
        rule: rule.into(),
        package: package.into(),
        module: module.cloned(),
        message: message.into(),
    }
}

fn read_manifest(root: &Path) -> Manifest {
    let mut result = Manifest::default();
    let mut visited = HashSet::new();
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    for (name, development) in [
        ("requirements.txt", false),
        ("requirements.in", false),
        ("dev-requirements.txt", true),
        ("requirements-dev.txt", true),
    ] {
        read_requirements(
            &canonical_root,
            &root.join(name),
            development,
            &mut visited,
            &mut result,
        );
    }
    if let Ok(content) = fs::read_to_string(root.join("pyproject.toml")) {
        if let Ok(doc) = content.parse::<toml::Value>() {
            if let Some(deps) = doc
                .get("project")
                .and_then(|v| v.get("dependencies"))
                .and_then(toml::Value::as_array)
            {
                result.present = true;
                for dep in deps.iter().filter_map(toml::Value::as_str) {
                    if let Some((name, version)) = parse_requirement(dep) {
                        add_package(&mut result, name, version, "pyproject.toml", false);
                    }
                }
            }
            if let Some(groups) = doc
                .get("project")
                .and_then(|v| v.get("optional-dependencies"))
                .and_then(toml::Value::as_table)
            {
                result.present = true;
                for (group, deps) in groups {
                    for dep in deps
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(toml::Value::as_str)
                    {
                        if let Some((name, version)) = parse_requirement(dep) {
                            result.optional.insert(normalize(&name));
                            add_package(
                                &mut result,
                                name,
                                version,
                                &format!("pyproject.toml:extra:{group}"),
                                false,
                            );
                        }
                    }
                }
            }
            if let Some(groups) = doc.get("dependency-groups").and_then(toml::Value::as_table) {
                result.present = true;
                for (group, deps) in groups {
                    for dep in deps
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(toml::Value::as_str)
                    {
                        if let Some((name, version)) = parse_requirement(dep) {
                            add_package(
                                &mut result,
                                name,
                                version,
                                &format!("pyproject.toml:{group}"),
                                true,
                            );
                        }
                    }
                }
            }
            if let Some(deps) = doc
                .get("tool")
                .and_then(|v| v.get("poetry"))
                .and_then(|v| v.get("dependencies"))
                .and_then(toml::Value::as_table)
            {
                result.present = true;
                for (name, value) in deps {
                    if name != "python" {
                        add_package(
                            &mut result,
                            name.clone(),
                            value.as_str().map(str::to_string),
                            "pyproject.toml:poetry",
                            false,
                        );
                    }
                }
            }
            if let Some(deps) = doc
                .get("tool")
                .and_then(|v| v.get("poetry"))
                .and_then(|v| v.get("group"))
                .and_then(toml::Value::as_table)
            {
                result.present = true;
                for (group, value) in deps {
                    if !matches!(group.as_str(), "dev" | "test" | "testing") {
                        continue;
                    }
                    if let Some(deps) = value.get("dependencies").and_then(toml::Value::as_table) {
                        for (name, value) in deps {
                            add_package(
                                &mut result,
                                name.clone(),
                                value.as_str().map(str::to_string),
                                &format!("pyproject.toml:{group}"),
                                true,
                            );
                        }
                    }
                }
            }
        }
    }
    if let Ok(content) = fs::read_to_string(root.join("uv.lock")) {
        if let Ok(doc) = content.parse::<toml::Value>() {
            for package in doc
                .get("package")
                .and_then(toml::Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(name) = package.get("name").and_then(toml::Value::as_str) {
                    result.installed.insert(normalize(name));
                    result.packages.push(PackageDependency {
                        name: name.into(),
                        version: package
                            .get("version")
                            .and_then(toml::Value::as_str)
                            .map(str::to_string),
                        source: "uv.lock".into(),
                    });
                }
            }
        }
    }
    result
        .packages
        .sort_by(|a, b| (&a.name, &a.source).cmp(&(&b.name, &b.source)));
    result
        .packages
        .dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name) && a.source == b.source);
    result
}

fn read_requirements(
    root: &Path,
    path: &Path,
    development: bool,
    visited: &mut HashSet<(PathBuf, bool)>,
    manifest: &mut Manifest,
) {
    let Ok(path) = path.canonicalize() else {
        return;
    };
    if !visited.insert((path.clone(), development)) {
        return;
    }
    let Ok(content) = fs::read_to_string(&path) else {
        return;
    };
    manifest.present = true;
    let source = path
        .strip_prefix(root)
        .unwrap_or(&path)
        .to_string_lossy()
        .to_string();
    for line in content.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if let Some(include) = line
            .strip_prefix("-r ")
            .or_else(|| line.strip_prefix("--requirement "))
        {
            if let Some(parent) = path.parent() {
                read_requirements(
                    root,
                    &parent.join(include.trim()),
                    development,
                    visited,
                    manifest,
                );
            }
        } else if let Some((name, version)) = parse_requirement(line) {
            add_package(manifest, name, version, &source, development);
        }
    }
}

fn add_package(
    result: &mut Manifest,
    name: String,
    version: Option<String>,
    source: &str,
    development: bool,
) {
    if development {
        result.development.insert(normalize(&name));
    } else {
        result.direct.insert(normalize(&name));
    }
    result.packages.push(PackageDependency {
        name,
        version,
        source: source.into(),
    });
}

fn normalize(name: &str) -> String {
    let value = name.to_ascii_lowercase().replace(['-', '_', '.'], "");
    match value.as_str() {
        "pyyaml" => "yaml".into(),
        "pillow" => "pil".into(),
        "beautifulsoup4" => "bs4".into(),
        "opencvpython" => "cv2".into(),
        "scikitlearn" => "sklearn".into(),
        _ => value,
    }
}

fn parse_requirement(value: &str) -> Option<(String, Option<String>)> {
    let value = value.split('#').next()?.trim();
    if value.is_empty() || value.starts_with('-') {
        return None;
    }
    let end = value
        .find(|c: char| matches!(c, '<' | '>' | '=' | '!' | '~' | ';' | '[' | ' '))
        .unwrap_or(value.len());
    let name = value[..end].trim().to_string();
    if name.is_empty() {
        return None;
    }
    let version = (end < value.len()).then(|| value[end..].trim().to_string());
    Some((name, version))
}

fn is_stdlib(name: &str) -> bool {
    static NAMES: OnceLock<HashSet<String>> = OnceLock::new();
    let names = NAMES.get_or_init(|| {
        let mut names: HashSet<String> = [
            "__future__",
            "builtins",
            "os",
            "sys",
            "typing",
            "pathlib",
            "json",
            "collections",
            "asyncio",
            "re",
            "math",
            "time",
            "datetime",
            "itertools",
            "functools",
            "subprocess",
            "threading",
            "unittest",
            "logging",
            "tempfile",
            "shutil",
            "abc",
            "dataclasses",
            "enum",
            "io",
            "types",
            "inspect",
            "ast",
            "importlib",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        let output = ["python3", "python"].iter().find_map(|program| {
            std::process::Command::new(program)
                .args([
                    "-I",
                    "-c",
                    "import sys; print('\\n'.join(sys.stdlib_module_names))",
                ])
                .output()
                .ok()
                .filter(|output| output.status.success())
        });
        if let Some(output) = output {
            names.extend(
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .map(str::to_string),
            );
        }
        names
    });
    names.contains(name)
}
