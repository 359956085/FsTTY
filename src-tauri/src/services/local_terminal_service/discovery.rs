use crate::models::{LocalShell, LocalShellAvailability};
use std::path::PathBuf;

#[derive(Debug)]
pub(super) struct ShellProgram {
    pub path: PathBuf,
    pub label: String,
    pub args: &'static [&'static str],
}

pub fn detect() -> Vec<LocalShellAvailability> {
    [LocalShell::Cmd, LocalShell::Powershell, LocalShell::GitBash]
        .into_iter()
        .map(|shell| {
            let result = resolve(shell);
            LocalShellAvailability {
                shell,
                available: result.is_ok(),
                label: result
                    .as_ref()
                    .map(|program| program.label.clone())
                    .unwrap_or_else(|_| label(shell).into()),
                reason: result.err(),
            }
        })
        .collect()
}
fn label(shell: LocalShell) -> &'static str {
    match shell {
        LocalShell::Cmd => "CMD",
        LocalShell::Powershell => "PowerShell",
        LocalShell::GitBash => "Git Bash",
    }
}

pub(super) fn resolve(shell: LocalShell) -> Result<ShellProgram, String> {
    if !cfg!(windows) {
        return Err("本地终端仅支持 Windows".into());
    }
    let windows = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let programs = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    match shell {
        LocalShell::Cmd => candidate([windows.join("System32").join("cmd.exe")], "CMD", &[]),
        LocalShell::Powershell => {
            let mut paths = vec![programs.join("PowerShell/7/pwsh.exe")];
            paths.extend(
                path_programs("pwsh.exe")
                    .filter(|p| !p.to_string_lossy().to_ascii_lowercase().contains("preview")),
            );
            powershell(
                paths,
                windows.join("System32/WindowsPowerShell/v1.0/powershell.exe"),
            )
        }
        LocalShell::GitBash => {
            let mut roots = git_registry_roots();
            roots.push(programs.join("Git"));
            if let Some(path) = std::env::var_os("ProgramFiles(x86)") {
                roots.push(PathBuf::from(path).join("Git"));
            }
            if let Some(path) = std::env::var_os("LOCALAPPDATA") {
                roots.push(PathBuf::from(path).join("Programs/Git"));
            }
            // A PATH entry must belong to a Git installation. Never pick WSL's bash.exe.
            for git in path_programs("git.exe").filter(|path| path.is_file()) {
                if let Some(parent) = git.parent() {
                    roots.extend(parent.ancestors().take(3).map(|root| root.to_owned()));
                }
            }
            candidate(
                roots
                    .into_iter()
                    .flat_map(|root| [root.join("bin/bash.exe"), root.join("usr/bin/bash.exe")]),
                "Git Bash",
                &["--login", "-i"],
            )
        }
    }
}

fn powershell(paths: Vec<PathBuf>, legacy: PathBuf) -> Result<ShellProgram, String> {
    candidate(paths, "PowerShell 7", &["-NoLogo"])
        .or_else(|_| candidate([legacy], "Windows PowerShell 5.1", &["-NoLogo"]))
}

fn candidate(
    paths: impl IntoIterator<Item = PathBuf>,
    label: &str,
    args: &'static [&'static str],
) -> Result<ShellProgram, String> {
    paths
        .into_iter()
        .find(|p| p.is_absolute() && p.is_file())
        .map(|path| ShellProgram {
            // CMD parses forward slashes in its own executable path as command
            // switches. Rebuild components with Windows' native separators.
            path: path.components().collect(),
            label: label.into(),
            args,
        })
        .ok_or_else(|| format!("未检测到 {label}。安装或修复后，请点击“重新检测”。"))
}
fn path_programs(name: &str) -> impl Iterator<Item = PathBuf> {
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths)
                .map(|p| p.join(name))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
        .into_iter()
}
#[cfg(not(windows))]
fn git_registry_roots() -> Vec<PathBuf> {
    Vec::new()
}
#[cfg(windows)]
fn git_registry_roots() -> Vec<PathBuf> {
    use windows_sys::Win32::System::Registry::*;
    let mut roots = Vec::new();
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        for view in [RRF_SUBKEY_WOW6464KEY, RRF_SUBKEY_WOW6432KEY] {
            let mut data = [0u16; 4096];
            let mut bytes = std::mem::size_of_val(&data) as u32;
            let result = unsafe {
                RegGetValueW(
                    hive,
                    super::windows::wide("SOFTWARE\\GitForWindows").as_ptr(),
                    super::windows::wide("InstallPath").as_ptr(),
                    RRF_RT_REG_SZ | view,
                    std::ptr::null_mut(),
                    data.as_mut_ptr().cast(),
                    &mut bytes,
                )
            };
            if result == 0 {
                let end = data.iter().position(|c| *c == 0).unwrap_or(data.len());
                roots.push(PathBuf::from(String::from_utf16_lossy(&data[..end])));
            }
        }
    }
    roots
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn powershell_prefers_stable_install_and_falls_back_when_missing() {
        let root =
            std::env::temp_dir().join(format!("fstty-shell-detection-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let current = root.join("pwsh.exe");
        let legacy = root.join("powershell.exe");
        std::fs::write(&legacy, b"").unwrap();
        assert_eq!(
            powershell(vec![current.clone()], legacy.clone())
                .unwrap()
                .label,
            "Windows PowerShell 5.1"
        );
        std::fs::write(&current, b"").unwrap();
        assert_eq!(
            powershell(vec![current.clone()], legacy.clone())
                .unwrap()
                .path,
            current
        );
        std::fs::remove_file(&current).unwrap();
        std::fs::remove_file(&legacy).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn executable_paths_use_native_separators_even_with_mixed_input() {
        let executable = std::env::current_exe().unwrap();
        let mixed = PathBuf::from(executable.to_string_lossy().replace('\\', "/"));
        let program = candidate([mixed], "test", &[]).unwrap();
        assert_eq!(program.path, executable);
        assert!(!program.path.to_string_lossy().contains('/'));
    }

    #[test]
    fn missing_shell_keeps_an_explanation() {
        assert!(candidate([PathBuf::from("missing.exe")], "Git Bash", &[])
            .unwrap_err()
            .contains("Git Bash"));
    }
}
