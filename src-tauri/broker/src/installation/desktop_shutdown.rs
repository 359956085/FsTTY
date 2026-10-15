//! Installation waits for human confirmation without a deadline. Only process
//! termination after confirmation has a bounded, shared deadline.
use super::files;
use crate::windows::{self, Handle};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    Storage::FileSystem::SYNCHRONIZE,
    System::{Diagnostics::ToolHelp::*, Threading::*},
    UI::WindowsAndMessaging::*,
};

trait Process {
    fn wait(&self, timeout: Duration) -> Result<bool, u32>;
    fn terminate(&self) -> Result<(), u32>;
}
#[derive(Debug, PartialEq, Eq)]
struct Failure {
    index: usize,
    code: &'static str,
    error: Option<u32>,
    terminate_error: Option<u32>,
}
fn stop_batch(
    processes: &[impl Process],
    budget: Duration,
    elapsed: impl Fn() -> Duration,
) -> Result<(), Failure> {
    let mut attempts = Vec::with_capacity(processes.len());
    // Request every termination before waiting, so one pending exit does not
    // delay the termination request for another matching process.
    for (index, process) in processes.iter().enumerate() {
        let exited = process.wait(Duration::ZERO).map_err(|error| Failure {
            index,
            code: "desktop_wait_failed",
            error: Some(error),
            terminate_error: None,
        })?;
        attempts.push(if exited {
            None
        } else {
            process.terminate().err()
        });
    }
    for (index, process) in processes.iter().enumerate() {
        // Even a failed TerminateProcess can race another exit request. The
        // process handle's signaled state, not the API return alone, is final.
        let remaining = budget.saturating_sub(elapsed());
        match process.wait(remaining) {
            Ok(true) => {}
            Ok(false) => {
                return Err(Failure {
                    index,
                    code: "desktop_exit_timeout",
                    error: None,
                    terminate_error: attempts[index],
                })
            }
            Err(error) => {
                return Err(Failure {
                    index,
                    code: "desktop_wait_failed",
                    error: Some(error),
                    terminate_error: attempts[index],
                })
            }
        }
    }
    Ok(())
}
struct Target {
    handle: Handle,
    pid: u32,
    path: PathBuf,
}
impl Process for Target {
    fn wait(&self, timeout: Duration) -> Result<bool, u32> {
        match unsafe {
            WaitForSingleObject(
                self.handle.0,
                timeout.as_millis().min(u32::MAX as u128 - 1) as u32,
            )
        } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            _ => Err(unsafe { GetLastError() }),
        }
    }
    fn terminate(&self) -> Result<(), u32> {
        // Identification needs no termination rights. Open those rights only
        // for an exact path match, then verify both handles name the same
        // process instance before using the new handle.
        let handle = Handle(unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
                0,
                self.pid,
            )
        });
        if handle.0.is_null() {
            return Err(unsafe { GetLastError() });
        }
        if creation_time(&self.handle)? != creation_time(&handle)? {
            return Err(ERROR_INVALID_PARAMETER);
        }
        if unsafe { TerminateProcess(handle.0, 0) } != 0 {
            Ok(())
        } else {
            Err(unsafe { GetLastError() })
        }
    }
}
fn creation_time(handle: &Handle) -> Result<u64, u32> {
    let mut created: FILETIME = unsafe { std::mem::zeroed() };
    let mut exited = created;
    let mut kernel = created;
    let mut user = created;
    if unsafe { GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user) } == 0
    {
        return Err(unsafe { GetLastError() });
    }
    Ok(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
}
fn inspection_failure(pid: u32, stage: &str, error: u32) -> String {
    format!("[desktop_inspect_failed] pid={pid} stage={stage} windows_error={error}; 无法核实 FsTTY 进程路径，操作已停止")
}
fn matches(path: &Path, directories: &[PathBuf]) -> bool {
    directories
        .iter()
        .any(|directory| files::same_path(&directory.join("fstty.exe"), path))
}
fn targets(directories: &[PathBuf]) -> crate::Result<Vec<Target>> {
    let snapshot = Handle(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) });
    if snapshot.0 == INVALID_HANDLE_VALUE {
        return Err(format!("[desktop_scan_failed] Windows error={}", unsafe {
            GetLastError()
        }));
    }
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of_val(&entry) as u32;
    let mut more = unsafe { Process32FirstW(snapshot.0, &mut entry) } != 0;
    let mut result = Vec::new();
    while more {
        let end = entry
            .szExeFile
            .iter()
            .position(|v| *v == 0)
            .unwrap_or(entry.szExeFile.len());
        if String::from_utf16_lossy(&entry.szExeFile[..end]).eq_ignore_ascii_case("fstty.exe") {
            let handle = Handle(unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                    0,
                    entry.th32ProcessID,
                )
            });
            if handle.0.is_null() {
                let error = unsafe { GetLastError() };
                // The process may have disappeared since the ToolHelp snapshot.
                // Other failures leave its path unknown and must not be skipped.
                if error != ERROR_INVALID_PARAMETER {
                    return Err(inspection_failure(entry.th32ProcessID, "open", error));
                }
            } else {
                let mut path = vec![0u16; 32768];
                let mut count = path.len() as u32;
                if unsafe { QueryFullProcessImageNameW(handle.0, 0, path.as_mut_ptr(), &mut count) }
                    != 0
                {
                    let path = PathBuf::from(String::from_utf16_lossy(&path[..count as usize]));
                    if matches(&path, directories) {
                        result.push(Target {
                            handle,
                            pid: entry.th32ProcessID,
                            path,
                        });
                    }
                } else {
                    let error = unsafe { GetLastError() };
                    if unsafe { WaitForSingleObject(handle.0, 0) } != WAIT_OBJECT_0 {
                        return Err(inspection_failure(entry.th32ProcessID, "query_path", error));
                    }
                }
            }
        }
        more = unsafe { Process32NextW(snapshot.0, &mut entry) } != 0;
    }
    if unsafe { GetLastError() } != ERROR_NO_MORE_FILES {
        return Err(format!("[desktop_scan_failed] Windows error={}", unsafe {
            GetLastError()
        }));
    }
    Ok(result)
}
fn describe(target: &Target, failure: &Failure, elapsed: Duration) -> String {
    format!("[{}] 旧桌面未能退出，安装已停止; pid={} path={} windows_error={:?} terminate_error={:?} elapsed_ms={}",
        failure.code, target.pid, target.path.display(), failure.error, failure.terminate_error, elapsed.as_millis())
}
pub(super) fn close(directories: &[PathBuf], confirm: bool) -> crate::Result<()> {
    close_with(
        || targets(directories),
        confirm.then_some(|| {
            if unsafe {
                MessageBoxW(
                    std::ptr::null_mut(),
                    windows::wide(
                        "继续将关闭旧 FsTTY，正在进行的 SSH 连接和传输任务会中断。是否继续？",
                    )
                    .as_ptr(),
                    windows::wide("FsTTY 安装确认").as_ptr(),
                    MB_OKCANCEL | MB_ICONWARNING | MB_DEFBUTTON2,
                )
            } != IDOK
            {
                return Err("用户取消关闭旧桌面，安装未继续".into());
            }
            Ok(())
        }),
        Duration::from_secs(10),
    )
}
fn close_with(
    mut scan: impl FnMut() -> crate::Result<Vec<Target>>,
    confirm: Option<impl FnOnce() -> crate::Result<()>>,
    budget: Duration,
) -> crate::Result<()> {
    let mut processes = scan()?;
    if !processes.is_empty() {
        if let Some(confirm) = confirm {
            // Do not keep a stale process list across an unbounded human wait.
            drop(processes);
            confirm()?;
            processes = scan()?;
        }
    }
    // This clock deliberately starts only AFTER the user's decision.
    let started = Instant::now();
    if let Err(failure) = stop_batch(&processes, budget, || started.elapsed()) {
        return Err(describe(
            &processes[failure.index],
            &failure,
            started.elapsed(),
        ));
    }
    for target in scan()? {
        match target.wait(Duration::ZERO) {
            Ok(true) => {}
            state => {
                let failure = Failure {
                    index: 0,
                    code: if state.is_err() {
                        "desktop_wait_failed"
                    } else {
                        "desktop_exit_remaining"
                    },
                    error: state.err(),
                    terminate_error: None,
                };
                return Err(describe(&target, &failure, started.elapsed()));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        collections::VecDeque,
        rc::Rc,
    };
    struct Fake {
        waits: RefCell<VecDeque<Result<bool, u32>>>,
        termination: Result<(), u32>,
        stopped: Rc<Cell<usize>>,
        expected: usize,
        timeouts: RefCell<Vec<Duration>>,
    }
    impl Process for Fake {
        fn wait(&self, timeout: Duration) -> Result<bool, u32> {
            self.timeouts.borrow_mut().push(timeout);
            if !timeout.is_zero() {
                assert_eq!(
                    self.stopped.get(),
                    self.expected,
                    "all stop requests precede blocking waits"
                );
            }
            self.waits.borrow_mut().pop_front().unwrap()
        }
        fn terminate(&self) -> Result<(), u32> {
            self.stopped.set(self.stopped.get() + 1);
            self.termination
        }
    }
    fn fake(
        stopped: &Rc<Cell<usize>>,
        expected: usize,
        waits: Vec<Result<bool, u32>>,
        termination: Result<(), u32>,
    ) -> Fake {
        Fake {
            waits: RefCell::new(waits.into()),
            termination,
            stopped: stopped.clone(),
            expected,
            timeouts: RefCell::new(Vec::new()),
        }
    }
    #[test]
    fn no_process_and_already_exited_are_successful() {
        let stopped = Rc::new(Cell::new(0));
        assert!(stop_batch(&[] as &[Fake], Duration::from_secs(10), || Duration::ZERO).is_ok());
        let process = fake(&stopped, 0, vec![Ok(true), Ok(true)], Err(5));
        assert!(stop_batch(&[process], Duration::from_secs(10), || Duration::ZERO).is_ok());
        assert_eq!(stopped.get(), 0);
    }
    #[test]
    fn all_targets_are_stopped_before_waiting_and_exit_races_are_successful() {
        let stopped = Rc::new(Cell::new(0));
        let targets = [
            fake(&stopped, 2, vec![Ok(false), Ok(true)], Ok(())),
            fake(&stopped, 2, vec![Ok(false), Ok(true)], Err(5)),
        ];
        assert!(stop_batch(&targets, Duration::from_secs(10), || Duration::from_secs(2)).is_ok());
        assert_eq!(targets[0].timeouts.borrow()[1], Duration::from_secs(8));
    }
    #[test]
    fn real_timeout_and_wait_failure_remain_blocking() {
        let stopped = Rc::new(Cell::new(0));
        let targets = [fake(&stopped, 1, vec![Ok(false), Ok(false)], Err(5))];
        let failure = stop_batch(&targets, Duration::from_secs(10), || Duration::ZERO).unwrap_err();
        assert_eq!(failure.code, "desktop_exit_timeout");
        assert_eq!(failure.terminate_error, Some(5));
        let targets = [fake(&stopped, 2, vec![Ok(false), Err(6)], Ok(()))];
        assert_eq!(
            stop_batch(&targets, Duration::from_secs(10), || Duration::ZERO)
                .unwrap_err()
                .error,
            Some(6)
        );
    }
    #[test]
    fn full_and_exhausted_process_budgets_are_respected() {
        let stopped = Rc::new(Cell::new(0));
        let targets = [fake(&stopped, 1, vec![Ok(false), Ok(true)], Ok(()))];
        assert!(stop_batch(&targets, Duration::from_secs(10), || Duration::ZERO).is_ok());
        assert_eq!(targets[0].timeouts.borrow()[1], Duration::from_secs(10));
        let targets = [fake(&stopped, 2, vec![Ok(false), Ok(false)], Ok(()))];
        assert!(
            stop_batch(&targets, Duration::from_secs(10), || Duration::from_secs(
                11
            ))
            .is_err()
        );
        assert_eq!(targets[0].timeouts.borrow()[1], Duration::ZERO);
    }
    #[test]
    fn every_wait_uses_the_remaining_shared_budget() {
        let stopped = Rc::new(Cell::new(0));
        let clock = Cell::new(Duration::ZERO);
        let targets = [
            fake(&stopped, 2, vec![Ok(false), Ok(true)], Ok(())),
            fake(&stopped, 2, vec![Ok(false), Ok(true)], Ok(())),
        ];
        assert!(stop_batch(&targets, Duration::from_secs(10), || {
            let elapsed = clock.get();
            clock.set(elapsed + Duration::from_secs(7));
            elapsed
        })
        .is_ok());
        assert_eq!(targets[0].timeouts.borrow()[1], Duration::from_secs(10));
        assert_eq!(targets[1].timeouts.borrow()[1], Duration::from_secs(3));
    }

    #[test]
    fn shutdown_child() {
        if std::env::var("FSTTY_OWNED_SHUTDOWN_CHILD").as_deref() == Ok("1") {
            println!("FSTTY_SHUTDOWN_FIXTURE");
            std::thread::sleep(Duration::from_secs(30));
        }
    }

    struct Owned(std::process::Child);
    impl Drop for Owned {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    impl Owned {
        fn spawn() -> Self {
            use std::os::windows::process::CommandExt;
            use std::process::{Command, Stdio};
            Self(
                Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "installation::desktop_shutdown::tests::shutdown_child",
                        "--nocapture",
                    ])
                    .env("FSTTY_OWNED_SHUTDOWN_CHILD", "1")
                    .creation_flags(CREATE_NO_WINDOW)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap(),
            )
        }
        fn target(&self) -> Target {
            let handle = Handle(unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                    0,
                    self.0.id(),
                )
            });
            assert!(!handle.0.is_null());
            Target {
                handle,
                pid: self.0.id(),
                path: std::env::current_exe().unwrap(),
            }
        }
    }

    #[test]
    fn confirmation_rescans_targets_and_never_stops_the_stale_snapshot() {
        let old = Owned::spawn();
        let mut new = Owned::spawn();
        let mut snapshots = VecDeque::from([vec![old.target()], vec![new.target()], vec![]]);
        let confirmed = Cell::new(false);
        let scans = Cell::new(0);
        close_with(
            || {
                let scan = scans.get();
                if scan > 0 {
                    assert!(confirmed.get());
                }
                scans.set(scan + 1);
                Ok(snapshots.pop_front().unwrap())
            },
            Some(|| {
                assert_eq!(old.target().wait(Duration::ZERO), Ok(false));
                assert_eq!(new.target().wait(Duration::ZERO), Ok(false));
                confirmed.set(true);
                Ok(())
            }),
            Duration::from_secs(10),
        )
        .unwrap();
        assert!(new.0.wait().unwrap().success());
        assert_eq!(old.target().wait(Duration::ZERO), Ok(false));
        assert_eq!(scans.get(), 3);
    }

    #[test]
    fn cancellation_stops_before_rescanning_or_terminating() {
        let child = Owned::spawn();
        let scans = Cell::new(0);
        let error = close_with(
            || {
                scans.set(scans.get() + 1);
                Ok(vec![child.target()])
            },
            Some(|| Err("用户取消关闭旧桌面，安装未继续".into())),
            Duration::from_secs(10),
        )
        .unwrap_err();
        assert!(error.contains("用户取消"));
        assert_eq!(scans.get(), 1);
        assert_eq!(child.target().wait(Duration::ZERO), Ok(false));
    }

    #[test]
    fn newly_arrived_unconfirmed_process_blocks_instead_of_being_killed() {
        let child = Owned::spawn();
        let mut snapshots = VecDeque::from([vec![], vec![child.target()]]);
        let error = close_with(
            || Ok(snapshots.pop_front().unwrap()),
            Some(|| panic!("no initial target needs confirmation")),
            Duration::from_secs(10),
        )
        .unwrap_err();
        assert!(error.contains("[desktop_exit_remaining]"));
        assert_eq!(child.target().wait(Duration::ZERO), Ok(false));
    }

    #[test]
    fn post_confirmation_inspection_failure_blocks_without_terminating() {
        let child = Owned::spawn();
        let confirmed = Cell::new(false);
        let error = close_with(
            || {
                if confirmed.get() {
                    Err(inspection_failure(child.0.id(), "query_path", 5))
                } else {
                    Ok(vec![child.target()])
                }
            },
            Some(|| {
                confirmed.set(true);
                Ok(())
            }),
            Duration::from_secs(10),
        )
        .unwrap_err();
        assert!(error.contains("[desktop_inspect_failed]"));
        assert!(error.contains("stage=query_path windows_error=5"));
        assert_eq!(child.target().wait(Duration::ZERO), Ok(false));
    }

    #[test]
    fn reopening_a_different_process_instance_never_terminates_it() {
        let first = Owned::spawn();
        // Ensure these two native process creation times differ even on a
        // platform whose process timestamps have a coarse clock resolution.
        std::thread::sleep(Duration::from_millis(20));
        let second = Owned::spawn();
        let mut mismatched = first.target();
        mismatched.pid = second.0.id();
        assert_eq!(mismatched.terminate(), Err(ERROR_INVALID_PARAMETER));
        assert_eq!(first.target().wait(Duration::ZERO), Ok(false));
        assert_eq!(second.target().wait(Duration::ZERO), Ok(false));
    }

    #[test]
    fn native_owned_processes_and_already_exited_handles_are_safe() {
        let mut children = Vec::new();
        let mut processes = Vec::new();
        for _ in 0..2 {
            let child = Owned::spawn();
            processes.push(child.target());
            children.push(child);
        }
        children[0].0.kill().unwrap();
        children[0].0.wait().unwrap();
        let started = Instant::now();
        assert!(stop_batch(&processes, Duration::from_secs(10), || started.elapsed()).is_ok());
        assert!(processes.iter().all(|p| p.wait(Duration::ZERO) == Ok(true)));
    }

    #[test]
    fn only_exact_desktop_paths_match() {
        let directories = vec![PathBuf::from(r"C:\Apps\FsTTY")];
        assert!(matches(Path::new("c:/apps/fstty/fstty.exe"), &directories));
        assert!(!matches(Path::new(r"C:\Other\fstty.exe"), &directories));
        assert!(!matches(
            Path::new(r"C:\Apps\FsTTY-test\fstty.exe"),
            &directories
        ));
    }
}
