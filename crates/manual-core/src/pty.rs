use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

struct PtySession {
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    output_buffer: Arc<Mutex<Vec<u8>>>,
    utf8_pending: Vec<u8>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    owner: Option<String>,
    insertion: Option<tempfile::TempDir>,
}

static SESSIONS: OnceLock<Mutex<HashMap<String, PtySession>>> = OnceLock::new();

fn get_sessions() -> &'static Mutex<HashMap<String, PtySession>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

static CLOSED_OWNERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
fn closed_owners() -> &'static Mutex<HashSet<String>> {
    CLOSED_OWNERS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn pty_spawn(
    root: &Path,
    command: &str,
    args: &[String],
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    pty_spawn_owned(root, command, args, cols, rows, None)
}

fn pty_spawn_owned(
    root: &Path,
    command: &str,
    args: &[String],
    cols: u16,
    rows: u16,
    owner: Option<&str>,
) -> Result<String, String> {
    pty_spawn_owned_in(command,args,cols,rows,owner,root,None)
}

pub fn working_directory(root:&Path,value:Option<&str>)->Result<std::path::PathBuf,String>{
    let path=match value.map(str::trim).filter(|value|!value.is_empty()){
        Some(value) if Path::new(value).is_absolute()||Path::new(value)==root=>std::path::PathBuf::from(value),
        Some(value)=>root.join(value),
        None=>root.to_path_buf(),
    };
    let directory=crate::platform::canonical_clean(&path).map_err(|_|"作業フォルダが見つかりません。既存のフォルダを指定してください。".to_string())?;
    if !directory.is_dir(){return Err("作業フォルダにはフォルダを指定してください。".into());}
    Ok(directory)
}

fn pty_spawn_owned_in(command:&str,args:&[String],cols:u16,rows:u16,owner:Option<&str>,working_directory:&Path,insertion:Option<tempfile::TempDir>)->Result<String,String>{
    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let binary=crate::agent::which_binary(command).unwrap_or_else(||command.into());
    let launch=crate::agent::cli_command(&binary.to_string_lossy(),args,working_directory);
    let mut cmd = CommandBuilder::new(launch.get_program());
    cmd.cwd(working_directory);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("CLICOLOR", "1");
    cmd.env("FORCE_COLOR", "3");
    cmd.env("MUNIN_STUDIO_TOOLS",std::env::current_exe().map_err(|e|e.to_string())?);
    cmd.env_remove("NO_COLOR");
    for arg in launch.get_args() {
        cmd.arg(arg);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command in PTY: {}", e))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    let output_buffer = Arc::new(Mutex::new(Vec::new()));
    let output_buffer_clone = Arc::clone(&output_buffer);

    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Ok(mut guard) = output_buffer_clone.lock() {
                        guard.extend_from_slice(&buf[..n]);
                    } else {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let session_id = format!("pty-{}", SESSION_COUNTER.fetch_add(1, Ordering::SeqCst));
    let mut session = PtySession {
        master: Arc::new(Mutex::new(pair.master)),
        writer: Arc::new(Mutex::new(writer)),
        output_buffer,
        utf8_pending: Vec::new(),
        child,
        owner: owner.map(String::from),
        insertion,
    };

    // Closing a window can race with the spawn response. Keep an owner marker
    // so an in-flight spawn cannot register a session after its window closes.
    let closed = closed_owners().lock().map_err(|e| e.to_string())?;
    if owner.is_some_and(|owner| closed.contains(owner)) {
        let _ = session.child.kill();
        return Err("ターミナルの接続は取り消されました。".into());
    }
    let mut sessions = get_sessions().lock().map_err(|e| e.to_string())?;
    sessions.insert(session_id.clone(), session);

    Ok(session_id)
}

pub fn pty_write(session_id: &str, data: &str) -> Result<(), String> {
    let sessions = get_sessions()
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?;
    let session = sessions
        .get(session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    let mut writer = session
        .writer
        .lock()
        .map_err(|e| format!("Writer lock poisoned: {}", e))?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to PTY: {}", e))?;
    writer
        .flush()
        .map_err(|e| format!("Failed to flush PTY writer: {}", e))?;
    Ok(())
}

pub fn pty_read(session_id: &str) -> Result<(String, bool), String> {
    let mut sessions = get_sessions()
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    let alive = match session.child.try_wait() {
        Ok(None) => true,
        _ => false,
    };

    let mut buffer = session
        .output_buffer
        .lock()
        .map_err(|e| format!("Buffer lock poisoned: {}", e))?;
    let mut bytes = std::mem::take(&mut session.utf8_pending);
    bytes.extend_from_slice(&buffer);
    buffer.clear();
    let decoded = decode_utf8_stream(&bytes, &mut session.utf8_pending, !alive);
    Ok((decoded, alive))
}

fn decode_utf8_stream(bytes: &[u8], pending: &mut Vec<u8>, flush: bool) -> String {
    let mut out = String::new();
    let mut rest = bytes;
    while !rest.is_empty() {
        match std::str::from_utf8(rest) {
            Ok(valid) => {
                out.push_str(valid);
                break;
            }
            Err(error) => {
                let valid_len = error.valid_up_to();
                if valid_len > 0 {
                    out.push_str(std::str::from_utf8(&rest[..valid_len]).unwrap());
                }
                if let Some(err_len) = error.error_len() {
                    out.push('\u{FFFD}');
                    rest = &rest[valid_len + err_len..];
                } else if flush {
                    out.push('\u{FFFD}');
                    break;
                } else {
                    pending.extend_from_slice(&rest[valid_len..]);
                    break;
                }
            }
        }
    }
    out
}

pub fn pty_resize(session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = get_sessions()
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?;
    let session = sessions
        .get(session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    let master = session
        .master
        .lock()
        .map_err(|e| format!("Master lock poisoned: {}", e))?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize PTY: {}", e))?;
    Ok(())
}

pub fn pty_kill(session_id: &str) -> Result<(), String> {
    let mut sessions = get_sessions()
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?;
    if let Some(mut session) = sessions.remove(session_id) {
        let _ = session.child.kill();
    }
    Ok(())
}

pub fn pty_close_owner(owner: &str) -> Result<(), String> {
    if owner.is_empty() || owner.len() > 128 {
        return Err("ターミナル所有者IDが不正です。".into());
    }
    let mut closed = closed_owners().lock().map_err(|e| e.to_string())?;
    closed.insert(owner.to_string());
    let mut sessions = get_sessions().lock().map_err(|e| e.to_string())?;
    let ids: Vec<_> = sessions
        .iter()
        .filter(|(_, session)| session.owner.as_deref() == Some(owner))
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        if let Some(mut session) = sessions.remove(&id) {
            let _ = session.child.kill();
        }
    }
    Ok(())
}

fn approval_args(command: &str, auto_review: bool) -> &'static [&'static str] {
    match (command, auto_review) {
        ("codex", true) => &["--approve-for-me"],
        ("claude", true) => &["--permission-mode", "auto"],
        ("claude", false) => &["--permission-mode", "default"],
        ("agy", true) => &["--mode", "auto"],
        ("agy", false) => &["--settings", r#"{"agentMode":""}"#],
        _ => &[],
    }
}

pub fn execute_pty_request(
    action: &str,
    root: &Path,
    options: &serde_json::Value,
) -> Result<String, String> {
    match action {
        "pty-spawn" => {
            let default_shell = if cfg!(windows) {
                if crate::agent::which_binary("pwsh").is_some() {
                    "pwsh.exe".to_string()
                } else if crate::agent::which_binary("powershell").is_some() {
                    "powershell.exe".to_string()
                } else {
                    "cmd.exe".to_string()
                }
            } else {
                std::env::var("SHELL")
                    .ok()
                    .filter(|shell| !shell.trim().is_empty() && Path::new(shell).is_file())
                    .unwrap_or_else(|| "sh".to_string())
            };
            let command = options
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or(default_shell.as_str());
            let mut args: Vec<String> = options
                .get("args")
                .and_then(|v| {
                    if let Some(arr) = v.as_array() {
                        Some(
                            arr.iter()
                                .filter_map(|v| v.as_str().map(String::from))
                                .collect(),
                        )
                    } else if let Some(s) = v.as_str() {
                        if let Ok(arr) = serde_json::from_str::<Vec<String>>(s) {
                            Some(arr)
                        } else {
                            Some(s.split_whitespace().map(String::from).collect())
                        }
                    } else {
                        None
                    }
                })
                .unwrap_or_default();
            let cols = options
                .get("cols")
                .and_then(|v| {
                    v.as_u64()
                        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                })
                .unwrap_or(80) as u16;
            let rows = options
                .get("rows")
                .and_then(|v| {
                    v.as_u64()
                        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                })
                .unwrap_or(24) as u16;
            let owner = options
                .get("owner_id")
                .or_else(|| options.get("ownerId"))
                .and_then(|v| v.as_str());
            let directory=working_directory(root,options["working_directory"].as_str())?;
            if let Some(auto_review) = options["auto_review"].as_bool() {
                args.splice(..0, approval_args(command, auto_review).iter().map(|arg| (*arg).to_owned()));
            }
            let insertion = if options["studio_mcp"] == true && matches!(command, "codex" | "claude") {
                let mailbox = tempfile::tempdir().map_err(|error| error.to_string())?;
                let mut connection = crate::mcp::terminal_args(command, root, mailbox.path())?;
                connection.append(&mut args);
                args = connection;
                Some(mailbox)
            } else { None };
            let session_id = pty_spawn_owned_in(command, &args, cols, rows, owner,&directory,insertion)?;
            serde_json::to_string(&serde_json::json!({ "session_id": session_id }))
                .map_err(|e| e.to_string())
        }
        "pty-write" => {
            let session_id = options
                .get("session_id")
                .or_else(|| options.get("sessionId"))
                .and_then(|v| v.as_str())
                .ok_or("session_id is required")?;
            let data = options
                .get("data")
                .and_then(|v| v.as_str())
                .ok_or("data is required")?;
            pty_write(session_id, data)?;
            serde_json::to_string(&serde_json::json!({ "ok": true })).map_err(|e| e.to_string())
        }
        "pty-read" => {
            let session_id = options
                .get("session_id")
                .or_else(|| options.get("sessionId"))
                .and_then(|v| v.as_str())
                .ok_or("session_id is required")?;
            let (data, alive) = pty_read(session_id)?;
            let mut sessions = get_sessions().lock().map_err(|error| error.to_string())?;
            let insertion = sessions.get_mut(session_id).and_then(|session| {
                if alive { session.insertion.as_ref() } else { session.insertion = None; None }
            });
            let pending = insertion.and_then(|directory| crate::mcp_insert::pending(directory.path()).ok().flatten());
            serde_json::to_string(&serde_json::json!({ "data": data, "alive": alive, "insert": pending }))
                .map_err(|e| e.to_string())
        }
        "pty-insert-result" => {
            let session_id = options["sessionId"].as_str().ok_or("sessionId is required")?;
            let id = options["id"].as_str().ok_or("Insertion ID is required")?;
            let sessions = get_sessions().lock().map_err(|error| error.to_string())?;
            let mailbox = sessions.get(session_id).and_then(|session| session.insertion.as_ref())
                .ok_or("Studio insertion session has ended")?;
            crate::mcp_insert::acknowledge(mailbox.path(), id, &options["result"])?;
            Ok("{\"ok\":true}".into())
        }
        "pty-resize" => {
            let session_id = options
                .get("session_id")
                .or_else(|| options.get("sessionId"))
                .and_then(|v| v.as_str())
                .ok_or("session_id is required")?;
            let cols = options.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
            let rows = options.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
            pty_resize(session_id, cols, rows)?;
            serde_json::to_string(&serde_json::json!({ "ok": true })).map_err(|e| e.to_string())
        }
        "pty-close-owner" => {
            let owner = options
                .get("owner_id")
                .or_else(|| options.get("ownerId"))
                .and_then(|v| v.as_str())
                .ok_or("owner_id is required")?;
            pty_close_owner(owner)?;
            Ok("{\"ok\":true}".into())
        }
        "pty-kill" => {
            let session_id = options
                .get("session_id")
                .or_else(|| options.get("sessionId"))
                .and_then(|v| v.as_str())
                .ok_or("session_id is required")?;
            pty_kill(session_id)?;
            serde_json::to_string(&serde_json::json!({ "ok": true })).map_err(|e| e.to_string())
        }
        _ => Err(format!("Unsupported PTY action: {}", action)),
    }
}

fn is_oneshot_cli() -> bool {
    if std::env::var("MANUALCTL_DAEMON").is_ok() {
        return false;
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(name) = exe.file_name().and_then(|n| n.to_str()) {
            return name == "manualctl" || name == "manualctl.exe";
        }
    }
    false
}

fn send_to_daemon(
    action: &str,
    root: &Path,
    options: &serde_json::Value,
) -> Result<String, String> {
    let port_file = std::env::temp_dir().join("manualctl-pty-v2.port");
    let mut port = None;
    if let Ok(content) = std::fs::read_to_string(&port_file) {
        if let Ok(p) = content.trim().parse::<u16>() {
            port = Some(p);
        }
    }

    let mut stream = None;
    if let Some(p) = port {
        if let Ok(s) = std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], p)),
            std::time::Duration::from_millis(200),
        ) {
            stream = Some(s);
        }
    }

    if stream.is_none() {
        // Multiple manualctl requests (including close during startup) must
        // reach the same daemon rather than each starting a separate one.
        let startup_lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(std::env::temp_dir().join("manualctl-pty-v2.lock"))
            .map_err(|e| e.to_string())?;
        startup_lock.lock().map_err(|e| e.to_string())?;
        if let Ok(content) = std::fs::read_to_string(&port_file) {
            if let Ok(port) = content.trim().parse::<u16>() {
                stream = std::net::TcpStream::connect_timeout(
                    &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
                    std::time::Duration::from_millis(200),
                )
                .ok();
            }
        }
        if stream.is_none() {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let mut cmd = std::process::Command::new(exe);
            crate::platform::no_window(&mut cmd);
            cmd.arg("--pty-daemon")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                cmd.process_group(0);
            }
            cmd.spawn()
                .map_err(|e| format!("Failed to spawn PTY daemon: {}", e))?;

            let start = std::time::Instant::now();
            while start.elapsed() < std::time::Duration::from_secs(3) {
                std::thread::sleep(std::time::Duration::from_millis(50));
                if let Ok(content) = std::fs::read_to_string(&port_file) {
                    if let Ok(p) = content.trim().parse::<u16>() {
                        if let Ok(s) = std::net::TcpStream::connect_timeout(
                            &std::net::SocketAddr::from(([127, 0, 0, 1], p)),
                            std::time::Duration::from_millis(200),
                        ) {
                            stream = Some(s);
                            break;
                        }
                    }
                }
            }
        }
    }

    let mut stream = stream.ok_or_else(|| "Failed to connect to PTY daemon".to_string())?;
    let payload = serde_json::json!({
        "action": action,
        "root": root.to_string_lossy(),
        "options": options,
    });
    use std::io::{BufRead, BufReader, Write};
    writeln!(stream, "{}", payload).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| e.to_string())?;
    let resp: serde_json::Value =
        serde_json::from_str(&line).map_err(|e| format!("Failed to parse daemon response: {e}"))?;
    if let Some(err) = resp.get("error").and_then(|v| v.as_str()) {
        Err(err.to_string())
    } else if let Some(out) = resp.get("output").and_then(|v| v.as_str()) {
        Ok(out.to_string())
    } else {
        Err("Invalid daemon response".to_string())
    }
}

pub fn handle_pty_request(
    action: &str,
    root: &Path,
    options: &serde_json::Value,
) -> Result<String, String> {
    if is_oneshot_cli() {
        send_to_daemon(action, root, options)
    } else {
        execute_pty_request(action, root, options)
    }
}

pub fn run_daemon() {
    std::env::set_var("MANUALCTL_DAEMON", "1");
    let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Failed to bind PTY daemon: {}", e);
            return;
        }
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(e) => {
            eprintln!("Failed to get local port: {}", e);
            return;
        }
    };
    let port_file = std::env::temp_dir().join("manualctl-pty-v2.port");
    if let Err(e) = std::fs::write(&port_file, port.to_string()) {
        eprintln!("Failed to write port file: {}", e);
        return;
    }

    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        thread::spawn(move || {
            use std::io::{BufRead, BufReader, Write};
            let reader_stream = match stream.try_clone() {
                Ok(s) => s,
                Err(_) => return,
            };
            let mut reader = BufReader::new(reader_stream);
            let mut line = String::new();
            if reader.read_line(&mut line).is_ok() {
                if let Ok(req) = serde_json::from_str::<serde_json::Value>(&line) {
                    let action = req
                        .get("action")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    let root = req.get("root").and_then(|v| v.as_str()).unwrap_or(".");
                    let default_opts = serde_json::Value::Null;
                    let options = req.get("options").unwrap_or(&default_opts);
                    let res = execute_pty_request(action, Path::new(root), options);
                    let resp_json = match res {
                        Ok(out) => serde_json::json!({ "output": out }),
                        Err(err) => serde_json::json!({ "error": err }),
                    };
                    let _ = writeln!(stream, "{}", resp_json);
                    let _ = stream.flush();
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_approval_mode_uses_each_clis_session_options() {
        assert_eq!(approval_args("codex", true), ["--approve-for-me"]);
        assert!(approval_args("codex", false).is_empty());
        assert_eq!(approval_args("claude", true), ["--permission-mode", "auto"]);
        assert_eq!(approval_args("claude", false), ["--permission-mode", "default"]);
        assert_eq!(approval_args("agy", true), ["--mode", "auto"]);
        assert_eq!(approval_args("agy", false), ["--settings", r#"{"agentMode":""}"#]);
        assert!(approval_args("sh", true).is_empty());
    }
    use std::path::Path;

    #[cfg(windows)]
    #[test]
    fn npm_codex_terminal_runs_in_project_and_accepts_input() {
        let root=tempfile::tempdir().unwrap();
        let bin=root.path().join("npm path with spaces");
        let scripts=bin.join("node_modules/@openai/codex/bin");
        std::fs::create_dir_all(&scripts).unwrap();
        let shim=bin.join("codex.cmd");
        std::fs::write(&shim,"@exit /b 99\r\n").unwrap();
        std::fs::write(scripts.join("codex.js"),r#"
require('node:fs').writeFileSync('terminal-cwd.json',JSON.stringify(process.cwd()));
console.log('NODE_READY');
process.stdin.setRawMode(true);
process.stdin.on('data',data=>{require('node:fs').appendFileSync('terminal-input.txt',data);console.log('NODE:'+String(data).trim());});
"#).unwrap();
        let work=root.path().join("application source");std::fs::create_dir(&work).unwrap();
        let id=pty_spawn_owned_in(&shim.to_string_lossy(),&[],80,24,None,&work,None).unwrap();
        let mut output=String::new();let started=std::time::Instant::now();
        while !output.contains("NODE_READY") && started.elapsed().as_secs()<5 {
            output.push_str(&pty_read(&id).unwrap().0);thread::sleep(std::time::Duration::from_millis(20));
        }
        pty_write(&id,"hello_terminal\r").unwrap();
        while !output.contains("NODE:hello_terminal") && started.elapsed().as_secs()<7 {
            output.push_str(&pty_read(&id).unwrap().0);thread::sleep(std::time::Duration::from_millis(20));
        }
        pty_write(&id,"\x1b[B回答\r").unwrap();
        while !std::fs::read_to_string(work.join("terminal-input.txt")).unwrap_or_default().ends_with("\x1b[B回答\r") && started.elapsed().as_secs()<7 {
            thread::sleep(std::time::Duration::from_millis(20));
        }
        pty_kill(&id).unwrap();
        assert!(output.contains("NODE:hello_terminal"),"{output:?}");
        assert_eq!(std::fs::read_to_string(work.join("terminal-input.txt")).unwrap(),"hello_terminal\r\x1b[B回答\r");
        let cwd:String=serde_json::from_slice(&std::fs::read(work.join("terminal-cwd.json")).unwrap()).unwrap();
        assert_eq!(Path::new(&cwd).canonicalize().unwrap(),work.canonicalize().unwrap());
    }

    #[test]
    fn working_directory_defaults_to_root_and_validates_custom_folders(){
        let root=tempfile::tempdir().unwrap();
        assert_eq!(working_directory(root.path(),None).unwrap(),crate::platform::canonical_clean(root.path()).unwrap());
        let custom=root.path().join("application source");std::fs::create_dir(&custom).unwrap();
        assert_eq!(working_directory(root.path(),Some("application source")).unwrap(),crate::platform::canonical_clean(&custom).unwrap());
        std::fs::write(root.path().join("file.txt"),"not a directory").unwrap();
        assert!(working_directory(root.path(),Some("file.txt")).is_err());
        assert!(working_directory(root.path(),Some("missing")).is_err());
    }

    #[test]
    fn utf8_stream_decoder_preserves_multibyte_japanese_across_chunks() {
        let sample = "日本語テスト出力".as_bytes();
        let mut pending = Vec::new();
        // Split right in the middle of a 3-byte Japanese character
        let part1 = decode_utf8_stream(&sample[..4], &mut pending, false);
        let mut chunk2 = std::mem::take(&mut pending);
        chunk2.extend_from_slice(&sample[4..]);
        let part2 = decode_utf8_stream(&chunk2, &mut pending, true);
        assert_eq!(format!("{part1}{part2}"), "日本語テスト出力");
        assert!(pending.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn pty_advertises_truecolor_and_preserves_ansi_output() {
        let args = vec!["-c".into(), "printf '%s|%s|%s|%s\\n' \"$TERM\" \"$COLORTERM\" \"$FORCE_COLOR\" \"${NO_COLOR-unset}\"; printf '\\033[38;2;255;0;0mRED\\033[0m\\n'; sleep 1".into()];
        let id = pty_spawn(Path::new("."), "sh", &args, 80, 24).unwrap();
        let mut output = String::new();
        let started = std::time::Instant::now();
        while !output.contains("RED") && started.elapsed().as_secs() < 3 {
            output.push_str(&pty_read(&id).unwrap().0);
            thread::sleep(std::time::Duration::from_millis(20));
        }
        pty_kill(&id).unwrap();
        assert!(
            output.contains("xterm-256color|truecolor|3|unset"),
            "{output:?}"
        );
        assert!(
            output.contains("\x1b[38;2;255;0;0mRED\x1b[0m"),
            "{output:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn closing_owner_stops_only_its_sessions_and_rejects_late_spawns() {
        let owner = "test-closed-window";
        let other = "test-open-window";
        let id = pty_spawn_owned(Path::new("."), "sh", &[], 80, 24, Some(owner)).unwrap();
        let other_id = pty_spawn_owned(Path::new("."), "sh", &[], 80, 24, Some(other)).unwrap();
        pty_close_owner(owner).unwrap();
        assert!(pty_read(&id).is_err());
        assert!(pty_read(&other_id).unwrap().1);
        assert!(pty_spawn_owned(Path::new("."), "sh", &[], 80, 24, Some(owner)).is_err());
        pty_close_owner(other).unwrap();
    }

    #[test]
    fn test_pty_spawn_write_and_read() {
        let root = Path::new(".");
        #[cfg(windows)]
        let cmd = "cmd.exe";
        #[cfg(not(windows))]
        let cmd = "sh";
        let session_id = pty_spawn(root, cmd, &[], 80, 24).unwrap();
        pty_write(&session_id, "echo hello_pty\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let (output, alive) = pty_read(&session_id).unwrap();
        assert!(
            output.contains("hello_pty"),
            "Output should contain hello_pty, got: {:?}",
            output
        );
        assert!(alive);
        pty_kill(&session_id).unwrap();
    }
}
