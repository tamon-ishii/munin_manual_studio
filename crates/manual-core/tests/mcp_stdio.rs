use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[test]
fn lists_and_executes_project_tools_over_stdio() {
    let root = tempfile::tempdir().unwrap();
    let working_directory = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join(".munin")).unwrap();
    fs::write(root.path().join(".munin/proofreading-skills.json"),
        r#"[{"id":"house-style","rules":"Use the house style."}]"#).unwrap();
    image::DynamicImage::new_rgb8(16, 12)
        .save(root.path().join("image.png"))
        .unwrap();
    let mut server = Command::new(env!("CARGO_BIN_EXE_manualctl"))
        .args(["--studio-mcp", root.path().to_str().unwrap()])
        .current_dir(working_directory.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = server.stdin.take().unwrap();
    for request in [
        json!({"id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}),
        json!({"method": "notifications/initialized"}),
        json!({"id": 2, "method": "tools/list"}),
        json!({"id": 3, "method": "tools/call", "params": {"name": "inspect", "arguments": {"image": "image.png"}}}),
        json!({"id": 4, "method": "tools/call", "params": {"name": "inspect", "arguments": {"image": "../image.png"}}}),
        json!({"id": 5, "method": "tools/call", "params": {"name": "target-launch"}}),
        json!({"id": 6, "method": "tools/call", "params": {"name": "register-capture", "arguments": {"image": "image.png", "name":"Background screenshot"}}}),
        json!({"id": 7, "method": "tools/call", "params": {"name": "proofreading-skills"}}),
        json!({"id": 8, "method": "tools/call", "params": {"name": "proofread-text", "arguments":{"source":"Draft","skill":"missing-skill"}}}),
        json!({"id": 9, "method": "tools/call", "params": {"name": "import-generated-image", "arguments":{"image":"image.png","description":"Imported diagram"}}}),
        json!({"id": 10, "method": "tools/call", "params": {"name": "import-generated-image", "arguments":{"image":"../outside.png"}}}),
        json!({"id": 11, "method": "tools/call", "params": {"name": "proofread-text", "arguments":{"source":"Draft","skill":"house-style"}}}),
    ] {
        let mut request = request;
        request["jsonrpc"] = json!("2.0");
        writeln!(input, "{request}").unwrap();
    }
    drop(input);
    let output = server.wait_with_output().unwrap();
    assert!(output.status.success());
    let responses: Vec<Value> = std::str::from_utf8(&output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(responses.len(), 11);
    assert_eq!(responses[0]["result"]["protocolVersion"], "2025-06-18");
    assert!(responses[1]["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["name"] == "inspect"));
    let inspected: Value = serde_json::from_str(
        responses[2]["result"]["content"][0]["text"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(inspected["width"], 16);
    assert_eq!(inspected["height"], 12);
    assert_eq!(responses[3]["result"]["isError"], true);
    assert_eq!(responses[4]["error"]["code"], -32602);
    let registered: Value = serde_json::from_str(responses[5]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    let catalog = manual_core::capture_resources::list(root.path()).unwrap();
    assert_eq!(catalog["items"][0]["id"], registered["resource_id"]);
    assert_eq!(catalog["items"][0]["name"], "Background screenshot");
    assert_eq!(registered["uimap_elements"], 0);
    let skills: Value = serde_json::from_str(responses[6]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(skills["skills"].as_array().unwrap().len(), 4);
    assert_eq!(skills["skills"][3]["id"], "house-style");
    assert_eq!(responses[7]["result"]["isError"], true);
    assert_eq!(responses[7]["result"]["content"][0]["text"], "Unknown proofreading skill.");
    let imported: Value = serde_json::from_str(responses[8]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(imported["provider"], "mcp");
    assert_eq!(imported["prompt"], "Imported diagram");
    assert_eq!(image::image_dimensions(root.path().join(imported["path"].as_str().unwrap())).unwrap(), (16, 12));
    let assets = manual_core::resources::list(root.path()).unwrap();
    assert!(assets["items"].as_array().unwrap().iter().any(|item| item["path"] == imported["path"] && item["kind"] == "generated"));
    assert_eq!(responses[9]["result"]["isError"], true);
    assert_eq!(responses[10]["result"]["isError"], true);
    assert!(responses[10]["result"]["content"][0]["text"].as_str().unwrap().contains("API or local LLM"));
}

#[test]
fn annotates_png_and_waits_for_editor_acknowledgement() {
    let root = tempfile::tempdir().unwrap();
    let mailbox = tempfile::tempdir().unwrap();
    let original = root.path().join("image.png");
    image::DynamicImage::new_rgb8(32, 24)
        .save(&original)
        .unwrap();
    let original_bytes = fs::read(&original).unwrap();
    let manuscript = root.path().join("index.md");
    fs::write(&manuscript, "Original draft").unwrap();
    let mut server = Command::new(env!("CARGO_BIN_EXE_manualctl"))
        .arg("--studio-mcp")
        .arg(root.path())
        .arg(mailbox.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = server.stdin.take().unwrap();
    for message in [
        json!({"id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}),
        json!({"method":"notifications/initialized"}),
        json!({"id":2,"method":"tools/call","params":{"name":"annotate-and-insert","arguments":{
            "image":"image.png","output":"assets/annotated.png","scene":{"annotations":[]},"alt":"Screenshot"
        }}}),
    ] {
        let mut message = message;
        message["jsonrpc"] = json!("2.0");
        writeln!(input, "{message}").unwrap();
    }
    drop(input);
    let deadline = Instant::now() + Duration::from_secs(3);
    let ticket = loop {
        if let Some(ticket) = fs::read_dir(mailbox.path())
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.join("request.json").is_file())
        {
            break ticket;
        }
        if server.try_wait().unwrap().is_some() || Instant::now() >= deadline {
            let _ = server.kill();
            let output = server.wait_with_output().unwrap();
            panic!(
                "No editor request. {}",
                String::from_utf8_lossy(&output.stdout)
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let request: Value =
        serde_json::from_slice(&fs::read(ticket.join("request.json")).unwrap()).unwrap();
    assert_eq!(request["action"], "insert-image");
    assert_eq!(request["arguments"]["path"], "assets/annotated.png");
    assert_eq!(request["arguments"]["alt"], "Screenshot");
    assert!(server.try_wait().unwrap().is_none());
    let reply = tempfile::NamedTempFile::new_in(&ticket).unwrap();
    let expected =
        json!({"page":"index.md","output":"assets/annotated.png","inserted":true,"saved":false});
    serde_json::to_writer(reply.as_file(), &expected).unwrap();
    reply.persist(ticket.join("response.json")).unwrap();
    let output = server.wait_with_output().unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    let response: Value = serde_json::from_str(stdout.lines().last().unwrap()).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(response["result"]["content"][0]["text"].as_str().unwrap())
            .unwrap(),
        expected
    );
    assert!(image::open(root.path().join("assets/annotated.png")).is_ok());
    assert_eq!(fs::read(&original).unwrap(), original_bytes);
    assert_eq!(fs::read_to_string(&manuscript).unwrap(), "Original draft");
}
