import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

export function resolveReleaseRun({ eventName, publishRequested, ref, defaultBranch, version }) {
  if (!["push", "workflow_dispatch"].includes(eventName)) {
    throw new Error("Windows 发布工作流的触发方式无效");
  }
  if (![undefined, null, "", true, false, "true", "false"].includes(publishRequested)) {
    throw new Error("publish 输入必须是布尔值");
  }
  const publish = publishRequested === true || publishRequested === "true";
  if (eventName === "workflow_dispatch" && !publish) {
    if (!defaultBranch || ref !== `refs/heads/${defaultBranch}`) {
      throw new Error(`无签名验证必须从默认分支 ${defaultBranch || "main"} 运行`);
    }
    return {
      mode: "validation",
      tag: validateReleaseRef(`refs/tags/v${version}`, version),
    };
  }
  return { mode: "release", tag: validateReleaseRef(ref, version) };
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

export async function validateValidationArtifacts(directory, { repo, commit, version, ref }) {
  const context = JSON.parse(await readFile(join(directory, "validation-context.json"), "utf8"));
  if (context.schema !== 1
      || context.purpose !== "unsigned-validation"
      || context.publishable !== false
      || context.authenticode !== false
      || context.updaterSignature !== false
      || context.repo !== repo
      || context.commit !== commit
      || context.version !== version
      || context.ref !== ref) {
    throw new Error("无签名验证产物上下文无效");
  }
  if (!/^[a-f\d]{40}$/.test(commit) || !Number.isFinite(Date.parse(context.createdAt))) {
    throw new Error("无签名验证产物提交或生成时间无效");
  }
  const installer = `FsTTY_${version}_x64-setup-UNSIGNED.exe`;
  const payloadNames = [installer, "VALIDATION-ONLY.txt"];
  const expectedEntries = [...payloadNames, "validation-context.json"].sort();
  const entries = (await readdir(directory)).sort();
  if (entries.join("\0") !== expectedEntries.join("\0")) {
    throw new Error("无签名验证目录包含缺失或非预期文件");
  }
  if (!context.files
      || Object.keys(context.files).sort().join("\0") !== [...payloadNames].sort().join("\0")) {
    throw new Error("无签名验证产物清单不完整");
  }
  for (const name of payloadNames) {
    const bytes = await readFile(join(directory, name));
    const expected = context.files[name];
    if (bytes.length === 0 || bytes.length !== expected.size || sha256(bytes) !== expected.sha256) {
      throw new Error(`无签名验证产物校验失败：${name}`);
    }
  }
  const warning = await readFile(join(directory, "VALIDATION-ONLY.txt"), "utf8");
  if (!warning.includes("UNSIGNED") || !warning.includes("未签名") || !warning.includes(commit)) {
    throw new Error("无签名验证警告内容不完整");
  }
  return context;
}

function readPeInformation(file) {
  const command = `
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $env:FSTTY_VERIFY_FILE
$signature = Get-AuthenticodeSignature -LiteralPath $env:FSTTY_VERIFY_FILE
[pscustomobject]@{
  ProductVersion = $item.VersionInfo.ProductVersion
  SignatureStatus = [string]$signature.Status
} | ConvertTo-Json -Compress
`;
  const output = execFileSync(
    "pwsh.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, FSTTY_VERIFY_FILE: file },
    },
  );
  return JSON.parse(output);
}

function verifyUnsignedExecutables(version, installer) {
  const files = [
    resolve(root, "src-tauri/target/broker-package/fstty-broker.exe"),
    resolve(root, process.env.CARGO_TARGET_DIR || "src-tauri/target", "release/fstty.exe"),
    installer,
  ];
  for (const file of files) {
    const information = readPeInformation(file);
    if (![version, `${version}.0`].includes(information.ProductVersion)) {
      throw new Error(`无签名验证程序版本不一致：${file}`);
    }
    if (information.SignatureStatus !== "NotSigned") {
      throw new Error(`无签名验证程序包含 Authenticode 签名：${file}`);
    }
  }
}

async function collectValidation() {
  if (process.env.FSTTY_RELEASE_MODE !== "validation"
      || process.env.FSTTY_REQUIRE_AUTHENTICODE === "1") {
    throw new Error("无签名验证产物只能由 validation 模式生成");
  }
  const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  validateReleaseRef(`refs/tags/${process.env.RELEASE_TAG}`, version);
  const commit = process.env.RELEASE_COMMIT;
  const actualCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (commit !== actualCommit) throw new Error("构建目录提交与验证提交不同");
  const repo = process.env.GITHUB_REPOSITORY;
  const ref = process.env.GITHUB_REF;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "") || !ref?.startsWith("refs/heads/")
      || !/^[a-f\d]{40}$/.test(commit || "")) {
    throw new Error("无签名验证仓库、分支或提交无效");
  }
  const originalName = `FsTTY_${version}_x64-setup.exe`;
  const source = resolve(root, process.env.CARGO_TARGET_DIR || "src-tauri/target", "release/bundle/nsis");
  const sourceInstaller = join(source, originalName);
  verifyUnsignedExecutables(version, sourceInstaller);

  const directory = join(root, "artifacts/windows-validation");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const installer = `FsTTY_${version}_x64-setup-UNSIGNED.exe`;
  await copyFile(sourceInstaller, join(directory, installer));
  const warning = `FsTTY 未签名验证产物 / FsTTY UNSIGNED validation artifact

仅用于 Windows Sandbox 或虚拟机中的安装验证，不得发布、分发或用于在线更新。
For installation testing in Windows Sandbox or a virtual machine only. Do not publish, distribute, or use for online updates.

Version: ${version}
Commit: ${commit}
`;
  await writeFile(join(directory, "VALIDATION-ONLY.txt"), warning);
  const context = {
    schema: 1,
    purpose: "unsigned-validation",
    publishable: false,
    authenticode: false,
    updaterSignature: false,
    repo,
    ref,
    commit,
    version,
    createdAt: new Date().toISOString(),
    files: {},
  };
  for (const name of [installer, "VALIDATION-ONLY.txt"]) {
    const bytes = await readFile(join(directory, name));
    context.files[name] = { size: bytes.length, sha256: sha256(bytes) };
  }
  await writeFile(join(directory, "validation-context.json"), `${JSON.stringify(context, null, 2)}\n`);
  await validateValidationArtifacts(directory, { repo, commit, version, ref });
  console.log(`无签名验证产物校验通过：${version}，提交 ${commit}`);
}

async function collect() {
  if (process.env.FSTTY_RELEASE_MODE !== "release"
      || process.env.FSTTY_REQUIRE_AUTHENTICODE !== "1") {
    throw new Error("正式发布产物只能由 release 签名模式生成");
  }
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
      const run = resolveReleaseRun({
        eventName: process.env.GITHUB_EVENT_NAME,
        publishRequested: process.env.FSTTY_PUBLISH_REQUESTED,
        ref: process.env.GITHUB_REF,
        defaultBranch: process.env.FSTTY_DEFAULT_BRANCH,
        version,
      });
      const tag = run.tag;
      extractVersionReleaseNotes(await readFile(join(root, "CHANGELOG.md"), "utf8"), tag);
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      if (process.env.GITHUB_SHA !== commit) throw new Error("运行提交与检出提交不同");
      await appendFile(process.env.GITHUB_OUTPUT, `tag=${tag}\ncommit=${commit}\nmode=${run.mode}\n`);
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
    case "collect-validation":
      await collectValidation();
      break;
    default:
      throw new Error("用法：node scripts/release-artifacts.mjs prepare|changes|collect|collect-validation");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run();
}
