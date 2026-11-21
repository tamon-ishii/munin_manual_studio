use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub(crate) fn request(
    directory: &Path,
    action: &str,
    arguments: &Value,
    seconds: u64,
) -> Result<Value, String> {
    let ticket = tempfile::Builder::new()
        .prefix("insert-")
        .tempdir_in(directory)
        .map_err(|error| error.to_string())?;
    let id = ticket.path().file_name().unwrap().to_string_lossy();
    let expires_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis()
        + u128::from(seconds) * 1000;
    write_json(
        &ticket.path().join("request.json"),
        &json!({"id": id, "action": action, "arguments": arguments, "expiresAt": expires_at}),
    )?;
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let response = ticket.path().join("response.json");
    loop {
        if let Some(result) = read_json(&response)? {
            if let Some(error) = result["error"].as_str() {
                return Err(error.to_string());
            }
            return Ok(result);
        }
        if Instant::now() >= deadline || !ticket.path().is_dir() {
            return Err(
                "Studio did not confirm the editor request. Check the editor before retrying."
                    .into(),
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

pub(crate) fn pending(directory: &Path) -> Result<Option<Value>, String> {
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let ticket = entry.path();
        if !ticket.join("response.json").exists() {
            if let Some(request) = read_json(&ticket.join("request.json"))? {
                return Ok(Some(request));
            }
        }
    }
    Ok(None)
}

pub(crate) fn acknowledge(directory: &Path, id: &str, result: &Value) -> Result<(), String> {
    if !id.starts_with("insert-")
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("Invalid Studio insertion ID".into());
    }
    let ticket = directory.join(id);
    if read_json(&ticket.join("request.json"))?.is_some() {
        write_json(&ticket.join("response.json"), result)?;
    }
    Ok(())
}

fn read_json(path: &Path) -> Result<Option<Value>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn write_json(path: &Path, data: &Value) -> Result<(), String> {
    let file = tempfile::NamedTempFile::new_in(path.parent().unwrap())
        .map_err(|error| error.to_string())?;
    serde_json::to_writer(file.as_file(), data).map_err(|error| error.to_string())?;
    file.persist(path).map_err(|error| error.to_string())?;
    Ok(())
}
