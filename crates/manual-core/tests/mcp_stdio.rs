use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Command, Stdio},
};

#[test]
fn lists_and_executes_project_tools_over_stdio() {
    let root = tempfile::tempdir().unwrap();
    let working_directory = tempfile::tempdir().unwrap();
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
    assert_eq!(responses.len(), 5);
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
}
