use crate::models::AppError;

const MAX_PATH_BYTES: usize = 4096;

pub(super) fn normalize_remote_path(path: &str) -> Result<String, AppError> {
    if path.is_empty()
        || !path.starts_with('/')
        || path.len() > MAX_PATH_BYTES
        || path
            .chars()
            .any(|character| character == '\0' || character.is_control())
    {
        return Err(AppError::Validation("远程路径无效".to_owned()));
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            value => parts.push(value),
        }
    }
    Ok(format!("/{}", parts.join("/")))
}

pub(super) fn validate_remote_name(name: &str) -> Result<(), AppError> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name
            .chars()
            .any(|character| character == '\0' || character.is_control())
    {
        return Err(AppError::Validation("远程文件名无效".to_owned()));
    }
    Ok(())
}

pub(super) fn join_remote_path(directory: &str, name: &str) -> String {
    if directory == "/" {
        format!("/{name}")
    } else {
        format!("{directory}/{name}")
    }
}

pub(super) fn checked_join_remote_path(directory: &str, name: &str) -> Result<String, AppError> {
    normalize_remote_path(&join_remote_path(directory, name))
}

pub(super) fn resolve_remote_child(parent_path: &str, name: &str) -> Result<String, AppError> {
    validate_remote_name(name)?;
    let parent_path = normalize_remote_path(parent_path)?;
    checked_join_remote_path(&parent_path, name)
}

pub(super) fn resolve_remote_move_target(
    source_path: &str,
    target_directory: &str,
) -> Result<(String, String, String), AppError> {
    let source = normalize_mutable_remote_path(source_path, "禁止移动远程根目录")?;
    let target_directory = normalize_remote_path(target_directory)?;
    let name = source
        .rsplit('/')
        .next()
        .ok_or_else(|| AppError::Validation("远程移动源无效".to_owned()))?;
    validate_remote_name(name)?;
    let target = checked_join_remote_path(&target_directory, name)?;
    Ok((source, target_directory, target))
}

pub(super) fn normalize_mutable_remote_path(
    path: &str,
    root_error: &str,
) -> Result<String, AppError> {
    let path = normalize_remote_path(path)?;
    if path == "/" {
        return Err(AppError::Validation(root_error.to_owned()));
    }
    Ok(path)
}

pub(super) fn remote_parent_path(path: &str) -> String {
    path.rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
        .unwrap_or("/")
        .to_owned()
}

pub(super) fn is_same_or_remote_descendant(path: &str, directory: &str) -> bool {
    path == directory || path.starts_with(&format!("{directory}/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 规范化路径且不允许越过根目录() {
        assert_eq!(
            normalize_remote_path("/var/./log/../tmp").expect("路径应有效"),
            "/var/tmp"
        );
        assert_eq!(
            normalize_remote_path("/../../etc").expect("路径应有效"),
            "/etc"
        );
        assert!(normalize_remote_path("relative").is_err());
    }

    #[test]
    fn 移动目标拒绝根目录和自身子目录() {
        assert!(resolve_remote_move_target("/", "/tmp").is_err());
        let (source, directory, target) =
            resolve_remote_move_target("/home/project", "/archive").expect("移动路径应有效");
        assert_eq!(
            (source, directory, target),
            (
                "/home/project".to_owned(),
                "/archive".to_owned(),
                "/archive/project".to_owned()
            )
        );
        assert!(is_same_or_remote_descendant(
            "/home/project/src",
            "/home/project"
        ));
    }
}
