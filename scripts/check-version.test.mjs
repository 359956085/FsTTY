import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let fixtureRoot;
const updaterPublicKey = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEU5MzlGRTlCN0M4NUI2NjIKUldSaXRvVjhtLzQ1NmZGZFdxalJZeWRqUXJxS2pETm8zellkYmlxbnU0Sy9GbEpZbkhVZm1LVkoK";

function writeFixture(relativePath, content) {
  const filePath = join(fixtureRoot, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function changeJson(relativePath, change) {
  const data = JSON.parse(readFileSync(join(fixtureRoot, relativePath), "utf8"));
  change(data);
  writeFixture(relativePath, JSON.stringify(data));
}

function changeVersion(relativePath) {
  const content = readFileSync(join(fixtureRoot, relativePath), "utf8");
  writeFixture(relativePath, content.replace("1.5.0", "1.4.0"));
}

function changeCargoLockVersion(packageName) {
  const content = readFileSync(join(fixtureRoot, "src-tauri/Cargo.lock"), "utf8");
  const pattern = new RegExp(`(name = "${packageName}"\\nversion = ")[^"]+`);
  writeFixture("src-tauri/Cargo.lock", content.replace(pattern, (_, prefix) => `${prefix}1.4.0`));
}

function runCheck() {
  return spawnSync(process.execPath, [join(fixtureRoot, "scripts/check-version.mjs")], {
    cwd: tmpdir(),
    encoding: "utf8",
    timeout: 10_000,
  });
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "fstty-version-test-"));
  mkdirSync(join(fixtureRoot, "scripts"));
  copyFileSync(resolve(import.meta.dirname, "check-version.mjs"), join(fixtureRoot, "scripts/check-version.mjs"));
  writeFixture("package.json", JSON.stringify({
    name: "fstty", version: "1.5.0", dependencies: { "third-party": "1.4.0" },
  }));
  writeFixture("package-lock.json", JSON.stringify({
    version: "1.5.0",
    packages: {
      "": { name: "fstty", version: "1.5.0" },
      "node_modules/third-party": { version: "1.4.0" },
      "node_modules/fstty-helper": { version: "9.9.9" },
    },
  }));
  for (const [relativePath, name] of [
    ["src-tauri/Cargo.toml", "fstty"],
    ["src-tauri/broker/Cargo.toml", "fstty-broker"],
    ["src-tauri/network/Cargo.toml", "fstty-network"],
  ]) {
    writeFixture(relativePath, `[package]\nname = "${name}"\nversion = "1.5.0"\n`);
  }
  writeFixture("src-tauri/Cargo.lock", [
    ["third-party", "1.4.0"],
    ["fstty-helper", "9.9.9"],
    ["fstty-broker-helper", "9.9.9"],
    ["fstty-network-helper", "9.9.9"],
    ["fstty", "1.5.0"],
    ["fstty-broker", "1.5.0"],
    ["fstty-network", "1.5.0"],
  ].map(([name, version]) => `[[package]]\nname = "${name}"\nversion = "${version}"\n`).join("\n"));
  writeFixture("src-tauri/tauri.conf.json", JSON.stringify({
    version: "1.5.0",
    plugins: { updater: { pubkey: updaterPublicKey } },
  }));
  for (const readme of ["README.md", "README.en-US.md"]) {
    writeFixture(readme, "![Version](https://img.shields.io/badge/version-1.5.0-2563EB)\n");
  }
  writeFixture("CHANGELOG.md", `# Changelog

## [Unreleased]

## [1.5.0] - 2026-09-19

<!-- release-notes:zh-CN:start -->
### 简体中文
- 修复
<!-- release-notes:zh-CN:end -->

<!-- release-notes:en-US:start -->
### English
- Fixes
<!-- release-notes:en-US:end -->
`);
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("版本一致性检查", () => {
  it("项目版本一致时通过且忽略第三方及相似包名的版本", () => {
    const result = runCheck();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("版本一致：1.5.0");
    expect(result.stderr).toBe("");
  });

  it.each([
    ["npm 配置", "packageJson", () => changeVersion("package.json")],
    ["npm 锁文件根版本", "packageLock", () => changeVersion("package-lock.json")],
    ["npm 锁文件项目条目", "packageLockRoot", () => changeJson("package-lock.json", (data) => {
      data.packages[""].version = "1.4.0";
    })],
    ["桌面包", "cargo", () => changeVersion("src-tauri/Cargo.toml")],
    ["凭据服务包", "broker", () => changeVersion("src-tauri/broker/Cargo.toml")],
    ["共享网络包", "network", () => changeVersion("src-tauri/network/Cargo.toml")],
    ["桌面包锁条目", "cargoLock", () => changeCargoLockVersion("fstty")],
    ["凭据服务包锁条目", "brokerLock", () => changeCargoLockVersion("fstty-broker")],
    ["共享网络包锁条目", "networkLock", () => changeCargoLockVersion("fstty-network")],
    ["Tauri 配置", "tauri", () => changeVersion("src-tauri/tauri.conf.json")],
    ["中文徽章", "readme", () => changeVersion("README.md")],
    ["英文徽章", "readmeEnglish", () => changeVersion("README.en-US.md")],
    ["更新日志", "changelog", () => changeVersion("CHANGELOG.md")],
  ])("%s 版本错配时失败并指出来源", (_label, key, change) => {
    change();
    const result = runCheck();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("版本一致性检查失败");
    expect(result.stderr).toContain(`"${key}":"1.4.0"`);
  });

  it.each([
    ["根版本", "packageLock", (data) => { delete data.version; }],
    ["项目条目", "packageLockRoot", (data) => { delete data.packages[""]; }],
  ])("npm 锁文件缺少%s时不能忽略", (_label, key, change) => {
    changeJson("package-lock.json", change);
    const result = runCheck();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`"${key}":null`);
  });

  it.each(["fstty", "fstty-broker", "fstty-network"])("缺少 %s 锁条目时不能误用相似包名", (packageName) => {
    const content = readFileSync(join(fixtureRoot, "src-tauri/Cargo.lock"), "utf8");
    const pattern = new RegExp(`\\[\\[package\\]\\]\\nname = "${packageName}"\\nversion = "[^"]+"\\n`);
    writeFixture("src-tauri/Cargo.lock", content.replace(pattern, ""));
    const result = runCheck();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("未找到 src-tauri/Cargo.lock 中的版本号");
  });

  it.each([
    ["空值", ""],
    ["非 Base64", "不是公钥"],
    ["错误内容", Buffer.from("普通文本").toString("base64")],
  ])("更新公钥为%s时失败", (_label, pubkey) => {
    changeJson("src-tauri/tauri.conf.json", (data) => {
      data.plugins.updater.pubkey = pubkey;
    });
    const result = runCheck();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Tauri 更新公钥");
  });

  it("最新版本缺少双语更新说明时失败", () => {
    const content = readFileSync(join(fixtureRoot, "CHANGELOG.md"), "utf8");
    writeFixture(
      "CHANGELOG.md",
      content.replace("<!-- release-notes:en-US:start -->", "<!-- missing -->"),
    );
    const result = runCheck();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("缺少 en-US 更新说明");
  });
});
