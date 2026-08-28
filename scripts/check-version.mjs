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

const versions = {
  packageJson: readJson("package.json").version,
  cargo: readVersion("src-tauri/Cargo.toml", /^version\s*=\s*"([^"]+)"/m),
  cargoLock: readVersion(
    "src-tauri/Cargo.lock",
    /\[\[package\]\]\s+name\s*=\s*"fstty"\s+version\s*=\s*"([^"]+)"/m,
  ),
  tauri: readJson("src-tauri/tauri.conf.json").version,
  readme: readVersion("README.md", /badge\/version-([^/-]+)-/),
  readmeEnglish: readVersion("README.en-US.md", /badge\/version-([^/-]+)-/),
};

const uniqueVersions = new Set(Object.values(versions));
if (uniqueVersions.size !== 1) {
  console.error("版本一致性检查失败：" + JSON.stringify(versions));
  process.exitCode = 1;
} else {
  console.log(`版本一致：${[...uniqueVersions][0]}`);
}
