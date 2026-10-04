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
    let path = Path::new(program);
    let project_path = root.join(path);
    if !path.is_absolute() && project_path.exists() {
        return application_executable(&project_path.to_string_lossy());
    }
    application_executable(program)
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
