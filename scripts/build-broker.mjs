import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

if (process.platform === "win32") {
  const root = path.resolve(import.meta.dirname, "..");
  const result = spawnSync("cargo", ["build", "--manifest-path", path.join(root, "src-tauri/Cargo.toml"), "-p", "fstty-broker", "--release", "--locked"], { stdio: "inherit", cwd: root });
  if (result.error || result.status !== 0) throw new Error("凭据服务构建失败", { cause: result.error });
  const target = process.env.CARGO_TARGET_DIR ? path.resolve(root, process.env.CARGO_TARGET_DIR) : path.join(root, "src-tauri/target");
  const source = path.join(target, "release/fstty-broker.exe");
  const destination = path.join(root, "src-tauri/target/broker-package");
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(source, path.join(destination, "fstty-broker.exe"));
}
