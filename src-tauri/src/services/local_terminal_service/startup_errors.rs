// The host has no GUI logger. Carry diagnostics in the existing internal error
// string, then log and remove them at the GUI boundary. No IPC shape changes.
pub(super) const FAILED: &str = "本地终端启动失败。请重试；如仍失败，请查看日志。";
pub(super) const SECURITY: &str = "本地终端安全校验失败，启动已停止。请查看日志。";
pub(super) const PERMISSION: &str =
    "无法取得普通权限。可尝试正常启动 FsTTY 后重试，或右键会话选择“以管理员权限打开”。";
pub(super) const NO_STANDARD_TOKEN: &str =
    "当前环境无法以普通权限启动终端。请右键会话，选择“以管理员权限打开”。";
pub(super) const ADMIN_CANCELLED: &str = "已取消管理员授权，终端未启动。点击“启动”可重试。";
pub(super) const ADMIN_FAILED: &str = "无法请求管理员权限。请重试；如仍失败，请查看日志。";
pub(super) const DIRECTORY: &str =
    "起始目录不存在或无法访问。请编辑会话，选择可用目录，或留空使用用户主目录。";
pub(super) const HOME_DIRECTORY: &str = "无法确定用户主目录。请编辑会话并填写起始目录。";
pub(super) const TIMEOUT: &str = "本地终端启动超时。请重试；如仍失败，请查看日志。";
const DIAGNOSTIC: &str = "\n诊断：";

pub(super) fn diagnostic(message: &str, stage: &str, detail: impl std::fmt::Display) -> String {
    format!("{message}{DIAGNOSTIC}{stage}: {detail}")
}

pub(super) fn failure(stage: &str, detail: impl std::fmt::Display) -> String {
    diagnostic(FAILED, stage, detail)
}

pub(super) fn security(stage: &str, detail: impl std::fmt::Display) -> String {
    diagnostic(SECURITY, stage, detail)
}

pub(super) fn report(message: String) -> String {
    if let Some((summary, detail)) = message.split_once(DIAGNOSTIC) {
        log::warn!("本地终端启动：{detail}");
        summary.to_owned()
    } else {
        message
    }
}

#[cfg(windows)]
pub(super) fn standard_token_failure(
    elevation_type: Result<windows_sys::Win32::Security::TOKEN_ELEVATION_TYPE, std::io::Error>,
    detail: impl std::fmt::Display,
) -> String {
    use windows_sys::Win32::Security::TokenElevationTypeDefault;
    let message = if elevation_type
        .as_ref()
        .is_ok_and(|value| *value == TokenElevationTypeDefault)
    {
        NO_STANDARD_TOKEN
    } else {
        PERMISSION
    };
    diagnostic(
        message,
        "linked-token",
        format!("{detail}; elevation-type={elevation_type:?}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn only_confirmed_default_token_reports_missing_standard_rights() {
        use windows_sys::Win32::Security::{TokenElevationTypeDefault, TokenElevationTypeFull};
        let denied = || std::io::Error::from_raw_os_error(5);
        assert_eq!(
            report(standard_token_failure(
                Ok(TokenElevationTypeDefault),
                denied()
            )),
            NO_STANDARD_TOKEN
        );
        for token_type in [Ok(TokenElevationTypeFull), Err(denied())] {
            assert_eq!(
                report(standard_token_failure(token_type, denied())),
                PERMISSION
            );
        }
        // A linked token that fails validation must never claim no token exists.
        assert_eq!(
            report(diagnostic(PERMISSION, "linked-token-validation", denied())),
            PERMISSION
        );
    }

    #[test]
    fn internal_host_diagnostics_never_reach_the_user_message() {
        let detail = std::io::Error::from_raw_os_error(5);
        let wire = failure("pipe-connect", &detail);
        assert!(wire.contains("pipe-connect"));
        assert!(wire.contains(&detail.to_string()));
        assert_eq!(report(wire), FAILED);
        assert_eq!(report(security("handshake", "nonce mismatch")), SECURITY);
        assert_eq!(report(ADMIN_CANCELLED.into()), ADMIN_CANCELLED);
    }
}
