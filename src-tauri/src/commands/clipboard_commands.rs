use crate::models::{AppError, ClipboardContentKind};

fn classify_clipboard_content(
    format_count: Option<usize>,
    has_text: bool,
) -> Result<ClipboardContentKind, AppError> {
    match format_count {
        None => Err(AppError::Internal("无法检查 Windows 剪贴板格式".to_owned())),
        Some(0) => Ok(ClipboardContentKind::Empty),
        Some(_) if has_text => Ok(ClipboardContentKind::Text),
        Some(_) => Ok(ClipboardContentKind::NonText),
    }
}

#[tauri::command]
pub fn get_system_clipboard_content_kind() -> Result<ClipboardContentKind, AppError> {
    #[cfg(target_os = "windows")]
    {
        use clipboard_win::formats::{Format, Unicode};

        // Tauri 文本读取会把空剪贴板和非文本统一为失败；先检查格式，才能给出准确提示。
        classify_clipboard_content(clipboard_win::count_formats(), Unicode.is_format_avail())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(ClipboardContentKind::Text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_empty_clipboard() {
        assert_eq!(
            classify_clipboard_content(Some(0), false).expect("空剪贴板应能分类"),
            ClipboardContentKind::Empty
        );
    }

    #[test]
    fn classifies_text_clipboard() {
        assert_eq!(
            classify_clipboard_content(Some(2), true).expect("文本剪贴板应能分类"),
            ClipboardContentKind::Text
        );
    }

    #[test]
    fn classifies_non_text_clipboard() {
        assert_eq!(
            classify_clipboard_content(Some(3), false).expect("非文本剪贴板应能分类"),
            ClipboardContentKind::NonText
        );
    }

    #[test]
    fn rejects_format_query_failure() {
        assert!(matches!(
            classify_clipboard_content(None, false),
            Err(AppError::Internal(_))
        ));
    }
}
