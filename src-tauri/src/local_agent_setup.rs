use crate::mcp_runtime::{self, McpStdioLaunchSpec};
use jsonc_parser::cst::{CstInputValue, CstRootNode};
use jsonc_parser::{json, ParseOptions};
use serde::{Deserialize, Serialize};
use serde_json::{json as serde_json_value, Map, Value};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use toml_edit::{value, Array, DocumentMut, Item, Table};
use uuid::Uuid;

mod http;
pub use http::LocalAgentHttpConfig;

const PROMPT_BEGIN: &str = "<!-- fstty:begin -->";
const PROMPT_END: &str = "<!-- fstty:end -->";

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalAgentTransport {
    #[default]
    Stdio,
    Http,
}

enum LocalAgentConnection<'a> {
    Stdio(&'a McpStdioLaunchSpec),
    Http(&'a LocalAgentHttpConfig),
}

impl LocalAgentConnection<'_> {
    fn inspect(&self, home: &Path, target: LocalAgentTarget) -> LocalAgentSetupState {
        match self {
            Self::Stdio(launch) => inspect_mcp_state(home, launch, target),
            Self::Http(config) => http::inspect(home, config, target),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalAgentTarget {
    Codex,
    Claude,
    Cursor,
    VsCode,
    GeminiCli,
    OpenCode,
    Trae,
    TraeCn,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalAgentSetupState {
    NotDetected,
    Missing,
    Current,
    Outdated,
    Invalid,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAgentCapability {
    pub target: LocalAgentTarget,
    pub installed: bool,
    pub state: LocalAgentSetupState,
    pub detail: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalAgentStepStatus {
    Configured,
    Current,
    ManualRequired,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAgentConfigureResult {
    pub target: LocalAgentTarget,
    pub mcp_status: LocalAgentStepStatus,
    pub prompt_status: LocalAgentStepStatus,
    pub message: Option<String>,
}

pub fn inspect_local_agent_setup(
    app_data_dir: &Path,
    http: Option<LocalAgentHttpConfig>,
) -> Result<Vec<LocalAgentCapability>, String> {
    let home = user_home_directory()?;
    let launch = mcp_runtime::launch_spec(app_data_dir);
    let connection = match http.as_ref() {
        Some(config) => LocalAgentConnection::Http(config),
        None => LocalAgentConnection::Stdio(&launch),
    };
    Ok(inspect_with_home(&home, &connection))
}

pub fn configure_local_agents(
    app_data_dir: &Path,
    targets: Vec<LocalAgentTarget>,
    prompt: &str,
    http: Option<LocalAgentHttpConfig>,
) -> Result<Vec<LocalAgentConfigureResult>, String> {
    if targets.is_empty() {
        return Err("请至少选择一个本地 Agent".to_owned());
    }
    let mut unique_targets = Vec::with_capacity(targets.len());
    for target in targets {
        if !unique_targets.contains(&target) {
            unique_targets.push(target);
        }
    }
    let home = user_home_directory()?;
    if let Some(config) = http {
        // HTTP 客户端只连已有 GUI 服务，不复制可执行文件或创建 stdio 启动器。
        return Ok(configure_with_home(
            &home,
            &LocalAgentConnection::Http(&config),
            unique_targets,
            prompt,
        ));
    }
    let executable = env::current_exe().map_err(|_| "无法获取 FsTTY 程序路径".to_owned())?;
    let launch = mcp_runtime::prepare(app_data_dir, &executable)?;
    Ok(configure_with_home(
        &home,
        &LocalAgentConnection::Stdio(&launch),
        unique_targets,
        prompt,
    ))
}

fn inspect_with_home(
    home: &Path,
    connection: &LocalAgentConnection<'_>,
) -> Vec<LocalAgentCapability> {
    const TARGETS: [LocalAgentTarget; 8] = [
        LocalAgentTarget::Codex,
        LocalAgentTarget::Claude,
        LocalAgentTarget::Cursor,
        LocalAgentTarget::VsCode,
        LocalAgentTarget::GeminiCli,
        LocalAgentTarget::OpenCode,
        LocalAgentTarget::Trae,
        LocalAgentTarget::TraeCn,
    ];
    TARGETS
        .into_iter()
        .map(|target| {
            let installed = target_detected(home, target);
            if !installed {
                return LocalAgentCapability {
                    target,
                    installed: false,
                    state: LocalAgentSetupState::NotDetected,
                    detail: Some("未检测到本地安装".to_owned()),
                };
            }
            let state = connection.inspect(home, target);
            LocalAgentCapability {
                target,
                installed,
                state,
                detail: None,
            }
        })
        .collect()
}

fn configure_with_home(
    home: &Path,
    connection: &LocalAgentConnection<'_>,
    targets: Vec<LocalAgentTarget>,
    prompt: &str,
) -> Vec<LocalAgentConfigureResult> {
    targets
        .into_iter()
        .map(|target| {
            if !target_detected(home, target) {
                return failed_result(target, "未检测到本地安装");
            }
            configure_target(home, connection, target, prompt)
        })
        .collect()
}

fn configure_target(
    home: &Path,
    connection: &LocalAgentConnection<'_>,
    target: LocalAgentTarget,
    prompt: &str,
) -> LocalAgentConfigureResult {
    let mcp_state = connection.inspect(home, target);
    if mcp_state == LocalAgentSetupState::Invalid {
        return failed_result(target, "现有 MCP 配置无法解析，未修改文件");
    }
    let mcp_result = match connection {
        LocalAgentConnection::Http(config) => http::configure(home, config, target),
        LocalAgentConnection::Stdio(launch) => match target {
            LocalAgentTarget::Codex => configure_codex_mcp(home, launch),
            LocalAgentTarget::Claude => configure_claude_mcp(home, launch),
            LocalAgentTarget::Cursor => configure_json_mcp(
                &home.join(".cursor").join("mcp.json"),
                "mcpServers",
                launch,
                false,
            ),
            LocalAgentTarget::VsCode => {
                configure_json_mcp(&vscode_mcp_path(home), "servers", launch, true)
            }
            LocalAgentTarget::GeminiCli => configure_json_mcp(
                &home.join(".gemini").join("settings.json"),
                "mcpServers",
                launch,
                false,
            ),
            LocalAgentTarget::OpenCode => configure_opencode_mcp(home, launch),
            LocalAgentTarget::Trae | LocalAgentTarget::TraeCn => {
                configure_json_mcp(&trae_mcp_path(home, target), "mcpServers", launch, false)
            }
        },
    };
    let mcp_status = match mcp_result {
        Ok(changed) => {
            if changed {
                LocalAgentStepStatus::Configured
            } else {
                LocalAgentStepStatus::Current
            }
        }
        Err(message) => return failed_result(target, &message),
    };

    if requires_manual_prompt(target) {
        return LocalAgentConfigureResult {
            target,
            mcp_status,
            prompt_status: LocalAgentStepStatus::ManualRequired,
            message: None,
        };
    }

    let prompt_path = prompt_path(home, target);
    let prompt_result = if target == LocalAgentTarget::VsCode {
        let content = format!(
            "---\nname: FsTTY\ndescription: FsTTY MCP 使用指南\napplyTo: \"**\"\n---\n\n{prompt}\n"
        );
        let existing = read_optional_text(&prompt_path);
        existing.and_then(|existing| write_if_changed(&prompt_path, existing.as_deref(), &content))
    } else {
        merge_prompt_file(&prompt_path, prompt)
    };
    match prompt_result {
        Ok(changed) => LocalAgentConfigureResult {
            target,
            mcp_status,
            prompt_status: if changed {
                LocalAgentStepStatus::Configured
            } else {
                LocalAgentStepStatus::Current
            },
            message: None,
        },
        Err(message) => LocalAgentConfigureResult {
            target,
            mcp_status,
            prompt_status: LocalAgentStepStatus::Failed,
            message: Some(message),
        },
    }
}

fn requires_manual_prompt(target: LocalAgentTarget) -> bool {
    matches!(
        target,
        LocalAgentTarget::Cursor | LocalAgentTarget::Trae | LocalAgentTarget::TraeCn
    )
}

fn failed_result(target: LocalAgentTarget, message: &str) -> LocalAgentConfigureResult {
    LocalAgentConfigureResult {
        target,
        mcp_status: LocalAgentStepStatus::Failed,
        prompt_status: LocalAgentStepStatus::Failed,
        message: Some(message.to_owned()),
    }
}

fn configure_codex_mcp(home: &Path, launch: &McpStdioLaunchSpec) -> Result<bool, String> {
    let mut server = Table::new();
    server["command"] = value(&launch.command);
    let mut args = Array::new();
    for argument in &launch.args {
        args.push(argument.as_str());
    }
    server["args"] = value(args);
    write_codex_mcp(home, server)
}

fn write_codex_mcp(home: &Path, server: Table) -> Result<bool, String> {
    let path = home.join(".codex").join("config.toml");
    let existing = read_optional_text(&path)?;
    let mut document = existing
        .as_deref()
        .unwrap_or_default()
        .parse::<DocumentMut>()
        .map_err(|_| "Codex config.toml 无法解析".to_owned())?;
    ensure_toml_table(&mut document, "mcp_servers")?;
    if document["mcp_servers"]
        .as_table()
        .and_then(|servers| servers.get("fstty"))
        .is_some_and(|server| !server.is_table())
    {
        return Err("Codex 配置中的 mcp_servers.fstty 不是表".to_owned());
    }
    document["mcp_servers"]["fstty"] = Item::Table(server);
    let next = document.to_string();
    write_if_changed(&path, existing.as_deref(), &next)
}

fn ensure_toml_table(document: &mut DocumentMut, key: &str) -> Result<(), String> {
    if document.get(key).is_none() {
        document[key] = Item::Table(Table::new());
    }
    if !document[key].is_table() {
        return Err(format!("Codex 配置中的 {key} 不是表"));
    }
    Ok(())
}

fn configure_json_mcp(
    path: &Path,
    root_key: &str,
    launch: &McpStdioLaunchSpec,
    include_type: bool,
) -> Result<bool, String> {
    let mut server = serde_json_value!({
        "command": launch.command,
        "args": launch.args
    });
    if include_type {
        server["type"] = Value::String("stdio".to_owned());
    }
    write_json_mcp(path, root_key, server)
}

fn write_json_mcp(path: &Path, root_key: &str, server: Value) -> Result<bool, String> {
    let existing = read_optional_text(path)?;
    let mut root = match existing.as_deref() {
        Some(content) => serde_json::from_str::<Value>(content)
            .map_err(|_| format!("{} 无法解析", path.display()))?,
        None => Value::Object(Map::new()),
    };
    let object = root
        .as_object_mut()
        .ok_or_else(|| format!("{} 根节点不是对象", path.display()))?;
    if !object.contains_key(root_key) {
        object.insert(root_key.to_owned(), Value::Object(Map::new()));
    }
    let servers = object
        .get_mut(root_key)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("{} 中的 {root_key} 不是对象", path.display()))?;
    if servers
        .get("fstty")
        .is_some_and(|server| !server.is_object())
    {
        return Err(format!("{} 中的 fstty 配置不是对象", path.display()));
    }
    servers.insert("fstty".to_owned(), server);
    let next = serde_json::to_string_pretty(&root)
        .map_err(|_| format!("无法生成 {}", path.display()))?
        + "\n";
    write_if_changed(path, existing.as_deref(), &next)
}

fn configure_opencode_mcp(home: &Path, launch: &McpStdioLaunchSpec) -> Result<bool, String> {
    let command = std::iter::once(launch.command.clone())
        .chain(launch.args.iter().cloned())
        .collect::<Vec<_>>();
    write_opencode_mcp(
        home,
        json!({
            "type": "local",
            "command": command,
            "enabled": true
        }),
    )
}

fn write_opencode_mcp(home: &Path, desired: CstInputValue) -> Result<bool, String> {
    let path = opencode_config_path(home)?;
    let existing = read_optional_text(&path)?;
    let source = existing.as_deref().unwrap_or("{}");
    let parsed = jsonc_parser::parse_to_serde_value::<Value>(source, &ParseOptions::default())
        .map_err(|_| format!("{} 无法解析", path.display()))?;
    let object = parsed
        .as_object()
        .ok_or_else(|| format!("{} 根节点不是对象", path.display()))?;
    if object.get("mcp").is_some_and(|value| !value.is_object())
        || object
            .get("mcp")
            .and_then(Value::as_object)
            .and_then(|mcp| mcp.get("fstty"))
            .is_some_and(|value| !value.is_object())
    {
        return Err(format!("{} 中的 mcp.fstty 不是对象", path.display()));
    }
    if object
        .get("mcp")
        .and_then(Value::as_object)
        .is_some_and(unsupported_opencode_layout)
    {
        return Err("OpenCode MCP 配置结构不受支持，未修改配置".to_owned());
    }

    let root = CstRootNode::parse(source, &ParseOptions::default())
        .map_err(|_| format!("{} 无法解析", path.display()))?;
    let root_object = root
        .object_value()
        .ok_or_else(|| format!("{} 根节点不是对象", path.display()))?;
    let mcp_object = match root_object.get("mcp") {
        Some(property) => property
            .object_value()
            .ok_or_else(|| format!("{} 中的 mcp 不是对象", path.display()))?,
        None => root_object
            .append("mcp", json!({}))
            .object_value()
            .ok_or_else(|| format!("{} 无法创建 mcp 对象", path.display()))?,
    };
    if let Some(property) = mcp_object.get("fstty") {
        property.set_value(desired);
    } else {
        mcp_object.append("fstty", desired);
    }
    let next = root.to_string();
    write_if_changed(&path, existing.as_deref(), &next)
}

fn configure_claude_mcp(home: &Path, launch: &McpStdioLaunchSpec) -> Result<bool, String> {
    let command = find_command("claude").ok_or_else(|| "未找到 claude 命令".to_owned())?;
    configure_claude_mcp_with(home, launch, |args| {
        let output = Command::new(&command)
            .args(args)
            .output()
            .map_err(|_| "无法执行 claude mcp 命令".to_owned())?;
        Ok(CommandResult {
            success: output.status.success(),
            stderr: output.stderr,
            stdout: output.stdout,
        })
    })
}

struct CommandResult {
    success: bool,
    stderr: Vec<u8>,
    stdout: Vec<u8>,
}

fn configure_claude_mcp_with(
    home: &Path,
    launch: &McpStdioLaunchSpec,
    mut run: impl FnMut(&[String]) -> Result<CommandResult, String>,
) -> Result<bool, String> {
    let desired = serde_json_value!({
        "type": "stdio",
        "command": launch.command,
        "args": launch.args
    });
    let desired_text =
        serde_json::to_string(&desired).map_err(|_| "无法生成 Claude 配置".to_owned())?;
    let get = run(&["mcp".to_owned(), "get".to_owned(), "fstty".to_owned()])?;
    if get.success && text_contains_launch_spec(&String::from_utf8_lossy(&get.stdout), launch) {
        return Ok(false);
    }

    let store_path = home.join(".claude.json");
    let snapshot = fs::read(&store_path).ok();
    if get.success && snapshot.is_none() {
        return Err("Claude 已有 fstty 配置，但无法建立安全快照".to_owned());
    }
    if get.success {
        let removed = run(&[
            "mcp".to_owned(),
            "remove".to_owned(),
            "--scope".to_owned(),
            "user".to_owned(),
            "fstty".to_owned(),
        ])?;
        if !removed.success {
            return Err(command_error("Claude MCP 旧配置移除失败", &removed.stderr));
        }
    }
    let added = run(&[
        "mcp".to_owned(),
        "add-json".to_owned(),
        "--scope".to_owned(),
        "user".to_owned(),
        "fstty".to_owned(),
        desired_text,
    ])?;
    if added.success {
        return Ok(true);
    }
    if let Some(snapshot) = snapshot {
        let _ = atomic_write(&store_path, &snapshot);
    }
    Err(command_error("Claude MCP 配置失败", &added.stderr))
}

fn command_error(prefix: &str, _stderr: &[u8]) -> String {
    // 客户端可能把旧 HTTP 配置及 Token 写入错误输出；只返回固定操作原因。
    prefix.to_owned()
}

fn inspect_mcp_state(
    home: &Path,
    launch: &McpStdioLaunchSpec,
    target: LocalAgentTarget,
) -> LocalAgentSetupState {
    match target {
        LocalAgentTarget::Claude => inspect_claude_state(home, launch),
        LocalAgentTarget::Codex => inspect_codex_state(home, launch),
        LocalAgentTarget::Cursor => inspect_json_state(
            &home.join(".cursor").join("mcp.json"),
            "mcpServers",
            launch,
            false,
        ),
        LocalAgentTarget::VsCode => {
            inspect_json_state(&vscode_mcp_path(home), "servers", launch, true)
        }
        LocalAgentTarget::GeminiCli => inspect_json_state(
            &home.join(".gemini").join("settings.json"),
            "mcpServers",
            launch,
            false,
        ),
        LocalAgentTarget::OpenCode => inspect_opencode_state(home, launch),
        LocalAgentTarget::Trae | LocalAgentTarget::TraeCn => {
            inspect_json_state(&trae_mcp_path(home, target), "mcpServers", launch, false)
        }
    }
}

fn inspect_opencode_state(home: &Path, launch: &McpStdioLaunchSpec) -> LocalAgentSetupState {
    let Ok(path) = opencode_config_path(home) else {
        return LocalAgentSetupState::Invalid;
    };
    let Ok(Some(content)) = read_optional_text(&path) else {
        return if path.exists() {
            LocalAgentSetupState::Invalid
        } else {
            LocalAgentSetupState::Missing
        };
    };
    let Ok(root) = jsonc_parser::parse_to_serde_value::<Value>(&content, &ParseOptions::default())
    else {
        return LocalAgentSetupState::Invalid;
    };
    let Some(object) = root.as_object() else {
        return LocalAgentSetupState::Invalid;
    };
    if object.get("mcp").is_some_and(|value| !value.is_object()) {
        return LocalAgentSetupState::Invalid;
    }
    if object
        .get("mcp")
        .and_then(Value::as_object)
        .is_some_and(unsupported_opencode_layout)
    {
        return LocalAgentSetupState::Invalid;
    }
    let Some(server) = root.get("mcp").and_then(|value| value.get("fstty")) else {
        return LocalAgentSetupState::Missing;
    };
    if !server.is_object() {
        return LocalAgentSetupState::Invalid;
    }
    let desired_command = std::iter::once(launch.command.as_str())
        .chain(launch.args.iter().map(String::as_str))
        .collect::<Vec<_>>();
    let command_current = server
        .get("command")
        .and_then(Value::as_array)
        .is_some_and(|command| {
            command.len() == desired_command.len()
                && command
                    .iter()
                    .zip(desired_command)
                    .all(|(actual, desired)| actual.as_str() == Some(desired))
        });
    let type_current = server.get("type").and_then(Value::as_str) == Some("local");
    let enabled_current = server.get("enabled").and_then(Value::as_bool) == Some(true);
    if command_current && type_current && enabled_current && !has_http_fields(server) {
        LocalAgentSetupState::Current
    } else {
        LocalAgentSetupState::Outdated
    }
}

fn inspect_codex_state(home: &Path, launch: &McpStdioLaunchSpec) -> LocalAgentSetupState {
    let path = home.join(".codex").join("config.toml");
    let Ok(Some(content)) = read_optional_text(&path) else {
        return if path.exists() {
            LocalAgentSetupState::Invalid
        } else {
            LocalAgentSetupState::Missing
        };
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
    let command = server.get("command").and_then(Item::as_str);
    let args = server.get("args").and_then(Item::as_array);
    if command == Some(launch.command.as_str())
        && [
            "url",
            "http_headers",
            "env_http_headers",
            "bearer_token_env_var",
        ]
        .iter()
        .all(|key| !server.contains_key(key))
        && args.is_some_and(|args| {
            args.len() == launch.args.len()
                && args
                    .iter()
                    .zip(&launch.args)
                    .all(|(actual, expected)| actual.as_str() == Some(expected.as_str()))
        })
    {
        LocalAgentSetupState::Current
    } else {
        LocalAgentSetupState::Outdated
    }
}

fn inspect_json_state(
    path: &Path,
    root_key: &str,
    launch: &McpStdioLaunchSpec,
    include_type: bool,
) -> LocalAgentSetupState {
    let Ok(Some(content)) = read_optional_text(path) else {
        return if path.exists() {
            LocalAgentSetupState::Invalid
        } else {
            LocalAgentSetupState::Missing
        };
    };
    let Ok(root) = serde_json::from_str::<Value>(&content) else {
        return LocalAgentSetupState::Invalid;
    };
    let Some(root) = root.as_object() else {
        return LocalAgentSetupState::Invalid;
    };
    let Some(servers) = root.get(root_key) else {
        return LocalAgentSetupState::Missing;
    };
    let Some(servers) = servers.as_object() else {
        return LocalAgentSetupState::Invalid;
    };
    let Some(server) = servers.get("fstty") else {
        return LocalAgentSetupState::Missing;
    };
    if !server.is_object() {
        return LocalAgentSetupState::Invalid;
    }
    let command_current =
        server.get("command").and_then(Value::as_str) == Some(launch.command.as_str());
    let type_current = !include_type || server.get("type").and_then(Value::as_str) == Some("stdio");
    let args_current = server
        .get("args")
        .and_then(Value::as_array)
        .is_some_and(|args| {
            args.len() == launch.args.len()
                && args
                    .iter()
                    .zip(&launch.args)
                    .all(|(actual, expected)| actual.as_str() == Some(expected.as_str()))
        });
    if command_current && args_current && type_current && !has_http_fields(server) {
        LocalAgentSetupState::Current
    } else {
        LocalAgentSetupState::Outdated
    }
}

fn inspect_claude_state(home: &Path, launch: &McpStdioLaunchSpec) -> LocalAgentSetupState {
    let path = home.join(".claude.json");
    let Ok(Some(content)) = read_optional_text(&path) else {
        return if path.exists() {
            LocalAgentSetupState::Invalid
        } else {
            LocalAgentSetupState::Missing
        };
    };
    let Ok(root) = serde_json::from_str::<Value>(&content) else {
        return LocalAgentSetupState::Invalid;
    };
    let Some(root) = root.as_object() else {
        return LocalAgentSetupState::Invalid;
    };
    let Some(servers) = root.get("mcpServers") else {
        return LocalAgentSetupState::Missing;
    };
    let Some(servers) = servers.as_object() else {
        return LocalAgentSetupState::Invalid;
    };
    let Some(server) = servers.get("fstty") else {
        return LocalAgentSetupState::Missing;
    };
    if !server.is_object() {
        return LocalAgentSetupState::Invalid;
    }
    let command_current =
        server.get("command").and_then(Value::as_str) == Some(launch.command.as_str());
    let type_current = server.get("type").and_then(Value::as_str) == Some("stdio");
    let args_current = server
        .get("args")
        .and_then(Value::as_array)
        .is_some_and(|args| {
            args.len() == launch.args.len()
                && args
                    .iter()
                    .zip(&launch.args)
                    .all(|(actual, expected)| actual.as_str() == Some(expected.as_str()))
        });
    if command_current && args_current && type_current && !has_http_fields(server) {
        LocalAgentSetupState::Current
    } else {
        LocalAgentSetupState::Outdated
    }
}

fn text_contains_launch_spec(content: &str, launch: &McpStdioLaunchSpec) -> bool {
    content.contains(&launch.command)
        && launch
            .args
            .iter()
            .all(|argument| content.contains(argument))
}

fn has_http_fields(server: &Value) -> bool {
    [
        "url",
        "httpUrl",
        "headers",
        "http_headers",
        "env_http_headers",
        "bearer_token_env_var",
    ]
    .iter()
    .any(|key| server.get(key).is_some())
}

fn unsupported_opencode_layout(servers: &Map<String, Value>) -> bool {
    // 不把新版嵌套 servers 布局误当成旧版平铺配置；用户需先手工确认迁移。
    servers
        .get("servers")
        .and_then(Value::as_object)
        .is_some_and(|nested| !nested.contains_key("type"))
}

fn merge_prompt_file(path: &Path, prompt: &str) -> Result<bool, String> {
    let existing = read_optional_text(path)?;
    let next = merge_prompt(existing.as_deref().unwrap_or_default(), prompt)?;
    write_if_changed(path, existing.as_deref(), &next)
}

fn merge_prompt(existing: &str, prompt: &str) -> Result<String, String> {
    let begins = existing.match_indices(PROMPT_BEGIN).collect::<Vec<_>>();
    let ends = existing.match_indices(PROMPT_END).collect::<Vec<_>>();
    if begins.len() != ends.len() || begins.len() > 1 {
        return Err("提示词中的 FsTTY 标记损坏，未修改文件".to_owned());
    }
    let block_start = prompt
        .find(PROMPT_BEGIN)
        .ok_or_else(|| "FsTTY 提示词缺少开始标记".to_owned())?;
    let block_end = prompt
        .find(PROMPT_END)
        .map(|index| index + PROMPT_END.len())
        .ok_or_else(|| "FsTTY 提示词缺少结束标记".to_owned())?;
    let block = &prompt[block_start..block_end];
    if begins.is_empty() {
        let prefix = existing.trim_end();
        return Ok(if prefix.is_empty() {
            format!("{block}\n")
        } else {
            format!("{prefix}\n\n{block}\n")
        });
    }
    let start = begins[0].0;
    let end = ends[0].0 + PROMPT_END.len();
    let prefix = &existing[..start];
    // 历史配置可能让 FsTTY 标记紧贴上一段；更新时补足空行，避免不同工具区块粘连。
    let separator = if prefix.is_empty() || prefix.ends_with("\n\n") || prefix.ends_with("\r\n\r\n")
    {
        ""
    } else if prefix.ends_with("\r\n") {
        "\r\n"
    } else if prefix.ends_with('\n') {
        "\n"
    } else if prefix.contains("\r\n") {
        "\r\n\r\n"
    } else {
        "\n\n"
    };
    Ok(format!(
        "{}{}{}{}",
        prefix,
        separator,
        block,
        &existing[end..]
    ))
}

fn write_if_changed(path: &Path, existing: Option<&str>, next: &str) -> Result<bool, String> {
    check_configuration_snapshot(path, existing.map(str::as_bytes))?;
    if existing == Some(next) {
        return Ok(false);
    }
    atomic_write_checked(
        path,
        next.as_bytes(),
        Some(existing.map(str::as_bytes)),
        mcp_runtime::replace_file,
    )?;
    Ok(true)
}

fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    atomic_write_checked(path, content, None, mcp_runtime::replace_file)
}

fn check_configuration_snapshot(path: &Path, expected: Option<&[u8]>) -> Result<(), String> {
    let actual = read_optional_text(path)?;
    if actual.as_deref().map(str::as_bytes) != expected {
        return Err(format!(
            "配置已被其他程序修改，请重新检测后重试：{}",
            path.display()
        ));
    }
    Ok(())
}

fn atomic_write_checked(
    path: &Path,
    content: &[u8],
    expected: Option<Option<&[u8]>>,
    commit: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    if path
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(format!("拒绝写入符号链接：{}", path.display()));
    }
    let parent = path
        .parent()
        .ok_or_else(|| "配置路径缺少父目录".to_owned())?;
    fs::create_dir_all(parent).map_err(|_| format!("无法创建目录：{}", parent.display()))?;
    let suffix = Uuid::new_v4();
    let temp = parent.join(format!(".fstty-{suffix}.tmp"));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .map_err(|_| format!("无法创建临时文件：{}", temp.display()))?;
    let written = file.write_all(content).and_then(|_| file.sync_all());
    drop(file);
    if written.is_err() {
        let _ = fs::remove_file(&temp);
        return Err(format!("无法写入临时文件：{}", temp.display()));
    }
    if let Some(expected) = expected {
        // 文件生成期间 Agent 可能保存了其他设置；提交前再次检查，不能覆盖新内容。
        if let Err(error) = check_configuration_snapshot(path, expected) {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
    }
    // 原子替换始终保留原文件到提交时，不产生主文件缺失窗口或残留含令牌备份。
    if commit(&temp, path).is_err() {
        let _ = fs::remove_file(&temp);
        return Err(format!("无法提交配置：{}", path.display()));
    }
    Ok(())
}

fn read_optional_text(path: &Path) -> Result<Option<String>, String> {
    if path
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(format!("拒绝读取符号链接：{}", path.display()));
    }
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(format!("无法读取配置：{}", path.display())),
    }
}

fn prompt_path(home: &Path, target: LocalAgentTarget) -> PathBuf {
    match target {
        LocalAgentTarget::Codex => home.join(".codex").join("AGENTS.md"),
        LocalAgentTarget::Claude => home.join(".claude").join("CLAUDE.md"),
        LocalAgentTarget::VsCode => home
            .join(".copilot")
            .join("instructions")
            .join("fstty.instructions.md"),
        LocalAgentTarget::GeminiCli => home.join(".gemini").join("GEMINI.md"),
        LocalAgentTarget::Cursor => home.join(".cursor").join("unused"),
        LocalAgentTarget::OpenCode => home.join(".config").join("opencode").join("AGENTS.md"),
        LocalAgentTarget::Trae | LocalAgentTarget::TraeCn => home.join(".trae").join("unused"),
    }
}

fn vscode_mcp_path(home: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    if let Some(app_data) = env::var_os("APPDATA") {
        return PathBuf::from(app_data)
            .join("Code")
            .join("User")
            .join("mcp.json");
    }
    #[cfg(target_os = "macos")]
    {
        return home
            .join("Library")
            .join("Application Support")
            .join("Code")
            .join("User")
            .join("mcp.json");
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let root = env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        root.join("Code").join("User").join("mcp.json")
    }
    #[cfg(target_os = "windows")]
    home.join("AppData")
        .join("Roaming")
        .join("Code")
        .join("User")
        .join("mcp.json")
}

fn opencode_config_path(home: &Path) -> Result<PathBuf, String> {
    let directory = home.join(".config").join("opencode");
    let json_path = directory.join("opencode.json");
    let jsonc_path = directory.join("opencode.jsonc");
    if json_path.exists() && jsonc_path.exists() {
        return Err("OpenCode 同时存在 opencode.json 和 opencode.jsonc，未修改配置".to_owned());
    }
    Ok(if jsonc_path.exists() {
        jsonc_path
    } else {
        json_path
    })
}

fn trae_mcp_path(home: &Path, target: LocalAgentTarget) -> PathBuf {
    trae_user_directory(home, target)
        .join("settings")
        .join("mcp.json")
}

fn trae_user_directory(home: &Path, target: LocalAgentTarget) -> PathBuf {
    #[cfg(target_os = "windows")]
    let root = env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData").join("Roaming"));
    #[cfg(target_os = "macos")]
    let root = home.join("Library").join("Application Support");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let root = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    trae_user_directory_from_root(&root, target)
}

fn trae_user_directory_from_root(root: &Path, target: LocalAgentTarget) -> PathBuf {
    let application_name = match target {
        LocalAgentTarget::Trae => "Trae",
        LocalAgentTarget::TraeCn => "Trae CN",
        _ => unreachable!("仅 Trae 目标可解析用户目录"),
    };
    root.join(application_name).join("User")
}

fn target_detected(home: &Path, target: LocalAgentTarget) -> bool {
    match target {
        LocalAgentTarget::Codex => home.join(".codex").exists() || find_command("codex").is_some(),
        LocalAgentTarget::Claude => find_command("claude").is_some(),
        LocalAgentTarget::Cursor => {
            home.join(".cursor").exists()
                || find_command("cursor").is_some()
                || find_command("cursor-agent").is_some()
        }
        LocalAgentTarget::VsCode => {
            vscode_mcp_path(home).parent().is_some_and(Path::exists)
                || find_command("code").is_some()
        }
        LocalAgentTarget::GeminiCli => {
            home.join(".gemini").exists() || find_command("gemini").is_some()
        }
        LocalAgentTarget::OpenCode => {
            home.join(".config").join("opencode").exists() || find_command("opencode").is_some()
        }
        LocalAgentTarget::Trae | LocalAgentTarget::TraeCn => {
            trae_user_directory(home, target).exists()
        }
    }
}

fn find_command(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    let extensions: &[&str] = if cfg!(windows) {
        &[".exe", ".cmd", ".bat", ""]
    } else {
        &[""]
    };
    for directory in env::split_paths(&path) {
        for extension in extensions {
            let candidate = directory.join(format!("{name}{extension}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn user_home_directory() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let home = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME"));
    #[cfg(not(target_os = "windows"))]
    let home = env::var_os("HOME");
    home.map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "无法获取当前用户目录".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn test_directory(name: &str) -> PathBuf {
        let path = env::temp_dir().join(format!("fstty-local-agent-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).expect("应创建测试目录");
        path
    }

    fn test_launch_spec(root: &Path) -> McpStdioLaunchSpec {
        mcp_runtime::launch_spec(root)
    }

    const PROMPT: &str = "<!-- fstty:begin -->\n\nUse FsTTY MCP.\n\n<!-- fstty:end -->";

    #[test]
    fn json合并保留其他配置并且幂等() {
        let root = test_directory("json");
        let path = root.join("mcp.json");
        fs::write(
            &path,
            r#"{"mcpServers":{"other":{"command":"other"}},"keep":true}"#,
        )
        .expect("应写入配置");
        let launch = test_launch_spec(&root);

        assert!(configure_json_mcp(&path, "mcpServers", &launch, false).unwrap());
        assert!(!configure_json_mcp(&path, "mcpServers", &launch, false).unwrap());
        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["keep"], true);
        assert_eq!(value["mcpServers"]["other"]["command"], "other");
        assert_eq!(value["mcpServers"]["fstty"]["command"], launch.command);
        assert_eq!(
            value["mcpServers"]["fstty"]["args"],
            serde_json_value!(launch.args)
        );
        assert_eq!(
            inspect_json_state(&path, "mcpServers", &launch, false),
            LocalAgentSetupState::Current
        );
        assert_eq!(
            inspect_json_state(&path, "mcpServers", &launch, true),
            LocalAgentSetupState::Outdated
        );
        assert!(configure_json_mcp(&path, "mcpServers", &launch, true).unwrap());
        assert_eq!(
            inspect_json_state(&path, "mcpServers", &launch, true),
            LocalAgentSetupState::Current
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn toml合并保留注释和其他服务() {
        let root = test_directory("toml");
        let codex = root.join(".codex");
        fs::create_dir_all(&codex).unwrap();
        fs::write(
            codex.join("config.toml"),
            "# keep\n[mcp_servers.other]\ncommand = \"other\"\n",
        )
        .unwrap();
        let launch = test_launch_spec(&root);

        assert!(configure_codex_mcp(&root, &launch).unwrap());
        let content = fs::read_to_string(codex.join("config.toml")).unwrap();
        assert!(content.contains("# keep"));
        assert!(content.contains("[mcp_servers.other]"));
        assert!(content.contains("[mcp_servers.fstty]"));
        assert!(!configure_codex_mcp(&root, &launch).unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn codex检测安全处理缺失损坏和完整配置() {
        let root = test_directory("codex-inspect");
        let codex = root.join(".codex");
        let path = codex.join("config.toml");
        fs::create_dir_all(&codex).unwrap();
        let launch = test_launch_spec(&root);

        for (content, expected) in [
            ("", LocalAgentSetupState::Missing),
            ("theme = \"dark\"\n", LocalAgentSetupState::Missing),
            (
                "[mcp_servers.other]\ncommand = \"other\"\n",
                LocalAgentSetupState::Missing,
            ),
            (
                "[mcp_servers.fstty]\ncommand = \"other\"\n",
                LocalAgentSetupState::Outdated,
            ),
            ("mcp_servers = \"broken\"\n", LocalAgentSetupState::Invalid),
            (
                "[mcp_servers]\nfstty = \"broken\"\n",
                LocalAgentSetupState::Invalid,
            ),
            ("{ broken", LocalAgentSetupState::Invalid),
        ] {
            fs::write(&path, content).unwrap();
            let before = fs::read(&path).unwrap();
            assert_eq!(inspect_codex_state(&root, &launch), expected);
            assert_eq!(fs::read(&path).unwrap(), before);
        }

        fs::write(
            &path,
            "[mcp_servers.fstty]\ncommand = \"fstty.exe\"\nargs = [\"--mcp-stdio\"]\n",
        )
        .unwrap();
        assert_eq!(
            inspect_codex_state(&root, &launch),
            LocalAgentSetupState::Outdated
        );

        configure_codex_mcp(&root, &launch).unwrap();
        assert_eq!(
            inspect_codex_state(&root, &launch),
            LocalAgentSetupState::Current
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn opencode合并jsonc保留注释并配置全局提示词() {
        let root = test_directory("opencode-jsonc");
        let directory = root.join(".config").join("opencode");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("opencode.jsonc");
        fs::write(
            &path,
            "{\n  // 保留注释\n  \"theme\": \"dark\",\n  \"mcp\": {\n    \"other\": { \"type\": \"remote\" },\n  },\n}\n",
        )
        .unwrap();
        let launch = test_launch_spec(&root);

        let first = configure_with_home(
            &root,
            &LocalAgentConnection::Stdio(&launch),
            vec![LocalAgentTarget::OpenCode],
            PROMPT,
        );
        assert_eq!(first[0].mcp_status, LocalAgentStepStatus::Configured);
        assert_eq!(first[0].prompt_status, LocalAgentStepStatus::Configured);
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("// 保留注释"));
        assert!(content.contains("\"theme\": \"dark\""));
        assert!(content.contains("\"other\""));
        assert!(content.contains("\"fstty\""));
        assert_eq!(
            inspect_opencode_state(&root, &launch),
            LocalAgentSetupState::Current
        );
        assert!(fs::read_to_string(directory.join("AGENTS.md"))
            .unwrap()
            .contains(PROMPT_BEGIN));

        let second = configure_with_home(
            &root,
            &LocalAgentConnection::Stdio(&launch),
            vec![LocalAgentTarget::OpenCode],
            PROMPT,
        );
        assert_eq!(second[0].mcp_status, LocalAgentStepStatus::Current);
        assert_eq!(second[0].prompt_status, LocalAgentStepStatus::Current);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn opencode双配置冲突和损坏配置均不写入() {
        let root = test_directory("opencode-invalid");
        let directory = root.join(".config").join("opencode");
        fs::create_dir_all(&directory).unwrap();
        let json_path = directory.join("opencode.json");
        let jsonc_path = directory.join("opencode.jsonc");
        fs::write(&json_path, "{}\n").unwrap();
        fs::write(&jsonc_path, "{ /* keep */ }\n").unwrap();
        let json_before = fs::read(&json_path).unwrap();
        let jsonc_before = fs::read(&jsonc_path).unwrap();
        let launch = test_launch_spec(&root);

        assert!(configure_opencode_mcp(&root, &launch).is_err());
        assert_eq!(
            inspect_opencode_state(&root, &launch),
            LocalAgentSetupState::Invalid
        );
        assert_eq!(fs::read(&json_path).unwrap(), json_before);
        assert_eq!(fs::read(&jsonc_path).unwrap(), jsonc_before);

        fs::remove_file(&json_path).unwrap();
        fs::write(&jsonc_path, "{ broken").unwrap();
        let invalid_before = fs::read(&jsonc_path).unwrap();
        assert!(configure_opencode_mcp(&root, &launch).is_err());
        assert_eq!(fs::read(&jsonc_path).unwrap(), invalid_before);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn trae两版本路径独立且配置返回手工提示词() {
        let root = test_directory("trae");
        let international = trae_user_directory_from_root(&root, LocalAgentTarget::Trae);
        let china = trae_user_directory_from_root(&root, LocalAgentTarget::TraeCn);
        assert_eq!(international, root.join("Trae").join("User"));
        assert_eq!(china, root.join("Trae CN").join("User"));

        let launch = test_launch_spec(&root);
        for target in [LocalAgentTarget::Trae, LocalAgentTarget::TraeCn] {
            let path = trae_user_directory_from_root(&root, target)
                .join("settings")
                .join("mcp.json");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, r#"{"mcpServers":{"other":{"command":"keep"}}}"#).unwrap();
            assert!(configure_json_mcp(&path, "mcpServers", &launch, false).unwrap());
            let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(value["mcpServers"]["other"]["command"], "keep");
            assert_eq!(value["mcpServers"]["fstty"]["command"], launch.command);
            assert_eq!(
                value["mcpServers"]["fstty"]["args"],
                serde_json_value!(launch.args)
            );

            assert!(requires_manual_prompt(target));
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn 提示词追加替换且保护损坏标记() {
        let appended = merge_prompt("用户内容\n", PROMPT).unwrap();
        assert!(appended.starts_with("用户内容\n\n"));
        let updated = merge_prompt(&appended, &PROMPT.replace("Use", "Always use")).unwrap();
        assert!(updated.contains("Always use FsTTY"));
        assert_eq!(updated.matches(PROMPT_BEGIN).count(), 1);
        assert!(merge_prompt("<!-- fstty:begin -->\n损坏", PROMPT).is_err());
    }

    #[test]
    fn 更新提示词时补足区块前空行并保持幂等() {
        let adjacent = format!("<!-- CODEGRAPH_END -->\n{PROMPT}\n");
        let normalized = merge_prompt(&adjacent, PROMPT).unwrap();
        assert!(normalized.contains("<!-- CODEGRAPH_END -->\n\n<!-- fstty:begin -->"));
        assert_eq!(merge_prompt(&normalized, PROMPT).unwrap(), normalized);

        let adjacent_crlf = adjacent.replace('\n', "\r\n");
        let normalized_crlf = merge_prompt(&adjacent_crlf, PROMPT).unwrap();
        assert!(normalized_crlf.contains("<!-- CODEGRAPH_END -->\r\n\r\n<!-- fstty:begin -->"));
    }

    #[test]
    fn 损坏json不修改原文件() {
        let root = test_directory("invalid-json");
        let path = root.join("mcp.json");
        fs::write(&path, "{broken").unwrap();
        let before = fs::read(&path).unwrap();
        let launch = test_launch_spec(&root);

        assert!(configure_json_mcp(&path, "mcpServers", &launch, false).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn 异常fstty节点不被覆盖() {
        let root = test_directory("invalid-node");
        let path = root.join("mcp.json");
        fs::write(&path, r#"{"mcpServers":{"fstty":"broken"}}"#).unwrap();
        let before = fs::read(&path).unwrap();
        let launch = test_launch_spec(&root);

        assert!(configure_json_mcp(&path, "mcpServers", &launch, false).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(
            inspect_json_state(&path, "mcpServers", &launch, false),
            LocalAgentSetupState::Invalid
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn 旧版直接exe配置在各格式中均为过期() {
        let root = test_directory("legacy-direct-exe");
        let launch = test_launch_spec(&root);

        let json_path = root.join("mcp.json");
        fs::write(
            &json_path,
            r#"{"mcpServers":{"fstty":{"command":"fstty.exe","args":["--mcp-stdio"]}}}"#,
        )
        .unwrap();
        assert_eq!(
            inspect_json_state(&json_path, "mcpServers", &launch, false),
            LocalAgentSetupState::Outdated
        );

        let opencode = root.join(".config").join("opencode");
        fs::create_dir_all(&opencode).unwrap();
        fs::write(
            opencode.join("opencode.json"),
            r#"{"mcp":{"fstty":{"type":"local","command":["fstty.exe","--mcp-stdio"],"enabled":true}}}"#,
        )
        .unwrap();
        assert_eq!(
            inspect_opencode_state(&root, &launch),
            LocalAgentSetupState::Outdated
        );

        fs::write(
            root.join(".claude.json"),
            r#"{"mcpServers":{"fstty":{"type":"stdio","command":"fstty.exe","args":["--mcp-stdio"]}}}"#,
        )
        .unwrap();
        assert_eq!(
            inspect_claude_state(&root, &launch),
            LocalAgentSetupState::Outdated
        );
        fs::write(
            root.join(".claude.json"),
            serde_json::to_vec(&serde_json_value!({
                "mcpServers": {
                    "fstty": {
                        "type": "stdio",
                        "command": launch.command,
                        "args": launch.args
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            inspect_claude_state(&root, &launch),
            LocalAgentSetupState::Current
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn claude命令成功配置新服务() {
        let root = test_directory("claude-success");
        let calls = RefCell::new(Vec::<Vec<String>>::new());
        let launch = test_launch_spec(&root);
        let changed = configure_claude_mcp_with(&root, &launch, |args| {
            calls.borrow_mut().push(args.to_vec());
            Ok(CommandResult {
                success: args.get(1).is_some_and(|arg| arg == "add-json"),
                stderr: Vec::new(),
                stdout: Vec::new(),
            })
        })
        .unwrap();

        assert!(changed);
        assert_eq!(calls.borrow().len(), 2);
        assert_eq!(calls.borrow()[1][1], "add-json");
        let desired: Value = serde_json::from_str(&calls.borrow()[1][5]).unwrap();
        assert_eq!(desired["command"], launch.command);
        assert_eq!(desired["args"], serde_json_value!(launch.args));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn claude命令失败恢复原配置() {
        let root = test_directory("claude-rollback");
        let store_path = root.join(".claude.json");
        fs::write(&store_path, b"original").unwrap();
        let launch = test_launch_spec(&root);
        let result = configure_claude_mcp_with(&root, &launch, |args| {
            match args.get(1).map(String::as_str) {
                Some("get") => Ok(CommandResult {
                    success: true,
                    stderr: Vec::new(),
                    stdout: b"old fstty config".to_vec(),
                }),
                Some("remove") => {
                    fs::write(&store_path, b"removed").unwrap();
                    Ok(CommandResult {
                        success: true,
                        stderr: Vec::new(),
                        stdout: Vec::new(),
                    })
                }
                _ => {
                    fs::write(&store_path, b"partial").unwrap();
                    Ok(CommandResult {
                        success: false,
                        stderr: b"failed".to_vec(),
                        stdout: Vec::new(),
                    })
                }
            }
        });

        assert!(result.is_err());
        assert_eq!(fs::read(&store_path).unwrap(), b"original");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn 未检测agent返回失败而不影响其他项() {
        let root = test_directory("partial");
        fs::create_dir_all(root.join(".codex")).unwrap();
        let launch = test_launch_spec(&root);
        let results = configure_with_home(
            &root,
            &LocalAgentConnection::Stdio(&launch),
            vec![LocalAgentTarget::Codex, LocalAgentTarget::GeminiCli],
            PROMPT,
        );

        assert_eq!(results[0].mcp_status, LocalAgentStepStatus::Configured);
        assert_eq!(results[1].mcp_status, LocalAgentStepStatus::Failed);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn 外部配置变更阻止过期内容覆盖() {
        let root = test_directory("concurrent-change");
        let path = root.join("mcp.json");
        fs::write(&path, "用户刚保存的新内容").unwrap();
        let error = write_if_changed(&path, Some("旧内容"), "FsTTY 新内容").unwrap_err();
        assert!(error.contains("其他程序修改"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "用户刚保存的新内容");
        assert!(write_if_changed(&path, None, "FsTTY 新内容").is_err());
        fs::remove_file(&path).unwrap();
        assert!(write_if_changed(&path, Some("旧内容"), "FsTTY 新内容").is_err());
        assert!(!path.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn 提交失败保留原文件并清理含令牌临时文件() {
        let root = test_directory("commit-failure");
        let path = root.join("mcp.json");
        fs::write(&path, "original").unwrap();
        let error = atomic_write_checked(
            &path,
            b"Bearer dummy-test-token",
            Some(Some(b"original")),
            |temp, destination| {
                assert!(temp.is_file());
                assert_eq!(fs::read(destination).unwrap(), b"original");
                Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
            },
        )
        .unwrap_err();
        assert!(!error.contains("dummy-test-token"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        assert!(write_if_changed(&path, Some("original"), "recovered").unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), "recovered");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn 提交前再次检测外部修改并清理临时文件() {
        let root = test_directory("precommit-recheck");
        let path = root.join("mcp.json");
        fs::write(&path, "new external content").unwrap();
        let error = atomic_write_checked(
            &path,
            b"Bearer dummy-test-token",
            Some(Some(b"old")),
            |_, _| panic!("不应提交过期快照"),
        )
        .unwrap_err();
        assert!(error.contains("其他程序修改"));
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        assert_eq!(fs::read_to_string(&path).unwrap(), "new external content");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn 客户端错误原文不暴露令牌或私钥() {
        assert_eq!(
            command_error(
                "Claude MCP 配置失败",
                b"Authorization: Bearer secret; private_key=secret"
            ),
            "Claude MCP 配置失败"
        );
    }

    #[test]
    fn 本地配置协议仅接受已知枚举且默认stdio() {
        assert_eq!(LocalAgentTransport::default(), LocalAgentTransport::Stdio);
        assert_eq!(
            serde_json::from_str::<LocalAgentTransport>("\"http\"").unwrap(),
            LocalAgentTransport::Http
        );
        assert!(serde_json::from_str::<LocalAgentTransport>("\"sse\"").is_err());
    }
}
