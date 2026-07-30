use rmcp::{
    model::{CallToolResult, ContentBlock},
    schemars,
};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub(super) const MAX_SEARCH_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct SearchRemoteFileArgs {
    /// FsTTY 会话 ID。
    pub(super) session_id: String,
    /// 要扫描的远程普通文件绝对路径。
    pub(super) path: String,
    /// 查询文本，长度为 1–1024 字节，不能包含换行或控制字符。
    #[schemars(length(min = 1, max = 1024))]
    pub(super) query: String,
    /// 扫描起始字节偏移；启用 tail 时必须为 0。
    #[serde(default)]
    pub(super) offset: u64,
    /// 是否从文件尾部向前取一个扫描窗口。
    #[serde(default)]
    pub(super) tail: bool,
    /// 单次扫描字节数，范围为 1–16 MiB。
    #[serde(default = "default_search_scan_bytes")]
    #[schemars(range(min = 1, max = 16_777_216))]
    pub(super) scan_bytes: usize,
    /// 是否区分查询文本的大小写。
    #[serde(default)]
    pub(super) case_sensitive: bool,
    /// 每个匹配项之前返回的上下文行数，范围为 0–50。
    #[serde(default)]
    #[schemars(range(min = 0, max = 50))]
    pub(super) before_lines: usize,
    /// 每个匹配项之后返回的上下文行数，范围为 0–50。
    #[serde(default)]
    #[schemars(range(min = 0, max = 50))]
    pub(super) after_lines: usize,
    /// 最多返回的匹配项数量，范围为 1–50。
    #[serde(default = "default_search_max_matches")]
    #[schemars(range(min = 1, max = 50))]
    pub(super) max_matches: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteFileSearchMatch {
    pub(super) byte_offset: u64,
    pub(super) line: String,
    pub(super) before: Vec<String>,
    pub(super) after: Vec<String>,
    pub(super) line_truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteFileSearchResult {
    pub(super) matches: Vec<RemoteFileSearchMatch>,
    pub(super) start_offset: u64,
    pub(super) next_offset: u64,
    pub(super) file_size: u64,
    pub(super) scanned_bytes: usize,
    pub(super) end_of_file: bool,
    pub(super) match_limit_reached: bool,
    pub(super) lossy_decoding: bool,
    pub(super) output_truncated: bool,
}

pub(super) struct RemoteFileSearchInput<'a> {
    pub(super) content: &'a [u8],
    pub(super) start_offset: u64,
    pub(super) file_size: u64,
    pub(super) starts_at_line_boundary: bool,
    pub(super) window_reaches_end: bool,
    pub(super) query: &'a str,
    pub(super) case_sensitive: bool,
    pub(super) before_lines: usize,
    pub(super) after_lines: usize,
    pub(super) max_matches: usize,
}

pub(super) fn default_search_scan_bytes() -> usize {
    4 * 1024 * 1024
}

fn default_search_max_matches() -> usize {
    50
}

pub(super) fn validate_search_remote_file_args(
    args: &SearchRemoteFileArgs,
) -> Result<(), &'static str> {
    if args.query.is_empty()
        || args.query.len() > 1_024
        || args.query.chars().any(|character| {
            matches!(character, '\0' | '\r' | '\n') || character.is_control() && character != '\t'
        })
    {
        return Err("查询文本必须为 1 到 1024 字节，且不能包含换行或控制字符");
    }
    if args.scan_bytes == 0 || args.scan_bytes > 16 * 1024 * 1024 {
        return Err("scanBytes 必须在 1 字节到 16 MiB 之间");
    }
    if args.before_lines > 50 || args.after_lines > 50 {
        return Err("beforeLines 和 afterLines 必须在 0 到 50 之间");
    }
    if args.max_matches == 0 || args.max_matches > 50 {
        return Err("maxMatches 必须在 1 到 50 之间");
    }
    Ok(())
}

pub(super) fn search_remote_text(input: RemoteFileSearchInput<'_>) -> RemoteFileSearchResult {
    const MAX_OUTPUT_LINE_CHARS: usize = 2_048;

    let normalized_query = (!input.case_sensitive).then(|| input.query.to_lowercase());
    let mut matches: Vec<RemoteFileSearchMatch> = Vec::new();
    let mut before = VecDeque::with_capacity(input.before_lines);
    let mut pending_after: Vec<(usize, usize)> = Vec::new();
    let mut cursor = 0;
    let mut lossy_decoding = false;
    let mut match_limit_reached = false;

    // 扫描窗口可能从一行中间开始；丢弃残行，避免返回误导性匹配。
    if !input.starts_at_line_boundary {
        match input.content.iter().position(|byte| *byte == b'\n') {
            Some(position) => cursor = position + 1,
            None => {
                return RemoteFileSearchResult {
                    matches,
                    start_offset: input.start_offset,
                    next_offset: input
                        .start_offset
                        .saturating_add(input.content.len() as u64),
                    file_size: input.file_size,
                    scanned_bytes: input.content.len(),
                    end_of_file: input.window_reaches_end,
                    match_limit_reached,
                    lossy_decoding,
                    output_truncated: false,
                };
            }
        }
    }

    while cursor < input.content.len() {
        let remaining = &input.content[cursor..];
        let newline = remaining.iter().position(|byte| *byte == b'\n');
        if newline.is_none() && !input.window_reaches_end {
            break;
        }
        let line_length = newline.unwrap_or(remaining.len());
        let next_cursor = cursor
            .saturating_add(line_length)
            .saturating_add(usize::from(newline.is_some()));
        let mut line_bytes = &input.content[cursor..cursor + line_length];
        if line_bytes.last() == Some(&b'\r') {
            line_bytes = &line_bytes[..line_bytes.len() - 1];
        }
        lossy_decoding |= std::str::from_utf8(line_bytes).is_err();
        let full_line = String::from_utf8_lossy(line_bytes);
        let preview: String = full_line.chars().take(MAX_OUTPUT_LINE_CHARS).collect();
        let line_truncated = full_line.chars().count() > MAX_OUTPUT_LINE_CHARS;

        for (match_index, remaining_lines) in &mut pending_after {
            if *remaining_lines > 0 {
                matches[*match_index].after.push(preview.clone());
                *remaining_lines -= 1;
            }
        }
        pending_after.retain(|(_, remaining_lines)| *remaining_lines > 0);

        if !match_limit_reached {
            let matched = if let Some(normalized_query) = normalized_query.as_deref() {
                full_line.to_lowercase().contains(normalized_query)
            } else {
                full_line.contains(input.query)
            };
            if matched {
                let match_index = matches.len();
                matches.push(RemoteFileSearchMatch {
                    byte_offset: input.start_offset.saturating_add(cursor as u64),
                    line: preview.clone(),
                    before: before.iter().cloned().collect(),
                    after: Vec::with_capacity(input.after_lines),
                    line_truncated,
                });
                if input.after_lines > 0 {
                    pending_after.push((match_index, input.after_lines));
                }
                if matches.len() >= input.max_matches {
                    match_limit_reached = true;
                }
            }
        }

        if input.before_lines > 0 {
            before.push_back(preview);
            while before.len() > input.before_lines {
                before.pop_front();
            }
        }
        cursor = next_cursor;
        if match_limit_reached && pending_after.is_empty() {
            break;
        }
    }

    let next_offset = input.start_offset.saturating_add(cursor as u64);
    RemoteFileSearchResult {
        matches,
        start_offset: input.start_offset,
        next_offset,
        file_size: input.file_size,
        scanned_bytes: cursor,
        end_of_file: next_offset >= input.file_size,
        match_limit_reached,
        lossy_decoding,
        output_truncated: false,
    }
}

pub(super) fn search_json_result(mut result: RemoteFileSearchResult) -> CallToolResult {
    loop {
        let Ok(text) = serde_json::to_string(&result) else {
            return CallToolResult::error(vec![ContentBlock::text(
                "无法序列化远程文件搜索结果".to_owned(),
            )]);
        };
        let response = CallToolResult::success(vec![ContentBlock::text(text)]);
        if serde_json::to_vec(&response).is_ok_and(|bytes| bytes.len() <= MAX_SEARCH_RESPONSE_BYTES)
        {
            return response;
        }

        // 从尾部裁剪完整匹配项，确保续扫偏移始终落在首个未返回的匹配处。
        let Some(removed) = result.matches.pop() else {
            return CallToolResult::error(vec![ContentBlock::text(
                "远程文件搜索结果超过 8 MiB 输出限制".to_owned(),
            )]);
        };
        result.output_truncated = true;
        result.next_offset = removed.byte_offset;
        result.end_of_file = false;
    }
}
