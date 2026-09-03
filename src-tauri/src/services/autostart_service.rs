use crate::models::AppError;
use std::sync::{Arc, Mutex};

type AutostartResult<T> = Result<T, AppError>;

/// 系统登记是唯一真值；轻量模式仍由现有 GUI 启动流程决定。
#[derive(Clone, Default)]
pub struct AutostartService {
    operation: Arc<Mutex<()>>,
}

impl AutostartService {
    pub fn get(&self) -> AutostartResult<bool> {
        self.run(|| SystemAutostart::new()?.is_enabled())
    }

    pub fn set_enabled(&self, enabled: bool) -> AutostartResult<bool> {
        self.run(|| set_enabled(&SystemAutostart::new()?, enabled))
    }

    fn run<T>(&self, operation: impl FnOnce() -> AutostartResult<T>) -> AutostartResult<T> {
        let _guard = self
            .operation
            .lock()
            .map_err(|_| AppError::Internal("开机自启服务锁定失败".to_owned()))?;
        operation()
    }
}

trait AutostartBackend {
    fn is_enabled(&self) -> AutostartResult<bool>;
    fn enable(&self) -> AutostartResult<()>;
    fn disable(&self) -> AutostartResult<()>;
}

fn set_enabled(backend: &impl AutostartBackend, enabled: bool) -> AutostartResult<bool> {
    if backend.is_enabled()? == enabled {
        return Ok(enabled);
    }
    if enabled {
        backend.enable()?;
    } else {
        backend.disable()?;
    }
    // 写入成功不等于系统已接受，回读才能避免界面显示虚假的启用状态。
    let actual = backend.is_enabled()?;
    if actual != enabled {
        return Err(AppError::Internal(
            "系统未应用开机自启设置，请重试".to_owned(),
        ));
    }
    Ok(actual)
}

struct SystemAutostart {
    #[cfg(windows)]
    launcher: auto_launch::AutoLaunch,
}

impl SystemAutostart {
    fn new() -> AutostartResult<Self> {
        #[cfg(windows)]
        {
            let executable = std::env::current_exe()
                .map_err(|_| AppError::Internal("无法获取 FsTTY 程序路径".to_owned()))?;
            let command = quoted_executable_path(&executable)?;
            Ok(Self {
                // 不传轻量或 stdio 参数；与手动启动共用模式恢复及单实例检查。
                launcher: auto_launch::AutoLaunch::new("FsTTY", &command, &[] as &[&str]),
            })
        }
        #[cfg(not(windows))]
        Err(AppError::Validation(
            "当前平台不支持开机自启设置".to_owned(),
        ))
    }
}

#[cfg(any(windows, test))]
fn quoted_executable_path(executable: &std::path::Path) -> AutostartResult<String> {
    let path = executable
        .to_str()
        .filter(|path| {
            executable.is_absolute()
                && !path
                    .chars()
                    .any(|character| character == '"' || character.is_control())
        })
        .ok_or_else(|| AppError::Validation("FsTTY 程序路径无效，无法设置开机自启".to_owned()))?;
    // 底层库直接拼接 Run 命令，必须自行引用路径，避免含空格安装目录产生歧义。
    Ok(format!("\"{path}\""))
}

impl AutostartBackend for SystemAutostart {
    fn is_enabled(&self) -> AutostartResult<bool> {
        #[cfg(windows)]
        {
            match self.launcher.is_enabled() {
                // 新用户尚未建立 Run 项时等同未登记，不为读取操作创建注册表项。
                Err(auto_launch::Error::Io(error))
                    if error.kind() == std::io::ErrorKind::NotFound =>
                {
                    Ok(false)
                }
                result => {
                    result.map_err(|_| AppError::Internal("无法读取系统开机自启状态".to_owned()))
                }
            }
        }
        #[cfg(not(windows))]
        Err(AppError::Validation(
            "当前平台不支持开机自启设置".to_owned(),
        ))
    }

    fn enable(&self) -> AutostartResult<()> {
        #[cfg(windows)]
        {
            self.launcher.enable().map_err(|_| {
                AppError::Internal("无法启用开机自启，请检查系统权限后重试".to_owned())
            })
        }
        #[cfg(not(windows))]
        Err(AppError::Validation(
            "当前平台不支持开机自启设置".to_owned(),
        ))
    }

    fn disable(&self) -> AutostartResult<()> {
        #[cfg(windows)]
        {
            match self.launcher.disable() {
                Err(auto_launch::Error::Io(error))
                    if error.kind() == std::io::ErrorKind::NotFound =>
                {
                    Ok(())
                }
                result => result.map_err(|_| {
                    AppError::Internal("无法关闭开机自启，请检查系统权限后重试".to_owned())
                }),
            }
        }
        #[cfg(not(windows))]
        Err(AppError::Validation(
            "当前平台不支持开机自启设置".to_owned(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[derive(Default)]
    struct MemoryAutostart {
        enabled: Cell<bool>,
        writes: Cell<usize>,
        fail_read: Cell<bool>,
        fail_write: Cell<bool>,
        fail_after_write: Cell<bool>,
        ignore_write: Cell<bool>,
    }

    impl MemoryAutostart {
        fn write(&self, enabled: bool) -> AutostartResult<()> {
            self.writes.set(self.writes.get() + 1);
            if self.fail_write.get() {
                return Err(AppError::Internal("模拟系统写入失败".to_owned()));
            }
            if !self.ignore_write.get() {
                self.enabled.set(enabled);
            }
            if self.fail_after_write.get() {
                return Err(AppError::Internal("模拟部分写入失败".to_owned()));
            }
            Ok(())
        }
    }

    impl AutostartBackend for MemoryAutostart {
        fn is_enabled(&self) -> AutostartResult<bool> {
            if self.fail_read.get() {
                return Err(AppError::Internal("模拟读取失败".to_owned()));
            }
            Ok(self.enabled.get())
        }
        fn enable(&self) -> AutostartResult<()> {
            self.write(true)
        }
        fn disable(&self) -> AutostartResult<()> {
            self.write(false)
        }
    }

    #[test]
    fn 自启默认关闭且重复启停幂等() {
        let backend = MemoryAutostart::default();
        assert!(!backend.is_enabled().unwrap());
        assert!(!set_enabled(&backend, false).unwrap());
        assert!(set_enabled(&backend, true).unwrap());
        assert!(set_enabled(&backend, true).unwrap());
        assert!(!set_enabled(&backend, false).unwrap());
        assert!(!set_enabled(&backend, false).unwrap());
        assert_eq!(backend.writes.get(), 2);
    }

    #[test]
    fn 读取失败不会尝试写入且失败后可重试() {
        let backend = MemoryAutostart::default();
        backend.fail_read.set(true);
        assert!(set_enabled(&backend, true).is_err());
        assert_eq!(backend.writes.get(), 0);
        backend.fail_read.set(false);
        backend.fail_write.set(true);
        assert!(set_enabled(&backend, true).is_err());
        assert!(!backend.is_enabled().unwrap());
        backend.fail_write.set(false);
        assert!(set_enabled(&backend, true).unwrap());
    }

    #[test]
    fn 部分写入失败回读仍以系统状态为准() {
        let backend = MemoryAutostart::default();
        backend.fail_after_write.set(true);
        assert!(set_enabled(&backend, true).is_err());
        assert!(backend.is_enabled().unwrap());
        backend.fail_after_write.set(false);
        assert!(!set_enabled(&backend, false).unwrap());
        backend.ignore_write.set(true);
        assert!(set_enabled(&backend, true).is_err());
    }

    #[test]
    fn 启动路径包含空格时仍只启动原程序() {
        let path = if cfg!(windows) {
            r"C:\Program Files\风时 FsTTY\fstty.exe"
        } else {
            "/opt/风时 FsTTY/fstty"
        };
        assert_eq!(
            quoted_executable_path(std::path::Path::new(path)).unwrap(),
            format!("\"{path}\"")
        );
        assert!(quoted_executable_path(std::path::Path::new("fstty.exe")).is_err());
        assert!(
            quoted_executable_path(std::path::Path::new(&format!("{path}\" --mcp-stdio"))).is_err()
        );
        assert!(quoted_executable_path(std::path::Path::new(&format!("{path}\n"))).is_err());
    }

    #[test]
    fn 克隆服务仍串行处理系统操作() {
        let service = AutostartService::default();
        let other = service.clone();
        service
            .run(|| {
                assert!(other.operation.try_lock().is_err());
                Ok(())
            })
            .unwrap();
        assert!(other.operation.try_lock().is_ok());
    }
}
