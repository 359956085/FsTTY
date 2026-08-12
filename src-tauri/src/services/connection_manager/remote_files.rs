use super::super::connection_paths::{normalize_remote_path, validate_remote_name};
use crate::models::{FileEntry, FileKind};
use russh_sftp::protocol::{FilePermissions, FileType as SftpFileType};

pub(crate) struct RemoteFileWindow {
    pub(crate) content: Vec<u8>,
    pub(crate) offset: u64,
    pub(crate) file_size: u64,
    pub(crate) starts_at_line_boundary: bool,
    pub(crate) end_of_file: bool,
}

pub(super) fn file_entry_from_remote(entry: russh_sftp::client::fs::DirEntry) -> Option<FileEntry> {
    let name = entry.file_name();
    validate_remote_name(&name).ok()?;
    let path = normalize_remote_path(&entry.path()).ok()?;
    let metadata = entry.metadata();
    let kind = match metadata.file_type() {
        SftpFileType::Dir => FileKind::Folder,
        SftpFileType::File => FileKind::File,
        SftpFileType::Symlink => FileKind::Symlink,
        SftpFileType::Other => FileKind::Other,
    };
    let mode = metadata.permissions.unwrap_or_default();
    let type_prefix = match kind {
        FileKind::Folder => 'd',
        FileKind::File => '-',
        FileKind::Symlink => 'l',
        FileKind::Other => '?',
    };
    let symbolic = FilePermissions::from(mode).to_string();
    Some(FileEntry {
        name,
        path,
        kind,
        size: matches!(kind, FileKind::File).then_some(metadata.len()),
        modified_at: metadata.mtime.map(|value| value as u64 * 1000),
        owner: metadata
            .user
            .or_else(|| metadata.uid.map(|value| value.to_string()))
            .unwrap_or_else(|| "--".to_owned()),
        group: metadata
            .group
            .or_else(|| metadata.gid.map(|value| value.to_string()))
            .unwrap_or_else(|| "--".to_owned()),
        permissions: format!("{type_prefix}{symbolic} ({:03o})", mode & 0o7777),
    })
}

fn file_kind_rank(kind: FileKind) -> u8 {
    match kind {
        FileKind::Folder => 0,
        FileKind::File => 1,
        FileKind::Symlink => 2,
        FileKind::Other => 3,
    }
}

pub(super) fn sort_file_entries(files: &mut Vec<FileEntry>) {
    let mut keyed = files
        .drain(..)
        .map(|entry| (file_kind_rank(entry.kind), entry.name.to_lowercase(), entry))
        .collect::<Vec<_>>();
    keyed.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    files.extend(keyed.into_iter().map(|(_, _, entry)| entry));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, kind: FileKind) -> FileEntry {
        FileEntry {
            name: name.to_owned(),
            path: format!("/{name}"),
            kind,
            size: None,
            modified_at: None,
            owner: "root".to_owned(),
            group: "root".to_owned(),
            permissions: "--------- (000)".to_owned(),
        }
    }

    #[test]
    fn sorts_directories_first_and_names_case_insensitively() {
        let mut files = vec![
            entry("beta", FileKind::File),
            entry("Zoo", FileKind::Folder),
            entry("alpha", FileKind::File),
            entry("apple", FileKind::Folder),
        ];

        sort_file_entries(&mut files);

        assert_eq!(
            files
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["apple", "Zoo", "alpha", "beta"]
        );
    }
}
