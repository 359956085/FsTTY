use super::{
    discovery,
    pipe::DuplexPipe,
    protocol::{self, Request, Response, Startup},
    startup_errors as startup,
    windows::{self, Handle},
};
use std::{
    fs::File,
    io::{Read, Write},
    mem::{size_of, zeroed},
    os::windows::io::{AsRawHandle, FromRawHandle},
    ptr::{null, null_mut},
    sync::{mpsc, Arc},
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::*,
    Storage::FileSystem::SYNCHRONIZE,
    System::{Console::*, JobObjects::*, Pipes::*, Threading::*},
};

struct PseudoConsole(HPCON);
impl Drop for PseudoConsole {
    fn drop(&mut self) {
        unsafe {
            ClosePseudoConsole(self.0);
        }
    }
}
struct Attributes(Vec<usize>);
impl Attributes {
    fn new(console: HPCON) -> Result<Self, String> {
        let mut size = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size);
        }
        let mut buffer = vec![0; size.div_ceil(size_of::<usize>())];
        if unsafe { InitializeProcThreadAttributeList(buffer.as_mut_ptr().cast(), 1, 0, &mut size) }
            == 0
        {
            return Err(windows::error("无法初始化终端进程属性"));
        }
        let mut value = Self(buffer);
        if unsafe {
            UpdateProcThreadAttribute(
                value.0.as_mut_ptr().cast(),
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                console as *const _,
                size_of::<HPCON>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(windows::error("无法绑定 ConPTY"));
        }
        Ok(value)
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.0.as_mut_ptr().cast());
        }
    }
}

fn anonymous_pipe() -> Result<(File, File), String> {
    let mut read = null_mut();
    let mut write = null_mut();
    if unsafe { CreatePipe(&mut read, &mut write, null(), 65536) } == 0 {
        return Err(windows::error("无法创建终端数据管道"));
    }
    Ok(unsafe { (File::from_raw_handle(read), File::from_raw_handle(write)) })
}

fn open_parent_pipe(parent_id: u32, nonce: &str) -> Result<(DuplexPipe, Arc<Handle>), String> {
    let parent = Arc::new(Handle(unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
            0,
            parent_id,
        )
    }));
    if parent.0.is_null() {
        return Err(windows::error("本地终端父进程已退出"));
    }
    windows::verify_image(parent.0)?;
    let pipe = DuplexPipe::connect(&windows::pipe_name(nonce))
        .map_err(|e| startup::failure("host-pipe-connect", e))?;
    let mut server = 0;
    if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut server) } == 0 {
        return Err(startup::security(
            "pipe-server-query",
            std::io::Error::last_os_error(),
        ));
    }
    if server != parent_id || unsafe { WaitForSingleObject(parent.0, 0) } != WAIT_TIMEOUT {
        return Err(startup::security(
            "pipe-server",
            "PID mismatch or parent exited",
        ));
    }
    Ok((pipe, parent))
}

pub(super) fn run(arguments: &[String]) -> Result<(), String> {
    if arguments.len() != 2 {
        return Err("本地终端 host 参数无效".into());
    }
    let parent_id = arguments[0].parse::<u32>().map_err(|_| "父进程 ID 无效")?;
    let nonce = uuid::Uuid::parse_str(&arguments[1])
        .map_err(|_| "本地终端请求 ID 无效")?
        .to_string();
    let (mut pipe, parent) = open_parent_pipe(parent_id, &nonce)?;
    // A parent crash must end even a host blocked in a PTY write or pipe read.
    std::thread::spawn(move || unsafe {
        WaitForSingleObject(parent.0, INFINITE);
        TerminateProcess(GetCurrentProcess(), 1);
    });
    protocol::write(&mut pipe, &Response::Hello { nonce })
        .map_err(|e| startup::failure("host-hello", e))?;
    let request: Request =
        protocol::read(&mut pipe).map_err(|e| startup::failure("host-startup-read", e))?;
    let Request::Start(startup) = request else {
        return Err(startup::security(
            "host-startup-order",
            "unexpected request",
        ));
    };
    match serve(&mut pipe, startup) {
        Ok(()) => Ok(()),
        Err(message) => {
            let _ = protocol::write(
                &mut pipe,
                &Response::Error {
                    message: message.clone(),
                },
            );
            Err(message)
        }
    }
}

fn serve(pipe: &mut DuplexPipe, startup: Startup) -> Result<(), String> {
    if !protocol::dimensions(startup.columns, startup.rows)
        || startup.directory.len() > 4096
        || startup.directory.chars().any(char::is_control)
    {
        return Err(startup::failure(
            "host-startup-validation",
            "invalid directory encoding or dimensions",
        ));
    }
    if !std::path::Path::new(&startup.directory).is_absolute()
        || !std::path::Path::new(&startup.directory).is_dir()
    {
        return Err(startup::diagnostic(
            startup::DIRECTORY,
            "host-directory",
            "not an accessible absolute directory",
        ));
    }
    let identity = fstty_broker::windows::current_identity()
        .map_err(|e| startup::security("host-identity", e))?;
    if identity.elevated != startup.elevated {
        return Err(startup::security("host-rights", "actual rights mismatch"));
    }
    let program = discovery::resolve(startup.shell)?;
    let highlight = super::highlighting::prepare(
        startup.shell,
        &program.args.join(" "),
        startup.highlight_token.as_deref(),
        identity.elevated,
    );
    // The dedicated host does not load users' Clink paths/inputrc or registry scripts.
    if startup.highlight_token.is_some() && startup.shell == crate::models::LocalShell::Cmd {
        std::env::remove_var("CLINK_PATH");
        std::env::remove_var("CLINK_PROFILE");
        std::env::remove_var("CLINK_INPUTRC");
        std::env::set_var("CLINK_NOAUTORUN", "1");
        std::env::set_var("FSTTY_HIGHLIGHT_ONLY", "1");
        std::env::set_var("CLINK_NO_REMOTE_COLORING", "1");
    }
    let (input_read, mut input_write) = anonymous_pipe()?;
    let (mut output_read, output_write) = anonymous_pipe()?;
    let mut raw_console = 0;
    let size = COORD {
        X: startup.columns as i16,
        Y: startup.rows as i16,
    };
    let hr = unsafe {
        CreatePseudoConsole(
            size,
            input_read.as_raw_handle(),
            output_write.as_raw_handle(),
            0,
            &mut raw_console,
        )
    };
    if hr < 0 {
        return Err(startup::failure(
            "conpty-create",
            format!("HRESULT={hr:#x}"),
        ));
    }
    let console = PseudoConsole(raw_console);
    // The ignore-Ctrl+C process attribute is inherited by child processes.
    // Reset it in this dedicated host before starting interactive shells.
    unsafe {
        SetConsoleCtrlHandler(None, 0);
    }
    let mut attributes = Attributes::new(console.0)?;
    let job = Handle(unsafe { CreateJobObjectW(null(), null()) });
    if job.0.is_null() {
        return Err(windows::error("无法创建本地终端进程组"));
    }
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err(windows::error("无法设置进程组回收"));
    }
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
    let mut info: STARTUPINFOEXW = unsafe { zeroed() };
    info.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    // Null standard handles let ConPTY install its own console handles, even
    // when FsTTY was launched by a process with redirected standard streams.
    info.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    info.lpAttributeList = attributes.0.as_mut_ptr().cast();
    let mut command = windows::wide(format!(
        "{} {}",
        windows::quote(&program.path),
        highlight.arguments
    ));
    let directory = windows::wide(&startup.directory);
    // Git's login profile respects the selected directory when this is set.
    // The host is dedicated to this terminal and launches exactly one shell.
    if startup.shell == crate::models::LocalShell::GitBash {
        std::env::set_var("CHERE_INVOKING", "1");
    }
    if unsafe {
        CreateProcessW(
            null(),
            command.as_mut_ptr(),
            null(),
            null(),
            0,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
            null(),
            directory.as_ptr(),
            &info.StartupInfo,
            &mut process,
        )
    } == 0
    {
        return Err(windows::error("无法启动本地 shell"));
    }
    let child = windows::ChildProcess(Handle(process.hProcess));
    let thread = Handle(process.hThread);
    drop(input_read);
    drop(output_write);
    if unsafe { AssignProcessToJobObject(job.0, child.0 .0) } == 0 {
        return Err(windows::error("无法保护本地终端子进程"));
    }

    let (output_tx, output_rx) = mpsc::sync_channel::<Vec<u8>>(8);
    let mut highlight_stages =
        super::highlighting::StageObserver::new(startup.highlight_token.as_deref());
    let reader = std::thread::spawn(move || {
        let mut buffer = [0; 16384];
        let mut forwarding = true;
        while let Ok(size) = output_read.read(&mut buffer) {
            if size == 0 {
                break;
            }
            if let Some(stage) = highlight_stages.observe(&buffer[..size]) {
                crate::logging::record_local_terminal_host_failure(&format!(
                    "local-highlight stage={stage}: shell initialization unavailable"
                ));
            }
            if forwarding && output_tx.send(buffer[..size].to_vec()).is_err() {
                forwarding = false;
            }
            // Always drain through ClosePseudoConsole, even after the GUI exits.
        }
    });
    if unsafe { ResumeThread(thread.0) } == u32::MAX {
        return Err(windows::error("无法继续本地终端进程"));
    }
    protocol::write(
        pipe,
        &Response::Ready {
            elevated: identity.elevated,
            label: program.label,
            highlight: highlight.info.clone(),
        },
    )
    .map_err(|e| startup::failure("host-ready-write", e))?;
    let mut output_pipe = pipe.clone();
    let (exit_tx, exit_rx) = mpsc::sync_channel(1);
    let writer = std::thread::spawn(move || {
        while let Ok(mut data) = output_rx.recv() {
            while data.len() < 65536 {
                match output_rx.try_recv() {
                    Ok(next) => data.extend(next),
                    Err(_) => break,
                }
            }
            if protocol::write(&mut output_pipe, &Response::Data { data }).is_err() {
                return;
            }
        }
        if let Ok(code) = exit_rx.recv() {
            let _ = protocol::write(&mut output_pipe, &Response::Exit { code });
        }
    });
    let (control_tx, control_rx) = mpsc::sync_channel(16);
    let mut control_pipe = pipe.clone();
    std::thread::spawn(move || {
        while let Ok(request) = protocol::read::<Request>(&mut control_pipe) {
            if control_tx.send(request).is_err() {
                break;
            }
        }
    });
    let (input_tx, input_rx) = mpsc::sync_channel::<Vec<u8>>(16);
    std::thread::spawn(move || {
        for data in input_rx {
            if input_write.write_all(&data).is_err() {
                break;
            }
        }
    });

    let mut exit_code = None;
    let mut dimensions = (startup.columns, startup.rows);
    loop {
        if unsafe { WaitForSingleObject(child.0 .0, 0) } == WAIT_OBJECT_0 {
            let mut code = 0;
            if unsafe { GetExitCodeProcess(child.0 .0, &mut code) } != 0 {
                exit_code = Some(code);
            }
            break;
        }
        match control_rx.recv_timeout(Duration::from_millis(20)) {
            Ok(Request::Input { data }) if data.len() <= protocol::MAX_INPUT => {
                // Apply bounded backpressure to writes. The GUI owns an
                // independent process handle and can stop a blocked host.
                if input_tx.send(data).is_err() {
                    break;
                }
            }
            Ok(Request::Resize { columns, rows }) if protocol::dimensions(columns, rows) => unsafe {
                if dimensions == (columns, rows) {
                    continue;
                }
                let result = ResizePseudoConsole(
                    console.0,
                    COORD {
                        X: columns as i16,
                        Y: rows as i16,
                    },
                );
                if result >= 0 {
                    dimensions = (columns, rows);
                }
            },
            Ok(Request::Stop {}) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            _ => break,
        }
    }
    unsafe {
        TerminateJobObject(job.0, 1);
    }
    drop(input_tx);
    drop(console);
    let _ = reader.join();
    let _ = exit_tx.send(exit_code);
    let _ = writer.join();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::LocalShell;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use tokio::net::windows::named_pipe::NamedPipeServer;

    fn fixture(role: &str, directory: &std::path::Path) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", "services::local_terminal_service::host::tests::conpty_authenticated_host_and_parent_crash_cleanup", "--ignored", "--nocapture"]);
        command
            .env("FSTTY_TEST_LOCAL_ROLE", role)
            .env("FSTTY_TEST_LOCAL_DIRECTORY", directory)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        command
    }

    async fn wait_for_file(path: &std::path::Path) {
        tokio::time::timeout(Duration::from_secs(20), async {
            while !path.is_file() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    #[ignore = "Requires an isolated Windows verification environment"]
    async fn conpty_authenticated_host_and_parent_crash_cleanup() {
        let role = std::env::var("FSTTY_TEST_LOCAL_ROLE").unwrap_or_default();
        if role == "host" {
            run(&[
                std::env::var("FSTTY_TEST_PARENT_ID").unwrap(),
                std::env::var("FSTTY_TEST_PIPE_NONCE").unwrap(),
            ])
            .unwrap();
            return;
        }
        if role == "parent" {
            let directory =
                std::path::PathBuf::from(std::env::var_os("FSTTY_TEST_LOCAL_DIRECTORY").unwrap());
            let nonce = uuid::Uuid::new_v4().to_string();
            let mut pipe = windows::listener(&nonce).unwrap();
            let child = fixture("host", &directory)
                .env("FSTTY_TEST_PARENT_ID", std::process::id().to_string())
                .env("FSTTY_TEST_PIPE_NONCE", &nonce)
                .spawn()
                .unwrap();
            // Borrow the std::process::Child handle without closing it twice.
            let process = std::mem::ManuallyDrop::new(Handle(child.as_raw_handle()));
            pipe.connect().await.unwrap();
            let wrong_process = std::mem::ManuallyDrop::new(Handle(unsafe { GetCurrentProcess() }));
            assert!(windows::verify_client(&pipe, &wrong_process).is_err());
            windows::verify_client(&pipe, &process).unwrap();
            assert!(
                matches!(protocol::receive::<Response>(&mut pipe).await.unwrap(), Response::Hello { nonce: actual } if actual == nonce)
            );
            protocol::send(
                &mut pipe,
                &Request::Start(Startup {
                    shell: LocalShell::Powershell,
                    directory: directory.display().to_string(),
                    columns: 100,
                    rows: 30,
                    elevated: fstty_broker::windows::current_identity().unwrap().elevated,
                    highlight_token: None,
                }),
            )
            .await
            .unwrap();
            assert!(matches!(
                protocol::receive::<Response>(&mut pipe).await.unwrap(),
                Response::Ready { .. }
            ));
            send_input(&mut pipe, "$PID | Set-Content shell.pid; Write-Output ('FSTTY_' + 'CRASH_READY'); Start-Sleep -Seconds 60\r").await;
            read_until(&mut pipe, "FSTTY_CRASH_READY").await;
            std::fs::write(directory.join("host.pid"), child.id().to_string()).unwrap();
            wait_for_file(&directory.join("crash.now")).await;
            // Simulate a GUI crash: bypass Rust drops and all graceful cleanup.
            std::process::exit(0);
        }
        let directory =
            std::env::temp_dir().join(format!("fstty-parent-crash-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let mut parent = fixture("parent", &directory).spawn().unwrap();
        let result = tokio::time::timeout(Duration::from_secs(30), async {
            wait_for_file(&directory.join("host.pid")).await;
            let processes: Vec<_> = ["host.pid", "shell.pid"].into_iter().map(|file| {
                let pid = std::fs::read_to_string(directory.join(file)).unwrap().trim().parse::<u32>().unwrap();
                let process = Handle(unsafe { OpenProcess(SYNCHRONIZE, 0, pid) });
                assert!(!process.0.is_null());
                assert_eq!(unsafe { WaitForSingleObject(process.0, 0) }, WAIT_TIMEOUT);
                process
            }).collect();
            std::fs::write(directory.join("crash.now"), b"").unwrap();
            for process in processes {
                assert_eq!(unsafe { WaitForSingleObject(process.0, 5000) }, WAIT_OBJECT_0);
            }
            eprintln!("PASS authenticated pipe: both PIDs/images matched; parent crash reclaimed host and PTY shell");
        }).await;
        let _ = parent.kill();
        let _ = parent.wait();
        let _ = std::fs::remove_dir_all(directory);
        result.unwrap();
    }

    async fn send_input(pipe: &mut NamedPipeServer, input: &str) {
        protocol::send(
            pipe,
            &Request::Input {
                data: input.as_bytes().to_vec(),
            },
        )
        .await
        .unwrap();
    }

    async fn read_until(pipe: &mut NamedPipeServer, marker: &str) -> String {
        read_until_recorded(pipe, marker, None).await
    }

    async fn read_until_recorded(
        pipe: &mut NamedPipeServer,
        marker: &str,
        trace: Option<&std::path::Path>,
    ) -> String {
        let mut bytes = Vec::new();
        loop {
            match protocol::receive::<Response>(pipe).await.unwrap() {
                Response::Data { data } => {
                    // Reply to the console's cursor-position query like xterm.
                    if data.windows(4).any(|value| value == b"\x1b[6n") {
                        send_input(pipe, "\x1b[1;1R").await;
                    }
                    bytes.extend(data);
                    let output = String::from_utf8_lossy(&bytes);
                    if let Some(path) = trace {
                        std::fs::write(path, output.as_bytes()).unwrap();
                    }
                    if output.contains(marker) {
                        return output.into_owned();
                    }
                }
                other => panic!(
                    "shell exited early: {other:?}; output: {}",
                    String::from_utf8_lossy(&bytes)
                ),
            }
        }
    }

    #[tokio::test]
    #[ignore = "Requires a dedicated Windows PowerShell fixture directory; no UAC or user commands"]
    async fn conpty_highlight_powershell_fixture() {
        let root = std::path::PathBuf::from(
            std::env::var_os("FSTTY_HIGHLIGHT_FIXTURE_ROOT")
                .expect("explicit fixture root required"),
        );
        let directory = root.join(format!("powershell-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        std::fs::create_dir(directory.join("FixtureFolder")).unwrap();
        let token = "e6b4ea51-2f6b-4449-9550-f4b20082a620";
        let elevated = fstty_broker::windows::current_identity().unwrap().elevated;
        let nonce = uuid::Uuid::new_v4().to_string();
        let mut pipe = windows::listener(&nonce).unwrap();
        let path = directory.display().to_string();
        let helper = std::thread::spawn(move || {
            let mut client = DuplexPipe::connect(&windows::pipe_name(&nonce)).unwrap();
            serve(
                &mut client,
                Startup {
                    shell: LocalShell::Powershell,
                    directory: path,
                    columns: 200,
                    rows: 30,
                    elevated,
                    highlight_token: Some(token.into()),
                },
            )
        });
        let result = tokio::time::timeout(Duration::from_secs(30), async {
            pipe.connect().await.unwrap();
            match protocol::receive::<Response>(&mut pipe).await.unwrap() {
                Response::Ready { highlight: Some(_), elevated: actual, label, .. } => {
                    assert_eq!(actual, elevated);
                    std::fs::write(root.join("powershell-fixture-info.json"),
                        serde_json::to_vec_pretty(&serde_json::json!({"shell": label, "elevated": actual, "uacRequested": false})).unwrap()).unwrap();
                }
                other => panic!("unexpected startup response: {other:?}"),
            }
            let mut trace = read_until_recorded(&mut pipe, &format!("fstty-highlight:{token}:input"), Some(&root.join("powershell-progress.txt"))).await;
            assert!(trace.contains(&format!("fstty-highlight:{token}:ready")));
            for command in ["Write-Output ('ERROR: ' + 'fixture')\r", "Get-ChildItem\r"] {
                send_input(&mut pipe, command).await;
                trace.push_str(
                    &read_until(&mut pipe, &format!("fstty-highlight:{token}:input")).await,
                );
            }
            assert!(!trace.contains(&format!("fstty-highlight:{token}:failed:")));
            let execute = format!("fstty-highlight:{token}:execute");
            let prompt = format!("fstty-highlight:{token}:prompt");
            let output = trace
                .split(&execute)
                .nth(1)
                .unwrap()
                .split(&prompt)
                .next()
                .unwrap();
            assert!(output.contains("ERROR: fixture"));
            std::fs::write(root.join("powershell-trace.txt"), trace).unwrap();
            protocol::send(&mut pipe, &Request::Stop {}).await.unwrap();
        })
        .await;
        let _ = protocol::send(&mut pipe, &Request::Stop {}).await;
        drop(pipe);
        helper.join().unwrap().unwrap();
        result.expect("PowerShell highlight fixture timed out");
    }

    // Run the compiled test executable inside Windows Sandbox. All file writes
    // are confined to a fresh test directory; this never requests elevation.
    #[tokio::test]
    #[ignore = "Requires a dedicated Windows CMD fixture directory; no UAC or user commands"]
    async fn conpty_highlight_cmd_fixture() {
        let root = std::path::PathBuf::from(
            std::env::var_os("FSTTY_HIGHLIGHT_FIXTURE_ROOT")
                .expect("explicit fixture root required"),
        );
        let directory = root.join(format!("cmd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        std::fs::create_dir(directory.join("FixtureFolder")).unwrap();
        std::fs::create_dir(directory.join("FixtureFolder").join("InnerFolder")).unwrap();
        let token = "e6b4ea51-2f6b-4449-9550-f4b20082a620";
        let elevated = fstty_broker::windows::current_identity().unwrap().elevated;
        let nonce = uuid::Uuid::new_v4().to_string();
        let mut pipe = windows::listener(&nonce).unwrap();
        let path = directory.display().to_string();
        let helper = std::thread::spawn(move || {
            let mut client = DuplexPipe::connect(&windows::pipe_name(&nonce)).unwrap();
            serve(
                &mut client,
                Startup {
                    shell: LocalShell::Cmd,
                    directory: path,
                    columns: 200,
                    rows: 12,
                    elevated,
                    highlight_token: Some(token.into()),
                },
            )
        });
        let result = tokio::time::timeout(Duration::from_secs(30), async {
            pipe.connect().await.unwrap();
            assert!(matches!(
                protocol::receive::<Response>(&mut pipe).await.unwrap(),
                Response::Ready {
                    highlight: Some(_),
                    ..
                }
            ));
            let mut trace = read_until(&mut pipe, &format!("fstty-highlight:{token}:input")).await;
            for command in [
                "fstty_missing_fixture_command\r",
                "dir\r",
                "cd FixtureFolder\r",
                "dir\r",
                "cd ..\r",
                "dir\r",
            ] {
                send_input(&mut pipe, command).await;
                trace.push_str(
                    &read_until(&mut pipe, &format!("fstty-highlight:{token}:input")).await,
                );
            }
            if std::env::var_os("FSTTY_TEST_HIGHLIGHT_RESIZE").is_some() {
                // The input marker may precede the final cursor-visibility data.
                while let Ok(Ok(Response::Data { data })) = tokio::time::timeout(
                    Duration::from_millis(300),
                    protocol::receive::<Response>(&mut pipe),
                )
                .await
                {
                    trace.push_str(&String::from_utf8_lossy(&data));
                }
                protocol::send(
                    &mut pipe,
                    &Request::Resize {
                        columns: 200,
                        rows: 12,
                    },
                )
                .await
                .unwrap();
                let mut redraw = Vec::new();
                while let Ok(Ok(Response::Data { data })) = tokio::time::timeout(
                    Duration::from_millis(300),
                    protocol::receive::<Response>(&mut pipe),
                )
                .await
                {
                    redraw.extend(data);
                }
                std::fs::write(root.join("cmd-resize.txt"), &redraw).unwrap();
                assert!(
                    redraw.is_empty(),
                    "unchanged dimensions must not redraw shell history"
                );
                protocol::send(
                    &mut pipe,
                    &Request::Resize {
                        columns: 180,
                        rows: 12,
                    },
                )
                .await
                .unwrap();
                while let Ok(Ok(Response::Data { data })) = tokio::time::timeout(
                    Duration::from_millis(300),
                    protocol::receive::<Response>(&mut pipe),
                )
                .await
                {
                    redraw.extend(data);
                }
                std::fs::write(root.join("cmd-size-change.txt"), &redraw).unwrap();
                trace.push_str(&String::from_utf8_lossy(&redraw));
            }
            let execute = format!("fstty-highlight:{token}:execute");
            let prompt = format!("fstty-highlight:{token}:prompt");
            let output = trace
                .split(&execute)
                .nth(1)
                .unwrap()
                .split(&prompt)
                .next()
                .unwrap();
            assert!(output.contains("fstty_missing_fixture_command'"));
            let output = trace
                .split(&execute)
                .nth(2)
                .unwrap()
                .split(&prompt)
                .next()
                .unwrap();
            assert!(output.contains("FixtureFolder"));
            std::fs::write(root.join("cmd-trace.txt"), trace).unwrap();
            protocol::send(&mut pipe, &Request::Stop {}).await.unwrap();
        })
        .await;
        drop(pipe);
        helper.join().unwrap().unwrap();
        result.expect("highlight fixture timed out");
    }

    // Run the compiled test executable inside Windows Sandbox. All file writes
    // are confined to a fresh test directory; this never requests elevation.
    #[tokio::test]
    #[ignore = "Requires an isolated Windows verification environment"]
    async fn conpty_shells_unicode_resize_interrupt_exit_and_cleanup() {
        let elevated = fstty_broker::windows::current_identity().unwrap().elevated;
        eprintln!("Native test token elevated: {elevated}; no UAC request is made");
        let directory =
            std::env::temp_dir().join(format!("fstty 本地测试 {}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(90), async {
            for shell in [LocalShell::Cmd, LocalShell::Powershell, LocalShell::GitBash] {
                let Ok(program) = discovery::resolve(shell) else {
                    eprintln!("SKIP {shell:?}: unavailable");
                    continue;
                };
                let nonce = uuid::Uuid::new_v4().to_string();
                let mut pipe = windows::listener(&nonce).unwrap();
                let path = directory.display().to_string();
                let helper = std::thread::spawn(move || {
                    let mut client = DuplexPipe::connect(&windows::pipe_name(&nonce)).unwrap();
                    serve(&mut client, Startup { shell, directory: path, columns: 100, rows: 30, elevated, highlight_token: None })
                });
                pipe.connect().await.unwrap();
                assert!(matches!(protocol::receive::<Response>(&mut pipe).await.unwrap(), Response::Ready { elevated: actual, .. } if actual == elevated));
                eprintln!("Ready: {}", program.label);
                protocol::send(&mut pipe, &Request::Resize { columns: 110, rows: 35 }).await.unwrap();
                // A distinct prompt allows each command to finish before Ctrl+C
                // or the next command. Ctrl+C may flush buffered input itself.
                let command = match shell {
                    LocalShell::Cmd => "prompt FSTTY_PROMPT$G\recho FSTTY_中文_OUTPUT\rcd\rfor /L %i in (1,1,3000) do @echo OUTPUT_%i\r",
                    LocalShell::Powershell => "function prompt { 'FSTTY_' + 'PROMPT> ' }; Write-Output 'FSTTY_中文_OUTPUT'; (Get-Location).Path; 1..3000 | ForEach-Object { \"OUTPUT_$_\" }\r",
                    LocalShell::GitBash => "stty size; PS1='FSTTY_'\"PROMPT> \"; printf 'FSTTY_中文_OUTPUT\\n'; pwd; for i in {1..3000}; do echo OUTPUT_$i; done\r",
                };
                send_input(&mut pipe, command).await;
                let output = read_until(&mut pipe, "OUTPUT_3000").await;
                if shell == LocalShell::GitBash { assert!(output.contains("35 110")); }
                assert!(output.contains("中文"));
                assert!(output.contains("本地测试"));
                if !output.split("OUTPUT_3000").last().unwrap().contains("FSTTY_PROMPT>") {
                    read_until(&mut pipe, "FSTTY_PROMPT>").await;
                }
                eprintln!("Output completed: {} bytes", output.len());
                let (interrupt, marker) = match shell {
                    LocalShell::Cmd => ("ping -n 30 127.0.0.1\r", "TTL="),
                    LocalShell::Powershell => ("Write-Output ('FSTTY_' + 'WAITING'); Start-Sleep -Seconds 30\r", "FSTTY_WAITING"),
                    // Print readiness from inside the foreground job. Printing
                    // in the parent shell races the fork/foreground handoff.
                    LocalShell::GitBash => ("bash -c 'printf \"FSTTY_\"\"WAITING\\n\"; while :; do :; done'\r", "FSTTY_WAITING"),
                };
                send_input(&mut pipe, interrupt).await;
                read_until(&mut pipe, marker).await;
                send_input(&mut pipe, "\x03").await;
                tokio::time::timeout(Duration::from_secs(5), read_until(&mut pipe, "FSTTY_PROMPT>"))
                    .await.expect("Ctrl+C did not interrupt the foreground command promptly");
                eprintln!("Ctrl+C returned to the interactive prompt");
                if shell == LocalShell::GitBash {
                    send_input(&mut pipe, "ping.exe -n 30 127.0.0.1\r").await;
                    read_until(&mut pipe, "TTL=").await;
                    send_input(&mut pipe, "\x03").await;
                    tokio::time::timeout(Duration::from_secs(5), read_until(&mut pipe, "FSTTY_PROMPT>"))
                        .await.expect("Ctrl+C did not interrupt Git Bash's native child promptly");
                    eprintln!("Git Bash interrupted both a POSIX foreground job and a Windows child");
                }
                let descendant = if shell == LocalShell::Powershell {
                    send_input(&mut pipe, "$child = Start-Process -FilePath ($env:WINDIR + '\\System32\\ping.exe') -ArgumentList '-n 60 127.0.0.1' -WindowStyle Hidden -PassThru; $child.Id | Set-Content child.pid; Write-Output ('FSTTY_' + 'CHILD_READY')\r").await;
                    read_until(&mut pipe, "FSTTY_CHILD_READY").await;
                    let pid = std::fs::read_to_string(directory.join("child.pid")).unwrap()
                        .trim().parse::<u32>().unwrap();
                    let process = Handle(unsafe { OpenProcess(SYNCHRONIZE, 0, pid) });
                    assert!(!process.0.is_null());
                    assert_eq!(unsafe { WaitForSingleObject(process.0, 0) }, WAIT_TIMEOUT);
                    Some(process)
                } else { None };
                send_input(&mut pipe, "exit 7\r").await;
                loop {
                    match protocol::receive::<Response>(&mut pipe).await.unwrap() {
                        Response::Data { .. } => {},
                        Response::Exit { code } => { assert_eq!(code, Some(7)); break; }
                        other => panic!("unexpected terminal end: {other:?}"),
                    }
                }
                drop(pipe);
                helper.join().unwrap().unwrap();
                if let Some(descendant) = descendant {
                    assert_eq!(unsafe { WaitForSingleObject(descendant.0, 5000) }, WAIT_OBJECT_0);
                    eprintln!("Managed descendant was reclaimed on shell exit");
                }
                eprintln!("PASS {}: Unicode, spaced directory, 3000 output lines, resize, Ctrl+C, exit 7", program.label);
            }
        }).await;
        let _ = std::fs::remove_dir_all(directory);
        result.expect("ConPTY validation timed out");
    }
}
