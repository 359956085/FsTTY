use fs2::FileExt;
use sha2::{Digest, Sha256};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const RUNTIME_DIRECTORY: &str = "mcp-runtime";
const RUNTIME_PREFIX: &str = "fstty-mcp-";
const RUNTIME_SUFFIX: &str = ".exe";
const CURRENT_RUNTIME_FILE: &str = "current-runtime.txt";
const LAUNCHER_FILE: &str = "fstty-mcp.cmd";
const PREPARE_LOCK_FILE: &str = ".prepare.lock";

const LAUNCHER_CONTENT: &str = "@echo off\r\n\
setlocal DisableDelayedExpansion\r\n\
if not exist \"%~dp0current-runtime.txt\" goto unavailable\r\n\
set \"FSTTY_MCP_EXE=\"\r\n\
set /p \"FSTTY_MCP_EXE=\"<\"%~dp0current-runtime.txt\"\r\n\
if not defined FSTTY_MCP_EXE goto unavailable\r\n\
\"%~dp0%FSTTY_MCP_EXE%\" --mcp-stdio\r\n\
set \"FSTTY_MCP_EXIT=%errorlevel%\"\r\n\
endlocal & exit /b %FSTTY_MCP_EXIT%\r\n\
:unavailable\r\n\
>&2 echo FsTTY MCP runtime is unavailable. Open FsTTY and run one-click setup.\r\n\
exit /b 1\r\n";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpStdioLaunchSpec {
    pub command: String,
    pub args: Vec<String>,
}

pub fn launch_spec(app_data_dir: &Path) -> McpStdioLaunchSpec {
    let launcher = runtime_directory(app_data_dir).join(LAUNCHER_FILE);
    let command = env::var_os("COMSPEC")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| {
            env::var_os("SystemRoot")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .map(|path| path.join("System32").join("cmd.exe"))
        })
        .unwrap_or_else(|| PathBuf::from("cmd.exe"));
    McpStdioLaunchSpec {
        command: command.to_string_lossy().into_owned(),
        args: vec![
            "/d".to_owned(),
            "/s".to_owned(),
            "/c".to_owned(),
            "call".to_owned(),
            launcher.to_string_lossy().into_owned(),
        ],
    }
}

pub fn prepare(
    app_data_dir: &Path,
    source_executable: &Path,
) -> Result<McpStdioLaunchSpec, String> {
    prepare_from_source(app_data_dir, source_executable, env!("CARGO_PKG_VERSION"))?;
    Ok(launch_spec(app_data_dir))
}

fn prepare_from_source(
    app_data_dir: &Path,
    source_executable: &Path,
    version: &str,
) -> Result<PathBuf, String> {
    let directory = runtime_directory(app_data_dir);
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建 MCP 运行时目录：{error}"))?;
    let lock_path = directory.join(PREPARE_LOCK_FILE);
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|error| format!("无法打开 MCP 运行时更新锁：{error}"))?;
    FileExt::lock_exclusive(&lock).map_err(|error| format!("无法锁定 MCP 运行时更新：{error}"))?;

    let result = prepare_locked(&directory, source_executable, version);
    let unlock_result = FileExt::unlock(&lock);
    match (result, unlock_result) {
        (Ok(path), Ok(())) => Ok(path),
        (Ok(_), Err(error)) => Err(format!("无法解锁 MCP 运行时更新：{error}")),
        (Err(error), _) => Err(error),
    }
}

fn prepare_locked(
    directory: &Path,
    source_executable: &Path,
    version: &str,
) -> Result<PathBuf, String> {
    if !source_executable.is_file() {
        return Err(format!(
            "FsTTY 程序文件不存在：{}",
            source_executable.display()
        ));
    }
    let source_hash = sha256_file(source_executable)?;
    let runtime_name = format!(
        "{RUNTIME_PREFIX}{}-{source_hash}{RUNTIME_SUFFIX}",
        sanitize_version(version)
    );
    let runtime_path = directory.join(&runtime_name);
    ensure_runtime_copy(source_executable, &runtime_path, &source_hash)?;

    atomic_write_if_changed(&directory.join(LAUNCHER_FILE), LAUNCHER_CONTENT.as_bytes())?;
    atomic_write_if_changed(
        &directory.join(CURRENT_RUNTIME_FILE),
        format!("{runtime_name}\r\n").as_bytes(),
    )?;
    cleanup_old_runtimes(directory, &runtime_name);
    Ok(runtime_path)
}

fn runtime_directory(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(RUNTIME_DIRECTORY)
}

fn sanitize_version(version: &str) -> String {
    version
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("无法读取 MCP 运行时来源 {}：{error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("无法校验 MCP 运行时来源 {}：{error}", path.display()))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn ensure_runtime_copy(
    source: &Path,
    destination: &Path,
    expected_hash: &str,
) -> Result<(), String> {
    if destination.exists() {
        let existing_hash = sha256_file(destination)?;
        if existing_hash == expected_hash {
            return Ok(());
        }
        return Err(format!(
            "MCP 运行时校验失败，请重新启动 FsTTY：{}",
            destination.display()
        ));
    }

    let parent = destination
        .parent()
        .ok_or_else(|| "MCP 运行时路径缺少父目录".to_owned())?;
    let temp = parent.join(format!(".fstty-runtime-{}.tmp", Uuid::new_v4()));
    if let Err(error) = fs::copy(source, &temp) {
        return Err(format!("无法复制 MCP 运行时：{error}"));
    }
    let copied_hash = sha256_file(&temp)?;
    if copied_hash != expected_hash {
        let _ = fs::remove_file(&temp);
        return Err("MCP 运行时复制后校验失败".to_owned());
    }
    if let Err(error) = OpenOptions::new()
        .write(true)
        .open(&temp)
        .and_then(|file| file.sync_all())
    {
        let _ = fs::remove_file(&temp);
        return Err(format!("无法同步 MCP 运行时文件：{error}"));
    }
    if destination.exists() {
        let _ = fs::remove_file(&temp);
        return if sha256_file(destination)? == expected_hash {
            Ok(())
        } else {
            Err("并发创建的 MCP 运行时校验失败".to_owned())
        };
    }
    if let Err(error) = fs::rename(&temp, destination) {
        let _ = fs::remove_file(&temp);
        return Err(format!("无法提交 MCP 运行时文件：{error}"));
    }
    Ok(())
}

fn atomic_write_if_changed(path: &Path, content: &[u8]) -> Result<(), String> {
    if fs::read(path).is_ok_and(|current| current == content) {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "MCP 运行时元数据路径缺少父目录".to_owned())?;
    let temp = parent.join(format!(".fstty-metadata-{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .map_err(|error| format!("无法创建 MCP 运行时元数据：{error}"))?;
    if let Err(error) = file.write_all(content).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temp);
        return Err(format!("无法写入 MCP 运行时元数据：{error}"));
    }
    drop(file);
    if let Err(error) = replace_file(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(format!("无法提交 MCP 运行时元数据：{error}"));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

fn cleanup_old_runtimes(directory: &Path, current_name: &str) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name != current_name
            && name.starts_with(RUNTIME_PREFIX)
            && name.ends_with(RUNTIME_SUFFIX)
        {
            if let Err(error) = fs::remove_file(entry.path()) {
                log::debug!(
                    "旧 MCP 运行时暂时无法清理：path={}，error={error}",
                    entry.path().display()
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn directory(label: &str) -> PathBuf {
        let path = env::temp_dir().join(format!("fstty-mcp-runtime-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).expect("应创建测试目录");
        path
    }

    fn runtime_names(app_data_dir: &Path) -> Vec<String> {
        let mut names = fs::read_dir(runtime_directory(app_data_dir))
            .expect("应读取运行时目录")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(RUNTIME_PREFIX) && name.ends_with(RUNTIME_SUFFIX))
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    #[test]
    fn 首次创建且重复准备幂等() {
        let root = directory("idempotent");
        let source = root.join("source.exe");
        fs::write(&source, b"first runtime").unwrap();

        let first = prepare_from_source(&root, &source, "1.2.3").unwrap();
        let pointer = fs::read(runtime_directory(&root).join(CURRENT_RUNTIME_FILE)).unwrap();
        let launcher = fs::read(runtime_directory(&root).join(LAUNCHER_FILE)).unwrap();
        let second = prepare_from_source(&root, &source, "1.2.3").unwrap();

        assert_eq!(first, second);
        assert_eq!(runtime_names(&root).len(), 1);
        assert_eq!(
            fs::read(runtime_directory(&root).join(CURRENT_RUNTIME_FILE)).unwrap(),
            pointer
        );
        assert_eq!(
            fs::read(runtime_directory(&root).join(LAUNCHER_FILE)).unwrap(),
            launcher
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn 内容变化切换哈希文件并清理旧副本() {
        let root = directory("content-change");
        let source = root.join("source.exe");
        fs::write(&source, b"first runtime").unwrap();
        let first = prepare_from_source(&root, &source, "1.2.3").unwrap();
        fs::write(&source, b"second runtime").unwrap();
        let second = prepare_from_source(&root, &source, "1.2.3").unwrap();

        assert_ne!(first, second);
        assert!(!first.exists());
        assert_eq!(fs::read(&second).unwrap(), b"second runtime");
        assert_eq!(
            runtime_names(&root),
            vec![second.file_name().unwrap().to_string_lossy()]
        );
        let pointer =
            fs::read_to_string(runtime_directory(&root).join(CURRENT_RUNTIME_FILE)).unwrap();
        assert_eq!(
            pointer.trim(),
            second.file_name().unwrap().to_string_lossy()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn 旧文件清理失败不影响当前运行时() {
        let root = directory("cleanup-failure");
        let directory = runtime_directory(&root);
        fs::create_dir_all(&directory).unwrap();
        let blocked = directory.join("fstty-mcp-old-blocked.exe");
        fs::create_dir(&blocked).unwrap();
        let source = root.join("source.exe");
        fs::write(&source, b"current runtime").unwrap();

        let current = prepare_from_source(&root, &source, "1.2.3").unwrap();

        assert!(current.is_file());
        assert!(blocked.is_dir());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn 启动脚本读取指针并传递stdio() {
        if !cfg!(target_os = "windows") {
            return;
        }
        let root = directory("path with spaces");
        let directory = runtime_directory(&root);
        fs::create_dir_all(&directory).unwrap();
        atomic_write_if_changed(&directory.join(LAUNCHER_FILE), LAUNCHER_CONTENT.as_bytes())
            .unwrap();
        let helper = directory.join("stdio-helper.cmd");
        fs::write(
            &helper,
            "@echo off\r\nset /p FSTTY_TEST_INPUT=\r\necho %1^|%FSTTY_TEST_INPUT%\r\n>&2 echo helper-stderr\r\n",
        )
        .unwrap();
        atomic_write_if_changed(
            &directory.join(CURRENT_RUNTIME_FILE),
            b"stdio-helper.cmd\r\n",
        )
        .unwrap();
        let spec = launch_spec(&root);
        let mut child = Command::new(&spec.command)
            .args(&spec.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("应启动固定入口");
        child.stdin.take().unwrap().write_all(b"hello\r\n").unwrap();
        let output = child.wait_with_output().unwrap();

        assert!(
            output.status.success(),
            "stderr={}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("--mcp-stdio|hello"));
        assert!(String::from_utf8_lossy(&output.stderr).contains("helper-stderr"));
        let _ = fs::remove_dir_all(root);
    }
}
