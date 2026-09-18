#[cfg(windows)]
mod acceptance {
    use fstty_broker::{protocol::*, windows};
    use russh::{client, server, Channel, ChannelId};
    use std::{
        os::windows::io::AsRawHandle,
        ptr::{null, null_mut},
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
    };
    use windows_sys::Win32::{
        Foundation::*,
        Security::*,
        Storage::FileSystem::*,
        System::{Pipes::*, Services::*, Threading::*},
    };
    use zeroize::Zeroizing;

    struct Fixture {
        attempts: Arc<AtomicUsize>,
        channels: Vec<Channel<server::Msg>>,
    }
    impl server::Handler for Fixture {
        type Error = russh::Error;
        async fn auth_password(
            &mut self,
            _: &str,
            password: &str,
        ) -> Result<server::Auth, Self::Error> {
            self.attempts.fetch_add(1, Ordering::SeqCst);
            Ok(if password == "FsTTY-acceptance-only-2026" {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            })
        }
        async fn channel_open_session(
            &mut self,
            channel: Channel<server::Msg>,
            reply: server::ChannelOpenHandle,
            _: &mut server::Session,
        ) -> Result<(), Self::Error> {
            self.channels.push(channel);
            reply.accept().await;
            Ok(())
        }
        async fn exec_request(
            &mut self,
            id: ChannelId,
            _: &[u8],
            s: &mut server::Session,
        ) -> Result<(), Self::Error> {
            s.channel_success(id)?;
            s.data(id, b"acceptance-ok".to_vec())?;
            s.exit_status_request(id, 0)?;
            s.eof(id)?;
            s.close(id)
        }
    }
    struct Client;
    impl client::Handler for Client {
        type Error = russh::Error;
        async fn check_server_key(
            &mut self,
            _: &russh::keys::PublicKey,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }

    fn check(value: bool, label: &str) -> Result<(), String> {
        if value {
            println!("通过：{label}");
            Ok(())
        } else {
            Err(format!("未通过：{label}"))
        }
    }
    async fn request(request: Request) -> Result<Response, String> {
        windows::request(&request).await
    }
    fn ticket(response: Response) -> Result<String, String> {
        match response {
            Response::Staged { ticket } => Ok(ticket),
            _ => Err("没有测试请求凭证".into()),
        }
    }

    pub async fn run(args: &[String]) -> Result<(), String> {
        match args {
            [mode] if mode == "--pipe-info" => {
                for access in [0, 1, 2, 3, 0x80, 0x100000, 0x20000, 0x120003] {
                    let raw = windows::Handle(unsafe {
                        CreateFileW(
                            windows::wide(PIPE).as_ptr(),
                            access,
                            0,
                            null(),
                            OPEN_EXISTING,
                            FILE_FLAG_OVERLAPPED | SECURITY_IDENTIFICATION | SECURITY_SQOS_PRESENT,
                            null_mut(),
                        )
                    });
                    println!(
                        "访问掩码 {access:x}，成功：{}，错误：{}",
                        raw.0 != INVALID_HANDLE_VALUE,
                        unsafe { GetLastError() }
                    );
                    drop(raw);
                }
                let pipe = windows::connect().await?;
                let mut sd = null_mut();
                let code = unsafe {
                    windows_sys::Win32::Security::Authorization::GetSecurityInfo(
                        pipe.as_raw_handle(),
                        windows_sys::Win32::Security::Authorization::SE_KERNEL_OBJECT,
                        DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
                        null_mut(),
                        null_mut(),
                        null_mut(),
                        null_mut(),
                        &mut sd,
                    )
                };
                if code != 0 {
                    return Err(format!("无法查询管道安全描述符 {code}"));
                }
                let _sd = windows::Local(sd);
                let mut text = null_mut();
                if unsafe {
                    windows_sys::Win32::Security::Authorization::ConvertSecurityDescriptorToStringSecurityDescriptorW(sd,1,DACL_SECURITY_INFORMATION|LABEL_SECURITY_INFORMATION,&mut text,null_mut())
                } == 0
                {
                    return Err("无法转换管道权限".into());
                }
                let _text = windows::Local(text.cast());
                let mut n = 0;
                unsafe {
                    while *text.add(n) != 0 {
                        n += 1;
                    }
                }
                println!(
                    "{}",
                    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, n) })
                );
                Ok(())
            }
            [mode] if mode == "--status" => {
                request(Request::Status).await?;
                println!(
                    "服务可用；调用者提权状态：{}",
                    windows::current_identity()?.elevated
                );
                Ok(())
            }
            [mode, id, approval, sid, report] if mode == "--probe" => {
                let result = probe(id, approval, sid).await;
                std::fs::write(report,serde_json::to_vec(&serde_json::json!({"passed":result.is_ok(),"error":result.as_ref().err(),"sid":windows::current_identity()?.sid})).unwrap()).map_err(|_|"无法保存验收结果")?;
                result
            }
            [mode, report] if mode == "--run" => parent(report, false).await,
            [mode, report] if mode == "--run-crossaccount" => parent(report, true).await,
            [mode, id, report] if mode == "--foreign" => {
                let identity = windows::current_identity()?;
                let listed = match request(Request::List).await? {
                    Response::Profiles { profiles } => profiles.iter().any(|p| p.target.id == *id),
                    _ => return Err("列表响应无效".into()),
                };
                let rejected = request(Request::Connect {
                    id: id.clone(),
                    proxy: Default::default(),
                })
                .await
                .is_err();
                std::fs::write(
                    report,
                    serde_json::to_vec(
                        &serde_json::json!({"id":id,"sid":identity.sid,"passed":!listed&&rejected}),
                    )
                    .unwrap(),
                )
                .map_err(|_| "无法保存跨账号验收结果")?;
                check(!listed && rejected, "另一账号无法查看或连接测试会话")
            }
            _ => Err("使用 --status、--run <报告路径> 或内部 --probe 模式".into()),
        }
    }

    async fn parent(report: &str, cross_account: bool) -> Result<(), String> {
        let owner = windows::current_identity()?;
        check(owner.elevated, "验收控制端已提权")?;
        request(Request::Status).await?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|_| "无法启动测试 SSH")?;
        let port = listener.local_addr().unwrap().port();
        let attempts = Arc::new(AtomicUsize::new(0));
        let counter = attempts.clone();
        let config = fstty_broker::proxy::server_config()?;
        let fixture = tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    break;
                };
                let handler = Fixture {
                    attempts: counter.clone(),
                    channels: vec![],
                };
                let config = config.clone();
                tokio::spawn(async move {
                    if let Ok(session) = server::run_stream(config, socket, handler).await {
                        let _ = session.await;
                    }
                });
            }
        });
        let id = uuid::Uuid::new_v4().to_string();
        let pending = ticket(
            request(Request::StageImport {
                proxy: Default::default(),
                target: Target {
                    id: id.clone(),
                    host: "127.0.0.1".into(),
                    port,
                    username: "acceptance".into(),
                    private_key: false,
                },
                secrets: Secrets {
                    password: Zeroizing::new("FsTTY-acceptance-only-2026".into()),
                    ..Default::default()
                },
            })
            .await?,
        )?;
        request(Request::Review {
            ticket: pending.clone(),
        })
        .await?;
        check(attempts.load(Ordering::SeqCst) == 0, "审批探测不发送密码")?;
        request(Request::Approve {
            ticket: pending,
            secrets: None,
        })
        .await?;
        let pending = ticket(
            request(Request::Stage {
                proxy: Default::default(),
                change: Change::Trust { id: id.clone() },
            })
            .await?,
        )?;
        let child_report = format!("{report}.child.json");
        let approval = pending.clone();
        let child_sid = owner.sid.clone();
        let child_id = id.clone();
        let child_file = child_report.clone();
        let tested = tokio::task::spawn_blocking(move || {
            limited_child(&child_id, &approval, &child_sid, &child_file)
        })
        .await
        .map_err(|_| "无法等待普通权限测试进程")?;
        let foreign = if cross_account {
            std::fs::write(
                format!("{report}.ready.json"),
                serde_json::to_vec(&serde_json::json!({"id":id})).unwrap(),
            )
            .map_err(|_| "无法保存跨账号测试标识")?;
            let started = std::time::Instant::now();
            loop {
                let value = std::fs::read(format!("{report}.foreign.json"))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
                if let Some(value) = value.filter(|v| v["id"].as_str() == Some(id.as_str())) {
                    break check(
                        value["passed"] == true
                            && value["sid"].as_str() != Some(owner.sid.as_str()),
                        "另一真实 SID 的访问被隔离",
                    );
                }
                if started.elapsed() > std::time::Duration::from_secs(50) {
                    break Err("等待另一账号验收超时".into());
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        } else {
            Ok(())
        };
        let tested = tested.and(foreign);
        let ciphertext = std::fs::read(windows::data_dir()?.join("credentials.v1.db"))
            .map_err(|_| "无法检查密文数据库")?;
        let clean = !ciphertext
            .windows(b"FsTTY-acceptance-only-2026".len())
            .any(|b| b == b"FsTTY-acceptance-only-2026");
        request(Request::Cancel { ticket: pending }).await?;
        let deletion = ticket(
            request(Request::Stage {
                proxy: Default::default(),
                change: Change::Delete { id: id.clone() },
            })
            .await?,
        )?;
        request(Request::Approve {
            ticket: deletion,
            secrets: None,
        })
        .await?;
        fixture.abort();
        std::fs::write(report,serde_json::to_vec_pretty(&serde_json::json!({"passed":tested.is_ok()&&clean,"child":child_report,"ownerSid":owner.sid,"ciphertextOnly":clean,"testCredentialDeleted":true,"authenticationCount":attempts.load(Ordering::SeqCst),"error":tested.as_ref().err()})).unwrap()).map_err(|_|"无法保存验收报告")?;
        tested?;
        check(clean, "数据库不含测试明文")
    }

    fn limited_child(id: &str, approval: &str, sid: &str, report: &str) -> Result<(), String> {
        // 使用交互桌面的普通权限令牌；子进程还会独立检查同一 SID 和未提权状态。
        let shell = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetShellWindow() };
        let mut shell_pid = 0;
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(
                shell,
                &mut shell_pid,
            );
        }
        let shell_process = windows::Handle(unsafe {
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, shell_pid)
        });
        let mut raw = null_mut();
        if shell_process.0.is_null()
            || unsafe { OpenProcessToken(shell_process.0, TOKEN_QUERY | TOKEN_DUPLICATE, &mut raw) }
                == 0
        {
            return Err("无法读取普通桌面令牌".into());
        }
        let token = windows::Handle(raw);
        let mut primary = null_mut();
        if unsafe {
            DuplicateTokenEx(
                token.0,
                TOKEN_ALL_ACCESS,
                null(),
                SecurityImpersonation,
                TokenPrimary,
                &mut primary,
            )
        } == 0
        {
            return Err("无法复制普通权限测试令牌".into());
        }
        let limited = windows::Handle(primary);
        let exe = std::env::current_exe().map_err(|_| "无法定位验收程序")?;
        if [report, sid, id, approval].iter().any(|s| s.contains('"')) {
            return Err("验收参数无效".into());
        }
        let mut command = windows::wide(&format!(
            "\"{}\" --probe {id} {approval} {sid} \"{report}\"",
            exe.display()
        ));
        let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe {
            CreateProcessWithTokenW(
                limited.0,
                0,
                windows::wide(&exe.to_string_lossy()).as_ptr(),
                command.as_mut_ptr(),
                CREATE_NO_WINDOW,
                null(),
                null(),
                &startup,
                &mut process,
            )
        } == 0
        {
            return Err(format!(
                "无法启动同账号普通权限测试进程（{}）",
                unsafe { GetLastError() }
            ));
        }
        let process_handle = windows::Handle(process.hProcess);
        let _thread = windows::Handle(process.hThread);
        if unsafe { WaitForSingleObject(process_handle.0, 60000) } != WAIT_OBJECT_0 {
            return Err("普通权限验收超时".into());
        }
        let mut code = 1;
        unsafe {
            GetExitCodeProcess(process_handle.0, &mut code);
        }
        check(code == 0, "同账号普通权限隔离及连接测试")
    }

    async fn probe(id: &str, approval: &str, sid: &str) -> Result<(), String> {
        let identity = windows::current_identity()?;
        check(
            !identity.elevated && identity.sid == sid,
            "确认为同账号未提权进程",
        )?;
        check(
            matches!(std::fs::File::open(windows::data_dir()?.join("credentials.v1.db")),Err(e) if e.raw_os_error()==Some(5)),
            "无法读取数据库",
        )?;
        check(
            std::fs::OpenOptions::new()
                .write(true)
                .open(windows::installed_exe()?)
                .is_err(),
            "无法替换服务程序",
        )?;
        let scm = unsafe { OpenSCManagerW(null(), null(), SC_MANAGER_CONNECT) };
        if scm.is_null() {
            return Err("无法读取 SCM".into());
        }
        let query =
            unsafe { OpenServiceW(scm, windows::wide(SERVICE).as_ptr(), SERVICE_QUERY_STATUS) };
        let change =
            unsafe { OpenServiceW(scm, windows::wide(SERVICE).as_ptr(), SERVICE_CHANGE_CONFIG) };
        let denied = change.is_null();
        if !change.is_null() {
            unsafe {
                CloseServiceHandle(change);
            }
        }
        let mut status: SERVICE_STATUS_PROCESS = unsafe { std::mem::zeroed() };
        let mut needed = 0;
        let queried = unsafe {
            QueryServiceStatusEx(
                query,
                SC_STATUS_PROCESS_INFO,
                (&mut status as *mut SERVICE_STATUS_PROCESS).cast(),
                std::mem::size_of::<SERVICE_STATUS_PROCESS>() as u32,
                &mut needed,
            )
        };
        unsafe {
            CloseServiceHandle(query);
            CloseServiceHandle(scm);
        }
        check(denied && queried != 0, "可以查询服务状态，不能修改服务配置")?;
        let memory = windows::Handle(unsafe {
            OpenProcess(
                PROCESS_VM_READ | PROCESS_QUERY_INFORMATION,
                0,
                status.dwProcessId,
            )
        });
        check(memory.0.is_null(), "无法读取服务进程内存")?;
        let forged = windows::Handle(unsafe {
            CreateNamedPipeW(
                windows::wide(PIPE).as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
                PIPE_REJECT_REMOTE_CLIENTS,
                255,
                4096,
                4096,
                0,
                null(),
            )
        });
        check(
            forged.0 == INVALID_HANDLE_VALUE,
            "无法创建伪造服务端管道实例",
        )?;
        check(
            request(Request::Approve {
                ticket: approval.into(),
                secrets: None,
            })
            .await
            .is_err(),
            "有效请求也不能绕过提权审批",
        )?;
        let mut pipe = windows::connect().await?;
        let mut pid = 0;
        unsafe {
            GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid);
        }
        check(pid == status.dwProcessId, "连接的是 SCM 登记的服务进程")?;
        fstty_broker::protocol::write(
            &mut pipe,
            &Request::Connect {
                id: id.into(),
                proxy: Default::default(),
            },
        )
        .await?;
        match fstty_broker::protocol::read(&mut pipe).await? {
            Response::Connected => {}
            Response::Error { message } => return Err(message),
            _ => return Err("SSH 连接响应无效".into()),
        }
        let mut client = client::connect_stream(Arc::new(client::Config::default()), pipe, Client)
            .await
            .map_err(|_| "代理 SSH 握手失败")?;
        check(
            client
                .authenticate_none("fstty")
                .await
                .map_err(|_| "代理身份确认失败")?
                .success(),
            "普通客户端连接无需接收密码",
        )?;
        let mut channel = client
            .channel_open_session()
            .await
            .map_err(|_| "无法打开命令通道")?;
        channel
            .exec(true, "fixture-only")
            .await
            .map_err(|_| "测试命令失败")?;
        let mut output = Vec::new();
        while let Some(message) = channel.wait().await {
            if let russh::ChannelMsg::Data { data } = message {
                output.extend_from_slice(&data);
            }
        }
        check(output == b"acceptance-ok", "服务持有 SSH 并返回命令结果")?;
        client
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await
            .map_err(|_| "无法关闭测试连接")?;
        Ok(())
    }
}

#[cfg(windows)]
#[tokio::main]
async fn main() {
    if let Err(error) = acceptance::run(&std::env::args().skip(1).collect::<Vec<_>>()).await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
#[cfg(not(windows))]
fn main() {
    eprintln!("仅在 Windows 运行权限验收");
}
