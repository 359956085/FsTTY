use crate::models::{
    AppError, AppUpdateInfo, AppUpdateProgress, AppUpdateSource, UpdateSourcePreference,
};
use semver::Version;
use std::future::Future;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, AppHandle};
use tauri_plugin_updater::{Update, UpdaterExt};
use time::format_description::well_known::Rfc3339;
use tokio::sync::Mutex;
use url::Url;

const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const AUTO_GITHUB_PRIORITY: Duration = Duration::from_secs(2);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MIRROR_UPDATE_ENDPOINT: &str = "https://f.qkw.io/fstty/updater/latest.json";
const GITHUB_UPDATE_ENDPOINT: &str =
    "https://github.com/359956085/FsTTY/releases/latest/download/latest.json";

struct UpdateAudit {
    operation_id: String,
    started: Instant,
    token_mode: &'static str,
    downloaded_bytes: AtomicU64,
    total_bytes: AtomicU64,
}

impl UpdateAudit {
    fn new() -> Self {
        Self {
            operation_id: uuid::Uuid::new_v4().to_string(),
            started: Instant::now(),
            token_mode: current_token_mode(),
            downloaded_bytes: AtomicU64::new(0),
            total_bytes: AtomicU64::new(0),
        }
    }

    fn add_chunk(&self, bytes: u64, total: Option<u64>) {
        self.downloaded_bytes.fetch_add(bytes, Ordering::Relaxed);
        if let Some(total) = total {
            self.total_bytes.store(total, Ordering::Relaxed);
        }
    }
}

fn log_update_event(
    audit: &UpdateAudit,
    phase: &str,
    source: &str,
    target_version: &str,
    result: &str,
    code: &str,
    detail: Option<&str>,
) {
    let detail = detail.map(sanitize_update_detail).unwrap_or_default();
    log::info!(
        "应用更新：operation_id={} source={} target_version={} phase={} elapsed_ms={} downloaded_bytes={} total_bytes={} token_mode={} result={} code={} detail={}",
        audit.operation_id,
        source,
        target_version,
        phase,
        audit.started.elapsed().as_millis(),
        audit.downloaded_bytes.load(Ordering::Relaxed),
        audit.total_bytes.load(Ordering::Relaxed),
        audit.token_mode,
        result,
        code,
        detail,
    );
}

#[cfg(windows)]
fn current_token_mode() -> &'static str {
    fstty_broker::installation::caller_context(std::process::id())
        .map(|context| context.mode.as_str())
        .unwrap_or("unknown")
}

#[cfg(not(windows))]
fn current_token_mode() -> &'static str {
    "standard"
}

fn sanitize_update_detail(value: &str) -> String {
    let mut output = String::with_capacity(value.len().min(1024));
    let mut rest = value;
    while let Some(index) = rest.find("S-1-") {
        output.push_str(&rest[..index]);
        output.push_str("<sid>");
        let sid = &rest[index..];
        let length = sid
            .char_indices()
            .take_while(|(_, character)| {
                character.is_ascii_digit() || *character == '-' || *character == 'S'
            })
            .map(|(index, character)| index + character.len_utf8())
            .last()
            .unwrap_or(4);
        rest = &sid[length..];
    }
    output.push_str(rest);
    let mut search_from = 0;
    while let Some(relative) = output[search_from..].find("://") {
        let scheme_end = search_from + relative + 3;
        let authority_end = output[scheme_end..]
            .find(|character: char| {
                character.is_whitespace() || matches!(character, '/' | '?' | '#')
            })
            .map(|offset| scheme_end + offset)
            .unwrap_or(output.len());
        let Some(at) = output[scheme_end..authority_end].rfind('@') else {
            search_from = authority_end.min(output.len());
            if search_from == output.len() {
                break;
            }
            continue;
        };
        output.replace_range(scheme_end..scheme_end + at, "<redacted>");
        search_from = scheme_end + "<redacted>@".len();
    }
    output
        .replace(['\r', '\n', '\t'], " ")
        .chars()
        .take(1024)
        .collect()
}

fn source_name(source: AppUpdateSource) -> &'static str {
    match source {
        AppUpdateSource::Mirror => "mirror",
        AppUpdateSource::GitHub => "github",
    }
}

fn preference_name(preference: UpdateSourcePreference) -> &'static str {
    match preference {
        UpdateSourcePreference::Auto => "auto",
        UpdateSourcePreference::GitHub => "github",
        UpdateSourcePreference::Mirror => "mirror",
    }
}

fn message_code(message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if lower.contains("timeout") || message.contains("超时") {
        "timeout"
    } else if lower.contains("proxy") || message.contains("代理") || lower.contains("407") {
        "proxy"
    } else if message.contains("签名") || lower.contains("signature") || lower.contains("minisign")
    {
        "signature"
    } else if message.contains("管理员授权") || message.contains("UAC") {
        "uac_cancelled"
    } else if message.contains("更新已取消") {
        "update_cancelled"
    } else if message.contains("调用进程已退出") {
        "caller_exited"
    } else if message.contains("调用者") || message.contains("身份") || message.contains("令牌")
    {
        "caller_identity"
    } else if message.contains("回滚") || message.contains("恢复") {
        "rollback"
    } else if message.contains("部署") || message.contains("安装") {
        "deploy"
    } else if message.contains("网络") || lower.contains("network") || lower.contains("connect") {
        "network"
    } else {
        "unexpected"
    }
}

fn updater_error_code(error: &tauri_plugin_updater::Error) -> &'static str {
    match error {
        tauri_plugin_updater::Error::Minisign(_)
        | tauri_plugin_updater::Error::Base64(_)
        | tauri_plugin_updater::Error::SignatureUtf8(_) => "signature",
        tauri_plugin_updater::Error::Reqwest(error) if error.is_timeout() => "timeout",
        tauri_plugin_updater::Error::Reqwest(error) if is_proxy_error(&error.to_string()) => {
            "proxy"
        }
        tauri_plugin_updater::Error::Network(error) if is_proxy_error(&error.to_string()) => {
            "proxy"
        }
        tauri_plugin_updater::Error::Reqwest(_) | tauri_plugin_updater::Error::Network(_) => {
            "network"
        }
        _ => "unexpected",
    }
}

fn is_proxy_error(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("proxy")
        || lower.contains("407")
        || lower.contains("tunnel")
        || lower.contains("authentication required")
}

fn updater_error_message(code: &str, checking: bool) -> &'static str {
    match (code, checking) {
        ("timeout", true) => "检查应用更新超时，请重试或切换下载源",
        ("timeout", false) => "下载应用更新超时，请重试或切换下载源",
        ("proxy", true) => "无法通过代理检查更新，请检查代理地址和认证",
        ("proxy", false) => "无法通过代理下载更新，请检查代理地址和认证",
        ("network", true) => "检查应用更新失败，请检查网络和证书",
        ("network", false) => "下载应用更新失败，请检查网络和证书",
        ("signature", _) => "更新包签名验证失败，请从官方发布页手动安装最新版",
        (_, true) => "检查应用更新失败，请重试或切换下载源",
        _ => "下载或校验应用更新失败，请重试或切换下载源",
    }
}

fn broker_update_error(error: &str) -> AppError {
    let message = match message_code(error) {
        "uac_cancelled" => "已取消管理员授权，应用更新未安装",
        "update_cancelled" => "应用更新已取消",
        "caller_exited" => "更新调用进程已退出，请重新检查更新",
        "caller_identity" => "更新调用者身份已变化，请重新检查更新",
        "signature" => "更新包签名验证失败，请从官方发布页重新下载",
        "rollback" => "更新部署和自动恢复均未完成，请查看后台安装日志",
        "deploy" => "更新部署失败，旧版本已保留或恢复，请查看后台安装日志",
        "timeout" => "应用更新操作超时，请重试",
        _ => "应用更新未完成，请查看后台日志后重试",
    };
    AppError::Internal(message.into())
}

#[derive(Clone)]
struct PendingAppUpdate {
    source: AppUpdateSource,
    update: Update,
}

#[derive(Clone, Default)]
pub struct AppUpdateService {
    pending: Arc<Mutex<Option<PendingAppUpdate>>>,
    installing: Arc<AtomicBool>,
}

impl AppUpdateService {
    pub async fn check(
        &self,
        app: &AppHandle,
        proxy: &str,
        preference: UpdateSourcePreference,
    ) -> Result<Option<AppUpdateInfo>, AppError> {
        let audit = UpdateAudit::new();
        let requested_source = preference_name(preference);
        log_update_event(
            &audit,
            "check_start",
            requested_source,
            "unknown",
            "started",
            "pending",
            None,
        );
        let result = self.check_inner(app, proxy, preference, &audit).await;
        match &result {
            Ok(Some(info)) => log_update_event(
                &audit,
                "check_complete",
                source_name(info.source),
                &info.version,
                "success",
                "update_available",
                None,
            ),
            Ok(None) => log_update_event(
                &audit,
                "check_complete",
                requested_source,
                env!("CARGO_PKG_VERSION"),
                "success",
                "up_to_date",
                None,
            ),
            Err(error) => log_update_event(
                &audit,
                "check_complete",
                requested_source,
                "unknown",
                "failure",
                message_code(&error.to_string()),
                Some(&error.to_string()),
            ),
        }
        result
    }

    async fn check_inner(
        &self,
        app: &AppHandle,
        proxy: &str,
        preference: UpdateSourcePreference,
        audit: &UpdateAudit,
    ) -> Result<Option<AppUpdateInfo>, AppError> {
        let proxy = parse_proxy(proxy)?;
        self.close().await;

        let (source, update) = match preference {
            UpdateSourcePreference::Auto => {
                // GitHub 检查成功即采用该源；仅在失败或超时时检查官方镜像。
                github_first_source(
                    check_source(
                        app,
                        AppUpdateSource::GitHub,
                        GITHUB_UPDATE_ENDPOINT,
                        proxy.clone(),
                        audit,
                    ),
                    check_source(
                        app,
                        AppUpdateSource::Mirror,
                        MIRROR_UPDATE_ENDPOINT,
                        proxy,
                        audit,
                    ),
                    AUTO_GITHUB_PRIORITY,
                )
                .await?
            }
            UpdateSourcePreference::GitHub => (
                AppUpdateSource::GitHub,
                check_source(
                    app,
                    AppUpdateSource::GitHub,
                    GITHUB_UPDATE_ENDPOINT,
                    proxy,
                    audit,
                )
                .await
                .map_err(AppError::Connection)?,
            ),
            UpdateSourcePreference::Mirror => (
                AppUpdateSource::Mirror,
                check_source(
                    app,
                    AppUpdateSource::Mirror,
                    MIRROR_UPDATE_ENDPOINT,
                    proxy,
                    audit,
                )
                .await
                .map_err(AppError::Connection)?,
            ),
        };

        let Some(update) = update else {
            return Ok(None);
        };
        let selected = PendingAppUpdate { source, update };
        let info = update_info(&selected);
        *self.pending.lock().await = Some(selected);
        Ok(Some(info))
    }

    pub async fn install(
        &self,
        on_progress: Channel<AppUpdateProgress>,
        proxy: &str,
    ) -> Result<(), AppError> {
        let audit = UpdateAudit::new();
        let metadata = self
            .pending
            .lock()
            .await
            .as_ref()
            .map(|pending| (source_name(pending.source), pending.update.version.clone()));
        let (source, target_version) = metadata
            .as_ref()
            .map(|(source, version)| (*source, version.as_str()))
            .unwrap_or(("unknown", "unknown"));
        log_update_event(
            &audit,
            "install_start",
            source,
            target_version,
            "started",
            "pending",
            None,
        );
        let result = self.install_inner(on_progress, proxy, &audit).await;
        match &result {
            Ok(()) => log_update_event(
                &audit,
                "install_handoff",
                source,
                target_version,
                "success",
                "installer_started",
                None,
            ),
            Err(error) => log_update_event(
                &audit,
                "install_complete",
                source,
                target_version,
                "failure",
                message_code(&error.to_string()),
                Some(&error.to_string()),
            ),
        }
        result
    }

    async fn install_inner(
        &self,
        on_progress: Channel<AppUpdateProgress>,
        proxy: &str,
        audit: &UpdateAudit,
    ) -> Result<(), AppError> {
        let proxy = parse_proxy(proxy)?;
        #[cfg(windows)]
        fstty_broker::installation::check_desktop(
            &std::env::current_exe().map_err(|_| AppError::Internal("无法定位当前程序".into()))?,
        )
        .map_err(AppError::Internal)?;
        if self.installing.swap(true, Ordering::AcqRel) {
            return Err(AppError::Busy("应用更新正在安装".to_owned()));
        }
        let pending = self
            .pending
            .lock()
            .await
            .clone()
            .ok_or_else(|| AppError::NotFound("没有待安装的应用更新".to_owned()));
        let mut pending = match pending {
            Ok(pending) => pending,
            Err(error) => {
                self.installing.store(false, Ordering::Release);
                return Err(error);
            }
        };

        // 下载使用开始时的配置快照，不沿用检查更新时的旧代理，也不改变进行中的下载。
        apply_download_proxy(&mut pending.update, proxy);
        let source = pending.source;
        let target_version = pending.update.version.clone();
        log_update_event(
            audit,
            "download",
            source_name(source),
            &target_version,
            "started",
            "pending",
            None,
        );
        let mut started = false;
        #[cfg(not(windows))]
        let result = pending
            .update
            .download_and_install(
                |chunk_bytes, total_bytes| {
                    audit.add_chunk(chunk_bytes as u64, total_bytes);
                    if !started {
                        started = true;
                        let _ = on_progress.send(AppUpdateProgress::Started { total_bytes });
                    }
                    let _ = on_progress.send(AppUpdateProgress::Progress {
                        chunk_bytes: chunk_bytes as u64,
                    });
                },
                || {
                    let _ = on_progress.send(AppUpdateProgress::Finished);
                },
            )
            .await
            .map_err(|error| download_error(audit, source, &target_version, &error));
        #[cfg(windows)]
        let result = async {
            let bytes = pending
                .update
                .download(
                    |chunk_bytes, total_bytes| {
                        audit.add_chunk(chunk_bytes as u64, total_bytes);
                        if !started {
                            started = true;
                            let _ = on_progress.send(AppUpdateProgress::Started { total_bytes });
                        }
                        let _ = on_progress.send(AppUpdateProgress::Progress {
                            chunk_bytes: chunk_bytes as u64,
                        });
                    },
                    || {},
                )
                .await
                .map_err(|error| download_error(audit, source, &target_version, &error))?;
            audit
                .downloaded_bytes
                .store(bytes.len() as u64, Ordering::Relaxed);
            log_update_event(
                audit,
                "download",
                source_name(source),
                &target_version,
                "success",
                "downloaded",
                None,
            );
            let ticket =
                match fstty_broker::update::stage(&bytes, pending.update.signature.clone()).await {
                    Ok(ticket) => ticket,
                    Err(error) => {
                        log_update_event(
                            audit,
                            "stage",
                            source_name(source),
                            &target_version,
                            "failure",
                            message_code(&error),
                            Some(&error),
                        );
                        return Err(broker_update_error(&error));
                    }
                };
            log_update_event(
                audit,
                "stage",
                source_name(source),
                &target_version,
                "success",
                "staged",
                None,
            );
            let elevation = match tokio::task::spawn_blocking(move || {
                fstty_broker::windows::elevate_update(&ticket)
            })
            .await
            {
                Ok(elevation) => elevation,
                Err(_) => {
                    let error = "安全更新窗口启动失败";
                    log_update_event(
                        audit,
                        "elevate",
                        source_name(source),
                        &target_version,
                        "failure",
                        "elevation_start_failed",
                        Some(error),
                    );
                    return Err(AppError::Internal(error.into()));
                }
            };
            if let Err(error) = elevation {
                log_update_event(
                    audit,
                    "elevate",
                    source_name(source),
                    &target_version,
                    "failure",
                    message_code(&error),
                    Some(&error),
                );
                return Err(broker_update_error(&error));
            }
            log_update_event(
                audit,
                "elevate",
                source_name(source),
                &target_version,
                "success",
                "approved",
                None,
            );
            let _ = on_progress.send(AppUpdateProgress::Finished);
            Ok::<(), AppError>(())
        }
        .await;
        self.installing.store(false, Ordering::Release);
        result?;
        self.close().await;
        Ok(())
    }

    pub fn is_installing(&self) -> bool {
        self.installing.load(Ordering::Acquire)
    }

    pub async fn close(&self) {
        self.pending.lock().await.take();
    }
}

fn apply_download_proxy(update: &mut Update, proxy: Option<Url>) {
    update.no_proxy = proxy.is_none();
    update.proxy = proxy;
}

async fn check_source<R: tauri::Runtime>(
    app: &AppHandle<R>,
    source: AppUpdateSource,
    endpoint: &str,
    proxy: Option<Url>,
    audit: &UpdateAudit,
) -> Result<Option<Update>, String> {
    let endpoint = endpoint
        .parse()
        .map_err(|error| format!("{source:?} 更新地址无效：{error}"))?;
    let mut builder = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| format!("{source:?} 更新器配置失败：{error}"))?
        .timeout(CHECK_TIMEOUT);
    if let Some(proxy) = proxy {
        builder = builder.proxy(proxy);
    } else {
        builder = builder.no_proxy();
    }
    let mut update = match builder
        .build()
        .map_err(|error| format!("{source:?} 更新器创建失败：{error}"))?
        .check()
        .await
    {
        Ok(update) => update,
        Err(error) => {
            let code = updater_error_code(&error);
            let detail = if code == "signature" {
                "signature verification failed".to_owned()
            } else {
                error.to_string()
            };
            log_update_event(
                audit,
                "source_check",
                source_name(source),
                "unknown",
                "failure",
                code,
                Some(&detail),
            );
            return Err(format!("{source:?} {}", updater_error_message(code, true)));
        }
    };
    if let Some(update) = &mut update {
        // 检查请求应快速失败，安装包下载则必须允许慢速网络完成。
        update.timeout = Some(DOWNLOAD_TIMEOUT);
        Version::parse(update.version.trim_start_matches('v'))
            .map_err(|error| format!("{source:?} 更新版本 {} 无效：{error}", update.version))?;
    }
    log_update_event(
        audit,
        "source_check",
        source_name(source),
        update
            .as_ref()
            .map(|update| update.version.as_str())
            .unwrap_or(env!("CARGO_PKG_VERSION")),
        "success",
        if update.is_some() {
            "update_available"
        } else {
            "up_to_date"
        },
        None,
    );
    Ok(update)
}

fn download_error(
    audit: &UpdateAudit,
    source: AppUpdateSource,
    target_version: &str,
    error: &tauri_plugin_updater::Error,
) -> AppError {
    let code = updater_error_code(error);
    let detail = if code == "signature" {
        "signature verification failed".to_owned()
    } else {
        error.to_string()
    };
    log_update_event(
        audit,
        "download",
        source_name(source),
        target_version,
        "failure",
        code,
        Some(&detail),
    );
    AppError::Internal(updater_error_message(code, false).into())
}

async fn github_first_source<T, GitHubFuture, MirrorFuture>(
    github: GitHubFuture,
    mirror: MirrorFuture,
    priority_timeout: Duration,
) -> Result<(AppUpdateSource, T), AppError>
where
    GitHubFuture: Future<Output = Result<T, String>>,
    MirrorFuture: Future<Output = Result<T, String>>,
{
    let github_error = match tokio::time::timeout(priority_timeout, github).await {
        Ok(Ok(value)) => return Ok((AppUpdateSource::GitHub, value)),
        Ok(Err(error)) => error,
        Err(_) => "GitHub 更新检查超时".to_owned(),
    };
    log::warn!("应用更新源检查失败：{github_error}");
    match mirror.await {
        Ok(value) => Ok((AppUpdateSource::Mirror, value)),
        Err(mirror_error) => {
            log::warn!("应用更新源检查失败：{mirror_error}");
            Err(AppError::Connection(format!(
                "所有应用更新源均不可用：{github_error}；{mirror_error}"
            )))
        }
    }
}

fn update_info(pending: &PendingAppUpdate) -> AppUpdateInfo {
    AppUpdateInfo {
        body: pending.update.body.clone(),
        date: pending
            .update
            .date
            .and_then(|date| date.format(&Rfc3339).ok()),
        source: pending.source,
        version: pending.update.version.clone(),
    }
}

fn parse_proxy(proxy: &str) -> Result<Option<Url>, AppError> {
    let mut proxy = fstty_network::parse_proxy(proxy).map_err(AppError::Validation)?;
    if let Some(url) = &mut proxy {
        if url.scheme() == "socks5" {
            // 更新请求与 SSH 一样由代理解析目标域名，避免本机 DNS 绕过代理。
            url.set_scheme("socks5h")
                .map_err(|_| AppError::Validation("SOCKS5 代理地址无效".into()))?;
        }
    }
    Ok(proxy)
}

#[cfg(test)]
#[path = "app_update_service/proxy_tests.rs"]
mod proxy_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn 自动模式采用github更新且不等待镜像() {
        let result = tokio::time::timeout(
            Duration::from_millis(50),
            github_first_source(
                std::future::ready(Ok::<Option<u8>, String>(Some(7))),
                std::future::pending::<Result<Option<u8>, String>>(),
                AUTO_GITHUB_PRIORITY,
            ),
        )
        .await
        .expect("GitHub 成功后应立即返回")
        .expect("成功结果应保留");
        assert_eq!(result, (AppUpdateSource::GitHub, Some(7)));
    }

    #[tokio::test]
    async fn 自动模式github无更新也不检查镜像() {
        let result = github_first_source(
            std::future::ready(Ok::<Option<u8>, String>(None)),
            std::future::pending::<Result<Option<u8>, String>>(),
            AUTO_GITHUB_PRIORITY,
        )
        .await
        .expect("GitHub 无更新也是有效检查结果");
        assert_eq!(result, (AppUpdateSource::GitHub, None));
    }

    #[tokio::test]
    async fn 自动模式github失败后采用镜像() {
        let result = github_first_source(
            std::future::ready(Err::<Option<u8>, String>("GitHub 失败".to_owned())),
            std::future::ready(Ok::<Option<u8>, String>(Some(7))),
            AUTO_GITHUB_PRIORITY,
        )
        .await
        .expect("镜像成功时检查应成功");
        assert_eq!(result, (AppUpdateSource::Mirror, Some(7)));
    }

    #[tokio::test]
    async fn 自动模式github超时后采用镜像() {
        let result = github_first_source(
            std::future::pending::<Result<Option<u8>, String>>(),
            std::future::ready(Ok::<Option<u8>, String>(Some(7))),
            Duration::from_millis(10),
        )
        .await
        .expect("GitHub 超时后应采用镜像");
        assert_eq!(result, (AppUpdateSource::Mirror, Some(7)));
    }

    #[tokio::test]
    async fn 自动模式双源失败返回合并错误() {
        let error = github_first_source(
            std::future::ready(Err::<Option<u8>, String>("GitHub 失败".to_owned())),
            std::future::ready(Err::<Option<u8>, String>("镜像失败".to_owned())),
            AUTO_GITHUB_PRIORITY,
        )
        .await
        .expect_err("双源失败必须报错");
        let message = error.to_string();
        assert!(message.contains("GitHub 失败"));
        assert!(message.contains("镜像失败"));
    }

    #[test]
    fn 代理只允许受支持协议() {
        assert!(parse_proxy("").expect("空代理应有效").is_none());
        assert!(parse_proxy("socks5://127.0.0.1:1080")
            .expect("SOCKS5 代理应有效")
            .is_some());
        assert!(parse_proxy("ftp://127.0.0.1").is_err());
    }

    #[test]
    fn 更新错误分类区分代理授权与管理员取消() {
        assert!(is_proxy_error("407 Proxy Authentication Required"));
        assert_eq!(message_code("已取消管理员授权"), "uac_cancelled");
        assert_eq!(message_code("应用更新已取消"), "update_cancelled");
        assert_eq!(message_code("更新调用进程已退出"), "caller_exited");
        assert_eq!(message_code("更新包签名验证失败"), "signature");
        assert_eq!(message_code("自动恢复失败"), "rollback");
    }

    #[test]
    fn 更新日志脱敏代理凭据和完整_sid() {
        let detail = sanitize_update_detail(
            "https://user:secret@proxy.example/a owner=S-1-5-21-123-456-789-1001",
        );
        assert!(!detail.contains("user:secret"));
        assert!(!detail.contains("S-1-5-21"));
        assert!(detail.contains("<redacted>@proxy.example"));
        assert!(detail.contains("<sid>"));
    }
}
