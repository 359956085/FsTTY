use crate::models::{
    AppError, AppUpdateInfo, AppUpdateProgress, AppUpdateSource, UpdateSourcePreference,
};
use semver::Version;
use std::future::Future;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{ipc::Channel, AppHandle};
use tauri_plugin_updater::{Update, UpdaterExt};
use time::format_description::well_known::Rfc3339;
use tokio::sync::Mutex;
use url::Url;

const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const CNB_UPDATE_ENDPOINT: &str =
    "https://cnb.cool/359956085/FsTTY/-/releases/download/updater/latest.json";
const GITHUB_UPDATE_ENDPOINT: &str =
    "https://github.com/359956085/FsTTY/releases/latest/download/latest.json";

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
        let proxy = parse_proxy(proxy)?;
        self.close().await;

        let (source, update) = match preference {
            UpdateSourcePreference::Auto => {
                // 自动模式优先响应速度；首个有效成功结果立即决定，失败才等待备用源。
                first_successful_source(
                    check_source(
                        app,
                        AppUpdateSource::Cnb,
                        CNB_UPDATE_ENDPOINT,
                        proxy.clone(),
                    ),
                    check_source(app, AppUpdateSource::GitHub, GITHUB_UPDATE_ENDPOINT, proxy),
                )
                .await?
            }
            UpdateSourcePreference::GitHub => (
                AppUpdateSource::GitHub,
                check_source(app, AppUpdateSource::GitHub, GITHUB_UPDATE_ENDPOINT, proxy)
                    .await
                    .map_err(AppError::Connection)?,
            ),
            UpdateSourcePreference::Cnb => (
                AppUpdateSource::Cnb,
                check_source(app, AppUpdateSource::Cnb, CNB_UPDATE_ENDPOINT, proxy)
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
        let mut started = false;
        #[cfg(not(windows))]
        let result = pending
            .update
            .download_and_install(
                |chunk_bytes, total_bytes| {
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
            .map_err(|_| {
                AppError::Internal(
                    "下载或安装应用更新失败，请检查网络、代理、证书及更新签名".into(),
                )
            });
        #[cfg(windows)]
        let result = async {
            let bytes = pending
                .update
                .download(
                    |chunk_bytes, total_bytes| {
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
                .map_err(|_| {
                    AppError::Internal("下载应用更新失败，请检查网络、代理、证书及更新签名".into())
                })?;
            let ticket = fstty_broker::update::stage(&bytes, pending.update.signature.clone())
                .await
                .map_err(AppError::Internal)?;
            tokio::task::spawn_blocking(move || fstty_broker::windows::elevate_update(&ticket))
                .await
                .map_err(|_| AppError::Internal("安全更新窗口启动失败".into()))?
                .map_err(AppError::Internal)?;
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
    let update = builder
        .build()
        .map_err(|error| format!("{source:?} 更新器创建失败：{error}"))?
        .check()
        .await
        .map_err(|_| format!("{source:?} 更新检查失败，请检查网络、代理认证及证书"))?;
    if let Some(update) = &update {
        Version::parse(update.version.trim_start_matches('v'))
            .map_err(|error| format!("{source:?} 更新版本 {} 无效：{error}", update.version))?;
    }
    Ok(update)
}

async fn first_successful_source<T, CnbFuture, GitHubFuture>(
    cnb: CnbFuture,
    github: GitHubFuture,
) -> Result<(AppUpdateSource, T), AppError>
where
    CnbFuture: Future<Output = Result<T, String>>,
    GitHubFuture: Future<Output = Result<T, String>>,
{
    tokio::pin!(cnb);
    tokio::pin!(github);
    let (first_source, first_result) = tokio::select! {
        result = &mut cnb => (AppUpdateSource::Cnb, result),
        result = &mut github => (AppUpdateSource::GitHub, result),
    };
    match first_result {
        Ok(value) => Ok((first_source, value)),
        Err(first_error) => {
            log::warn!("应用更新源检查失败：{first_error}");
            let (second_source, second_result) = match first_source {
                AppUpdateSource::Cnb => (AppUpdateSource::GitHub, github.await),
                AppUpdateSource::GitHub => (AppUpdateSource::Cnb, cnb.await),
            };
            match second_result {
                Ok(value) => Ok((second_source, value)),
                Err(second_error) => {
                    log::warn!("应用更新源检查失败：{second_error}");
                    Err(AppError::Connection(format!(
                        "所有应用更新源均不可用：{first_error}；{second_error}"
                    )))
                }
            }
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
    async fn 自动模式采用首个成功结果且不等待另一源() {
        let result = tokio::time::timeout(
            Duration::from_millis(50),
            first_successful_source(
                std::future::ready(Ok::<Option<u8>, String>(None)),
                std::future::pending::<Result<Option<u8>, String>>(),
            ),
        )
        .await
        .expect("最快成功源应立即返回")
        .expect("成功结果应保留");
        assert_eq!(result, (AppUpdateSource::Cnb, None));
    }

    #[tokio::test]
    async fn 自动模式首源失败后采用备用源() {
        let result = first_successful_source(
            std::future::ready(Err::<Option<u8>, String>("CNB 失败".to_owned())),
            std::future::ready(Ok::<Option<u8>, String>(Some(7))),
        )
        .await
        .expect("备用源成功时检查应成功");
        assert_eq!(result, (AppUpdateSource::GitHub, Some(7)));
    }

    #[tokio::test]
    async fn 自动模式双源失败返回合并错误() {
        let error = first_successful_source(
            std::future::ready(Err::<Option<u8>, String>("CNB 失败".to_owned())),
            std::future::ready(Err::<Option<u8>, String>("GitHub 失败".to_owned())),
        )
        .await
        .expect_err("双源失败必须报错");
        let message = error.to_string();
        assert!(message.contains("CNB 失败"));
        assert!(message.contains("GitHub 失败"));
    }

    #[test]
    fn 代理只允许受支持协议() {
        assert!(parse_proxy("").expect("空代理应有效").is_none());
        assert!(parse_proxy("socks5://127.0.0.1:1080")
            .expect("SOCKS5 代理应有效")
            .is_some());
        assert!(parse_proxy("ftp://127.0.0.1").is_err());
    }
}
