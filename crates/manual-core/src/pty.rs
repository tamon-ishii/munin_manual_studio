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
    child: Box<dyn portable_pty::Child + Send + Sync>,
    owner: Option<String>,
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
    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let mut cmd = CommandBuilder::new(command);
    cmd.cwd(root);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("CLICOLOR", "1");
    cmd.env("FORCE_COLOR", "3");
    cmd.env_remove("NO_COLOR");
    for arg in args {
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
        child,
        owner: owner.map(String::from),
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
    let bytes = std::mem::take(&mut *buffer);
    Ok((String::from_utf8_lossy(&bytes).to_string(), alive))
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

pub fn execute_pty_request(
    action: &str,
    root: &Path,
    options: &serde_json::Value,
) -> Result<String, String> {
    match action {
        "pty-spawn" => {
            let command = options
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or_else(|| if cfg!(windows) { "cmd.exe" } else { "sh" });
            let args: Vec<String> = options
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
            let session_id = pty_spawn_owned(root, command, &args, cols, rows, owner)?;
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
            serde_json::to_string(&serde_json::json!({ "data": data, "alive": alive }))
                .map_err(|e| e.to_string())
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
    use std::path::Path;

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
