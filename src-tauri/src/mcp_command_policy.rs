use crate::models::{
    AppError, McpCommandMatchType, McpCommandPolicy, McpCommandPolicyMode, McpCommandRule,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use uuid::Uuid;

pub const MAX_RULES_PER_GROUP: usize = 100;
pub const MAX_TOTAL_RULES: usize = 500;
pub const MAX_PATTERN_BYTES: usize = 4 * 1024;
pub const MAX_TOTAL_PATTERN_BYTES: usize = 128 * 1024;
const POLICY_FILE_VERSION: u8 = 1;
const MAX_POLICY_FILE_BYTES: u64 = 256 * 1024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct McpCommandPolicyDocument {
    version: u8,
    enabled: bool,
    mode: McpCommandPolicyMode,
    rules: Vec<McpCommandRule>,
}

impl From<McpCommandPolicy> for McpCommandPolicyDocument {
    fn from(policy: McpCommandPolicy) -> Self {
        Self {
            version: POLICY_FILE_VERSION,
            enabled: policy.enabled,
            mode: policy.mode,
            rules: policy.rules,
        }
    }
}

impl From<McpCommandPolicyDocument> for McpCommandPolicy {
    fn from(document: McpCommandPolicyDocument) -> Self {
        Self {
            enabled: document.enabled,
            mode: document.mode,
            rules: document.rules,
        }
    }
}

pub fn normalize_policy(mut policy: McpCommandPolicy) -> Result<McpCommandPolicy, AppError> {
    if policy.rules.len() > MAX_RULES_PER_GROUP {
        return Err(AppError::Validation(
            "单个分组的高级命令规则不能超过 100 条".to_owned(),
        ));
    }
    let mut seen = HashSet::with_capacity(policy.rules.len());
    for rule in &mut policy.rules {
        let pattern = rule.pattern.trim();
        if pattern.is_empty()
            || pattern.len() > MAX_PATTERN_BYTES
            || pattern.chars().any(char::is_control)
        {
            return Err(AppError::Validation(
                "高级命令规则为空、过长或包含控制字符".to_owned(),
            ));
        }
        rule.pattern = pattern.to_owned();
        if !seen.insert((rule.match_type, rule.pattern.clone())) {
            return Err(AppError::Validation("高级命令规则重复".to_owned()));
        }
    }
    Ok(policy)
}

pub fn command_allowed(policy: &McpCommandPolicy, command: &str) -> bool {
    if !policy.enabled {
        return true;
    }
    let command = command.trim();
    let matched = policy.rules.iter().any(|rule| match rule.match_type {
        McpCommandMatchType::Exact => command == rule.pattern,
        McpCommandMatchType::Glob => glob_matches(&rule.pattern, command),
    });
    match policy.mode {
        McpCommandPolicyMode::Allow => matched,
        McpCommandPolicyMode::Exclude => !matched,
    }
}

pub fn import_policy(path: &Path) -> Result<McpCommandPolicy, AppError> {
    validate_json_path(path)?;
    let metadata = fs::metadata(path)
        .map_err(|error| AppError::Persistence(format!("无法读取高级命令策略文件：{error}")))?;
    if !metadata.is_file() || metadata.len() > MAX_POLICY_FILE_BYTES {
        return Err(AppError::Validation(
            "高级命令策略文件无效或超过 256 KiB".to_owned(),
        ));
    }
    let content = fs::read(path)
        .map_err(|error| AppError::Persistence(format!("无法读取高级命令策略文件：{error}")))?;
    let document = serde_json::from_slice::<McpCommandPolicyDocument>(&content)
        .map_err(|error| AppError::Validation(format!("高级命令策略 JSON 无效：{error}")))?;
    if document.version != POLICY_FILE_VERSION {
        return Err(AppError::Validation("高级命令策略版本不受支持".to_owned()));
    }
    normalize_policy(document.into())
}

pub fn export_policy(path: &Path, policy: McpCommandPolicy) -> Result<(), AppError> {
    validate_json_path(path)?;
    let policy = normalize_policy(policy)?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| AppError::Validation("高级命令策略导出路径无效".to_owned()))?;
    fs::create_dir_all(parent)
        .map_err(|error| AppError::Persistence(format!("无法创建策略导出目录：{error}")))?;
    let content = serde_json::to_vec_pretty(&McpCommandPolicyDocument::from(policy))
        .map_err(|error| AppError::Internal(format!("无法序列化高级命令策略：{error}")))?;
    let temp_path = parent.join(format!(".fstty-command-policy-{}.tmp", Uuid::new_v4()));
    let result = write_synced(&temp_path, &content).and_then(|_| replace_file(&temp_path, path));
    if result.is_err() {
        let _ = fs::remove_file(temp_path);
    }
    result
}

fn validate_json_path(path: &Path) -> Result<(), AppError> {
    if !path.is_absolute()
        || path.extension().and_then(|value| value.to_str()) != Some("json")
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(AppError::Validation(
            "高级命令策略路径必须是绝对 JSON 文件路径".to_owned(),
        ));
    }
    Ok(())
}

fn write_synced(path: &Path, content: &[u8]) -> Result<(), AppError> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| AppError::Persistence(format!("无法创建策略临时文件：{error}")))?;
    file.write_all(content)
        .and_then(|_| file.sync_all())
        .map_err(|error| AppError::Persistence(format!("无法写入策略临时文件：{error}")))
}

fn replace_file(temp_path: &Path, target_path: &Path) -> Result<(), AppError> {
    let backup_path = target_path.with_extension(format!("json.{}.bak", Uuid::new_v4()));
    let had_target = target_path.exists();
    if had_target {
        fs::rename(target_path, &backup_path)
            .map_err(|error| AppError::Persistence(format!("无法替换策略文件：{error}")))?;
    }
    if let Err(error) = fs::rename(temp_path, target_path) {
        if had_target {
            let _ = fs::rename(&backup_path, target_path);
        }
        return Err(AppError::Persistence(format!("无法提交策略文件：{error}")));
    }
    if had_target {
        let _ = fs::remove_file(backup_path);
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GlobToken {
    Literal(char),
    AnyOne,
    AnyMany,
}

fn glob_matches(pattern: &str, value: &str) -> bool {
    let tokens = glob_tokens(pattern);
    let value = value.chars().collect::<Vec<_>>();
    let (mut token_index, mut value_index) = (0, 0);
    let (mut star_index, mut star_value_index) = (None, 0);
    while value_index < value.len() {
        match tokens.get(token_index) {
            Some(GlobToken::Literal(expected)) if *expected == value[value_index] => {
                token_index += 1;
                value_index += 1;
            }
            Some(GlobToken::AnyOne) => {
                token_index += 1;
                value_index += 1;
            }
            Some(GlobToken::AnyMany) => {
                star_index = Some(token_index);
                token_index += 1;
                star_value_index = value_index;
            }
            _ if star_index.is_some() => {
                star_value_index += 1;
                value_index = star_value_index;
                token_index = star_index.expect("星号索引应存在") + 1;
            }
            _ => return false,
        }
    }
    while matches!(tokens.get(token_index), Some(GlobToken::AnyMany)) {
        token_index += 1;
    }
    token_index == tokens.len()
}

fn glob_tokens(pattern: &str) -> Vec<GlobToken> {
    let mut result = Vec::with_capacity(pattern.chars().count());
    let mut characters = pattern.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '*' => result.push(GlobToken::AnyMany),
            '?' => result.push(GlobToken::AnyOne),
            '\\' if matches!(characters.peek(), Some('*' | '?' | '\\')) => {
                result.push(GlobToken::Literal(
                    characters.next().expect("转义字符应存在"),
                ));
            }
            literal => result.push(GlobToken::Literal(literal)),
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn rule(match_type: McpCommandMatchType, pattern: &str) -> McpCommandRule {
        McpCommandRule {
            match_type,
            pattern: pattern.to_owned(),
        }
    }

    #[test]
    fn 精确匹配区分大小写并忽略首尾空白() {
        let policy = McpCommandPolicy {
            enabled: true,
            mode: McpCommandPolicyMode::Allow,
            rules: vec![rule(McpCommandMatchType::Exact, "pwd")],
        };
        assert!(command_allowed(&policy, "  pwd \n"));
        assert!(!command_allowed(&policy, "PWD"));
    }

    #[test]
    fn 模糊匹配支持通配符转义复合命令和unicode() {
        assert!(glob_matches("echo * && printf ?", "echo 你好 && printf 好"));
        assert!(glob_matches(r"echo \* \? \", r"echo * ? \"));
        assert!(!glob_matches("git ?", "git 状态表"));
        assert!(!glob_matches("git *", "Git status"));
    }

    #[test]
    fn 空规则遵循可用与排除模式语义() {
        let mut policy = McpCommandPolicy {
            enabled: true,
            mode: McpCommandPolicyMode::Allow,
            rules: Vec::new(),
        };
        assert!(!command_allowed(&policy, "pwd"));
        policy.mode = McpCommandPolicyMode::Exclude;
        assert!(command_allowed(&policy, "pwd"));
        policy.enabled = false;
        assert!(command_allowed(&policy, "pwd"));
    }

    #[test]
    fn 规则校验修剪正文并拒绝重复() {
        let normalized = normalize_policy(McpCommandPolicy {
            enabled: true,
            mode: McpCommandPolicyMode::Allow,
            rules: vec![rule(McpCommandMatchType::Exact, " pwd ")],
        })
        .expect("规则应有效");
        assert_eq!(normalized.rules[0].pattern, "pwd");
        assert!(normalize_policy(McpCommandPolicy {
            enabled: true,
            mode: McpCommandPolicyMode::Allow,
            rules: vec![
                rule(McpCommandMatchType::Exact, "pwd"),
                rule(McpCommandMatchType::Exact, " pwd "),
            ],
        })
        .is_err());
    }

    #[test]
    fn json导入导出保留策略且损坏文件不被接受() {
        let directory = std::env::temp_dir().join(format!("fstty-policy-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("应创建测试目录");
        let path = directory.join("policy.json");
        let policy = McpCommandPolicy {
            enabled: true,
            mode: McpCommandPolicyMode::Exclude,
            rules: vec![rule(McpCommandMatchType::Glob, "rm *")],
        };
        export_policy(&path, policy.clone()).expect("应导出策略");
        assert_eq!(import_policy(&path).expect("应导入策略"), policy);

        fs::write(&path, br#"{"version":1,"enabled":true,"mode":"allow","rules":[{"matchType":"exact","pattern":""}]}"#)
            .expect("应写入损坏策略");
        assert!(import_policy(&path).is_err());
        let _ = fs::remove_dir_all(directory);
    }
}
