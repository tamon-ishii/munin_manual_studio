use serde_json::{json, Value};
use std::{fs, path::Path, sync::Mutex};

static INSTALL_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn install(root: &Path, options: &Value) -> Result<Value, String> {
    let skill = options["skill"].as_str().unwrap_or_default();
    let (repository, source_dir) = match skill {
        "yomiyasu" => ("https://github.com/nanaism/yomiyasu.git", "skills/yomiyasu"),
        "natural-japanese" => ("https://github.com/coji/natural-japanese.git", "skills/natural-japanese"),
        "japanese-tech-writing" => ("https://gist.github.com/fd287c3133457c4fd8f5601d34aa817d.git", ""),
        _ => return Err("インストールできる推敲スキルを選んでください。".into()),
    };
    let parent = match options["agent"].as_str() {
        Some("codex" | "agy") => ".agents/skills",
        Some("claude") => ".claude/skills",
        _ => return Err("インストール先の AI クライアントを選んでください。".into()),
    };
    let relative = format!("{parent}/{skill}");
    let destination = crate::config::project_path(root, &relative)?;
    if let Some(result) = existing_installation(&destination, &relative)? {
        return Ok(result);
    }

    let git = crate::agent::which_binary("git")
        .ok_or("推敲スキルのダウンロードには Git が必要です。")?;
    let download = tempfile::tempdir().map_err(|error| error.to_string())?;
    let checkout = download.path().join("source");
    let args = [
        "-c", "credential.interactive=false", "clone", "--quiet", "--depth", "1",
        repository, &checkout.to_string_lossy(),
    ].map(str::to_owned);
    let result = crate::agent::run_process(root, &git.to_string_lossy(), &args)?;
    if !result.status.success() {
        return Err(format!("推敲スキルをダウンロードできませんでした。\n{}", String::from_utf8_lossy(&result.stderr).trim()));
    }

    install_checkout(root, &relative, &checkout, source_dir)
}

fn install_checkout(root: &Path, relative: &str, checkout: &Path, source_dir: &str) -> Result<Value, String> {
    let source = crate::config::project_path(checkout, if source_dir.is_empty() { "SKILL.md" } else { source_dir })?;
    let _guard = INSTALL_LOCK.lock().map_err(|error| error.to_string())?;
    let destination = crate::config::project_path(root, relative)?;
    if let Some(result) = existing_installation(&destination, relative)? {
        return Ok(result);
    }
    let parent = destination.parent().ok_or("スキルの配置先が無効です。")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let staging = tempfile::tempdir_in(parent).map_err(|error| error.to_string())?;
    let package = staging.path().join("package");
    if source_dir.is_empty() {
        fs::create_dir(&package).map_err(|error| error.to_string())?;
        fs::copy(source, package.join("SKILL.md")).map_err(|error| error.to_string())?;
    } else {
        copy_package(&source, &package).map_err(|error| error.to_string())?;
    }
    if !package.join("SKILL.md").is_file() {
        return Err("配布元に SKILL.md が見つかりません。".into());
    }
    fs::rename(package, destination).map_err(|error| error.to_string())?;
    Ok(json!({"path": relative, "already_installed": false}))
}

fn existing_installation(destination: &Path, relative: &str) -> Result<Option<Value>, String> {
    match fs::symlink_metadata(destination) {
        Ok(metadata) if metadata.is_dir() && destination.join("SKILL.md").is_file() =>
            Ok(Some(json!({"path": relative, "already_installed": true}))),
        Ok(_) => Err(format!("配置先に既存のファイルまたはフォルダがあります。 {relative}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn copy_package(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::create_dir(destination)?;
    for item in fs::read_dir(source)? {
        let item = item?;
        let target = destination.join(item.file_name());
        let kind = item.file_type()?;
        if kind.is_dir() {
            copy_package(&item.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(item.path(), target)?;
        } else {
            return Err(std::io::Error::other("スキルに通常のファイルやフォルダ以外が含まれています。"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_complete_package_and_preserves_existing_skill() {
        let root = tempfile::tempdir().unwrap();
        let checkout = tempfile::tempdir().unwrap();
        let source = checkout.path().join("skills/yomiyasu");
        fs::create_dir_all(source.join("references")).unwrap();
        fs::write(source.join("SKILL.md"), "original").unwrap();
        fs::write(source.join("references/rules.md"), "rules").unwrap();
        let relative = ".agents/skills/yomiyasu";
        let result = install_checkout(root.path(), relative, checkout.path(), "skills/yomiyasu").unwrap();
        assert_eq!(result["already_installed"], false);
        assert_eq!(fs::read_to_string(root.path().join(relative).join("references/rules.md")).unwrap(), "rules");
        fs::write(source.join("SKILL.md"), "upstream change").unwrap();
        let result = install_checkout(root.path(), relative, checkout.path(), "skills/yomiyasu").unwrap();
        assert_eq!(result["already_installed"], true);
        assert_eq!(fs::read_to_string(root.path().join(relative).join("SKILL.md")).unwrap(), "original");
    }

    #[test]
    fn installs_single_file_skill_for_claude() {
        let root = tempfile::tempdir().unwrap();
        let checkout = tempfile::tempdir().unwrap();
        fs::write(checkout.path().join("SKILL.md"), "technical writing").unwrap();
        let relative = ".claude/skills/japanese-tech-writing";
        install_checkout(root.path(), relative, checkout.path(), "").unwrap();
        assert_eq!(fs::read_to_string(root.path().join(relative).join("SKILL.md")).unwrap(), "technical writing");
    }
}
