import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

if (process.platform === "win32") {
  const root = path.resolve(import.meta.dirname, "..");
  // 服务必须能在没有 Visual C++ 运行库的干净系统上独立启动。
  const rustFlags = process.env.CARGO_ENCODED_RUSTFLAGS?.split("\x1f")
    ?? (process.env.RUSTFLAGS ?? "").split(/\s+/).filter(Boolean);
  const target = process.env.FSTTY_BROKER_TARGET_DIR
    ? path.resolve(root, process.env.FSTTY_BROKER_TARGET_DIR)
    : path.join(root, "src-tauri/target/broker-build");
  const env = { ...process.env, CARGO_TARGET_DIR: target, CARGO_ENCODED_RUSTFLAGS: [...rustFlags, "-C", "target-feature=+crt-static"].join("\x1f") };
  const result = spawnSync("cargo", ["build", "--manifest-path", path.join(root, "src-tauri/Cargo.toml"), "-p", "fstty-broker", "--release", "--locked"], { stdio: "inherit", cwd: root, env });
  if (result.error || result.status !== 0) throw new Error("凭据服务构建失败", { cause: result.error });
  const source = path.join(target, "release/fstty-broker.exe");
  const destination = path.join(root, "src-tauri/target/broker-package");
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(source, path.join(destination, "fstty-broker.exe"));
}
