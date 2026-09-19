import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveUpdaterPublicKey } from "./ci-build-config.mjs";

const root = resolve(import.meta.dirname, "..");
const configPath = resolve(root, "src-tauri/target/ci-build.json");
const target = resolve(root, process.env.CARGO_TARGET_DIR || "src-tauri/target");
const mode = process.argv[2];

function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.error || result.status !== 0) throw new Error("构建步骤失败", { cause: result.error });
}

function tauri(...args) {
  run(process.execPath, [resolve(root, "node_modules/@tauri-apps/cli/tauri.js"), ...args]);
}

const started = Date.now();
try {
  switch (mode) {
    case "configure": {
      // Broker 构建脚本直接读取基础配置，必须在任何 Rust 编译前核对公钥。
      const original = resolve(root, "src-tauri/tauri.conf.json");
      const config = JSON.parse(readFileSync(original, "utf8"));
      const configuredKey = config.plugins?.updater?.pubkey?.trim();
      resolveUpdaterPublicKey(
        configuredKey,
        process.env.FSTTY_UPDATER_PUBLIC_KEY,
        process.env.FSTTY_RELEASE_MODE === "release",
      );
      mkdirSync(resolve(root, "src-tauri/target"), { recursive: true });
      const ciConfig = { build: { beforeBuildCommand: "" }, bundle: { createUpdaterArtifacts: false } };
      writeFileSync(configPath, JSON.stringify(ciConfig));
      break;
    }
    case "frontend":
      run(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc")]);
      run(process.execPath, [resolve(root, "node_modules/vite/bin/vite.js"), "build"]);
      break;
    case "broker":
      run(process.execPath, [resolve(root, "scripts/build-broker.mjs")]);
      break;
    case "desktop":
      tauri("build", "--ci", "--no-bundle", "--config", configPath, "--", "--locked");
      break;
    case "bundle":
      tauri("bundle", "--ci", "--bundles", "nsis", "--config", configPath);
      break;
    case "sign": {
      if (!process.env.TAURI_SIGNING_PRIVATE_KEY) throw new Error("缺少更新签名私钥");
      const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
      tauri("signer", "sign", resolve(target, `release/bundle/nsis/FsTTY_${version}_x64-setup.exe`));
      break;
    }
    default:
      throw new Error("用法：node scripts/ci-build.mjs configure|frontend|broker|desktop|bundle|sign");
  }
} finally {
  const line = `构建步骤 ${mode}：${((Date.now() - started) / 1000).toFixed(1)} 秒`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
}
