use crate::models::{
    AppError, AppUpdateInfo, AppUpdateProgress, AppUpdateSource, UpdateSourcePreference,
};
use semver::Version;
use std::future::Future;
use std::sync::Arc;
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

    pub async fn install(&self, on_progress: Channel<AppUpdateProgress>) -> Result<(), AppError> {
        let pending = self
            .pending
            .lock()
            .await
            .clone()
            .ok_or_else(|| AppError::NotFound("没有待安装的应用更新".to_owned()))?;

        let mut started = false;
        pending
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
            .map_err(|error| AppError::Internal(format!("下载或安装应用更新失败：{error}")))?;
        self.close().await;
        Ok(())
    }

    pub async fn close(&self) {
        self.pending.lock().await.take();
    }
}

async fn check_source(
    app: &AppHandle,
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
    }
    let update = builder
        .build()
        .map_err(|error| format!("{source:?} 更新器创建失败：{error}"))?
        .check()
        .await
        .map_err(|error| format!("{source:?} 更新检查失败：{error}"))?;
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
    let proxy = proxy.trim();
    if proxy.is_empty() {
        return Ok(None);
    }
    if proxy.len() > 512 || proxy.chars().any(char::is_control) {
        return Err(AppError::Validation("更新代理地址无效".to_owned()));
    }
    let parsed =
        Url::parse(proxy).map_err(|_| AppError::Validation("更新代理地址无效".to_owned()))?;
    if !matches!(parsed.scheme(), "http" | "https" | "socks5") {
        return Err(AppError::Validation("更新代理地址无效".to_owned()));
    }
    Ok(Some(parsed))
}

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
