fn main() {
    println!("cargo:rerun-if-changed=../tauri.conf.json");
    println!("cargo:rerun-if-env-changed=CARGO_PKG_VERSION");
    let config: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("../tauri.conf.json").expect("缺少桌面发布配置"),
    )
    .expect("发布配置无效");
    let key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .unwrap_or("");
    assert!(!key.is_empty(), "发布公钥不能为空");
    assert!(!key.contains(['\r', '\n']), "发布公钥必须为单行 Base64");
    println!("cargo:rustc-env=FSTTY_RELEASE_PUBLIC_KEY={key}");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        embed_windows_version();
    }
}

fn embed_windows_version() {
    let version = std::env::var("CARGO_PKG_VERSION").expect("缺少 Broker 包版本");
    let numeric = version.split(['-', '+']).next().expect("Broker 包版本无效");
    let parts = numeric
        .split('.')
        .map(|part| part.parse::<u16>().expect("Broker 包版本必须为数字"))
        .collect::<Vec<_>>();
    assert_eq!(parts.len(), 3, "Broker 包版本必须包含主、次、修订版本");

    let resource = format!(
        r#"#include <windows.h>

1 VERSIONINFO
FILEVERSION {major},{minor},{patch},0
PRODUCTVERSION {major},{minor},{patch},0
FILEFLAGSMASK 0x3fL
FILEFLAGS 0x0L
FILEOS 0x40004L
FILETYPE 0x1L
FILESUBTYPE 0x0L
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      VALUE "CompanyName", "FsTTY\0"
      VALUE "FileDescription", "FsTTY Broker\0"
      VALUE "FileVersion", "{version}\0"
      VALUE "InternalName", "fstty-broker\0"
      VALUE "OriginalFilename", "fstty-broker.exe\0"
      VALUE "ProductName", "FsTTY Broker\0"
      VALUE "ProductVersion", "{version}\0"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x0409, 1200
  END
END
"#,
        major = parts[0],
        minor = parts[1],
        patch = parts[2],
    );
    let resource_path =
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("缺少 Broker 构建输出目录"))
            .join("fstty-broker-version.rc");
    std::fs::write(&resource_path, resource).expect("无法生成 Broker Windows 版本资源");
    embed_resource::compile_for(resource_path, ["fstty-broker"], embed_resource::NONE)
        .manifest_required()
        .expect("无法编译 Broker Windows 版本资源");
}
