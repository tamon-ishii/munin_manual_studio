use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Component, Path};
use std::process::Command;
use tempfile::{tempdir, tempdir_in};
use walkdir::WalkDir;

use super::agent::which_binary;
use super::config::read_config;
use super::task::{
    collect_markdown_files, encode_prompt, parse_page_tags, read_answer, source_hash, tasks,
    utc_now, PageTag,
};

const SITE_MANIFEST: &str = ".moduleloom-site-files.json";

fn site_relative_path(path: &str) -> Result<&Path, String> {
    let relative = Path::new(path);
    if path.is_empty()
        || !relative
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(format!("Invalid generated site path: {path}"));
    }
    Ok(relative)
}

fn publish_site(temp_site: &Path, output_root: &Path) -> Result<(), String> {
    publish_site_inner(temp_site, output_root, false)
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    for entry in WalkDir::new(source) {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().is_symlink() {
            return Err(format!(
                "Symbolic links are not supported in manual output: {}",
                entry.path().display()
            ));
        }
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|e| e.to_string())?;
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(target).map_err(|e| e.to_string())?;
        } else {
            fs::copy(entry.path(), target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn publish_site_inner(
    temp_site: &Path,
    output_root: &Path,
    fail_after_old_rename: bool,
) -> Result<(), String> {
    if fs::symlink_metadata(output_root).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(format!(
            "Symbolic links are not supported for manual output: {}",
            output_root.display()
        ));
    }
    let parent = output_root
        .parent()
        .ok_or_else(|| "Manual output needs a parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let staging = tempdir_in(parent).map_err(|e| e.to_string())?;
    let prepared = staging.path().join("prepared");
    copy_tree(output_root, &prepared)?;
    fs::create_dir_all(&prepared).map_err(|e| e.to_string())?;

    let manifest_path = output_root.join(SITE_MANIFEST);
    let legacy_site = !manifest_path.exists()
        && fs::read_to_string(output_root.join("index.html"))
            .is_ok_and(|html| html.contains("name=\"generator\" content=\"mkdocs-"));
    let old_files: BTreeSet<String> = if manifest_path.is_file() {
        serde_json::from_slice::<Vec<String>>(&fs::read(&manifest_path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Invalid site manifest: {e}"))?
            .into_iter()
            .collect()
    } else {
        BTreeSet::new()
    };
    for path in &old_files {
        site_relative_path(path)?;
    }

    let mut new_files = BTreeSet::new();
    for entry in WalkDir::new(temp_site) {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(temp_site)
            .map_err(|e| e.to_string())?;
        let name = rel.to_string_lossy().replace('\\', "/");
        site_relative_path(&name)?;
        if name == SITE_MANIFEST {
            return Err("Generated site conflicts with the site manifest".to_string());
        }
        let dest = output_root.join(rel);
        let top_level = name.split('/').next().unwrap_or("");
        if ["ai", "brief.md", ".backup"].contains(&top_level) {
            return Err(format!(
                "Generated site conflicts with manual source data: {name}"
            ));
        }
        if dest.exists() && !old_files.contains(&name) && !legacy_site {
            return Err(format!(
                "Generated site would overwrite an unmanaged file: {}",
                dest.display()
            ));
        }
        new_files.insert(name);
    }

    for name in old_files.difference(&new_files) {
        let path = prepared.join(site_relative_path(name)?);
        if path.is_file() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    for name in &new_files {
        let rel = site_relative_path(name)?;
        let dest = prepared.join(rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(temp_site.join(rel), &dest).map_err(|e| e.to_string())?;
    }
    let manifest = serde_json::to_vec_pretty(&new_files).map_err(|e| e.to_string())?;
    fs::write(prepared.join(SITE_MANIFEST), manifest).map_err(|e| e.to_string())?;

    let old_output = staging.path().join("previous");
    let had_output = output_root.exists();
    if had_output {
        fs::rename(output_root, &old_output).map_err(|e| e.to_string())?;
    }
    let publish_result = if fail_after_old_rename {
        Err("Simulated publication failure".to_string())
    } else {
        fs::rename(&prepared, output_root).map_err(|e| e.to_string())
    };
    if let Err(error) = publish_result {
        if had_output {
            if let Err(restore) = fs::rename(&old_output, output_root) {
                let recovery = staging.keep();
                return Err(format!(
                    "{error}; failed to restore previous site: {restore}; previous site is at {}",
                    recovery.join("previous").display()
                ));
            }
        }
        return Err(error);
    }
    Ok(())
}

pub fn build(
    templates: &Path,
    generated: &Path,
    output_root: &Path,
    draft: bool,
    root: Option<&Path>,
) -> Result<String, String> {
    build_inner(templates, generated, output_root, draft, root, false)
}

#[cfg(test)]
pub(crate) fn build_without_mkdocs(
    templates: &Path,
    generated: &Path,
    output_root: &Path,
) -> Result<String, String> {
    build_inner(templates, generated, output_root, true, None, true)
}

fn build_inner(
    templates: &Path,
    generated: &Path,
    output_root: &Path,
    draft: bool,
    root: Option<&Path>,
    no_mkdocs: bool,
) -> Result<String, String> {
    let task_list = tasks(templates)?;
    let mut answers = HashMap::new();

    for task in &task_list {
        if task.status == "approved" || task.status == "current" {
            continue;
        }
        let answer_path = generated.join("answers").join(format!("{}.md", task.id));
        if !answer_path.is_file() {
            if !draft {
                return Err(format!(
                    "Missing answer for {}: {}",
                    task.id,
                    answer_path.display()
                ));
            }
            continue;
        }
        match read_answer(&answer_path, task) {
            Ok(ans) => {
                answers.insert(task.id.clone(), ans);
            }
            Err(e) => {
                if !draft {
                    return Err(e);
                }
            }
        }
    }

    let tmp = tempdir().map_err(|e| e.to_string())?;
    let temp_root = tmp.path();
    let temp_docs = temp_root.join("docs");
    let temp_site = temp_root.join("site");
    fs::create_dir_all(&temp_docs).map_err(|e| e.to_string())?;

    let built_at = utc_now();

    for page in collect_markdown_files(templates) {
        let content = fs::read_to_string(&page).map_err(|e| e.to_string())?;
        let page_rel = page
            .strip_prefix(templates)
            .unwrap_or(&page)
            .to_string_lossy()
            .replace('\\', "/");
        let mut ids = std::collections::HashSet::new();
        let tags = parse_page_tags(&page_rel, &content, &mut ids)?;

        let mut rendered = String::new();
        let mut last_idx = 0;

        for tag in tags {
            if let PageTag::Task { range, task } = tag {
                rendered.push_str(&content[last_idx..range.start]);
                let task_id = &task.id;
                let kind = &task.kind;
                let prompt = &task.prompt;

                if let Some((created, body, approved)) = answers.get(task_id) {
                    let digest = source_hash(kind, prompt);
                    let approved_attr = approved
                        .as_ref()
                        .map(|a| format!(" approved-at={a}"))
                        .unwrap_or_default();
                    let prompt_attr = format!(" prompt-b64={}", encode_prompt(prompt));
                    rendered.push_str(&format!(
                        "<!-- ai:generated id={task_id} kind={kind} created-at={created} source-sha256={digest}{prompt_attr}{approved_attr} -->\n{body}\n<!-- /ai:generated -->"
                    ));
                } else {
                    rendered.push_str(&format!("> **作成待ち:** `{task_id}` ({kind})"));
                }
                last_idx = range.end;
            }
        }
        rendered.push_str(&content[last_idx..]);
        let final_page = rendered.replace("{{BUILD_TIMESTAMP}}", &built_at);

        let rel = page.strip_prefix(templates).unwrap_or(&page);
        let dest = temp_docs.join(rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&dest, final_page).map_err(|e| e.to_string())?;
    }

    // markdown 以外の静的ファイルをコピー
    for entry in WalkDir::new(templates).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            if entry.path().extension().map_or(true, |ext| ext != "md") {
                let rel = entry.path().strip_prefix(templates).unwrap_or(entry.path());
                let dest = temp_docs.join(rel);
                if let Some(parent) = dest.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                fs::copy(entry.path(), &dest).map_err(|e| e.to_string())?;
            }
        }
    }

    let legacy_assets = generated.join("assets");
    if legacy_assets.is_dir() {
        let dest_assets = temp_docs.join("assets");
        let _ = fs::create_dir_all(&dest_assets);
        for entry in WalkDir::new(&legacy_assets)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if entry.file_type().is_file() {
                let rel = entry
                    .path()
                    .strip_prefix(&legacy_assets)
                    .unwrap_or(entry.path());
                let dest = dest_assets.join(rel);
                if let Some(parent) = dest.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                if !dest.exists() {
                    fs::copy(entry.path(), &dest).map_err(|e| e.to_string())?;
                }
            }
        }
    }

    let (site_name, theme_name, theme_lang, use_dir_urls) = if let Some(r) = root {
        let cfg = read_config(r);
        (
            cfg.mkdocs.site_name,
            cfg.mkdocs.theme,
            cfg.mkdocs.language,
            cfg.mkdocs.use_directory_urls,
        )
    } else {
        (
            "ModuleLoom マニュアル".to_string(),
            "material".to_string(),
            "ja".to_string(),
            false,
        )
    };

    let mut nav_lines = String::new();
    for page in collect_markdown_files(templates) {
        let rel = page.strip_prefix(templates).unwrap_or(&page);
        let rel_posix = rel.to_string_lossy().replace('\\', "/");
        let stem = page.file_stem().unwrap_or_default().to_string_lossy();
        nav_lines.push_str(&format!(
            "  - {}: {}\n",
            serde_json::to_string(&stem).unwrap(),
            serde_json::to_string(&rel_posix).unwrap()
        ));
    }

    let config_yaml = format!(
        "site_name: {}\n\
        theme:\n  name: {}\n  language: {}\n\
        use_directory_urls: {}\n\
        site_dir: {}\n\
        markdown_extensions:\n\
          - pymdownx.superfences:\n\
              custom_fences:\n\
                - name: mermaid\n\
                  class: mermaid\n\
                  format: !!python/name:pymdownx.superfences.fence_code_format\n\
        nav:\n{}",
        serde_json::to_string(&site_name).unwrap(),
        theme_name,
        theme_lang,
        if use_dir_urls { "true" } else { "false" },
        serde_json::to_string(&temp_site.to_string_lossy()).unwrap(),
        nav_lines
    );

    let temp_config = temp_root.join("mkdocs.yml");
    fs::write(&temp_config, config_yaml).map_err(|e| e.to_string())?;

    fs::create_dir_all(output_root).map_err(|e| e.to_string())?;

    // 外部 mkdocs CLI の探索
    let mut mkdocs_cmd: Option<Vec<String>> = None;
    if let Some(bin) = which_binary("mkdocs") {
        mkdocs_cmd = Some(vec![bin.to_string_lossy().into_owned()]);
    } else if let Some(r) = root {
        let venv_mkdocs = r.join(".venv").join("bin").join("mkdocs");
        if venv_mkdocs.is_file() {
            mkdocs_cmd = Some(vec![venv_mkdocs.to_string_lossy().into_owned()]);
        }
    }

    if mkdocs_cmd.is_none() {
        for py in &["python3", "python"] {
            if let Some(py_bin) = which_binary(py) {
                // python -m mkdocs が使えるかチェック
                let test_out = Command::new(&py_bin)
                    .args(["-m", "mkdocs", "--version"])
                    .output();
                if let Ok(out) = test_out {
                    if out.status.success() {
                        mkdocs_cmd = Some(vec![
                            py_bin.to_string_lossy().into_owned(),
                            "-m".to_string(),
                            "mkdocs".to_string(),
                        ]);
                        break;
                    }
                }
            }
        }
    }

    if let Some(cmd_parts) = if no_mkdocs { None } else { mkdocs_cmd } {
        let (prog, args) = cmd_parts.split_first().unwrap();
        let mut final_args: Vec<String> = args.to_vec();
        final_args.extend([
            "build".to_string(),
            "-f".to_string(),
            temp_config.to_string_lossy().into_owned(),
            "-d".to_string(),
            temp_site.to_string_lossy().into_owned(),
        ]);

        let output = Command::new(prog)
            .args(&final_args)
            .current_dir(temp_root)
            .output()
            .map_err(|e| format!("Failed to run mkdocs: {e}"))?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            let out = String::from_utf8_lossy(&output.stdout);
            let msg = if !err.trim().is_empty() {
                err.trim()
            } else {
                out.trim()
            };
            return Err(format!("MkDocs site build failed: {msg}"));
        }
        publish_site(&temp_site, output_root)?;
        Ok(format!(
            "{}\nSite: {}",
            output_root.display(),
            output_root.display()
        ))
    } else {
        Ok(format!(
            "{}\nMkDocs site build skipped: install mkdocs-material to generate HTML at {}",
            output_root.display(),
            output_root.display()
        ))
    }
}

#[cfg(test)]
mod site_tests {
    use super::*;

    #[test]
    fn publish_removes_only_previously_generated_files() {
        let tmp = tempdir().unwrap();
        let site = tmp.path().join("site");
        let output = tmp.path().join("output");
        fs::create_dir_all(&site).unwrap();
        fs::create_dir_all(&output).unwrap();
        fs::write(site.join("old.html"), "Old page").unwrap();
        fs::write(output.join("notes.txt"), "User note").unwrap();
        publish_site(&site, &output).unwrap();

        fs::remove_file(site.join("old.html")).unwrap();
        fs::write(site.join("new.html"), "New page").unwrap();
        publish_site(&site, &output).unwrap();

        assert!(!output.join("old.html").exists());
        assert_eq!(
            fs::read_to_string(output.join("new.html")).unwrap(),
            "New page"
        );
        assert_eq!(
            fs::read_to_string(output.join("notes.txt")).unwrap(),
            "User note"
        );
    }

    #[test]
    fn publish_rejects_unmanaged_file_collision() {
        let tmp = tempdir().unwrap();
        let site = tmp.path().join("site");
        let output = tmp.path().join("output");
        fs::create_dir_all(&site).unwrap();
        fs::create_dir_all(&output).unwrap();
        fs::write(site.join("index.html"), "Generated page").unwrap();
        fs::write(output.join("index.html"), "User page").unwrap();

        let err = publish_site(&site, &output).unwrap_err();

        assert!(err.contains("unmanaged file"));
        assert_eq!(
            fs::read_to_string(output.join("index.html")).unwrap(),
            "User page"
        );
        assert!(!output.join(SITE_MANIFEST).exists());
    }

    #[test]
    fn publish_adopts_legacy_mkdocs_site_without_removing_user_files() {
        let tmp = tempdir().unwrap();
        let site = tmp.path().join("site");
        let output = tmp.path().join("output");
        fs::create_dir_all(&site).unwrap();
        fs::create_dir_all(&output).unwrap();
        fs::write(site.join("index.html"), "New page").unwrap();
        fs::write(
            output.join("index.html"),
            "<meta name=\"generator\" content=\"mkdocs-1.6\">",
        )
        .unwrap();
        fs::write(output.join("notes.txt"), "User note").unwrap();

        publish_site(&site, &output).unwrap();

        assert_eq!(
            fs::read_to_string(output.join("index.html")).unwrap(),
            "New page"
        );
        assert_eq!(
            fs::read_to_string(output.join("notes.txt")).unwrap(),
            "User note"
        );
        assert!(output.join(SITE_MANIFEST).is_file());
    }

    #[test]
    fn publication_failure_restores_previous_site_and_user_files() {
        let tmp = tempdir().unwrap();
        let site = tmp.path().join("site");
        let output = tmp.path().join("output");
        fs::create_dir_all(&site).unwrap();
        fs::create_dir_all(&output).unwrap();
        fs::write(site.join("index.html"), "First version").unwrap();
        fs::write(output.join("notes.txt"), "User note").unwrap();
        publish_site(&site, &output).unwrap();
        let original_manifest = fs::read(output.join(SITE_MANIFEST)).unwrap();

        fs::write(site.join("index.html"), "Second version").unwrap();
        let err = publish_site_inner(&site, &output, true).unwrap_err();

        assert_eq!(err, "Simulated publication failure");
        assert_eq!(
            fs::read_to_string(output.join("index.html")).unwrap(),
            "First version"
        );
        assert_eq!(
            fs::read_to_string(output.join("notes.txt")).unwrap(),
            "User note"
        );
        assert_eq!(
            fs::read(output.join(SITE_MANIFEST)).unwrap(),
            original_manifest
        );
    }

    #[cfg(unix)]
    #[test]
    fn publication_rejects_symlinks_without_touching_their_target() {
        use std::os::unix::fs::symlink;

        let tmp = tempdir().unwrap();
        let site = tmp.path().join("site");
        let output = tmp.path().join("output");
        fs::create_dir_all(&site).unwrap();
        fs::create_dir_all(&output).unwrap();
        fs::write(site.join("index.html"), "Generated page").unwrap();
        let outside = tmp.path().join("outside.txt");
        fs::write(&outside, "Outside data").unwrap();
        symlink(&outside, output.join("link.txt")).unwrap();

        let err = publish_site(&site, &output).unwrap_err();

        assert!(err.contains("Symbolic links are not supported"));
        assert_eq!(fs::read_to_string(outside).unwrap(), "Outside data");
        assert!(!output.join(SITE_MANIFEST).exists());
    }
}
