use crate::models::{AppError, AppUpdateInfo, AppUpdateProgress, AppUpdateSource};
use semver::Version;
use std::cmp::Ordering;
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
    ) -> Result<Option<AppUpdateInfo>, AppError> {
        let proxy = parse_proxy(proxy)?;
        self.close().await;

        let cnb = check_source(
            app,
            AppUpdateSource::Cnb,
            CNB_UPDATE_ENDPOINT,
            proxy.clone(),
        );
        let github = check_source(app, AppUpdateSource::GitHub, GITHUB_UPDATE_ENDPOINT, proxy);
        // 两个源必须同时进入 settled 状态，避免较快但陈旧的源抢先决定版本。
        let (cnb, github) = tokio::join!(cnb, github);
        let selected = select_update([
            (AppUpdateSource::Cnb, cnb),
            (AppUpdateSource::GitHub, github),
        ])?;

        let Some(selected) = selected else {
            return Ok(None);
        };
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
    builder
        .build()
        .map_err(|error| format!("{source:?} 更新器创建失败：{error}"))?
        .check()
        .await
        .map_err(|error| format!("{source:?} 更新检查失败：{error}"))
}

fn select_update<const N: usize>(
    results: [(AppUpdateSource, Result<Option<Update>, String>); N],
) -> Result<Option<PendingAppUpdate>, AppError> {
    let mut candidates = Vec::new();
    let mut errors = Vec::new();
    let mut successful_source_count = 0;

    for (source, result) in results {
        match result {
            Ok(update) => {
                if let Some(update) = update {
                    match Version::parse(update.version.trim_start_matches('v')) {
                        Ok(version) => {
                            successful_source_count += 1;
                            candidates.push((version, source, update));
                        }
                        Err(error) => {
                            let error =
                                format!("{source:?} 更新版本 {} 无效：{error}", update.version);
                            log::warn!("应用更新源检查失败：{error}");
                            errors.push(error);
                        }
                    }
                } else {
                    successful_source_count += 1;
                }
            }
            Err(error) => {
                log::warn!("应用更新源检查失败：{error}");
                errors.push(error);
            }
        }
    }

    if successful_source_count == 0 {
        return Err(AppError::Connection(format!(
            "所有应用更新源均不可用：{}",
            errors.join("；")
        )));
    }

    candidates.sort_by(|left, right| compare_candidate(&left.0, left.1, &right.0, right.1));
    Ok(candidates
        .pop()
        .map(|(_, source, update)| PendingAppUpdate { source, update }))
}

fn source_priority(source: AppUpdateSource) -> u8 {
    match source {
        AppUpdateSource::Cnb => 1,
        AppUpdateSource::GitHub => 0,
    }
}

fn compare_candidate(
    left_version: &Version,
    left_source: AppUpdateSource,
    right_version: &Version,
    right_source: AppUpdateSource,
) -> Ordering {
    left_version
        .cmp(right_version)
        .then_with(|| source_priority(left_source).cmp(&source_priority(right_source)))
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

    #[test]
    fn 高版本优先于来源优先级() {
        let older = Version::parse("1.2.0").expect("旧版本应有效");
        let newer = Version::parse("1.3.0").expect("新版本应有效");
        assert_eq!(
            compare_candidate(
                &older,
                AppUpdateSource::Cnb,
                &newer,
                AppUpdateSource::GitHub,
            ),
            Ordering::Less
        );
    }

    #[test]
    fn 同版本优先选择_cnb() {
        let version = Version::parse("1.2.0").expect("版本应有效");
        assert_eq!(
            compare_candidate(
                &version,
                AppUpdateSource::Cnb,
                &version,
                AppUpdateSource::GitHub,
            ),
            Ordering::Greater
        );
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
