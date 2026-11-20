use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Write},
    path::Path,
};

pub const FLAG: &str = "--studio-mcp";
const NAME: &str = "munin-studio";
const PROTOCOL_VERSION: &str = "2025-11-25";

pub(crate) fn terminal_args(agent: &str, root: &Path) -> Result<Vec<String>, String> {
    if !matches!(agent, "codex" | "claude") {
        return Ok(Vec::new());
    }
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let command = executable
        .to_str()
        .ok_or("Studio executable path is not UTF-8")?;
    let root = root.to_str().ok_or("Studio project path is not UTF-8")?;
    let args = [FLAG, root];
    if agent == "claude" {
        let config = json!({"mcpServers": { (NAME): {
            "type": "stdio", "command": command, "args": args
        }}});
        return Ok(vec!["--mcp-config".into(), config.to_string()]);
    }
    let mut config = Vec::new();
    for (key, value) in [
        ("command", toml::Value::String(command.into())),
        (
            "args",
            toml::Value::Array(
                args.into_iter()
                    .map(|arg| toml::Value::String(arg.into()))
                    .collect(),
            ),
        ),
        ("enabled", toml::Value::Boolean(true)),
    ] {
        config.extend(["-c".into(), format!("mcp_servers.{NAME}.{key}={value}")]);
    }
    Ok(config)
}

pub fn run(root: &Path) -> Result<(), String> {
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("Studio project must be a directory".into());
    }
    serve(&root, io::stdin().lock(), io::stdout().lock()).map_err(|error| error.to_string())
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object", "properties": properties, "required": required,
            "additionalProperties": false
        }
    })
}

fn tools() -> Vec<Value> {
    let path = json!({"type": "string", "description": "Path relative to the Studio project"});
    vec![
        tool(
            "windows",
            "List windows available for MarkIts capture.",
            json!({}),
            &[],
        ),
        tool(
            "capture",
            "Capture a window to a new PNG in the Studio project.",
            json!({
                "window": {"type": "string", "description": "ID from the windows tool"},
                "output": path, "detect_ui": {"type": "boolean", "default": true}
            }),
            &["window", "output"],
        ),
        tool(
            "inspect",
            "Read image dimensions and MarkIts UI metadata.",
            json!({"image": path}),
            &["image"],
        ),
        tool(
            "annotate",
            "Render MarkIts annotations into a new project PNG.",
            json!({
                "image": path, "output": path, "scene": {"type": "object"},
                "crop_margin": {"type": "integer", "minimum": 0, "maximum": 4096},
                "strip_metadata": {"type": "boolean"}
            }),
            &["image", "output", "scene"],
        ),
        tool(
            "operations-schema",
            "Read the MarkIts operation script schema.",
            json!({}),
            &[],
        ),
        tool(
            "operations-validate",
            "Validate a MarkIts operation script.",
            json!({"script": {"type": "object"}}),
            &["script"],
        ),
        tool(
            "operations-inspect",
            "Read the MarkIts recording or script embedded in a PNG.",
            json!({
                "image": path, "script_only": {"type": "boolean"}
            }),
            &["image"],
        ),
    ]
}

fn call_tool(root: &Path, catalog: &[Value], params: &Value) -> Result<Value, (i32, &'static str)> {
    let name = params["name"]
        .as_str()
        .ok_or((-32602, "Tool name is required"))?;
    let tool = catalog
        .iter()
        .find(|tool| tool["name"] == name)
        .ok_or((-32602, "Unknown tool"))?;
    let mut request = match params.get("arguments") {
        None => serde_json::Map::new(),
        Some(Value::Object(arguments)) => arguments.clone(),
        _ => return Err((-32602, "Tool arguments must be an object")),
    };
    let schema = &tool["inputSchema"];
    let required = schema["required"].as_array().unwrap();
    if required
        .iter()
        .any(|key| !request.contains_key(key.as_str().unwrap()))
        || request
            .keys()
            .any(|key| schema["properties"].get(key).is_none())
    {
        return Err((-32602, "Missing or unknown tool arguments"));
    }
    for (key, value) in &request {
        let valid = match schema["properties"][key]["type"].as_str() {
            Some("string") => value.is_string(),
            Some("boolean") => value.is_boolean(),
            Some("object") => value.is_object(),
            Some("integer") => value.as_u64().is_some_and(|number| number <= 4096),
            _ => false,
        };
        if !valid {
            return Err((-32602, "Invalid tool argument"));
        }
    }
    request.insert("root".into(), json!(root));
    request.insert("action".into(), json!(name));
    let request = Value::Object(request);
    let outcome = match name {
        "windows" | "capture" => crate::terminal_tools::invoke_isolated(root, &request),
        _ => crate::terminal_tools::execute(&request),
    };
    Ok(match outcome {
        Ok(value) => json!({"content": [{"type": "text", "text": value.to_string()}]}),
        Err(error) => json!({"content": [{"type": "text", "text": error}], "isError": true}),
    })
}

fn serve(root: &Path, input: impl BufRead, mut output: impl Write) -> io::Result<()> {
    let catalog = tools();
    let mut negotiated = false;
    let mut initialized = false;
    for line in input.split(b'\n') {
        let line = line?;
        let request = serde_json::from_slice::<Value>(&line);
        let response = match request {
            Ok(request)
                if request["jsonrpc"] == "2.0"
                    && request["method"].is_string()
                    && request
                        .get("id")
                        .is_none_or(|id| id.is_string() || id.is_i64() || id.is_u64()) =>
            {
                let method = request["method"].as_str().unwrap();
                let Some(id) = request.get("id") else {
                    if method == "notifications/initialized" && negotiated {
                        initialized = true;
                    }
                    continue;
                };
                let result = match method {
                    "initialize" => match request["params"]["protocolVersion"].as_str() {
                        Some(version) => {
                            let version = match version {
                                "2024-11-05" | "2025-03-26" | "2025-06-18" => version,
                                _ => PROTOCOL_VERSION,
                            };
                            negotiated = true;
                            Ok(json!({
                                "protocolVersion": version,
                                "capabilities": {"tools": {}},
                                "serverInfo": {"name": NAME, "version": env!("CARGO_PKG_VERSION")}
                            }))
                        }
                        None => Err((-32602, "Protocol version is required")),
                    },
                    "ping" => Ok(json!({})),
                    "tools/list" if initialized => Ok(json!({"tools": catalog})),
                    "tools/call" if initialized => call_tool(root, &catalog, &request["params"]),
                    "tools/list" | "tools/call" => Err((-32002, "Server is not initialized")),
                    _ => Err((-32601, "Method not found")),
                };
                match result {
                    Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
                    Err((code, message)) => rpc_error(id, code, message),
                }
            }
            Ok(_) => rpc_error(&Value::Null, -32600, "Invalid request"),
            Err(_) => rpc_error(&Value::Null, -32700, "Parse error"),
        };
        serde_json::to_writer(&mut output, &response)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(())
}

fn rpc_error(id: &Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}
