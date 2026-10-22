//! Native executable identity used to match an existing window to a launched app.
use std::path::{Path, PathBuf};

pub fn application_executable(program: &str) -> Result<PathBuf, String> {
    let path = Path::new(program);
    #[cfg(target_os = "macos")]
    if path.is_dir() && path.extension().is_some_and(|ext| ext == "app") {
        let output = std::process::Command::new("/usr/bin/plutil")
            .args(["-extract", "CFBundleExecutable", "raw", "-o", "-"])
            .arg(path.join("Contents/Info.plist"))
            .output()
            .map_err(|e| format!("Cannot read application bundle: {e}"))?;
        if !output.status.success() {
            return Err("Application bundle has no CFBundleExecutable".into());
        }
        let name = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
        let name = name.trim();
        if name.is_empty()
            || Path::new(name).components().count() != 1
            || name == "."
            || name == ".."
        {
            return Err("Invalid application bundle executable".into());
        }
        let executable = path.join("Contents/MacOS").join(name);
        return executable
            .canonicalize()
            .map_err(|e| format!("Application executable is missing: {e}"));
    }
    if path.is_file() {
        return path.canonicalize().map_err(|e| e.to_string());
    }
    crate::agent::which_binary(program)
        .ok_or_else(|| format!("Application executable not found: {program}"))?
        .canonicalize()
        .map_err(|e| e.to_string())
}

pub fn application_executable_in(root: &Path, program: &str) -> Result<PathBuf, String> {
    application_command_in(root, program, &[]).map(|(executable, _)| executable)
}

fn literal_application_in(root: &Path, program: &str) -> Result<PathBuf, String> {
    let path = Path::new(program);
    let project_path = root.join(path);
    if !path.is_absolute() && project_path.exists() {
        return application_executable(&project_path.to_string_lossy());
    }
    application_executable(program)
}

/// Accept a complete launch command while preserving existing unquoted file paths.
/// Quotes group arguments; backslashes are literal so Windows paths survive unchanged.
/// This does not run a shell or expand variables, pipes, or substitutions.
pub fn application_command_in(root: &Path, program: &str, args: &[String]) -> Result<(PathBuf, Vec<String>), String> {
    let program = program.trim();
    if let Ok(executable) = literal_application_in(root, program) {
        return Ok((executable, args.to_vec()));
    }
    let mut words = split_application_command(program)?;
    if words.is_empty() || words[0].is_empty() {
        return Err("起動コマンドを入力してください。".into());
    }
    let executable = literal_application_in(root, &words.remove(0))?;
    words.extend_from_slice(args);
    Ok((executable, words))
}

fn split_application_command(command: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut started = false;
    for ch in command.chars() {
        if let Some(delimiter) = quote {
            if ch == delimiter { quote = None; } else { word.push(ch); }
        } else if ch == '"' || ch == '\'' {
            quote = Some(ch);
            started = true;
        } else if ch.is_whitespace() {
            if started { words.push(std::mem::take(&mut word)); started = false; }
        } else {
            word.push(ch);
            started = true;
        }
    }
    if quote.is_some() { return Err("起動コマンドの引用符を閉じてください。".into()); }
    if started { words.push(word); }
    Ok(words)
}

/// Follow launcher children as well as direct GUI processes (for example uv -> Python -> app).
pub fn process_descends_from(pid: u32, ancestor: u32) -> bool {
    if pid == ancestor { return true; }
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct ProcessEntry {
            size: u32, usage: u32, pid: u32, heap: usize, module: u32,
            threads: u32, parent: u32, priority: i32, flags: u32, name: [u16; 260],
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut std::ffi::c_void;
            fn Process32FirstW(handle: *mut std::ffi::c_void, entry: *mut ProcessEntry) -> i32;
            fn Process32NextW(handle: *mut std::ffi::c_void, entry: *mut ProcessEntry) -> i32;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        let snapshot = unsafe { CreateToolhelp32Snapshot(2, 0) };
        if snapshot as isize == -1 { return false; }
        let mut entry: ProcessEntry = unsafe { std::mem::zeroed() };
        entry.size = std::mem::size_of::<ProcessEntry>() as u32;
        let mut parents = std::collections::HashMap::new();
        let mut found = unsafe { Process32FirstW(snapshot, &mut entry) };
        while found != 0 {
            parents.insert(entry.pid, entry.parent);
            found = unsafe { Process32NextW(snapshot, &mut entry) };
        }
        unsafe { CloseHandle(snapshot); }
        follows_parent_chain(pid, ancestor, |child| parents.get(&child).copied())
    }
    #[cfg(target_os = "linux")]
    {
        follows_parent_chain(pid, ancestor, |child| {
            let stat = std::fs::read_to_string(format!("/proc/{child}/stat")).ok()?;
            stat.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse().ok()
        })
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    { false }
}

fn follows_parent_chain(mut pid: u32, ancestor: u32, mut parent: impl FnMut(u32) -> Option<u32>) -> bool {
    for _ in 0..64 {
        if pid == ancestor { return true; }
        let Some(next) = parent(pid) else { return false; };
        if next == 0 || next == pid { return false; }
        pid = next;
    }
    false
}

pub fn process_executable(pid: u32) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/{pid}/exe")).ok()
    }
    #[cfg(target_os = "macos")]
    {
        #[link(name = "proc")]
        unsafe extern "C" {
            fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, size: u32) -> i32;
        }
        let mut buffer = vec![0u8; 4096];
        let size =
            unsafe { proc_pidpath(pid as i32, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
        if size <= 0 {
            return None;
        }
        let end = buffer.iter().position(|b| *b == 0)?;
        use std::os::unix::ffi::OsStringExt;
        Some(PathBuf::from(std::ffi::OsString::from_vec(
            buffer[..end].to_vec(),
        )))
    }
    #[cfg(target_os = "windows")]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn QueryFullProcessImageNameW(
                handle: *mut std::ffi::c_void,
                flags: u32,
                buffer: *mut u16,
                size: *mut u32,
            ) -> i32;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        let handle = unsafe { OpenProcess(0x1000, 0, pid) };
        if handle.is_null() {
            return None;
        }
        let mut buffer = vec![0u16; 32768];
        let mut size = buffer.len() as u32;
        let success =
            unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size) };
        unsafe {
            CloseHandle(handle);
        }
        if success == 0 {
            return None;
        }
        use std::os::windows::ffi::OsStringExt;
        Some(PathBuf::from(std::ffi::OsString::from_wide(
            &buffer[..size as usize],
        )))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = pid;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launcher_ancestry_follows_multiple_generations_and_rejects_cycles() {
        let parents = [(40, 30), (30, 20), (20, 10)];
        let parent = |pid| parents.iter().find(|(child, _)| *child == pid).map(|(_, parent)| *parent);
        assert!(follows_parent_chain(40, 10, parent));
        assert!(!follows_parent_chain(40, 50, parent));
        assert!(!follows_parent_chain(40, 10, |_| Some(40)));
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn windows_detects_a_real_launcher_child() {
        let mut child = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"])
            .spawn().unwrap();
        let matched = process_descends_from(child.id(), std::process::id());
        let unrelated = process_descends_from(child.id(), u32::MAX);
        let _ = child.kill();
        let _ = child.wait();
        assert!(matched);
        assert!(!unrelated);
    }
    #[test]
    fn launch_commands_preserve_paths_and_append_separate_arguments() {
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("app with spaces.exe");
        std::fs::write(&executable, "test").unwrap();
        let expected = executable.canonicalize().unwrap();
        assert_eq!(application_command_in(dir.path(), "app with spaces.exe", &[]).unwrap(), (expected.clone(), vec![]));
        let command = format!("\"{}\" run \"script with spaces.py\" ''", executable.display());
        assert_eq!(application_command_in(dir.path(), &command, &["--extra".into()]).unwrap(),
            (expected, vec!["run".to_owned(), "script with spaces.py".into(), "".into(), "--extra".into()]));
        assert_eq!(split_application_command("uv run start_manual_studio.py").unwrap(), vec!["uv", "run", "start_manual_studio.py"]);
        assert_eq!(split_application_command(r#""C:\Program Files\uv.exe" run "C:\my project\main.py""#).unwrap(),
            vec![r"C:\Program Files\uv.exe", "run", r"C:\my project\main.py"]);
        assert!(split_application_command("uv run \"missing quote").is_err());
        assert!(application_command_in(dir.path(), "", &[]).is_err());
        assert_eq!(split_application_command("uv run $(literal) | other").unwrap(), vec!["uv", "run", "$(literal)", "|", "other"]);
    }
    #[test]
    fn current_process_has_the_expected_executable() {
        let expected = std::env::current_exe().unwrap().canonicalize().unwrap();
        assert_eq!(
            process_executable(std::process::id())
                .unwrap()
                .canonicalize()
                .unwrap(),
            expected
        );
        assert_eq!(
            application_executable(expected.to_str().unwrap()).unwrap(),
            expected
        );
        assert!(application_executable("manual-studio-missing-test-executable").is_err());
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("local-app");
        std::fs::write(&executable, "test").unwrap();
        assert_eq!(
            application_executable_in(dir.path(), "local-app").unwrap(),
            executable.canonicalize().unwrap()
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn resolves_the_executable_declared_by_an_app_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("Example.app");
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(app.join("Contents/Info.plist"), r#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Example</string></dict></plist>"#).unwrap();
        let executable = app.join("Contents/MacOS/Example");
        std::fs::write(&executable, "test").unwrap();
        assert_eq!(
            application_executable(app.to_str().unwrap()).unwrap(),
            executable.canonicalize().unwrap()
        );
    }
}
