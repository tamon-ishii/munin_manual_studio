//! Explicit, local manuscript Git operations. No checkout/reset or remote actions.
use crate::{agent, editor, workflow};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let scratch = tempfile::tempdir().map_err(|e| e.to_string())?;
    let stdout = scratch.path().join("stdout");
    let stderr = scratch.path().join("stderr");
    let arguments = [
        vec![
            "--no-pager".to_string(),
            "--literal-pathspecs".to_string(),
            "-c".to_string(),
            "color.ui=false".to_string(),
        ],
        args.iter().map(|s| s.to_string()).collect(),
    ]
    .concat();
    let mut command = agent::cli_command("git", &arguments, root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_COMMON_DIR",
    ] {
        command.env_remove(key);
    }
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(fs::File::create(&stdout).map_err(|e| e.to_string())?)
        .stderr(fs::File::create(&stderr).map_err(|e| e.to_string())?);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Gitを起動できません。Gitのインストールを確認してください: {e}"))?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                agent::stop_cli_tree(&mut child);
                let _ = child.wait();
                return Err(error.to_string());
            }
        }
        if started.elapsed() > Duration::from_secs(30) {
            agent::stop_cli_tree(&mut child);
            let _ = child.wait();
            return Err("Gitの処理が30秒以内に完了しませんでした。署名・フック・ロック状態を確認してください。".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    if !status.success() {
        let message = fs::read_to_string(&stderr).unwrap_or_default();
        let output = fs::read_to_string(&stdout).unwrap_or_default();
        return Err(format!(
            "Git: {}",
            format!("{message}\n{output}")
                .trim()
                .chars()
                .take(3000)
                .collect::<String>()
        ));
    }
    if fs::metadata(&stdout).map_err(|e| e.to_string())?.len() > 3_000_000 {
        return Err("Gitの結果が3MBを超えています。対象を絞ってください。".into());
    }
    fs::read_to_string(stdout).map_err(|e| e.to_string())
}

fn repository(root: &Path) -> Result<PathBuf, String> {
    let path = PathBuf::from(git(root, &["rev-parse", "--show-toplevel"])?.trim_end());
    let repo = path.canonicalize().map_err(|e| e.to_string())?;
    if !root
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(&repo)
    {
        return Err("Gitの作業フォルダーがプロジェクトと一致しません。".into());
    }
    Ok(repo)
}

fn manuscript_path(root: &Path, repo: &Path, page: &str) -> Result<String, String> {
    let path = editor::document_path(root, page)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.starts_with(root.canonicalize().map_err(|e| e.to_string())?) {
        return Err("プロジェクト外の原稿は操作できません。".into());
    }
    Ok(path
        .strip_prefix(repo)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/"))
}

pub(crate) fn handle(root: &Path, action: &str, options: &Value) -> Result<Value, String> {
    if action == "manuscript-git-status" {
        if let Err(message) = git(root, &["--version"]) {
            return Ok(
                json!({"available":false,"repository":false,"can_initialize":false,"message":message}),
            );
        }
        let repo = match repository(root) {
            Ok(repo) => repo,
            Err(message) => {
                return Ok(
                    json!({"available":true,"repository":false,"can_initialize":message.contains("not a git repository"),"message":message}),
                )
            }
        };
        let page = options["page"].as_str();
        let status = if let Some(page) = page {
            let path = manuscript_path(root, &repo, page)?;
            git(&repo, &["status", "--porcelain=v1", "--", &path])?
        } else {
            String::new()
        };
        let identity = git(root, &["var", "GIT_AUTHOR_IDENT"]);
        return Ok(
            json!({"available":true,"repository":true,"repository_root":repo,"status":status,"identity_ready":identity.is_ok(),"identity_message":identity.err()}),
        );
    }
    if action == "manuscript-git-init" {
        if options["confirm"] != true {
            return Err("Gitの初期化を確認してください。".into());
        }
        match repository(root) {
            Ok(_) => return Err("すでにGitリポジトリ内です。初期化は不要です。".into()),
            Err(message) if message.contains("not a git repository") => {}
            Err(message) => return Err(message),
        }
        git(root, &["init"])?;
        return handle(root, "manuscript-git-status", &json!({}));
    }
    let repo = repository(root)?;
    let page = options["page"].as_str().ok_or("原稿を選択してください。")?;
    let path = manuscript_path(root, &repo, page)?;
    match action {
        "manuscript-git-history" => {
            if git(root, &["rev-parse", "--verify", "HEAD"]).is_err() {
                return Ok(json!({"items":[]}));
            }
            let log = git(
                &repo,
                &[
                    "log",
                    "-n",
                    "100",
                    "--format=%H%x00%ct%x00%s%x00",
                    "--",
                    &path,
                ],
            )?;
            let fields: Vec<&str> = log.split('\0').collect();
            let items: Vec<Value> = fields.chunks_exact(3).map(|fields|json!({"id":fields[0].trim(),"timestamp":fields[1],"message":fields[2]})).collect();
            Ok(json!({"items":items}))
        }
        "manuscript-git-version" => {
            let id = options["commit"]
                .as_str()
                .ok_or("コミットを選択してください。")?;
            if !matches!(id.len(), 40 | 64) || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("コミットIDが不正です。".into());
            }
            git(
                root,
                &["rev-parse", "--verify", &format!("{id}^{{commit}}")],
            )?;
            let content = git(&repo, &["show", &format!("{id}:{path}")])?;
            let content = crate::legacy_ai::plain_markdown(&content, Some(&root.join("manual/ai")));
            Ok(json!({"page":page,"commit":id,"content":content}))
        }
        "manuscript-git-commit" => {
            let message = options["message"].as_str().unwrap_or("").trim();
            if message.is_empty() || message.len() > 2000 {
                return Err("コミットの説明を1〜2000バイトで入力してください。".into());
            }
            let _lock = workflow::page_lock(root, page)?;
            let document = editor::read_raw(root, page)?;
            if options["revision"].as_str() != Some(document.revision.as_str()) {
                return Err("原稿が変更されています。保存状態を確認し直してください。".into());
            }
            if !git(&repo, &["ls-files", "--unmerged"])?.trim().is_empty() {
                return Err(
                    "Gitにマージ競合があります。競合を解決してから保存してください。".into(),
                );
            }
            // --only excludes unrelated staged content. Register an untracked
            // manuscript with intent-to-add, without staging its contents.
            if git(&repo, &["ls-files", "--error-unmatch", "--", &path]).is_err() {
                git(&repo, &["add", "--intent-to-add", "--", &path])?;
            }
            git(&repo, &["commit", "--only", "-m", message, "--", &path])?;
            let id = git(root, &["rev-parse", "HEAD"])?;
            Ok(json!({"commit":id.trim(),"page":page}))
        }
        _ => Err("未対応のGit操作です。".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("docs")).unwrap();
        fs::write(
            root.path().join("manual_setting.json"),
            r#"{"docs":"docs"}"#,
        )
        .unwrap();
        fs::write(root.path().join("docs/手順 [1].md"), "# First 😀\n").unwrap();
        root
    }
    fn setup(root: &Path) {
        handle(root, "manuscript-git-init", &json!({"confirm":true})).unwrap();
        for (key, value) in [
            ("user.name", "Manuscript Test"),
            ("user.email", "test@example.invalid"),
            ("commit.gpgsign", "false"),
            ("core.hooksPath", ".git/hooks"),
        ] {
            git(root, &["config", key, value]).unwrap();
        }
    }
    #[test]
    fn explicit_history_and_commit_preserve_other_staged_files() {
        let root = project();
        let page = "手順 [1].md";
        assert_eq!(
            handle(root.path(), "manuscript-git-status", &json!({})).unwrap()["repository"],
            false
        );
        setup(root.path());
        assert!(
            handle(root.path(), "manuscript-git-history", &json!({"page":page})).unwrap()["items"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        fs::write(root.path().join("unrelated.txt"), "staged unrelated").unwrap();
        git(root.path(), &["add", "--", "unrelated.txt"]).unwrap();
        let first = editor::read(root.path(), page).unwrap();
        let result = handle(
            root.path(),
            "manuscript-git-commit",
            &json!({"page":page,"message":"Initial manuscript","revision":first.revision}),
        )
        .unwrap();
        assert!(git(root.path(), &["diff", "--cached", "--name-only"])
            .unwrap()
            .contains("unrelated.txt"));
        assert!(!git(root.path(), &["ls-tree", "--name-only", "-r", "HEAD"])
            .unwrap()
            .contains("unrelated.txt"));
        fs::write(root.path().join("docs/手順 [1].md"), "# Second\n").unwrap();
        let second = editor::read(root.path(), page).unwrap();
        handle(
            root.path(),
            "manuscript-git-commit",
            &json!({"page":page,"message":"Second manuscript","revision":second.revision}),
        )
        .unwrap();
        let history = handle(root.path(), "manuscript-git-history", &json!({"page":page})).unwrap();
        assert_eq!(history["items"].as_array().unwrap().len(), 2);
        assert_eq!(
            handle(
                root.path(),
                "manuscript-git-version",
                &json!({"page":page,"commit":result["commit"]})
            )
            .unwrap()["content"],
            first.content
        );
        assert_eq!(
            editor::read(root.path(), page).unwrap().content,
            second.content
        );
        assert!(handle(
            root.path(),
            "manuscript-git-version",
            &json!({"page":page,"commit":"--help"})
        )
        .is_err());
        assert!(handle(
            root.path(),
            "manuscript-git-version",
            &json!({"page":"../outside.md","commit":result["commit"]})
        )
        .is_err());
        assert!(handle(
            root.path(),
            "manuscript-git-commit",
            &json!({"page":page,"message":"stale","revision":first.revision})
        )
        .is_err());
    }

    #[test]
    fn project_inside_a_repository_uses_repository_relative_paths() {
        let root = project();
        setup(root.path());
        let nested = root.path().join("nested");
        fs::create_dir_all(nested.join("docs")).unwrap();
        fs::write(nested.join("manual_setting.json"), r#"{"docs":"docs"}"#).unwrap();
        fs::write(nested.join("docs/-start.md"), "# Nested\n").unwrap();
        let document = editor::read(&nested, "-start.md").unwrap();
        let result = handle(
            &nested,
            "manuscript-git-commit",
            &json!({"page":"-start.md","message":"Nested manuscript","revision":document.revision}),
        )
        .unwrap();
        assert_eq!(
            handle(
                &nested,
                "manuscript-git-history",
                &json!({"page":"-start.md"})
            )
            .unwrap()["items"][0]["id"],
            result["commit"]
        );
        assert_eq!(
            handle(
                &nested,
                "manuscript-git-version",
                &json!({"page":"-start.md","commit":result["commit"]})
            )
            .unwrap()["content"],
            document.content
        );
        assert_eq!(
            handle(
                &nested,
                "manuscript-git-status",
                &json!({"page":"-start.md"})
            )
            .unwrap()["status"],
            ""
        );
    }
}
