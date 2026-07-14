use crate::models::{FileEntry, FileKind};

pub struct FileService;

impl FileService {
    pub fn list(&self, _session_id: &str, path: &str) -> Vec<FileEntry> {
        // 固定目录树让面包屑、返回和进入目录可真实联动，不伪造任意路径内容。
        match path {
            "" | "/" => vec![folder("www", "/www")],
            "/www" => vec![folder("html", "/www/html")],
            "/www/html" | "/var/www/app" => html_files(),
            "/www/html/assets" | "/var/www/app/assets" => vec![
                folder("images", "/www/html/assets/images"),
                file("logo.svg", "/www/html/assets/logo.svg", 2_048),
            ],
            "/www/html/assets/images" | "/var/www/app/assets/images" => {
                vec![file(
                    "hero.webp",
                    "/www/html/assets/images/hero.webp",
                    86_016,
                )]
            }
            "/www/html/css" | "/var/www/app/css" => {
                vec![file("style.css", "/www/html/css/style.css", 12_288)]
            }
            "/www/html/js" | "/var/www/app/js" => {
                vec![file("app.js", "/www/html/js/app.js", 18_432)]
            }
            _ => Vec::new(),
        }
    }
}

fn html_files() -> Vec<FileEntry> {
    vec![
        folder("assets", "/www/html/assets"),
        folder("css", "/www/html/css"),
        folder("js", "/www/html/js"),
        file("index.html", "/www/html/index.html", 3_284),
        file("about.html", "/www/html/about.html", 2_150),
        file("contact.html", "/www/html/contact.html", 1_946),
        file("favicon.ico", "/www/html/favicon.ico", 5_529),
        file("robots.txt", "/www/html/robots.txt", 112),
    ]
}

fn folder(name: &str, path: &str) -> FileEntry {
    FileEntry {
        name: name.to_owned(),
        path: path.to_owned(),
        kind: FileKind::Folder,
        size: None,
        modified: "2024-05-16 10:22:00".to_owned(),
        owner: "root".to_owned(),
        group: "root".to_owned(),
        permissions: "drwxr-xr-x (755)".to_owned(),
    }
}

fn file(name: &str, path: &str, size: u64) -> FileEntry {
    FileEntry {
        name: name.to_owned(),
        path: path.to_owned(),
        kind: FileKind::File,
        size: Some(size),
        modified: "2024-05-16 10:22:31".to_owned(),
        owner: "root".to_owned(),
        group: "root".to_owned(),
        permissions: "-rw-r--r-- (644)".to_owned(),
    }
}
