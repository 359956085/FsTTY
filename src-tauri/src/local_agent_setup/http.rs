use super::*;
use toml_edit::InlineTable;
use zeroize::Zeroizing;

/// 令牌不实现 Debug/Serialize，检测结果和配置结果均不携带凭据。
pub struct LocalAgentHttpConfig {
    url: String,
    token: Option<Zeroizing<String>>,
}

impl LocalAgentHttpConfig {
    pub fn new(port: u16, token: Option<Zeroizing<String>>) -> Result<Self, String> {
        if port == 0 {
            return Err("MCP HTTP 端口无效".to_owned());
        }
        if token.as_ref().is_some_and(|token| {
            token.is_empty()
                || token.len() > 16 * 1024
                || !token.bytes().all(|byte| byte.is_ascii_graphic())
        }) {
            return Err("MCP HTTP Token 无效，请重新生成".to_owned());
        }
        Ok(Self {
            url: format!("http://127.0.0.1:{port}/mcp"),
            token,
        })
    }

    fn authorization(&self) -> Result<String, String> {
        self.token
            .as_ref()
            .map(|token| format!("Bearer {}", token.as_str()))
            .ok_or_else(|| "MCP HTTP Token 尚未初始化".to_owned())
    }

    fn json_server(&self, target: LocalAgentTarget) -> Result<Value, String> {
        let authorization = self.authorization()?;
        Ok(match target {
            LocalAgentTarget::Codex => serde_json_value!({
                "url": self.url,
                "http_headers": { "Authorization": authorization }
            }),
            LocalAgentTarget::GeminiCli => serde_json_value!({
                "httpUrl": self.url,
                "headers": { "Authorization": authorization }
            }),
            LocalAgentTarget::Claude | LocalAgentTarget::VsCode => serde_json_value!({
                "type": "http", "url": self.url,
                "headers": { "Authorization": authorization }
            }),
            LocalAgentTarget::OpenCode => serde_json_value!({
                "type": "remote", "url": self.url, "enabled": true, "oauth": false,
                "headers": { "Authorization": authorization }
            }),
            LocalAgentTarget::Cursor | LocalAgentTarget::Trae | LocalAgentTarget::TraeCn => {
                serde_json_value!({
                    "url": self.url, "headers": { "Authorization": authorization }
                })
            }
        })
    }
}

fn json_location(home: &Path, target: LocalAgentTarget) -> Result<(PathBuf, &'static str), String> {
    Ok(match target {
        LocalAgentTarget::Claude => (home.join(".claude.json"), "mcpServers"),
        LocalAgentTarget::Cursor => (home.join(".cursor").join("mcp.json"), "mcpServers"),
        LocalAgentTarget::VsCode => (vscode_mcp_path(home), "servers"),
        LocalAgentTarget::GeminiCli => (home.join(".gemini").join("settings.json"), "mcpServers"),
        LocalAgentTarget::OpenCode => (opencode_config_path(home)?, "mcp"),
        LocalAgentTarget::Trae | LocalAgentTarget::TraeCn => {
            (trae_mcp_path(home, target), "mcpServers")
        }
        LocalAgentTarget::Codex => return Err("Codex 使用 TOML 配置".to_owned()),
    })
}

pub(super) fn configure(
    home: &Path,
    config: &LocalAgentHttpConfig,
    target: LocalAgentTarget,
) -> Result<bool, String> {
    if target == LocalAgentTarget::Codex {
        let mut server = Table::new();
        server["url"] = value(&config.url);
        let mut headers = InlineTable::new();
        headers.insert("Authorization", config.authorization()?.into());
        server["http_headers"] = value(headers);
        return write_codex_mcp(home, server);
    }
    if target == LocalAgentTarget::OpenCode {
        let url = config.url.clone();
        let authorization = config.authorization()?;
        return write_opencode_mcp(
            home,
            json!({
                "type": "remote", "url": url, "enabled": true, "oauth": false,
                "headers": { "Authorization": authorization }
            }),
        );
    }
    let (path, root_key) = json_location(home, target)?;
    // Claude HTTP 直接合并用户级配置，不能把 Bearer Token 交给 CLI 参数或错误输出。
    write_json_mcp(&path, root_key, config.json_server(target)?)
}

pub(super) fn inspect(
    home: &Path,
    config: &LocalAgentHttpConfig,
    target: LocalAgentTarget,
) -> LocalAgentSetupState {
    if target == LocalAgentTarget::Codex {
        return inspect_codex(home, config);
    }
    let Ok((path, root_key)) = json_location(home, target) else {
        return LocalAgentSetupState::Invalid;
    };
    inspect_json(&path, root_key, config, target)
}

fn inspect_json(
    path: &Path,
    root_key: &str,
    config: &LocalAgentHttpConfig,
    target: LocalAgentTarget,
) -> LocalAgentSetupState {
    let content = match read_optional_text(path) {
        Ok(Some(content)) => content,
        Ok(None) => return LocalAgentSetupState::Missing,
        Err(_) => return LocalAgentSetupState::Invalid,
    };
    let root = if target == LocalAgentTarget::OpenCode {
        jsonc_parser::parse_to_serde_value::<Value>(&content, &ParseOptions::default()).ok()
    } else {
        serde_json::from_str::<Value>(&content).ok()
    };
    let Some(root) = root.as_ref().and_then(Value::as_object) else {
        return LocalAgentSetupState::Invalid;
    };
    let Some(servers) = root.get(root_key) else {
        return LocalAgentSetupState::Missing;
    };
    let Some(servers) = servers.as_object() else {
        return LocalAgentSetupState::Invalid;
    };
    if target == LocalAgentTarget::OpenCode && unsupported_opencode_layout(servers) {
        return LocalAgentSetupState::Invalid;
    }
    let Some(server) = servers.get("fstty") else {
        return LocalAgentSetupState::Missing;
    };
    if !server.is_object() {
        return LocalAgentSetupState::Invalid;
    }
    if config
        .json_server(target)
        .is_ok_and(|expected| *server == expected)
    {
        LocalAgentSetupState::Current
    } else {
        // 没有系统令牌时只能报告待更新，检测本身不能生成令牌或开启服务。
        LocalAgentSetupState::Outdated
    }
}

fn inspect_codex(home: &Path, config: &LocalAgentHttpConfig) -> LocalAgentSetupState {
    let path = home.join(".codex").join("config.toml");
    let content = match read_optional_text(&path) {
        Ok(Some(content)) => content,
        Ok(None) => return LocalAgentSetupState::Missing,
        Err(_) => return LocalAgentSetupState::Invalid,
    };
    let Ok(document) = content.parse::<DocumentMut>() else {
        return LocalAgentSetupState::Invalid;
    };
    let Some(servers) = document.get("mcp_servers") else {
        return LocalAgentSetupState::Missing;
    };
    let Some(servers) = servers.as_table() else {
        return LocalAgentSetupState::Invalid;
    };
    let Some(server) = servers.get("fstty") else {
        return LocalAgentSetupState::Missing;
    };
    let Some(server) = server.as_table() else {
        return LocalAgentSetupState::Invalid;
    };
    let current = config.authorization().is_ok_and(|authorization| {
        server.len() == 2
            && server.get("url").and_then(Item::as_str) == Some(config.url.as_str())
            && server
                .get("http_headers")
                .and_then(Item::as_table_like)
                .is_some_and(|headers| {
                    headers.len() == 1
                        && headers.get("Authorization").and_then(Item::as_str)
                            == Some(authorization.as_str())
                })
    });
    if current {
        LocalAgentSetupState::Current
    } else {
        LocalAgentSetupState::Outdated
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("fstty-local-http-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn config(port: u16, token: &str) -> LocalAgentHttpConfig {
        LocalAgentHttpConfig::new(port, Some(Zeroizing::new(token.to_owned()))).unwrap()
    }

    #[test]
    fn 八种客户端均使用回环地址及各自http字段() {
        let config = config(37653, "dummy-test-token");
        for target in [
            LocalAgentTarget::Codex,
            LocalAgentTarget::Claude,
            LocalAgentTarget::Cursor,
            LocalAgentTarget::VsCode,
            LocalAgentTarget::GeminiCli,
            LocalAgentTarget::OpenCode,
            LocalAgentTarget::Trae,
            LocalAgentTarget::TraeCn,
        ] {
            let server = config.json_server(target).unwrap();
            let url_key = if target == LocalAgentTarget::GeminiCli {
                "httpUrl"
            } else {
                "url"
            };
            let header_key = if target == LocalAgentTarget::Codex {
                "http_headers"
            } else {
                "headers"
            };
            assert_eq!(server[url_key], "http://127.0.0.1:37653/mcp");
            assert_eq!(
                server[header_key]["Authorization"],
                "Bearer dummy-test-token"
            );
            assert!(server.get("command").is_none());
            assert!(server.get("args").is_none());
            if matches!(target, LocalAgentTarget::Claude | LocalAgentTarget::VsCode) {
                assert_eq!(server["type"], "http");
            }
            if target == LocalAgentTarget::OpenCode {
                assert_eq!(server["type"], "remote");
                assert_eq!(server["enabled"], true);
                assert_eq!(server["oauth"], false);
            }
        }
    }

    #[test]
    fn json客户端双向切换保留其他服务且反复配置幂等() {
        let directory = TestDirectory::new();
        let config = config(37653, "dummy-test-token");
        let launch = mcp_runtime::launch_spec(&directory.0);
        for target in [
            LocalAgentTarget::Claude,
            LocalAgentTarget::Cursor,
            LocalAgentTarget::VsCode,
            LocalAgentTarget::GeminiCli,
            LocalAgentTarget::Trae,
            LocalAgentTarget::TraeCn,
        ] {
            // 路径完全来自隔离目录，不能借 APPDATA 解析到真实客户端。
            let path = directory.0.join(format!("{target:?}.json"));
            let root_key = if target == LocalAgentTarget::VsCode {
                "servers"
            } else {
                "mcpServers"
            };
            let mut original = serde_json_value!({"keep": {"nested": true}});
            original[root_key] = serde_json_value!({"other":{"command":"keep"}, "fstty":{"command":"old", "args":["--mcp-stdio"], "env":{"credential":"dummy"}}});
            fs::write(&path, serde_json::to_vec(&original).unwrap()).unwrap();
            assert!(write_json_mcp(&path, root_key, config.json_server(target).unwrap()).unwrap());
            assert!(!write_json_mcp(&path, root_key, config.json_server(target).unwrap()).unwrap());
            let actual: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(actual["keep"], original["keep"]);
            assert_eq!(actual[root_key]["other"], original[root_key]["other"]);
            assert_eq!(
                actual[root_key]["fstty"],
                config.json_server(target).unwrap()
            );
            assert_eq!(
                inspect_json(&path, root_key, &config, target),
                LocalAgentSetupState::Current
            );
            assert!(configure_json_mcp(
                &path,
                root_key,
                &launch,
                matches!(target, LocalAgentTarget::Claude | LocalAgentTarget::VsCode)
            )
            .unwrap());
            let actual: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert!(!has_http_fields(&actual[root_key]["fstty"]));
            assert_eq!(
                inspect_json(&path, root_key, &config, target),
                LocalAgentSetupState::Outdated
            );
        }
    }

    #[test]
    fn codex切换保持注释且检测当前端口令牌() {
        let directory = TestDirectory::new();
        let home = &directory.0;
        fs::create_dir(home.join(".codex")).unwrap();
        let path = home.join(".codex").join("config.toml");
        fs::write(
            &path,
            "# 用户注释\nmodel = \"keep\"\n[mcp_servers.other]\ncommand = \"keep\"\n",
        )
        .unwrap();
        let first = config(37653, "dummy-test-token");
        assert!(configure(home, &first, LocalAgentTarget::Codex).unwrap());
        assert!(!configure(home, &first, LocalAgentTarget::Codex).unwrap());
        let before = fs::read_to_string(&path).unwrap();
        assert!(before.contains("# 用户注释"));
        assert!(before.contains("[mcp_servers.other]"));
        assert_eq!(
            inspect(home, &first, LocalAgentTarget::Codex),
            LocalAgentSetupState::Current
        );
        for changed in [
            config(40000, "dummy-test-token"),
            config(37653, "rotated-test-token"),
            LocalAgentHttpConfig::new(37653, None).unwrap(),
        ] {
            assert_eq!(
                inspect(home, &changed, LocalAgentTarget::Codex),
                LocalAgentSetupState::Outdated
            );
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), before);
        let launch = mcp_runtime::launch_spec(home);
        configure_codex_mcp(home, &launch).unwrap();
        assert_eq!(
            inspect_codex_state(home, &launch),
            LocalAgentSetupState::Current
        );
        assert!(!fs::read_to_string(&path)
            .unwrap()
            .contains("dummy-test-token"));
    }

    #[test]
    fn opencode保留jsonc且拒绝未知嵌套结构() {
        let directory = TestDirectory::new();
        let home = &directory.0;
        let config_dir = home.join(".config").join("opencode");
        fs::create_dir_all(&config_dir).unwrap();
        let path = config_dir.join("opencode.jsonc");
        fs::write(&path, "{\n // 用户注释\n \"mcp\": {\"other\": {\"type\":\"local\",\"command\":[\"keep\"]},},\n}\n").unwrap();
        let config = config(37653, "dummy-test-token");
        assert!(configure(home, &config, LocalAgentTarget::OpenCode).unwrap());
        assert!(!configure(home, &config, LocalAgentTarget::OpenCode).unwrap());
        assert_eq!(
            inspect(home, &config, LocalAgentTarget::OpenCode),
            LocalAgentSetupState::Current
        );
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("// 用户注释"));
        assert!(content.contains("\"other\""));
        let launch = mcp_runtime::launch_spec(home);
        configure_opencode_mcp(home, &launch).unwrap();
        assert_eq!(
            inspect_opencode_state(home, &launch),
            LocalAgentSetupState::Current
        );
        assert!(!fs::read_to_string(&path)
            .unwrap()
            .contains("dummy-test-token"));
        let unknown = r#"{"mcp":{"servers":{"fstty":{"type":"remote"}}}}"#;
        fs::write(&path, unknown).unwrap();
        assert!(configure(home, &config, LocalAgentTarget::OpenCode).is_err());
        assert_eq!(
            inspect(home, &config, LocalAgentTarget::OpenCode),
            LocalAgentSetupState::Invalid
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), unknown);
    }

    #[test]
    fn claude只合并用户配置且结果不包含令牌() {
        let directory = TestDirectory::new();
        let home = &directory.0;
        let path = home.join(".claude.json");
        let original = serde_json_value!({"projects":{"keep":{"mcpServers":{"other":{"url":"https://example.invalid/mcp"}}}},"mcpServers":{"fstty":{"type":"stdio","command":"old"}}});
        fs::write(&path, serde_json::to_vec(&original).unwrap()).unwrap();
        let config = config(37653, "dummy-test-token");
        // 直接进入目标配置，不检测或执行机器上可能安装的 Claude CLI。
        let result = configure_target(
            home,
            &LocalAgentConnection::Http(&config),
            LocalAgentTarget::Claude,
            "<!-- fstty:begin -->\nUse FsTTY.\n<!-- fstty:end -->",
        );
        assert_eq!(result.mcp_status, LocalAgentStepStatus::Configured);
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("dummy-test-token"));
        let actual: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(actual["projects"], original["projects"]);
        assert_eq!(actual["mcpServers"]["fstty"]["type"], "http");
        assert!(!home.join("mcp-runtime").exists());
    }

    #[test]
    fn 损坏配置与单项失败不覆盖文件也不影响其他目标() {
        let directory = TestDirectory::new();
        let home = &directory.0;
        fs::create_dir(home.join(".cursor")).unwrap();
        fs::create_dir(home.join(".codex")).unwrap();
        let path = home.join(".cursor").join("mcp.json");
        let config = config(37653, "dummy-test-token");
        for original in [
            "{broken",
            r#"{"mcpServers":"broken"}"#,
            r#"{"mcpServers":{"fstty":"broken"}}"#,
        ] {
            fs::write(&path, original).unwrap();
            let results = configure_with_home(
                home,
                &LocalAgentConnection::Http(&config),
                vec![LocalAgentTarget::Cursor, LocalAgentTarget::Codex],
                "<!-- fstty:begin -->\nUse FsTTY.\n<!-- fstty:end -->",
            );
            assert_eq!(results[0].mcp_status, LocalAgentStepStatus::Failed);
            assert_ne!(results[1].mcp_status, LocalAgentStepStatus::Failed);
            assert!(!serde_json::to_string(&results)
                .unwrap()
                .contains("dummy-test-token"));
            assert_eq!(fs::read_to_string(&path).unwrap(), original);
        }
    }

    #[test]
    fn 未初始化令牌只读检测且拒绝写入() {
        let directory = TestDirectory::new();
        let path = directory.0.join(".claude.json");
        let valid = config(37653, "dummy-test-token");
        let missing = LocalAgentHttpConfig::new(37653, None).unwrap();
        assert_eq!(
            inspect(&directory.0, &missing, LocalAgentTarget::Claude),
            LocalAgentSetupState::Missing
        );
        assert!(configure(&directory.0, &missing, LocalAgentTarget::Claude).is_err());
        assert!(!path.exists());
        configure(&directory.0, &valid, LocalAgentTarget::Claude).unwrap();
        let before = fs::read(&path).unwrap();
        assert_eq!(
            inspect(&directory.0, &missing, LocalAgentTarget::Claude),
            LocalAgentSetupState::Outdated
        );
        for changed in [
            config(40000, "dummy-test-token"),
            config(37653, "rotated-test-token"),
        ] {
            assert_eq!(
                inspect(&directory.0, &changed, LocalAgentTarget::Claude),
                LocalAgentSetupState::Outdated
            );
        }
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn 端口及令牌边界校验不回显秘密() {
        assert!(LocalAgentHttpConfig::new(0, None).is_err());
        for token in [
            String::new(),
            "dummy-test-token\r\nInjected: true".to_owned(),
            "x".repeat(16 * 1024 + 1),
        ] {
            let error = LocalAgentHttpConfig::new(37653, Some(Zeroizing::new(token)))
                .err()
                .unwrap();
            assert!(!error.contains("dummy-test-token"));
            assert!(!error.contains("Injected"));
        }
    }
}
