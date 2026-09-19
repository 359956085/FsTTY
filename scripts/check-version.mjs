import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), "utf8"));
}

function readVersion(relativePath, pattern) {
  const content = fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
  const match = content.match(pattern);
  if (!match) {
    throw new Error(`未找到 ${relativePath} 中的版本号`);
  }
  return match[1];
}

function readLatestReleaseNotesVersion() {
  const content = fs.readFileSync(path.join(projectRoot, "CHANGELOG.md"), "utf8");
  const heading = /^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/m.exec(content);
  if (!heading) {
    throw new Error("CHANGELOG.md 缺少已发布版本标题");
  }
  const start = heading.index + heading[0].length;
  const next = content.slice(start).search(/^## \[/m);
  const section = content.slice(start, next < 0 ? undefined : start + next);
  for (const locale of ["zh-CN", "en-US"]) {
    const begin = `<!-- release-notes:${locale}:start -->`;
    const end = `<!-- release-notes:${locale}:end -->`;
    if (!section.includes(begin) || !section.includes(end)) {
      throw new Error(`CHANGELOG.md 最新版本缺少 ${locale} 更新说明`);
    }
  }
  return heading[1];
}

const packageLock = readJson("package-lock.json");
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const versions = {
  packageJson: readJson("package.json").version,
  packageLock: packageLock.version ?? null,
  packageLockRoot: packageLock.packages?.[""]?.version ?? null,
  cargo: readVersion("src-tauri/Cargo.toml", /^version\s*=\s*"([^"]+)"/m),
  broker: readVersion("src-tauri/broker/Cargo.toml", /^version\s*=\s*"([^"]+)"/m),
  network: readVersion("src-tauri/network/Cargo.toml", /^version\s*=\s*"([^"]+)"/m),
  cargoLock: readVersion(
    "src-tauri/Cargo.lock",
    /\[\[package\]\]\s+name\s*=\s*"fstty"\s+version\s*=\s*"([^"]+)"/m,
  ),
  brokerLock: readVersion(
    "src-tauri/Cargo.lock",
    /\[\[package\]\]\s+name\s*=\s*"fstty-broker"\s+version\s*=\s*"([^"]+)"/m,
  ),
  networkLock: readVersion(
    "src-tauri/Cargo.lock",
    /\[\[package\]\]\s+name\s*=\s*"fstty-network"\s+version\s*=\s*"([^"]+)"/m,
  ),
  tauri: tauriConfig.version,
  readme: readVersion("README.md", /badge\/version-([^/-]+)-/),
  readmeEnglish: readVersion("README.en-US.md", /badge\/version-([^/-]+)-/),
  changelog: readLatestReleaseNotesVersion(),
};

function validateUpdaterPublicKey(value) {
  if (typeof value !== "string" || !value || /[\r\n]/.test(value)
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Tauri 更新公钥必须是非空的单行 Base64");
  }
  const decodedBytes = Buffer.from(value, "base64");
  if (decodedBytes.toString("base64") !== value) {
    throw new Error("Tauri 更新公钥 Base64 编码无效");
  }
  const lines = decodedBytes.toString("utf8").trimEnd().split("\n");
  const keyBytes = lines.length === 2 && /^[A-Za-z0-9+/]+={0,2}$/.test(lines[1])
    ? Buffer.from(lines[1], "base64")
    : null;
  if (!/^untrusted comment: minisign public key: [A-F0-9]{16}$/.test(lines[0] ?? "")
      || keyBytes?.length !== 42 || keyBytes[0] !== 0x45 || keyBytes[1] !== 0x64) {
    throw new Error("Tauri 更新公钥不是有效的 minisign Ed25519 公钥");
  }
}

validateUpdaterPublicKey(tauriConfig.plugins?.updater?.pubkey);

const uniqueVersions = new Set(Object.values(versions));
if (uniqueVersions.size !== 1) {
  console.error("版本一致性检查失败：" + JSON.stringify(versions));
  process.exitCode = 1;
} else {
  console.log(`版本一致：${[...uniqueVersions][0]}`);
}
