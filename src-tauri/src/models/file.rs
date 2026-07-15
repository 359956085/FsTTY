use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: FileKind,
    pub size: Option<u64>,
    pub modified_at: Option<u64>,
    pub owner: String,
    pub group: String,
    pub permissions: String,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    File,
    Folder,
    Symlink,
    Other,
}
