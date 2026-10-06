use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::collections::HashMap;
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
}

static SESSIONS: OnceLock<Mutex<HashMap<String, PtySession>>> = OnceLock::new();

fn get_sessions() -> &'static Mutex<HashMap<String, PtySession>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn pty_spawn(
    root: &Path,
    command: &str,
    args: &[String],
    cols: u16,
    rows: u16,
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
    let session = PtySession {
        master: Arc::new(Mutex::new(pair.master)),
        writer: Arc::new(Mutex::new(writer)),
        output_buffer,
        child,
    };

    let mut sessions = get_sessions()
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?;
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
                .unwrap_or_else(|| {
                    if cfg!(windows) { "cmd.exe" } else { "sh" }
                });
            let args: Vec<String> = options
                .get("args")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let cols = options.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
            let rows = options.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
            let session_id = pty_spawn(root, command, &args, cols, rows)?;
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
            serde_json::to_string(&serde_json::json!({ "ok": true }))
                .map_err(|e| e.to_string())
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
            serde_json::to_string(&serde_json::json!({ "ok": true }))
                .map_err(|e| e.to_string())
        }
        "pty-kill" => {
            let session_id = options
                .get("session_id")
                .or_else(|| options.get("sessionId"))
                .and_then(|v| v.as_str())
                .ok_or("session_id is required")?;
            pty_kill(session_id)?;
            serde_json::to_string(&serde_json::json!({ "ok": true }))
                .map_err(|e| e.to_string())
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
    let port_file = std::env::temp_dir().join("manualctl-pty.port");
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
    let port_file = std::env::temp_dir().join("manualctl-pty.port");
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
                    let action = req.get("action").and_then(|v| v.as_str()).unwrap_or_default();
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
        assert!(output.contains("hello_pty"), "Output should contain hello_pty, got: {:?}", output);
        assert!(alive);
        pty_kill(&session_id).unwrap();
    }
}
