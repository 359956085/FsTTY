use super::*;

#[cfg(windows)]
pub fn repair_installation_paths(previous: &[PathBuf], current: &Path) -> Vec<String> {
    let home = match user_home_directory() {
        Ok(home) => home,
        Err(error) => return vec![error],
    };
    repair_with_home(&home, previous, current)
}

#[cfg(windows)]
fn repair_with_home(home: &Path, previous: &[PathBuf], current: &Path) -> Vec<String> {
    let mut errors = Vec::new();
    let codex = home.join(".codex/config.toml");
    if let Err(error) = repair_toml(&codex, previous, current) {
        errors.push(error);
    }
    let mut targets = vec![
        (home.join(".claude.json"), "mcpServers"),
        (home.join(".cursor/mcp.json"), "mcpServers"),
        (vscode_mcp_path(home), "servers"),
        (home.join(".gemini/settings.json"), "mcpServers"),
        (trae_mcp_path(home, LocalAgentTarget::Trae), "mcpServers"),
        (trae_mcp_path(home, LocalAgentTarget::TraeCn), "mcpServers"),
    ];
    match opencode_config_path(home) {
        Ok(path) => targets.push((path, "mcp")),
        Err(error) => errors.push(error),
    }
    for (path, root) in targets {
        if let Err(error) = repair_json(&path, root, previous, current) {
            errors.push(format!("{}：{error}", path.display()));
        }
    }
    errors
}

fn same_command(command: &str, directory: &Path) -> bool {
    let normalize = |text: &str| text.replace('/', "\\").to_lowercase();
    normalize(command) == normalize(&directory.join("fstty.exe").to_string_lossy())
}
fn replacement(command: &str, previous: &[PathBuf], current: &Path) -> Option<String> {
    previous
        .iter()
        .any(|old| same_command(command, old))
        .then(|| current.join("fstty.exe").to_string_lossy().into_owned())
}
fn suspicious(command: &str, previous: &[PathBuf]) -> bool {
    let normalized = command.replace('/', "\\").to_lowercase();
    previous
        .iter()
        .any(|old| normalized.contains(&old.to_string_lossy().replace('/', "\\").to_lowercase()))
}

fn repair_toml(path: &Path, previous: &[PathBuf], current: &Path) -> Result<(), String> {
    let Some(source) = read_optional_text(path)? else {
        return Ok(());
    };
    let mut document = source
        .parse::<DocumentMut>()
        .map_err(|_| "Codex 配置无法解析，请重新一键配置")?;
    let Some(server) = document
        .get_mut("mcp_servers")
        .and_then(|servers| servers.get_mut("fstty"))
    else {
        return Ok(());
    };
    if server.get("url").is_some() {
        return Ok(());
    }
    if let Some(command) = server.get("command").and_then(Item::as_str) {
        if let Some(next) = replacement(command, previous, current) {
            server["command"] = value(next);
            return write_if_changed(path, Some(&source), &document.to_string()).map(|_| ());
        }
        if suspicious(command, previous)
            || server
                .get("args")
                .is_some_and(|args| suspicious(&args.to_string(), previous))
        {
            return Err("Codex 使用旧目录的自定义命令，请重新一键配置".into());
        }
    }
    Ok(())
}

fn repair_json(
    path: &Path,
    root_key: &str,
    previous: &[PathBuf],
    current: &Path,
) -> Result<(), String> {
    let Some(source) = read_optional_text(path)? else {
        return Ok(());
    };
    let root = jsonc_parser::parse_to_serde_value::<Value>(&source, &ParseOptions::default())
        .map_err(|_| "配置无法解析，请重新一键配置")?;
    let Some(server) = root.get(root_key).and_then(|r| r.get("fstty")) else {
        return Ok(());
    };
    if server.get("url").is_some()
        || server
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|s| s == "http" || s == "sse" || s == "remote")
    {
        return Ok(());
    }
    let Some(command) = server.get("command") else {
        return Ok(());
    };
    let original = command.as_str().or_else(|| {
        command
            .as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_str)
    });
    let Some(original) = original else {
        return Err("自定义 FsTTY 命令无法识别，请重新一键配置".into());
    };
    let Some(next) = replacement(original, previous, current) else {
        if suspicious(&command.to_string(), previous)
            || server
                .get("args")
                .is_some_and(|a| suspicious(&a.to_string(), previous))
        {
            return Err("自定义命令仍指向旧目录，请重新一键配置".into());
        }
        return Ok(());
    };
    let parsed =
        CstRootNode::parse(&source, &ParseOptions::default()).map_err(|_| "无法解析配置")?;
    let property = parsed
        .object_value()
        .and_then(|r| r.get(root_key))
        .and_then(|r| r.object_value())
        .and_then(|r| r.get("fstty"))
        .and_then(|r| r.object_value())
        .and_then(|r| r.get("command"))
        .ok_or("配置结构无效")?;
    if let Some(args) = command.as_array() {
        let values = std::iter::once(next.as_str())
            .chain(args.iter().skip(1).map(|a| a.as_str().unwrap_or("")))
            .map(|s| CstInputValue::String(s.into()))
            .collect();
        if args.iter().any(|a| !a.is_string()) {
            return Err("命令参数格式无效，未修改配置".into());
        }
        property.set_value(CstInputValue::Array(values));
    } else {
        property.set_value(CstInputValue::String(next));
    }
    write_if_changed(path, Some(&source), &parsed.to_string()).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn 修复配置只替换程序路径并保留认证环境和参数() {
        let root = std::env::temp_dir().join(format!("fstty-path-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("config.toml");
        fs::write(&path, "# 用户注释\n[mcp_servers.fstty]\ncommand = 'D:/old/fstty.exe'\nargs = ['--mcp-stdio', '--custom']\n[mcp_servers.fstty.env]\nTEST = '保留'\n[mcp_servers.other]\ncommand = 'other'\n").unwrap();
        repair_toml(&path, &[PathBuf::from("D:/old")], Path::new("D:/new")).unwrap();
        let source = fs::read_to_string(&path).unwrap();
        let document = source.parse::<DocumentMut>().unwrap();
        assert!(source.contains("# 用户注释"));
        assert_eq!(
            document["mcp_servers"]["fstty"]["args"][1].as_str(),
            Some("--custom")
        );
        assert_eq!(
            document["mcp_servers"]["fstty"]["env"]["TEST"].as_str(),
            Some("保留")
        );
        assert_eq!(
            document["mcp_servers"]["other"]["command"].as_str(),
            Some("other")
        );
        assert!(document["mcp_servers"]["fstty"]["command"]
            .as_str()
            .unwrap()
            .replace('\\', "/")
            .contains("D:/new"));
        fs::remove_file(path).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn 只修复匹配命令并保留参数注释和其他服务器() {
        let root = std::env::temp_dir().join(format!("fstty-path-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("mcp.json");
        fs::write(&path, "{ // 用户注释\n\"mcpServers\":{\"fstty\":{\"command\":\"D:/old/fstty.exe\",\"args\":[\"--mcp-stdio\"],\"env\":{\"X\":\"Y\"}},\"other\":{\"command\":\"x\"}}}").unwrap();
        repair_json(
            &path,
            "mcpServers",
            &[PathBuf::from("D:/old")],
            Path::new("D:/new"),
        )
        .unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("用户注释"));
        let value =
            jsonc_parser::parse_to_serde_value::<Value>(&text, &ParseOptions::default()).unwrap();
        assert!(value["mcpServers"]["fstty"]["command"]
            .as_str()
            .unwrap()
            .replace('\\', "/")
            .contains("D:/new"));
        assert_eq!(value["mcpServers"]["fstty"]["args"][0], "--mcp-stdio");
        assert_eq!(value["mcpServers"]["other"]["command"], "x");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn 不修改远程配置或自定义命令() {
        let root = std::env::temp_dir().join(format!("fstty-path-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("mcp.json");
        for source in [
            r#"{"mcpServers":{"fstty":{"url":"http://localhost/mcp","command":"D:/old/fstty.exe"}}}"#,
            r#"{"mcpServers":{"fstty":{"command":"D:/old/fstty.exe --custom"}}}"#,
        ] {
            fs::write(&path, source).unwrap();
            let _ = repair_json(
                &path,
                "mcpServers",
                &[PathBuf::from("D:/old")],
                Path::new("D:/new"),
            );
            assert_eq!(fs::read_to_string(&path).unwrap(), source);
        }
        fs::remove_dir_all(root).unwrap();
    }
}
