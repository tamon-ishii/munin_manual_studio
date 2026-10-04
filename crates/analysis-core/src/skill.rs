//! Install the bundled Agent Skill for locally detected coding agents.

use std::env;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

const CONTENT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../skills/moduleloom-diagnostics/SKILL.md"
));
const SKILL_NAME: &str = "moduleloom-diagnostics";

fn command_exists(name: &str) -> bool {
    let Some(paths) = env::var_os("PATH") else {
        return false;
    };
    env::split_paths(&paths).any(|directory| {
        let executable = directory.join(name);
        executable.is_file() || (cfg!(windows) && directory.join(format!("{name}.exe")).is_file())
    })
}

fn install_one(name: &str, root: &Path) -> Result<String, String> {
    let destination = root.join("skills").join(SKILL_NAME).join("SKILL.md");
    if destination.exists() {
        return match fs::read_to_string(&destination) {
            Ok(existing) if existing == CONTENT => Ok(format!(
                "{name}: 既にインストール済み ({})",
                destination.display()
            )),
            Ok(_) => Err(format!(
                "{name}: 既存のスキルを保護しました ({})",
                destination.display()
            )),
            Err(error) => Err(format!("{name}: 既存のスキルを読めません: {error}")),
        };
    }
    let parent = destination.parent().ok_or("スキルの保存先が不正です")?;
    fs::create_dir_all(parent).map_err(|error| format!("{name}: 保存先を作れません: {error}"))?;
    let mut file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
    {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            return Err(format!(
                "{name}: 既存のスキルを保護しました ({})",
                destination.display()
            ));
        }
        Err(error) => return Err(format!("{name}: 保存できません: {error}")),
    };
    if let Err(error) = file.write_all(CONTENT.as_bytes()) {
        drop(file);
        let _ = fs::remove_file(&destination);
        return Err(format!("{name}: 書き込みに失敗しました: {error}"));
    }
    Ok(format!(
        "{name}: インストールしました ({})",
        destination.display()
    ))
}

pub fn install_detected() -> Result<String, String> {
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or("ホームディレクトリが見つかりません")?;
    let codex_override = env::var_os("CODEX_HOME").filter(|value| !value.is_empty());
    let codex = codex_override
        .as_ref()
        .map_or_else(|| home.join(".codex"), PathBuf::from);
    let agents = [
        (
            "Codex",
            codex.clone(),
            codex_override.is_some() || codex.is_dir() || command_exists("codex"),
        ),
        (
            "Claude Code",
            home.join(".claude"),
            home.join(".claude").is_dir() || command_exists("claude"),
        ),
        (
            "Cursor",
            home.join(".cursor"),
            home.join(".cursor").is_dir() || command_exists("cursor"),
        ),
    ];
    let mut results = Vec::new();
    let mut errors = Vec::new();
    for (name, root, detected) in agents {
        if !detected {
            continue;
        }
        match install_one(name, &root) {
            Ok(message) => results.push(message),
            Err(message) => errors.push(message),
        }
    }
    if results.is_empty() && errors.is_empty() {
        return Err("Codex、Claude Code、Cursor が見つかりませんでした".into());
    }
    if errors.is_empty() {
        Ok(results.join("\n"))
    } else {
        results.extend(errors);
        Err(results.join("\n"))
    }
}
