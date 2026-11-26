use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Write},
    path::Path,
};

pub const FLAG: &str = "--studio-mcp";
const NAME: &str = "munin-studio";
const PROTOCOL_VERSION: &str = "2025-11-25";

pub(crate) fn terminal_args(
    agent: &str,
    root: &Path,
    mailbox: &Path,
) -> Result<Vec<String>, String> {
    if !matches!(agent, "codex" | "claude") {
        return Ok(Vec::new());
    }
    let root = crate::platform::canonical_clean(root).map_err(|error| error.to_string())?;
    let executable = std::env::current_exe()
        .map(|p| crate::platform::strip_windows_verbatim(&p))
        .map_err(|error| error.to_string())?;
    let command = executable
        .to_str()
        .ok_or("Studio executable path is not UTF-8")?;
    let root = root.to_str().ok_or("Studio project path is not UTF-8")?;
    let mailbox = mailbox
        .to_str()
        .ok_or("Studio insertion path is not UTF-8")?;
    let args = [FLAG, root, mailbox];
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
        ("tool_timeout_sec", toml::Value::Integer(190)),
    ] {
        config.extend(["-c".into(), format!("mcp_servers.{NAME}.{key}={value}")]);
    }
    Ok(config)
}

pub fn run(root: &Path, mailbox: Option<&Path>) -> Result<(), String> {
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("Studio project must be a directory".into());
    }
    serve(&root, mailbox, io::stdin().lock(), io::stdout().lock())
        .map_err(|error| error.to_string())
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

fn tools(insertion: bool) -> Vec<Value> {
    let path = json!({"type": "string", "description": "Path relative to the Studio project"});
    let mut tools = vec![
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
            "attach-uimap",
            "Embed a UIMap JSON file in a new MarkIts-editable PNG without modifying the input image.",
            json!({"image":path,"uimap":path,"output":path}),
            &["image","uimap","output"],
        ),
        tool(
            "register-capture",
            "Register an original PNG in Studio Capture Resources, preserving any MarkIts UIMap and operation metadata.",
            json!({"image":path,"name":{"type":"string"}}),
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
        tool(
            "find-images",
            "Find project images by name, path or manuscript usage. Returns up to 50 matches.",
            json!({"query":{"type":"string"}}),
            &[],
        ),
    ];
    if insertion {
        tools.push(tool(
            "annotate-and-insert",
            "Annotate an existing screenshot and insert the new PNG at the current manuscript cursor. Leaves the manuscript unsaved.",
            json!({
                "image": path, "output": path, "scene": {"type": "object"},
                "crop_margin": {"type": "integer", "minimum": 0, "maximum": 4096},
                "strip_metadata": {"type": "boolean"},
                "alt": {"type": "string", "description": "Image description for the manuscript"}
            }),
            &["image", "output", "scene"],
        ));
        tools.extend([
            tool("active-editor", "Read the active manuscript, cursor and unsaved state, optionally including the current draft.", json!({"include_content":{"type":"boolean"}}), &[]),
            tool("insert-image", "Insert a project PNG/JPEG or a registered capture resource at the manuscript cursor. Supply exactly one of image or resource_id.",
                json!({"image":path,"resource_id":{"type":"string"},"alt":{"type":"string"}}), &[]),
            tool("preview-edit", "Review proposed Markdown edits in Studio and apply only the changes approved by the user, without saving.",
                json!({"page":{"type":"string"},"before":{"type":"string","description":"Exact draft from active-editor"},"after":{"type":"string"}}),
                &["page","before","after"]),
            tool("proofread", "Open Studio's proofreading diff. Supply up to three independent full Markdown drafts, keyed by skill ID. The user can mix changes from the drafts or keep the original per diff block. Applies only selected changes and leaves the document unsaved.",
                json!({
                    "page":{"type":"string","description":"Page from active-editor"},
                    "before":{"type":"string","description":"Exact draft from active-editor with include_content enabled"},
                    "drafts":{"type":"object","description":"Map of proofreading skill IDs to full Markdown drafts. Use proofreading-skills to list IDs and proofread-text to generate drafts.","minProperties":1,"maxProperties":3,"additionalProperties":{"type":"string"}}
                }),
                &["page","before","drafts"]),
        ]);
    }
    tools.extend([
        tool("import-generated-image", "Import an image already generated by the connected MCP client into the Studio generated image library. Returns its project-relative path for insert-image.",
            json!({"image":{"type":"string","description":"Project-relative image path"},"description":{"type":"string"}}),
            &["image"]),
        tool("proofreading-skills", "List built-in and project-defined proofreading skills and their editorial rules.", json!({}), &[]),
        tool("proofread-text", "Use Studio's configured AI to proofread Markdown using a skill from proofreading-skills. Returns revised Markdown without opening a review window or editing the manuscript.",
            json!({"source":{"type":"string","description":"Original Markdown"},"skill":{"type":"string","description":"Proofreading skill ID"}}),
            &["source","skill"]),
        tool("project-glossary", "List project terminology and preferred UI/style wording from .munin/glossary.json.",
            json!({"query":{"type":"string","description":"Optional substring filter"},"category":{"type":"string","description":"Optional category: ui, term, or style"}}),
            &[]),
        tool("upsert-glossary-term", "Add a new term or merge avoid variants/note into an existing term in .munin/glossary.json without deleting existing terms.",
            json!({
                "preferred":{"type":"string","description":"Canonical preferred wording"},
                "avoid":{"type":"array","items":{"type":"string"},"description":"Optional variants to avoid"},
                "category":{"type":"string","description":"Optional category: ui, term, or style"},
                "note":{"type":"string","description":"Optional editorial note"},
                "case_sensitive":{"type":"boolean","description":"Whether matching is case-sensitive"}
            }),
            &["preferred"]),
        tool("check-manuscript", "Run manuscript quality checks including broken links, missing images, MarkIts annotation/UIMap consistency, glossary violations, and unresolved ai-note comments.",
            json!({"page":{"type":"string","description":"Optional single manuscript path to check"}}),
            &[]),
        tool("draft-from-recording", "Generate a procedural Markdown draft from MarkIts operation recordings, scripts, annotations, or UIMap metadata embedded in a PNG or capture resource.",
            json!({"image":path,"resource_id":{"type":"string"},"page":{"type":"string"},"title":{"type":"string"}}),
            &[]),
        tool("analyze-app-impact", "Analyze Git diffs in the target application repository and list impacted manual pages and screenshots.",
            json!({"repo_path":{"type":"string","description":"Repository path (defaults to Studio project root)"},"base_ref":{"type":"string","description":"Git base ref such as HEAD~1 or a tag"}}),
            &[]),
        tool("fact-check-manuscript", "Verify commands, flags, paths, and quoted UI labels in a manuscript against source files and MarkIts UIMaps.",
            json!({"page":{"type":"string","description":"Manuscript path to audit"},"source_dir":{"type":"string","description":"Optional application source directory"}}),
            &["page"]),
        tool("project-overview", "Return project-wide manual structure, page headings, audience tags, orphan pages, duplicate headings, and warning counts.",
            json!({}),
            &[]),
        tool("translation-diff-plan", "Extract Git diffs from a source-language page and produce a differential synchronization plan for the target translation page.",
            json!({"source_page":{"type":"string"},"target_page":{"type":"string"},"base_ref":{"type":"string"},"target_language":{"type":"string"}}),
            &["source_page","target_page"]),
    ]);
    tools
}

fn call_tool(
    root: &Path,
    mailbox: Option<&Path>,
    catalog: &[Value],
    params: &Value,
) -> Result<Value, (i32, &'static str)> {
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
            Some("array") => value
                .as_array()
                .is_some_and(|items| items.iter().all(|v| v.is_string())),
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
        "annotate-and-insert" => annotate_and_insert(root, mailbox, request),
        "active-editor" => editor_request(mailbox, name, &request, 10),
        "insert-image" => insert_image(root, mailbox, &request),
        "preview-edit"
            if request["before"].as_str().unwrap().len() > 250_000
                || request["after"].as_str().unwrap().len() > 250_000 =>
        {
            Err("Diff exceeds the 250 kB review limit".into())
        }
        "preview-edit" => editor_request(mailbox, name, &request, 180),
        "proofread" => {
            let drafts = request["drafts"].as_object().unwrap();
            if drafts.is_empty() || drafts.len() > 3 || drafts.iter().any(|(id, value)| {
                id.trim().is_empty() || id.len() > 64 || !value.as_str().is_some_and(|draft| draft.len() <= 250_000)
            }) || request["before"].as_str().unwrap().len() > 250_000 {
                Err("Supply one to three proofreading drafts, each at most 250 kB.".into())
            } else {
                editor_request(mailbox, name, &request, 600)
            }
        }
        "proofreading-skills" => crate::selection_ai::proofreading_profiles(root).map(|skills| json!({"skills":skills})),
        "import-generated-image" => crate::image_generation::import_generated(root, request["image"].as_str().unwrap(), request["description"].as_str().unwrap_or("")),
        "proofread-text" if mailbox.is_some() => editor_request(mailbox, name, &request, 600),
        "proofread-text" => crate::selection_ai::proofread(root, request["source"].as_str().unwrap(), request["skill"].as_str().unwrap()),
        "project-glossary" => crate::glossary::query(root, request["query"].as_str().unwrap_or_default(), request["category"].as_str()),
        "upsert-glossary-term" => {
            let avoid: Vec<String> = request["avoid"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            crate::glossary::upsert_term(
                root,
                request["preferred"].as_str().unwrap(),
                &avoid,
                request["category"].as_str(),
                request["note"].as_str(),
                request["case_sensitive"].as_bool(),
            )
        }
        "check-manuscript" => crate::quality::check_page(root, request["page"].as_str()),
        "draft-from-recording" => crate::operation_draft::generate(root, request["image"].as_str(), request["resource_id"].as_str(), request["page"].as_str(), request["title"].as_str(), false),
        "analyze-app-impact" => crate::impact_analyzer::analyze(root, request["repo_path"].as_str(), request["base_ref"].as_str()),
        "fact-check-manuscript" => crate::fact_check::audit_manuscript(root, request["page"].as_str().unwrap(), request["source_dir"].as_str()),
        "project-overview" => crate::project_dashboard::overview(root),
        "translation-diff-plan" => crate::derivative::translation_diff_plan(root, request["source_page"].as_str().unwrap(), request["target_page"].as_str().unwrap(), request["base_ref"].as_str(), request["target_language"].as_str(), false),
        "find-images" => find_images(root, request["query"].as_str().unwrap_or_default()),
        _ => crate::terminal_tools::execute(&request),
    };
    Ok(match outcome {
        Ok(value) => json!({"content": [{"type": "text", "text": value.to_string()}]}),
        Err(error) => json!({"content": [{"type": "text", "text": error}], "isError": true}),
    })
}

fn annotate_and_insert(
    root: &Path,
    mailbox: Option<&Path>,
    mut request: Value,
) -> Result<Value, String> {
    let mailbox = mailbox
        .filter(|path| path.is_dir())
        .ok_or("Studio insertion session has ended")?;
    let (_, path) = image_path(root, request["output"].as_str().unwrap())?;
    request["action"] = json!("annotate");
    crate::terminal_tools::execute(&request)?;
    editor_request(
        Some(mailbox),
        "insert-image",
        &json!({"path": path, "alt": request["alt"]}),
        10,
    )
    .map_err(|error| format!("{error} Annotated PNG saved at {path}."))
}

fn image_path(root: &Path, input: &str) -> Result<(std::path::PathBuf, String), String> {
    let output = crate::config::project_path(root, input)?;
    let relative = output
        .strip_prefix(root)
        .map_err(|error| error.to_string())?;
    let path = relative
        .to_str()
        .ok_or("Output path is not UTF-8")?
        .replace('\\', "/");
    if path.contains(['\r', '\n', '<', '>']) {
        return Err("Output path cannot be used in a Markdown image".into());
    }
    Ok((output, path))
}

fn insert_image(root: &Path, mailbox: Option<&Path>, request: &Value) -> Result<Value, String> {
    let path = match (request["image"].as_str(), request["resource_id"].as_str()) {
        (Some(path), None) => path.to_string(),
        (None, Some(id)) => crate::capture_resources::generate(root, id, None, None)?.path,
        _ => return Err("Supply exactly one of image or resource_id".into()),
    };
    let (file, path) = image_path(root, &path)?;
    image::image_dimensions(file).map_err(|error| format!("Cannot read project image: {error}"))?;
    editor_request(
        mailbox,
        "insert-image",
        &json!({"path":path,"alt":request["alt"]}),
        10,
    )
}

fn editor_request(
    mailbox: Option<&Path>,
    action: &str,
    args: &Value,
    seconds: u64,
) -> Result<Value, String> {
    crate::mcp_insert::request(
        mailbox.ok_or("Studio editor session is unavailable")?,
        action,
        args,
        seconds,
    )
}

fn find_images(root: &Path, query: &str) -> Result<Value, String> {
    let resources = crate::resources::list(root)?;
    let captures = crate::capture_resources::list(root)?;
    let query = query.trim().to_lowercase();
    let mut matches = captures["items"]
        .as_array()
        .unwrap()
        .iter()
        .chain(resources["items"].as_array().unwrap())
        .filter(|item| {
            ["name", "path", "id"].iter().any(|key| {
                item[*key]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase()
                    .contains(&query)
            }) || item["usages"].as_array().is_some_and(|usages| {
                usages.iter().any(|usage| {
                    usage["page"]
                        .as_str()
                        .unwrap_or_default()
                        .to_lowercase()
                        .contains(&query)
                })
            })
        });
    let items: Vec<_> = matches.by_ref().take(50).map(|item| {
        let usages: Vec<_> = item["usages"].as_array().into_iter().flatten().take(20)
            .map(|usage| json!({"page": usage["page"], "line": usage["line"]})).collect();
        json!({
            "name":item["name"],"path":item["path"],"resource_id":item["id"],
            "kind":item["kind"].as_str().unwrap_or("capture-resource"),"missing":item["missing"],"usages":usages
        })
    }).collect();
    Ok(json!({"items":items,"truncated":matches.next().is_some()}))
}

fn serve(
    root: &Path,
    mailbox: Option<&Path>,
    input: impl BufRead,
    mut output: impl Write,
) -> io::Result<()> {
    let catalog = tools(mailbox.is_some());
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
                    "tools/call" if initialized => {
                        call_tool(root, mailbox, &catalog, &request["params"])
                    }
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
