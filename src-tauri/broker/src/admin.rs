use crate::{protocol::*, windows};
use std::ptr::{null, null_mut};
use windows_sys::Win32::{Foundation::*, UI::WindowsAndMessaging::*};
use zeroize::Zeroizing;

pub mod appearance;
mod dialog;
pub use appearance::Theme;
#[cfg(feature = "approval-preview")]
pub mod preview;
unsafe extern "system" fn secret_procedure(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // 阻止跨线程消息和辅助功能读取秘密；本窗口线程提交时仍可读取密码。
    if message == WM_GETOBJECT
        || message == WM_COPY
        || message == WM_CUT
        || (matches!(message, WM_GETTEXT | WM_GETTEXTLENGTH)
            && InSendMessageEx(null()) != ISMEX_NOSEND)
    {
        return 0;
    }
    let original = GetWindowLongPtrW(window, GWLP_USERDATA);
    CallWindowProcW(
        Some(std::mem::transmute::<
            isize,
            unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT,
        >(original)),
        window,
        message,
        wparam,
        lparam,
    )
}

fn clipboard_key(window: HWND) -> crate::Result<Zeroizing<String>> {
    use windows_sys::Win32::System::{DataExchange::*, Memory::*};
    if unsafe { OpenClipboard(window) } == 0 {
        return Err("无法读取剪贴板".into());
    }
    struct Close;
    impl Drop for Close {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }
    let _close = Close;
    let memory = unsafe { GetClipboardData(13) };
    if memory.is_null() {
        return Err("剪贴板不包含文本私钥".into());
    }
    let bytes = unsafe { GlobalSize(memory) };
    if bytes > 2 * (MAX_KEY + 1) {
        return Err("剪贴板私钥过大".into());
    }
    let raw = unsafe { GlobalLock(memory) };
    if raw.is_null() {
        return Err("无法读取剪贴板文本".into());
    }
    let text = unsafe { std::slice::from_raw_parts(raw.cast::<u16>(), bytes / 2) };
    let length = text.iter().position(|&c| c == 0).unwrap_or(text.len());
    let result = String::from_utf16(&text[..length])
        .map(Zeroizing::new)
        .map_err(|_| "私钥文本编码无效".to_owned());
    unsafe {
        GlobalUnlock(memory);
    }
    result
}

fn input(window: HWND, max: usize) -> crate::Result<Zeroizing<String>> {
    let n = unsafe { GetWindowTextLengthW(window) }.max(0) as usize;
    if n > max {
        return Err("输入内容过长".into());
    }
    let mut bytes = Zeroizing::new(vec![0u16; n + 1]);
    let size =
        unsafe { GetWindowTextW(window, bytes.as_mut_ptr(), bytes.len() as i32) }.max(0) as usize;
    Ok(Zeroizing::new(
        String::from_utf16(&bytes[..size]).map_err(|_| "输入编码无效")?,
    ))
}

pub fn manage(ticket: &str) -> crate::Result<()> {
    manage_with_theme(ticket, Theme::system())
}

pub fn manage_with_theme(ticket: &str, theme: Theme) -> crate::Result<()> {
    if !windows::current_identity()?.elevated {
        return Err("请通过 UAC 启动安全管理窗口".into());
    }
    uuid::Uuid::parse_str(ticket).map_err(|_| "确认请求无效")?;
    let rt = tokio::runtime::Runtime::new().map_err(|_| "无法初始化管理工具")?;
    let reviews = match rt.block_on(windows::request(&Request::Review {
        ticket: ticket.into(),
    }))? {
        Response::Review { review } => vec![*review],
        Response::BatchReview { reviews }
            if !reviews.is_empty() && reviews.iter().all(|r| !r.needs_secret) =>
        {
            reviews
        }
        _ => return Err("审批响应无效".into()),
    };
    let secrets = dialog::show(reviews, theme)?;
    match rt.block_on(windows::request(&Request::Approve {
        ticket: ticket.into(),
        secrets,
    }))? {
        Response::Complete => Ok(()),
        _ => Err("审批未完成".into()),
    }
}
pub fn repair() -> crate::Result<()> {
    if !windows::current_identity()?.elevated {
        return Err("修复服务需要管理员权限".into());
    }
    let message = windows::wide(&format!(
        "将重新注册并启动 FsTTYBroker 服务。\n\n账号：NT SERVICE\\FsTTYBroker\n程序：{}\n数据：{}\n\n已有受保护凭据保留。确认修复？",
        windows::installed_exe()?.display(), windows::data_dir()?.display()
    ));
    if unsafe {
        MessageBoxW(
            null_mut(),
            message.as_ptr(),
            windows::wide("FsTTY 凭据服务修复").as_ptr(),
            MB_OKCANCEL | MB_ICONWARNING | MB_DEFBUTTON2,
        )
    } != IDOK
    {
        return Err("已取消服务修复".into());
    }
    windows::install()
}

pub fn show_error(message: &str) {
    unsafe {
        MessageBoxW(
            null_mut(),
            windows::wide(message).as_ptr(),
            windows::wide("FsTTY 凭据服务").as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}
