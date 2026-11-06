use super::*;
use rmcp::ServiceExt;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

const MODERN: &str = "2026-07-28";
const SERVER_INFO: &str = "io.modelcontextprotocol/serverInfo";
const STDIO_TRANSFERS: [&str; 2] = ["upload_local_file", "download_remote_file"];
const HTTP_TRANSFERS: [&str; 2] = [
    "create_remote_file_upload_link",
    "create_remote_file_download_link",
];

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

fn initialize(version: &str, capabilities: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": version, "capabilities": capabilities,
        "clientInfo": {"name": "fstty-compatibility-test", "version": "1"}
    }})
}

fn modern_request(mut message: Value, capabilities: Value) -> Value {
    if message["params"].is_null() {
        message["params"] = json!({});
    }
    message["params"]["_meta"] = json!({
        "io.modelcontextprotocol/protocolVersion": MODERN,
        "io.modelcontextprotocol/clientCapabilities": capabilities
    });
    message
}

async fn check_tools(
    mut rpc: impl AsyncFnMut(Value) -> Value,
    transfer_tools: [&str; 2],
    version: &str,
) {
    let modern = version == MODERN;
    let opened = if modern {
        rpc(json!({"jsonrpc": "2.0", "id": 1, "method": "server/discover"})).await
    } else {
        let initialized = rpc(initialize(version, json!({}))).await;
        assert_eq!(initialized["result"]["protocolVersion"], version);
        rpc(json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).await;
        initialized
    };
    let info = if modern {
        assert!(opened["result"].get("serverInfo").is_none());
        assert!(opened["result"]["supportedVersions"]
            .as_array()
            .unwrap()
            .contains(&json!(MODERN)));
        assert_eq!(
            opened["result"]["supportedVersions"]
                .as_array()
                .unwrap()
                .contains(&json!("2024-11-05")),
            transfer_tools == STDIO_TRANSFERS
        );
        &opened["result"]["_meta"][SERVER_INFO]
    } else {
        &opened["result"]["serverInfo"]
    };
    assert_eq!(info["name"], "FsTTY");
    assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(
        opened["result"]["capabilities"]["tools"]["listChanged"],
        false
    );
    let list = rpc(json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})).await;
    assert_list_format(&list["result"], modern);
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
    if transfer_tools == STDIO_TRANSFERS {
        let download = tools
            .iter()
            .find(|tool| tool["name"] == "download_remote_file")
            .unwrap();
        assert_eq!(download["annotations"]["readOnlyHint"], false);
    }
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
    if modern {
        assert_eq!(out_of_range["result"]["isError"], true);
        assert!(out_of_range.get("error").is_none());
    } else {
        assert_eq!(out_of_range["error"]["code"], -32602);
        assert!(out_of_range["error"].get("data").is_none());
    }

    for (id, method) in ["resources/list", "resources/templates/list", "prompts/list"]
        .into_iter()
        .enumerate()
    {
        let list = rpc(json!({"jsonrpc": "2.0", "id": id + 8, "method": method})).await;
        assert_list_format(&list["result"], modern);
    }
    let cursor = rpc(json!({"jsonrpc": "2.0", "id": 11, "method": "tools/list", "params": {"cursor": "never-issued"}})).await;
    assert_eq!(cursor["error"]["code"], -32602);
    for (id, name, arguments) in [
        (12, "not_a_tool", json!({})),
        (13, "get_device_status", json!({"sessionId": 9})),
    ] {
        let response = rpc(tool_call(id, name, arguments)).await;
        assert_eq!(response["error"]["code"], -32602);
    }
    let missing_session = rpc(tool_call(
        14,
        "get_device_status",
        json!({"sessionId": "missing"}),
    ))
    .await;
    if modern {
        assert_eq!(missing_session["result"]["isError"], true);
        assert_eq!(
            missing_session["result"]["_meta"][SERVER_INFO]["name"],
            "FsTTY"
        );
    } else {
        assert_eq!(missing_session["error"]["code"], -32600);
    }
}

fn assert_list_format(result: &Value, modern: bool) {
    assert!(result.is_object(), "{result}");
    if modern {
        assert_eq!(result["resultType"], "complete");
        assert_eq!(result["ttlMs"], 0);
        assert_eq!(result["cacheScope"], "private");
        assert_eq!(result["_meta"][SERVER_INFO]["name"], "FsTTY");
    } else {
        for field in ["resultType", "ttlMs", "cacheScope", "_meta"] {
            assert!(result.get(field).is_none(), "{result}");
        }
    }
}

fn tool_call(id: u32, name: &str, arguments: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {"name": name, "arguments": arguments}})
}

#[tokio::test(start_paused = true)]
async fn stdio_tool_rate_limit_returns_retry_time_and_refills() {
    let directory =
        TestDirectory(std::env::temp_dir().join(format!("fstty-mcp-limit-{}", Uuid::new_v4())));
    let mut stdio = StdioProbe::spawn(directory.state());
    for id in 1..=31 {
        let reply = stdio
            .rpc(modern_request(
                tool_call(id, "list_sessions", json!({})),
                json!({}),
            ))
            .await;
        if id < 31 {
            assert_ne!(reply["result"]["isError"], true);
            assert!(reply["result"]["content"].is_array());
        } else {
            assert_eq!(reply["result"]["isError"], true);
            assert_eq!(reply["result"]["structuredContent"]["retryAfterMs"], 500);
        }
    }
    tokio::time::advance(Duration::from_millis(500)).await;
    let reply = stdio
        .rpc(modern_request(
            tool_call(32, "list_sessions", json!({})),
            json!({}),
        ))
        .await;
    assert_ne!(reply["result"]["isError"], true);
    assert!(reply["result"]["content"].is_array());
    stdio.close().await;
}

#[tokio::test]
async fn modern_roots_requires_capability_and_accepts_only_the_original_continuation() {
    let directory =
        TestDirectory(std::env::temp_dir().join(format!("fstty-mcp-roots-{}", Uuid::new_v4())));
    let authorized_root = directory.0.join("root");
    std::fs::create_dir_all(&authorized_root).unwrap();
    let root_url = url::Url::from_directory_path(&authorized_root).unwrap();
    let local_path = authorized_root.join("download.txt");
    let arguments =
        json!({"sessionId":"missing", "remotePath":"/file.txt", "localPath":local_path});
    let response_for = |id, arguments, state: &Value| {
        let mut request = tool_call(id, "download_remote_file", arguments);
        request["params"]["requestState"] = state.clone();
        request["params"]["inputResponses"] =
            json!({"roots": {"roots":[{"uri":root_url.as_str()}]}});
        modern_request(request, json!({"roots":{}}))
    };
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut stdio = StdioProbe::spawn(directory.state());
        let denied = stdio
            .rpc(modern_request(
                tool_call(1, "download_remote_file", arguments.clone()),
                json!({}),
            ))
            .await;
        assert_eq!(denied["error"]["code"], -32021);
        assert!(denied["error"]["data"]["requiredCapabilities"]["roots"].is_object());
        let asked = stdio
            .rpc(modern_request(
                tool_call(2, "download_remote_file", arguments.clone()),
                json!({"roots":{}}),
            ))
            .await;
        assert_eq!(asked["id"], 2);
        assert_eq!(asked["result"]["resultType"], "input_required");
        assert_eq!(
            asked["result"]["inputRequests"]["roots"]["method"],
            "roots/list"
        );
        let state = &asked["result"]["requestState"];
        assert!(state.is_string());

        let mut modified = arguments.clone();
        modified["remotePath"] = json!("/changed.txt");
        let rejected = stdio.rpc(response_for(3, modified, state)).await;
        assert_eq!(rejected["error"]["code"], -32602);
        let mut extra = arguments.clone();
        extra["extraPath"] = json!("/changed.txt");
        let rejected = stdio.rpc(response_for(9, extra, state)).await;
        assert_eq!(rejected["error"]["code"], -32602);
        let mut wrong_tool = response_for(4, arguments.clone(), state);
        wrong_tool["params"]["name"] = json!("upload_local_file");
        assert_eq!(stdio.rpc(wrong_tool).await["error"]["code"], -32602);
        let accepted = stdio.rpc(response_for(5, arguments.clone(), state)).await;
        assert_eq!(accepted["result"]["resultType"], "complete");
        assert_eq!(accepted["result"]["isError"], true);
        assert_eq!(accepted["result"]["content"][0]["text"], "未找到指定会话");
        let replay = stdio.rpc(response_for(6, arguments.clone(), state)).await;
        assert_eq!(replay["error"]["code"], -32602);

        let mut outside = arguments;
        outside["localPath"] = json!(directory.0.join("outside.txt"));
        let asked = stdio
            .rpc(modern_request(
                tool_call(7, "download_remote_file", outside.clone()),
                json!({"roots":{}}),
            ))
            .await;
        let rejected = stdio
            .rpc(response_for(8, outside, &asked["result"]["requestState"]))
            .await;
        assert_eq!(rejected["result"]["isError"], true);
        assert_eq!(
            rejected["result"]["content"][0]["text"],
            "本地路径不在 MCP Roots 内"
        );
        assert!(!local_path.exists());
        assert!(!directory.0.join("outside.txt").exists());
        stdio.close().await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn legacy_roots_respects_capability_and_cancelled_calls_leave_stdio_usable() {
    let directory =
        TestDirectory(std::env::temp_dir().join(format!("fstty-mcp-roots-{}", Uuid::new_v4())));
    let arguments = json!({
        "sessionId": "missing",
        "remotePath": "/file.txt",
        "localPath": directory.0.join("download.txt"),
        "extraPath": "/ignored-by-legacy.txt",
    });
    tokio::time::timeout(Duration::from_secs(10), async {
        for roots in [false, true] {
            let mut stdio = StdioProbe::spawn(directory.state());
            let capabilities = if roots { json!({"roots":{}}) } else { json!({}) };
            stdio.rpc(initialize("2025-11-25", capabilities)).await;
            stdio.send(&json!({"jsonrpc":"2.0","method":"notifications/initialized"})).await;
            stdio.send(&tool_call(2, "download_remote_file", arguments.clone())).await;
            let received = stdio.read().await;
            if roots {
                assert_eq!(received["method"], "roots/list");
                stdio.send(&json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":2}})).await;
                let response = stdio.rpc(json!({"jsonrpc":"2.0","id":3,"method":"tools/list"})).await;
                assert_eq!(response["id"], 3);
                assert!(response["result"]["tools"].is_array());
            } else {
                assert_eq!(received["id"], 2);
                assert_eq!(received["error"]["code"], -32600);
            }
            stdio.close().await;
        }
    }).await.unwrap();
}

struct StdioProbe {
    writer: tokio::io::WriteHalf<tokio::io::DuplexStream>,
    reader: tokio::io::Lines<BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>>,
    task: tokio::task::JoinHandle<()>,
}

impl StdioProbe {
    fn spawn(state: AppState) -> Self {
        let (server, client) = tokio::io::duplex(64 * 1024);
        let task = tokio::spawn(async move {
            let service = McpService::new(state, McpTransport::Stdio)
                .serve(tokio::io::split(server))
                .await
                .unwrap();
            service.waiting().await.unwrap();
        });
        let (read, writer) = tokio::io::split(client);
        Self {
            writer,
            reader: BufReader::new(read).lines(),
            task,
        }
    }

    async fn send(&mut self, message: &Value) {
        self.writer
            .write_all(format!("{message}\n").as_bytes())
            .await
            .unwrap();
    }

    async fn read(&mut self) -> Value {
        serde_json::from_str(&self.reader.next_line().await.unwrap().unwrap()).unwrap()
    }

    async fn rpc(&mut self, message: Value) -> Value {
        self.send(&message).await;
        if message.get("id").is_some() {
            self.read().await
        } else {
            Value::Null
        }
    }

    async fn close(self) {
        drop(self.writer);
        drop(self.reader);
        self.task.await.unwrap();
    }
}

struct HttpProbe {
    port: u16,
    token: String,
    version: &'static str,
    session: Option<String>,
}

impl HttpProbe {
    async fn post(
        &mut self,
        message: Value,
        method: Option<&str>,
        authenticated: bool,
    ) -> (String, Value) {
        let mut stream = tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, self.port))
            .await
            .unwrap();
        let mut headers = format!(
            "POST /mcp HTTP/1.0\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nMCP-Protocol-Version: {}\r\n",
            self.port, self.version
        );
        if authenticated {
            headers.push_str(&format!("Authorization: Bearer {}\r\n", self.token));
        }
        if let Some(session) = &self.session {
            headers.push_str(&format!("MCP-Session-Id: {session}\r\n"));
        }
        if let Some(method) = method {
            headers.push_str(&format!("Mcp-Method: {method}\r\n"));
            if let Some(name) = message["params"]["name"].as_str() {
                headers.push_str(&format!("Mcp-Name: {name}\r\n"));
            }
        }
        let payload = message.to_string();
        stream
            .write_all(
                format!(
                    "{headers}Content-Length: {}\r\n\r\n{payload}",
                    payload.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        let (headers, body) = response.split_once("\r\n\r\n").unwrap();
        for line in headers.lines() {
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case("mcp-session-id") {
                    self.session = Some(value.trim().to_owned());
                }
            }
        }
        let reply = serde_json::from_str::<Value>(body)
            .ok()
            .or_else(|| {
                body.lines()
                    .filter_map(|line| line.strip_prefix("data:"))
                    .filter_map(|data| serde_json::from_str::<Value>(data).ok())
                    .find(|event| event["id"] == message["id"])
            })
            .unwrap_or(Value::Null);
        (headers.to_owned(), reply)
    }

    async fn rpc(&mut self, message: Value) -> Value {
        let (headers, reply) = if self.version == MODERN {
            let method = message["method"].as_str().unwrap().to_owned();
            self.post(modern_request(message, json!({})), Some(&method), true)
                .await
        } else {
            self.post(message, None, true).await
        };
        assert!(
            headers.starts_with("HTTP/1.0 20")
                || (self.version == MODERN
                    && headers.starts_with("HTTP/1.0 400")
                    && reply["error"].is_object()),
            "{headers}\n{reply}"
        );
        reply
    }
}

#[tokio::test]
async fn stdio与_http_通过实际工具发现和调用验证兼容描述() {
    let directory =
        TestDirectory(std::env::temp_dir().join(format!("fstty-mcp-schema-{}", Uuid::new_v4())));
    let state = directory.state();
    tokio::time::timeout(Duration::from_secs(15), async {
        for version in ["2024-11-05", "2025-11-25", MODERN] {
            let mut stdio = StdioProbe::spawn(state.clone());
            check_tools(
                async |message| {
                    let message = if version == MODERN {
                        modern_request(message, json!({}))
                    } else {
                        message
                    };
                    stdio.rpc(message).await
                },
                STDIO_TRANSFERS,
                version,
            )
            .await;
            if version == MODERN {
                let mut request = modern_request(
                    json!({"jsonrpc":"2.0","id":15,"method":"tools/list"}),
                    json!({}),
                );
                request["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"] =
                    json!("2099-01-01");
                let reply = stdio.rpc(request).await;
                assert_eq!(reply["error"]["code"], -32022);
                assert!(reply["error"]["data"]["supported"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(MODERN)));
            }
            stdio.close().await;
        }

        let mut handshake = StdioProbe::spawn(state.clone());
        let reply = handshake.rpc(initialize(MODERN, json!({}))).await;
        assert_eq!(reply["result"]["protocolVersion"], "2025-11-25");
        handshake.close().await;

        let runtime = state.mcp_http_runtime.clone();
        let token = Uuid::new_v4().to_string();
        runtime.start(state, 0, token.clone()).await.unwrap();
        let port = runtime.running_port().await.unwrap();
        for version in ["2025-03-26", "2025-11-25", MODERN] {
            let mut http = HttpProbe {
                port,
                token: token.clone(),
                version,
                session: None,
            };
            check_tools(
                async |message| http.rpc(message).await,
                HTTP_TRANSFERS,
                version,
            )
            .await;
            if version == MODERN {
                assert!(http.session.is_none());
                let request = modern_request(
                    json!({"jsonrpc":"2.0","id":15,"method":"tools/list"}),
                    json!({}),
                );
                let (headers, _) = http.post(request.clone(), Some("tools/list"), false).await;
                assert!(headers.starts_with("HTTP/1.0 401"), "{headers}");
                assert!(
                    headers
                        .to_ascii_lowercase()
                        .contains("www-authenticate: bearer realm=\"fstty\""),
                    "{headers}"
                );
                let (headers, reply) = http.post(request.clone(), Some("prompts/list"), true).await;
                assert!(headers.starts_with("HTTP/1.0 400"), "{headers}");
                assert_eq!(reply["error"]["code"], -32020);
                let mut request = request;
                request["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"] =
                    json!("2025-11-25");
                let (headers, reply) = http.post(request, Some("tools/list"), true).await;
                assert!(headers.starts_with("HTTP/1.0 400"), "{headers}\n{reply}");
            } else {
                assert!(http.session.is_some());
            }
        }
        runtime.stop().await;
    })
    .await
    .expect("MCP protocol probes must finish within the timeout");
}
