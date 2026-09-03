use crate::services::AppState;
use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::watch;

#[derive(Clone, Copy, PartialEq, Eq)]
enum GuiPhase {
    Starting,
    Ready,
    ExitRequested,
    ShuttingDown,
    ShutdownComplete,
}

impl GuiPhase {
    fn is_exiting(self) -> bool {
        matches!(
            self,
            Self::ExitRequested | Self::ShuttingDown | Self::ShutdownComplete
        )
    }
}

struct GuiLifecycleInner {
    phase: watch::Sender<GuiPhase>,
    activating: AtomicBool,
    window_destroying: watch::Sender<bool>,
}

#[derive(Clone)]
pub(crate) struct GuiLifecycle {
    inner: Arc<GuiLifecycleInner>,
}

impl Default for GuiLifecycle {
    fn default() -> Self {
        let (phase, _) = watch::channel(GuiPhase::Starting);
        let (window_destroying, _) = watch::channel(false);
        Self {
            inner: Arc::new(GuiLifecycleInner {
                phase,
                activating: AtomicBool::new(false),
                window_destroying,
            }),
        }
    }
}

impl GuiLifecycle {
    pub(crate) fn mark_ready(&self) {
        self.inner.phase.send_if_modified(|phase| {
            if *phase != GuiPhase::Starting {
                return false;
            }
            *phase = GuiPhase::Ready;
            true
        });
    }

    pub(crate) fn is_exiting(&self) -> bool {
        self.inner.phase.borrow().is_exiting()
    }

    pub(crate) fn request_exit(&self) {
        self.inner.phase.send_if_modified(|phase| {
            if phase.is_exiting() {
                return false;
            }
            *phase = GuiPhase::ExitRequested;
            true
        });
    }

    pub(crate) fn begin_shutdown(&self) -> bool {
        self.inner.phase.send_if_modified(|phase| {
            if matches!(*phase, GuiPhase::ShuttingDown | GuiPhase::ShutdownComplete) {
                return false;
            }
            *phase = GuiPhase::ShuttingDown;
            true
        })
    }

    pub(crate) fn finish_shutdown(&self) {
        self.inner.phase.send_if_modified(|phase| {
            if *phase != GuiPhase::ShuttingDown {
                return false;
            }
            *phase = GuiPhase::ShutdownComplete;
            true
        });
    }

    pub(crate) fn shutdown_complete(&self) -> bool {
        *self.inner.phase.borrow() == GuiPhase::ShutdownComplete
    }

    pub(crate) fn destroy_window<E>(
        &self,
        destroy: impl FnOnce() -> Result<(), E>,
    ) -> Result<(), E> {
        // destroy 只提交事件；收到 Destroyed、旧窗口移出索引后才允许重建。
        self.inner.window_destroying.send_replace(true);
        let result = destroy();
        if result.is_err() {
            self.window_destroyed();
        }
        result
    }

    pub(crate) fn window_destroyed(&self) {
        self.inner.window_destroying.send_replace(false);
    }

    async fn wait_for_window_destruction(&self) {
        let mut destroying = self.inner.window_destroying.subscribe();
        let _ = destroying.wait_for(|destroying| !destroying).await;
    }

    fn try_activate(&self) -> Option<WindowActivation> {
        if self.is_exiting()
            || self
                .inner
                .activating
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return None;
        }
        let activation = WindowActivation {
            lifecycle: self.clone(),
        };
        // 退出可能与抢占激活槽并发，取得槽后仍需再次检查。
        (!self.is_exiting()).then_some(activation)
    }
}

struct WindowActivation {
    lifecycle: GuiLifecycle,
}

impl WindowActivation {
    async fn wait_until_ready(&self) -> bool {
        let mut phase = self.lifecycle.inner.phase.subscribe();
        let result = phase.wait_for(|phase| *phase != GuiPhase::Starting).await;
        matches!(result, Ok(phase) if *phase == GuiPhase::Ready)
    }

    async fn wait_for<T>(&self, operation: impl Future<Output = T>) -> Option<T> {
        let mut phase = self.lifecycle.inner.phase.subscribe();
        tokio::select! {
            biased;
            _ = phase.wait_for(|phase| phase.is_exiting()) => None,
            value = operation => (!self.lifecycle.is_exiting()).then_some(value),
        }
    }
}

impl Drop for WindowActivation {
    fn drop(&mut self) {
        // 激活失败、任务取消与成功共用释放路径，下一次托盘点击可以重试。
        self.lifecycle
            .inner
            .activating
            .store(false, Ordering::Release);
    }
}

pub(crate) fn request_main_window(app: &AppHandle) {
    let lifecycle = app.state::<GuiLifecycle>().inner().clone();
    let Some(activation) = lifecycle.try_activate() else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if !activation.wait_until_ready().await {
            return;
        }
        let service = app.state::<AppState>().lightweight_mode_service.clone();
        let Some(window_access) = activation.wait_for(service.window_activation_guard()).await
        else {
            return;
        };
        match activation
            .wait_for(tokio::time::timeout(
                Duration::from_secs(30),
                lifecycle.wait_for_window_destruction(),
            ))
            .await
        {
            Some(Ok(())) => {}
            Some(Err(_)) => {
                log::error!("等待主窗口销毁超时，请再次尝试恢复窗口");
                return;
            }
            None => return,
        }
        // WebView2 不允许在同步事件回调中重建窗口；建窗留在阻塞工作线程。
        let result = tauri::async_runtime::spawn_blocking(move || {
            let prepared = match prepare_main_window(&app, &lifecycle) {
                Ok(Some(window)) => window,
                Ok(None) => return,
                Err(error) => {
                    log::error!("恢复主窗口失败：{error}");
                    return;
                }
            };
            let callback_app = app.clone();
            let result = app.run_on_main_thread(move || {
                // 两个许可都保留到 UI 操作结束，不能在回调尚未执行时允许新的快照或建窗。
                let _activation = activation;
                let _window_access = window_access;
                if let Err(error) = present_main_window(&callback_app, prepared, &lifecycle) {
                    log::error!("显示主窗口失败：{error}");
                }
            });
            if let Err(error) = result {
                log::error!("无法调度主窗口显示：{error}");
            }
        })
        .await;
        if let Err(error) = result {
            log::error!("恢复主窗口任务失败：{error}");
        }
    });
}

pub(crate) fn request_app_exit(app: &AppHandle) {
    app.state::<GuiLifecycle>().request_exit();
    app.exit(0);
}

pub(crate) fn create_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .ok_or(tauri::Error::WindowNotFound)?;
    WebviewWindowBuilder::from_config(app, config)?.build()
}

// 把系统窗口操作限定在这个小接口，测试无需创建 WebView 或读取真实会话。
trait MainWindowHost {
    type Window;
    type Error;

    fn find_window(&self) -> Option<Self::Window>;
    fn create_window(&self) -> Result<Self::Window, Self::Error>;
    fn restore_taskbar(&self, window: &Self::Window) -> Result<(), Self::Error>;
    fn is_minimized(&self, window: &Self::Window) -> Result<bool, Self::Error>;
    fn unminimize(&self, window: &Self::Window) -> Result<(), Self::Error>;
    fn show(&self, window: &Self::Window) -> Result<(), Self::Error>;
    fn focus(&self, window: &Self::Window) -> Result<(), Self::Error>;
    fn destroy(&self, window: &Self::Window) -> Result<(), Self::Error>;
}

struct PreparedWindow<W> {
    window: W,
    created: bool,
}

fn prepare_main_window<H: MainWindowHost>(
    host: &H,
    lifecycle: &GuiLifecycle,
) -> Result<Option<PreparedWindow<H::Window>>, H::Error> {
    if lifecycle.is_exiting() {
        return Ok(None);
    }
    let prepared = match host.find_window() {
        Some(window) => PreparedWindow {
            window,
            created: false,
        },
        None => PreparedWindow {
            window: host.create_window()?,
            created: true,
        },
    };
    Ok(Some(prepared))
}

fn present_main_window<H: MainWindowHost>(
    host: &H,
    prepared: PreparedWindow<H::Window>,
    lifecycle: &GuiLifecycle,
) -> Result<(), H::Error> {
    if lifecycle.is_exiting() {
        // 建窗期间收到退出请求时，只销毁本次创建的隐藏窗口，不重新显示它。
        if prepared.created {
            host.destroy(&prepared.window)?;
        }
        return Ok(());
    }
    let window = &prepared.window;
    host.restore_taskbar(window)?;
    // 无条件执行还原会取消最大化；只还原确实处于最小化的窗口。
    if host.is_minimized(window)? {
        host.unminimize(window)?;
    }
    host.show(window)?;
    host.focus(window)
}

impl MainWindowHost for AppHandle {
    type Window = WebviewWindow;
    type Error = tauri::Error;

    fn find_window(&self) -> Option<Self::Window> {
        self.get_webview_window("main")
    }

    fn create_window(&self) -> Result<Self::Window, Self::Error> {
        create_main_window(self)
    }

    fn restore_taskbar(&self, window: &Self::Window) -> Result<(), Self::Error> {
        window.set_skip_taskbar(false)
    }

    fn is_minimized(&self, window: &Self::Window) -> Result<bool, Self::Error> {
        window.is_minimized()
    }

    fn unminimize(&self, window: &Self::Window) -> Result<(), Self::Error> {
        window.unminimize()
    }

    fn show(&self, window: &Self::Window) -> Result<(), Self::Error> {
        window.show()
    }

    fn focus(&self, window: &Self::Window) -> Result<(), Self::Error> {
        window.set_focus()
    }

    fn destroy(&self, window: &Self::Window) -> Result<(), Self::Error> {
        window.destroy()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use tokio::sync::oneshot;

    #[derive(Default)]
    struct TestWindow {
        exists: bool,
        minimized: bool,
        maximized: bool,
        fail_create: bool,
        fail_show: bool,
        operations: Vec<&'static str>,
    }

    #[derive(Default)]
    struct TestHost(RefCell<TestWindow>);

    impl MainWindowHost for TestHost {
        type Window = ();
        type Error = &'static str;

        fn find_window(&self) -> Option<Self::Window> {
            self.0.borrow().exists.then_some(())
        }

        fn create_window(&self) -> Result<Self::Window, Self::Error> {
            let mut state = self.0.borrow_mut();
            state.operations.push("create");
            if std::mem::take(&mut state.fail_create) {
                return Err("模拟建窗失败");
            }
            state.exists = true;
            Ok(())
        }

        fn restore_taskbar(&self, _: &()) -> Result<(), Self::Error> {
            self.0.borrow_mut().operations.push("taskbar");
            Ok(())
        }

        fn is_minimized(&self, _: &()) -> Result<bool, Self::Error> {
            let mut state = self.0.borrow_mut();
            state.operations.push("is_minimized");
            Ok(state.minimized)
        }

        fn unminimize(&self, _: &()) -> Result<(), Self::Error> {
            let mut state = self.0.borrow_mut();
            state.operations.push("unminimize");
            state.minimized = false;
            state.maximized = false;
            Ok(())
        }

        fn show(&self, _: &()) -> Result<(), Self::Error> {
            let mut state = self.0.borrow_mut();
            state.operations.push("show");
            if std::mem::take(&mut state.fail_show) {
                return Err("模拟显示失败");
            }
            Ok(())
        }

        fn focus(&self, _: &()) -> Result<(), Self::Error> {
            self.0.borrow_mut().operations.push("focus");
            Ok(())
        }

        fn destroy(&self, _: &()) -> Result<(), Self::Error> {
            let mut state = self.0.borrow_mut();
            state.operations.push("destroy");
            state.exists = false;
            Ok(())
        }
    }

    fn ready_lifecycle() -> GuiLifecycle {
        let lifecycle = GuiLifecycle::default();
        lifecycle.mark_ready();
        lifecycle
    }

    fn activate(host: &TestHost, lifecycle: &GuiLifecycle) -> Result<(), &'static str> {
        let Some(_activation) = lifecycle.try_activate() else {
            return Ok(());
        };
        if let Some(window) = prepare_main_window(host, lifecycle)? {
            present_main_window(host, window, lifecycle)?;
        }
        Ok(())
    }

    #[test]
    fn 普通窗口只显示并聚焦且不创建新窗口() {
        let host = TestHost(RefCell::new(TestWindow {
            exists: true,
            ..Default::default()
        }));
        activate(&host, &ready_lifecycle()).unwrap();
        assert_eq!(
            host.0.borrow().operations,
            ["taskbar", "is_minimized", "show", "focus"]
        );
    }

    #[test]
    fn 最小化窗口先还原再聚焦() {
        let host = TestHost(RefCell::new(TestWindow {
            exists: true,
            minimized: true,
            ..Default::default()
        }));
        activate(&host, &ready_lifecycle()).unwrap();
        assert_eq!(
            host.0.borrow().operations,
            ["taskbar", "is_minimized", "unminimize", "show", "focus"]
        );
        assert!(!host.0.borrow().minimized);
    }

    #[test]
    fn 最大化窗口不能被重复启动取消最大化() {
        let host = TestHost(RefCell::new(TestWindow {
            exists: true,
            maximized: true,
            ..Default::default()
        }));
        activate(&host, &ready_lifecycle()).unwrap();
        assert!(host.0.borrow().maximized);
        assert!(!host.0.borrow().operations.contains(&"unminimize"));
    }

    #[test]
    fn 轻量模式缺失窗口只创建一次() {
        let host = TestHost::default();
        let lifecycle = ready_lifecycle();
        activate(&host, &lifecycle).unwrap();
        activate(&host, &lifecycle).unwrap();
        assert_eq!(
            host.0
                .borrow()
                .operations
                .iter()
                .filter(|operation| **operation == "create")
                .count(),
            1
        );
    }

    #[test]
    fn 创建失败释放激活槽并允许再次恢复() {
        let host = TestHost(RefCell::new(TestWindow {
            fail_create: true,
            ..Default::default()
        }));
        let lifecycle = ready_lifecycle();
        assert!(activate(&host, &lifecycle).is_err());
        assert!(!host.0.borrow().exists);
        activate(&host, &lifecycle).unwrap();
        assert!(host.0.borrow().exists);
    }

    #[test]
    fn 显示失败保留已创建窗口供下次重试() {
        let host = TestHost(RefCell::new(TestWindow {
            fail_show: true,
            ..Default::default()
        }));
        let lifecycle = ready_lifecycle();
        assert!(activate(&host, &lifecycle).is_err());
        activate(&host, &lifecycle).unwrap();
        assert_eq!(
            host.0
                .borrow()
                .operations
                .iter()
                .filter(|operation| **operation == "create")
                .count(),
            1
        );
    }

    #[test]
    fn 重复激活请求共用一个许可且取消后可重试() {
        let lifecycle = ready_lifecycle();
        let activation = lifecycle.try_activate().unwrap();
        for _ in 0..20 {
            assert!(lifecycle.try_activate().is_none());
        }
        drop(activation);
        assert!(lifecycle.try_activate().is_some());
    }

    #[tokio::test]
    async fn 冷启动激活必须等初始化完成() {
        let lifecycle = GuiLifecycle::default();
        let activation = lifecycle.try_activate().unwrap();
        let mut waiting = Box::pin(activation.wait_until_ready());
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut waiting)
                .await
                .is_err()
        );
        lifecycle.mark_ready();
        assert!(waiting.await);
    }

    #[tokio::test]
    async fn 初始化期间退出不会被迟到的就绪通知复活() {
        let lifecycle = GuiLifecycle::default();
        let activation = lifecycle.try_activate().unwrap();
        lifecycle.request_exit();
        lifecycle.mark_ready();
        assert!(!activation.wait_until_ready().await);
        assert!(lifecycle.is_exiting());
    }

    #[tokio::test]
    async fn 等待轻量事务期间合并请求且不提前激活() {
        let lifecycle = ready_lifecycle();
        let activation = lifecycle.try_activate().unwrap();
        let (finished, transaction) = oneshot::channel();
        let mut waiting = Box::pin(activation.wait_for(transaction));
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut waiting)
                .await
                .is_err()
        );
        assert!(lifecycle.try_activate().is_none());
        finished.send(()).unwrap();
        assert!(matches!(waiting.await, Some(Ok(()))));
    }

    #[tokio::test]
    async fn 等待事务时退出立即取消而不是继续等到超时() {
        let lifecycle = ready_lifecycle();
        let activation = lifecycle.try_activate().unwrap();
        let mut waiting = Box::pin(activation.wait_for(std::future::pending::<()>()));
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut waiting)
                .await
                .is_err()
        );
        lifecycle.request_exit();
        assert!(tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .unwrap()
            .is_none());
        assert!(lifecycle.try_activate().is_none());
    }

    #[tokio::test]
    async fn 退出与事务完成同时就绪时优先退出() {
        let lifecycle = ready_lifecycle();
        let activation = lifecycle.try_activate().unwrap();
        lifecycle.request_exit();
        assert!(activation.wait_for(std::future::ready(())).await.is_none());
    }

    #[test]
    fn 建窗后退出销毁新窗口但不显示() {
        let lifecycle = ready_lifecycle();
        let host = TestHost::default();
        let prepared = prepare_main_window(&host, &lifecycle).unwrap().unwrap();
        lifecycle.request_exit();
        present_main_window(&host, prepared, &lifecycle).unwrap();
        assert_eq!(host.0.borrow().operations, ["create", "destroy"]);
    }

    #[test]
    fn 退出后的请求不操作已有窗口也不创建新窗口() {
        let lifecycle = ready_lifecycle();
        lifecycle.request_exit();
        for exists in [false, true] {
            let host = TestHost(RefCell::new(TestWindow {
                exists,
                ..Default::default()
            }));
            assert!(prepare_main_window(&host, &lifecycle).unwrap().is_none());
            activate(&host, &lifecycle).unwrap();
            assert!(host.0.borrow().operations.is_empty());
        }
    }

    #[tokio::test]
    async fn 销毁请求返回后仍需等待实际销毁事件() {
        let lifecycle = ready_lifecycle();
        lifecycle.destroy_window(|| Ok::<(), ()>(())).unwrap();
        let mut waiting = Box::pin(lifecycle.wait_for_window_destruction());
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut waiting)
                .await
                .is_err()
        );
        lifecycle.window_destroyed();
        tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn 销毁失败或事件先到时不遗留唤回屏障() {
        let lifecycle = ready_lifecycle();
        assert!(lifecycle.destroy_window(|| Err("模拟销毁失败")).is_err());
        tokio::time::timeout(
            Duration::from_secs(1),
            lifecycle.wait_for_window_destruction(),
        )
        .await
        .unwrap();
        lifecycle.destroy_window(|| Ok::<(), ()>(())).unwrap();
        lifecycle.window_destroyed();
        tokio::time::timeout(
            Duration::from_secs(1),
            lifecycle.wait_for_window_destruction(),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn 等待实际销毁期间退出会取消唤回() {
        let lifecycle = ready_lifecycle();
        let activation = lifecycle.try_activate().unwrap();
        lifecycle.destroy_window(|| Ok::<(), ()>(())).unwrap();
        let mut waiting = Box::pin(activation.wait_for(lifecycle.wait_for_window_destruction()));
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut waiting)
                .await
                .is_err()
        );
        lifecycle.request_exit();
        assert!(tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .unwrap()
            .is_none());
    }

    #[test]
    fn 多个退出请求只执行一次清理且完成前不放行退出() {
        let lifecycle = ready_lifecycle();
        lifecycle.request_exit();
        assert!(lifecycle.begin_shutdown());
        assert!(!lifecycle.begin_shutdown());
        assert!(!lifecycle.shutdown_complete());
        assert!(lifecycle.try_activate().is_none());
        lifecycle.finish_shutdown();
        lifecycle.request_exit();
        lifecycle.mark_ready();
        assert!(!lifecycle.begin_shutdown());
        assert!(lifecycle.shutdown_complete());
        assert!(lifecycle.try_activate().is_none());
    }
}
