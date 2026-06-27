use crate::models::{FileEntry, FileKind};

pub struct FileService;

impl FileService {
    pub fn list(&self, session_id: &str, path: &str) -> Vec<FileEntry> {
        let base = if path == "/" { "" } else { path };

        vec![
            folder("config", &format!("{base}/config"), "May 22, 16:20"),
            folder("public", &format!("{base}/public"), "May 23, 09:35"),
            folder("src", &format!("{base}/src"), "May 23, 09:38"),
            file(".env", &format!("{base}/.env"), 1_200, "May 23, 16:15"),
            file(
                "docker-compose.yml",
                &format!("{base}/docker-compose.yml"),
                2_100,
                "May 22, 16:18",
            ),
            file(
                "package.json",
                &format!("{base}/package.json"),
                1_800,
                "May 22, 16:18",
            ),
            file(
                "README.md",
                &format!("{base}/README.md"),
                4_300,
                "May 22, 16:18",
            ),
        ]
        .into_iter()
        .map(|mut entry| {
            // 首版只做模拟数据，但保留 session 维度，后续接 SFTP 时沿用同一接口。
            entry.owner = owner_for_session(session_id);
            entry
        })
        .collect()
    }
}

fn folder(name: &str, path: &str, modified: &str) -> FileEntry {
    FileEntry {
        name: name.to_owned(),
        path: path.to_owned(),
        kind: FileKind::Folder,
        size: None,
        modified: modified.to_owned(),
        owner: "devuser".to_owned(),
        group: "www-data".to_owned(),
        permissions: "drwxr-xr-x (755)".to_owned(),
    }
}

fn file(name: &str, path: &str, size: u64, modified: &str) -> FileEntry {
    FileEntry {
        name: name.to_owned(),
        path: path.to_owned(),
        kind: FileKind::File,
        size: Some(size),
        modified: modified.to_owned(),
        owner: "devuser".to_owned(),
        group: "www-data".to_owned(),
        permissions: "-rw-r--r-- (644)".to_owned(),
    }
}

fn owner_for_session(session_id: &str) -> String {
    if session_id.starts_with("prod") {
        "ubuntu".to_owned()
    } else if session_id.starts_with("test") {
        "tester".to_owned()
    } else {
        "devuser".to_owned()
    }
}
