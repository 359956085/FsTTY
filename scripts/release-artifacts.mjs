import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { powershellAuthenticodeArgs, readAuthenticodeSettings } from "./authenticode.mjs";
import { extractVersionReleaseNotes } from "./extract-release-notes.mjs";

const root = resolve(import.meta.dirname, "..");
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export function validateReleaseRef(ref, version) {
  const tag = `v${version}`;
  if (!/^\d+\.\d+\.\d+$/.test(version) || ref !== `refs/tags/${tag}`) {
    throw new Error("必须从与仓库版本一致的 vX.Y.Z 标签运行发布");
  }
  return tag;
}

export function affectsBuild(paths) {
  return paths.some((path) => /^(src\/|src-tauri\/|public\/|scripts\/|\.github\/|\.cargo\/|package(?:-lock)?\.json$|index\.html$|(?:vite|vitest|eslint|tsconfig|rust-toolchain)[^/]*$)/.test(path));
}

export function createUpdateManifest({ repo, tag, version, notes, createdAt, installer, signature }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("仓库名称无效");
  validateReleaseRef(`refs/tags/${tag}`, version);
  if (installer !== `FsTTY_${version}_x64-setup.exe` || !signature.trim()) {
    throw new Error("安装包名称或签名无效");
  }
  const platform = {
    signature: signature.trim(),
    url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(installer)}`,
  };
  return { version, notes, pub_date: createdAt, platforms: {
    "windows-x86_64": platform,
    "windows-x86_64-nsis": platform,
  } };
}

export async function validateArtifacts(directory, { repo, tag, commit }) {
  const context = JSON.parse(await readFile(join(directory, "release-context.json"), "utf8"));
  if (context.tag !== tag || context.commit !== commit || context.repo !== repo) {
    throw new Error("产物的标签、提交或仓库与本次发布不一致");
  }
  validateReleaseRef(`refs/tags/${tag}`, context.version);
  if (!/^[a-f\d]{40}$/.test(commit) || !Number.isFinite(Date.parse(context.createdAt))) {
    throw new Error("产物提交或生成时间无效");
  }
  const installer = `FsTTY_${context.version}_x64-setup.exe`;
  const names = [installer, `${installer}.sig`, "latest.json"];
  if (!context.files || Object.keys(context.files).sort().join() !== [...names].sort().join()) {
    throw new Error("发布产物清单不完整");
  }
  const assets = [];
  for (const name of names) {
    const bytes = await readFile(join(directory, name));
    const expected = context.files[name];
    if (bytes.length === 0 || bytes.length !== expected.size || sha256(bytes) !== expected.sha256) {
      throw new Error(`发布产物校验失败：${name}`);
    }
    assets.push({ name, bytes, size: bytes.length, digest: `sha256:${sha256(bytes)}` });
  }
  const signature = assets[1].bytes.toString("utf8").trim();
  const manifest = JSON.parse(assets[2].bytes.toString("utf8"));
  const expected = createUpdateManifest({ ...context, installer, signature });
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
    throw new Error("更新元数据的版本、平台、地址或签名与安装包不一致");
  }
  return { context, assets };
}

async function collect() {
  const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  const tag = process.env.RELEASE_TAG;
  validateReleaseRef(`refs/tags/${tag}`, version);
  const commit = process.env.RELEASE_COMMIT;
  const actualCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (commit !== actualCommit) throw new Error("构建目录提交与发布提交不同");
  const repo = process.env.GITHUB_REPOSITORY;
  const notes = extractVersionReleaseNotes(await readFile(join(root, "CHANGELOG.md"), "utf8"), tag);
  const installer = `FsTTY_${version}_x64-setup.exe`;
  const source = resolve(root, process.env.CARGO_TARGET_DIR || "src-tauri/target", "release/bundle/nsis");
  const entries = await readdir(source);
  if (!entries.includes(installer) || !entries.includes(`${installer}.sig`)) throw new Error("缺少安装包或更新签名");
  // 读取 PE 版本资源，不执行安装包。
  const fileVersion = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "(Get-Item -LiteralPath $env:FSTTY_VERIFY_FILE).VersionInfo.ProductVersion"],
  { encoding: "utf8", env: { ...process.env, FSTTY_VERIFY_FILE: join(source, installer) } }).trim();
  if (fileVersion !== version && fileVersion !== `${version}.0`) throw new Error("安装包内嵌版本与标签不同");
  const signing = readAuthenticodeSettings(process.env, true);
  execFileSync(
    "powershell.exe",
    powershellAuthenticodeArgs(root, join(source, installer), signing, true),
    { cwd: root, stdio: "inherit" },
  );
  const directory = join(root, "artifacts/windows-release");
  await mkdir(directory, { recursive: true });
  await copyFile(join(source, installer), join(directory, installer));
  await copyFile(join(source, `${installer}.sig`), join(directory, `${installer}.sig`));
  const context = { repo, tag, commit, version, notes, createdAt: new Date().toISOString(), files: {} };
  const signature = await readFile(join(directory, `${installer}.sig`), "utf8");
  const manifest = createUpdateManifest({ ...context, installer, signature });
  await writeFile(join(directory, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const name of [installer, `${installer}.sig`, "latest.json"]) {
    const bytes = await readFile(join(directory, name));
    context.files[name] = { size: bytes.length, sha256: sha256(bytes) };
  }
  await writeFile(join(directory, "release-context.json"), `${JSON.stringify(context, null, 2)}\n`);
  await validateArtifacts(directory, { repo, tag, commit });
  console.log(`产物校验通过：${version}，提交 ${commit}`);
}

async function run() {
  switch (process.argv[2]) {
    case "prepare": {
      const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
      const tag = validateReleaseRef(process.env.GITHUB_REF, version);
      extractVersionReleaseNotes(await readFile(join(root, "CHANGELOG.md"), "utf8"), tag);
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      if (process.env.GITHUB_SHA !== commit) throw new Error("运行提交与检出提交不同");
      await appendFile(process.env.GITHUB_OUTPUT, `tag=${tag}\ncommit=${commit}\n`);
      break;
    }
    case "changes": {
      const before = process.env.BEFORE_COMMIT;
      // 首次推送或旧提交已不可达时无法可靠比较；此时保守预热。
      const diff = /^[a-f\d]{40}$/.test(before || "")
        ? spawnSync("git", ["diff", "--name-only", "-z", before, "HEAD"], { cwd: root, encoding: "utf8" })
        : null;
      const warm = !diff || diff.status !== 0 || affectsBuild(diff.stdout.split("\0"));
      await appendFile(process.env.GITHUB_OUTPUT, `warm=${warm}\n`);
      break;
    }
    case "collect":
      await collect();
      break;
    default:
      throw new Error("用法：node scripts/release-artifacts.mjs prepare|changes|collect");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run();
}
