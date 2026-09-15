fn main() {
    println!("cargo:rerun-if-changed=../tauri.conf.json");
    let config: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("../tauri.conf.json").expect("缺少桌面发布配置"),
    )
    .expect("发布配置无效");
    let key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .unwrap_or("");
    assert!(!key.contains(['\r', '\n']), "发布公钥必须为单行 Base64");
    println!("cargo:rustc-env=FSTTY_RELEASE_PUBLIC_KEY={key}");
}
