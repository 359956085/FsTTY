use super::*;
use rmcp::ServiceExt;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn state(&self) -> AppState {
        let mut state = AppState::new(self.0.clone());
        state.credential_service = crate::services::CredentialService::memory_for_test();
        state
            .settings_service
            .lock()
            .unwrap()
            .update_mcp_transport(true, true, 37_653)
            .unwrap();
        state
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn assert_supported_schema(schema: &Value) {
    let node = schema.as_object().expect("schema node must be an object");
    assert!(matches!(
        node.get("type").and_then(Value::as_str),
        Some("object" | "string" | "integer" | "boolean")
    ));
    for (key, value) in node {
        match key.as_str() {
            "type" | "required" | "description" | "default" => {}
            "properties" => {
                for property in value.as_object().unwrap().values() {
                    assert_supported_schema(property);
                }
            }
            _ => panic!("schema keyword not supported by the DSH compatibility subset: {key}"),
        }
    }
}

async fn check_tools(mut rpc: impl AsyncFnMut(Value) -> Value, transfer_tools: [&str; 2]) {
    let initialized = rpc(json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-11-25", "capabilities": {},
            "clientInfo": {"name": "fstty-compatibility-test", "version": "1"}
        }
    }))
    .await;
    assert_eq!(
        initialized["result"]["capabilities"]["tools"]["listChanged"],
        false
    );
    rpc(json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).await;
    let list = rpc(json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})).await;
    assert_eq!(list["result"]["ttlMs"], 0);
    assert_eq!(list["result"]["cacheScope"], "private");
    let tools = list["result"]["tools"].as_array().unwrap();
    if std::env::var_os("FSTTY_TEST_PRINT_MCP_TOOLS").is_some() {
        println!("MCP_TOOLS {}", list["result"]["tools"]);
    }
    let mut expected = McpService::tool_router()
        .list_all()
        .into_iter()
        .filter(|tool| {
            ![
                "upload_local_file",
                "download_remote_file",
                "create_remote_file_upload_link",
                "create_remote_file_download_link",
            ]
            .contains(&tool.name.as_ref())
        })
        .map(|tool| tool.name.into_owned())
        .collect::<Vec<_>>();
    expected.extend(transfer_tools.map(str::to_owned));
    expected.sort_unstable();
    let names = tools
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(names, expected);
    for tool in tools {
        assert_eq!(tool["inputSchema"]["type"], "object");
        assert_supported_schema(&tool["inputSchema"]);
    }
    let schema_for =
        |name: &str| &tools.iter().find(|tool| tool["name"] == name).unwrap()["inputSchema"];
    let guide = schema_for("get_permission_guide");
    assert_eq!(guide["properties"]["toolName"]["type"], "string");
    assert!(guide["properties"]["toolName"].get("default").is_none());
    assert!(guide.get("required").is_none());
    let command = schema_for("execute_command");
    assert_eq!(command["required"], json!(["sessionId", "command"]));
    assert_eq!(command["properties"]["timeoutSeconds"]["default"], 60);

    let list_sessions = rpc(json!({
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": {"name": "list_sessions", "arguments": {}}
    }))
    .await;
    assert_eq!(list_sessions["result"]["content"][0]["text"], "[]");

    for (id, arguments) in [
        (4, json!({})),
        (5, json!({"toolName": null})),
        (6, json!({"toolName": "list_sessions"})),
    ] {
        let response = rpc(json!({
            "jsonrpc": "2.0", "id": id, "method": "tools/call",
            "params": {"name": "get_permission_guide", "arguments": arguments}
        }))
        .await;
        let guide = &response["result"]["structuredContent"];
        assert!(guide["steps"].is_array());
        assert_eq!(guide["targetTool"], arguments["toolName"]);
    }

    let out_of_range = rpc(json!({
        "jsonrpc": "2.0", "id": 7, "method": "tools/call",
        "params": {"name": "search_remote_file", "arguments": {
            "sessionId": "unused", "path": "/var/log/app.log", "query": "text", "afterLines": 51
        }}
    }))
    .await;
    assert_eq!(out_of_range["error"]["code"], -32602);
}

#[tokio::test]
async fn stdio与_http_通过实际工具发现和调用验证兼容描述() {
    let directory =
        TestDirectory(std::env::temp_dir().join(format!("fstty-mcp-schema-{}", Uuid::new_v4())));
    let state = directory.state();
    tokio::time::timeout(Duration::from_secs(15), async {
        let (server_io, client_io) = tokio::io::duplex(32 * 1024);
        let (server_read, server_write) = tokio::io::split(server_io);
        let task = tokio::spawn(async move {
            McpService::new(state.clone(), McpTransport::Stdio)
                .serve((server_read, server_write))
                .await
                .unwrap()
                .waiting()
                .await
                .unwrap();
            state
        });
        let (read, mut write) = tokio::io::split(client_io);
        let mut reader = BufReader::new(read).lines();
        check_tools(
            async |message: Value| {
                let expect_response = message.get("id").is_some();
                write
                    .write_all(format!("{message}\n").as_bytes())
                    .await
                    .unwrap();
                if expect_response {
                    serde_json::from_str(&reader.next_line().await.unwrap().unwrap()).unwrap()
                } else {
                    Value::Null
                }
            },
            ["upload_local_file", "download_remote_file"],
        )
        .await;
        drop(write);
        drop(reader);
        let state = task.await.unwrap();

        let runtime = state.mcp_http_runtime.clone();
        let token = Uuid::new_v4().to_string();
        runtime.start(state, 0, token.clone()).await.unwrap();
        let port = runtime.running_port().await.unwrap();
        let mut session = String::new();
        check_tools(
            async |message: Value| {
                let mut stream =
                    tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
                        .await
                        .unwrap();
                let payload = message.to_string();
                // HTTP/1.0 gives the test a close-delimited body without chunk framing.
                let request = format!(
                    "POST /mcp HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\
                     Authorization: Bearer {token}\r\n\
                     Content-Type: application/json\r\n\
                     Accept: application/json, text/event-stream\r\n\
                     MCP-Protocol-Version: 2025-11-25\r\n\
                     {session}Content-Length: {}\r\n\r\n{payload}",
                    payload.len()
                );
                stream.write_all(request.as_bytes()).await.unwrap();
                let mut response = String::new();
                stream.read_to_string(&mut response).await.unwrap();
                let (headers, body) = response.split_once("\r\n\r\n").unwrap();
                assert!(headers.starts_with("HTTP/1.0 20"), "{response}");
                for header in headers.lines() {
                    if let Some((name, value)) = header.split_once(':') {
                        if name.eq_ignore_ascii_case("mcp-session-id") {
                            session = format!("MCP-Session-Id: {}\r\n", value.trim());
                        }
                    }
                }
                if message.get("id").is_none() {
                    return Value::Null;
                }
                serde_json::from_str::<Value>(body).unwrap_or_else(|_| {
                    body.lines()
                        .filter_map(|line| line.strip_prefix("data:"))
                        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
                        .find(|event| event["id"] == message["id"])
                        .unwrap()
                })
            },
            [
                "create_remote_file_upload_link",
                "create_remote_file_download_link",
            ],
        )
        .await;
        runtime.stop().await;
    })
    .await
    .expect("MCP protocol probes must finish within the timeout");
}
