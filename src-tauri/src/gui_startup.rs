use fs2::FileExt;
use std::{
    fs::{File, OpenOptions},
    io,
    path::Path,
    thread,
    time::{Duration, Instant},
};

const STARTUP_LOCK_FILE: &str = ".gui-startup.lock";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const RETRY_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Debug)]
pub(crate) struct GuiStartupGuard {
    // 文件句柄持有启动锁；即使插件直接退出进程，操作系统也会释放它。
    _file: File,
}

impl GuiStartupGuard {
    pub(crate) fn acquire(app_data_dir: &Path) -> Result<Self, String> {
        Self::acquire_with_timeout(app_data_dir, STARTUP_TIMEOUT)
    }

    fn acquire_with_timeout(app_data_dir: &Path, timeout: Duration) -> Result<Self, String> {
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(app_data_dir.join(STARTUP_LOCK_FILE))
            .map_err(|error| format!("无法打开 GUI 启动锁：{error}"))?;
        let started = Instant::now();
        loop {
            match FileExt::try_lock_exclusive(&file) {
                Ok(()) => return Ok(Self { _file: file }),
                Err(error)
                    if lock_is_contended(&error) || error.kind() == io::ErrorKind::Interrupted =>
                {
                    let remaining = timeout.saturating_sub(started.elapsed());
                    if remaining.is_zero() {
                        return Err("等待 FsTTY 初始化超时，请稍后重试".to_owned());
                    }
                    thread::sleep(remaining.min(RETRY_INTERVAL));
                }
                Err(error) => return Err(format!("无法获取 GUI 启动锁：{error}")),
            }
        }
    }
}

fn lock_is_contended(error: &io::Error) -> bool {
    // Windows 的锁竞争不一定映射为 WouldBlock，必须同时识别 fs2 的平台错误码。
    error.kind() == io::ErrorKind::WouldBlock
        || error
            .raw_os_error()
            .is_some_and(|code| Some(code) == fs2::lock_contended_error().raw_os_error())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        io::{BufRead, BufReader, Write},
        path::PathBuf,
        process::{Child, Command, ExitStatus, Stdio},
        sync::mpsc::{self, Receiver},
    };

    const CHILD_DIRECTORY: &str = "FSTTY_GUI_STARTUP_TEST_DIRECTORY";
    const CHILD_EXIT_WITHOUT_DROP: &str = "FSTTY_GUI_STARTUP_TEST_EXIT_WITHOUT_DROP";
    const CHILD_WAITING: &str = "FSTTY_GUI_STARTUP_TEST_WAITING";
    const CHILD_LOCKED: &str = "FSTTY_GUI_STARTUP_TEST_LOCKED";

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("fstty-gui-startup-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).expect("应创建隔离测试目录");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct TestProcess {
        child: Child,
        events: Receiver<String>,
    }

    impl TestProcess {
        fn spawn(directory: &Path, exit_without_drop: bool) -> Self {
            let mut command = Command::new(std::env::current_exe().expect("应找到测试程序"));
            command
                .args([
                    "--exact",
                    "gui_startup::tests::startup_process_helper",
                    "--nocapture",
                ])
                .env(CHILD_DIRECTORY, directory)
                .env(
                    CHILD_EXIT_WITHOUT_DROP,
                    if exit_without_drop { "1" } else { "0" },
                )
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let mut child = command.spawn().expect("应启动隔离测试进程");
            let stdout = child.stdout.take().expect("应取得子进程输出");
            let (sender, events) = mpsc::channel();
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    for event in [CHILD_WAITING, CHILD_LOCKED] {
                        if line.contains(event) && sender.send(event.to_owned()).is_err() {
                            return;
                        }
                    }
                }
            });
            Self { child, events }
        }

        fn expect_event(&self, event: &str) {
            assert_eq!(
                self.events
                    .recv_timeout(Duration::from_secs(10))
                    .expect("应收到子进程状态"),
                event
            );
        }

        fn release(&mut self) -> ExitStatus {
            self.child
                .stdin
                .take()
                .expect("应取得子进程输入")
                .write_all(b"release\n")
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if let Some(status) = self.child.try_wait().expect("应读取子进程状态") {
                    return status;
                }
                assert!(Instant::now() < deadline, "测试子进程应及时退出");
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    impl Drop for TestProcess {
        fn drop(&mut self) {
            // 只清理本测试创建的子进程，断言失败时也不能留下持锁进程。
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[test]
    fn 首次获取与释放后重新获取且保留锁文件() {
        let directory = TestDirectory::new();
        let guard = GuiStartupGuard::acquire(&directory.0).unwrap();
        assert!(directory.0.join(STARTUP_LOCK_FILE).is_file());
        drop(guard);
        let _next = GuiStartupGuard::acquire_with_timeout(&directory.0, Duration::ZERO).unwrap();
        assert_eq!(
            fs::metadata(directory.0.join(STARTUP_LOCK_FILE))
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn 锁竞争超时后拒绝继续初始化() {
        let directory = TestDirectory::new();
        let _guard = GuiStartupGuard::acquire(&directory.0).unwrap();
        let result = GuiStartupGuard::acquire_with_timeout(&directory.0, Duration::from_millis(30));
        assert_eq!(result.unwrap_err(), "等待 FsTTY 初始化超时，请稍后重试");
    }

    #[test]
    fn 锁文件不可打开时不旁路启动() {
        let directory = TestDirectory::new();
        fs::create_dir(directory.0.join(STARTUP_LOCK_FILE)).unwrap();
        let error = GuiStartupGuard::acquire(&directory.0).unwrap_err();
        assert!(error.starts_with("无法打开 GUI 启动锁："));
    }

    #[test]
    fn 初始化失败自动释放启动门闩() {
        fn initialize(directory: &Path) -> Result<(), String> {
            let _guard = GuiStartupGuard::acquire(directory)?;
            Err("模拟初始化失败".to_owned())
        }
        let directory = TestDirectory::new();
        assert!(initialize(&directory.0).is_err());
        let _next = GuiStartupGuard::acquire_with_timeout(&directory.0, Duration::ZERO).unwrap();
    }

    #[test]
    fn 两个进程的初始化阶段不能重叠() {
        let directory = TestDirectory::new();
        let guard = GuiStartupGuard::acquire(&directory.0).unwrap();
        let mut second = TestProcess::spawn(&directory.0, false);
        second.expect_event(CHILD_WAITING);
        assert!(matches!(
            second.events.recv_timeout(Duration::from_millis(75)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        drop(guard);
        second.expect_event(CHILD_LOCKED);
        assert!(GuiStartupGuard::acquire_with_timeout(&directory.0, Duration::ZERO).is_err());
        assert!(second.release().success());
        let _next = GuiStartupGuard::acquire_with_timeout(&directory.0, Duration::ZERO).unwrap();
    }

    #[test]
    fn 子进程直接退出未执行析构也释放门闩() {
        let directory = TestDirectory::new();
        let mut process = TestProcess::spawn(&directory.0, true);
        process.expect_event(CHILD_WAITING);
        process.expect_event(CHILD_LOCKED);
        assert_eq!(process.release().code(), Some(23));
        let _next = GuiStartupGuard::acquire_with_timeout(&directory.0, Duration::ZERO).unwrap();
    }

    #[test]
    fn startup_process_helper() {
        let Some(directory) = std::env::var_os(CHILD_DIRECTORY) else {
            return;
        };
        println!("{CHILD_WAITING}");
        io::stdout().flush().unwrap();
        let _guard = GuiStartupGuard::acquire(Path::new(&directory)).unwrap();
        println!("{CHILD_LOCKED}");
        io::stdout().flush().unwrap();
        let mut input = String::new();
        io::stdin().read_line(&mut input).unwrap();
        if std::env::var(CHILD_EXIT_WITHOUT_DROP).as_deref() == Ok("1") {
            // 与单实例插件的退出路径一致，不依赖 Rust 析构来释放系统锁。
            std::process::exit(23);
        }
    }
}
