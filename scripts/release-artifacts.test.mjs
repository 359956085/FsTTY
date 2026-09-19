import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { affectsBuild, createUpdateManifest, sha256, validateArtifacts, validateReleaseRef } from "./release-artifacts.mjs";
import { publishGithubRelease } from "./publish-github-release.mjs";

const repo = "example/FsTTY";
const tag = "v1.5.0";
const commit = "a".repeat(40);
const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "fstty-release-test-"));
  directories.push(directory);
  const installer = "FsTTY_1.5.0_x64-setup.exe";
  const context = { repo, tag, commit, version: "1.5.0", notes: "中文说明\nEnglish notes", createdAt: "2026-09-18T00:00:00.000Z", files: {} };
  const manifest = createUpdateManifest({ ...context, installer, signature: "test-signature" });
  const files = { [installer]: Buffer.from("生成的测试安装包"), [`${installer}.sig`]: Buffer.from("test-signature\n"), "latest.json": Buffer.from(JSON.stringify(manifest)) };
  async function save() {
    for (const [name, bytes] of Object.entries(files)) {
      await writeFile(join(directory, name), bytes);
      context.files[name] = { size: bytes.length, sha256: sha256(bytes) };
    }
    await writeFile(join(directory, "release-context.json"), JSON.stringify(context));
  }
  await save();
  return { directory, context, files, manifest, save };
}

function github({ failUpload = 0, live = false, moved = false, corrupt = false } = {}) {
  const assets = [];
  const calls = [];
  let release = live ? { id: 1, tag_name: tag, draft: false, prerelease: false, upload_url: `https://uploads.github.com/repos/${repo}/releases/1/assets{?name,label}` } : null;
  let uploads = 0;
  let resolves = 0;
  const fetchImpl = async (address, options) => {
    const url = new URL(address);
    calls.push({ path: url.pathname, method: options.method, body: options.body });
    const response = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status });
    if (url.pathname.includes("/commits/")) return response({ sha: moved && ++resolves > 1 ? "b".repeat(40) : commit });
    if (url.pathname.includes("/releases/tags/")) return release ? response(release) : response({}, 404);
    if (options.method === "POST" && url.origin === "https://uploads.github.com") {
      if (++uploads === failUpload) return response({}, 500);
      assets.push({ id: assets.length + 10, name: url.searchParams.get("name"), state: "uploaded", size: options.body.length, digest: corrupt ? "sha256:bad" : `sha256:${sha256(options.body)}` });
      return response(assets.at(-1), 201);
    }
    if (options.method === "POST") {
      release = { ...JSON.parse(options.body), id: 1, upload_url: `https://uploads.github.com/repos/${repo}/releases/1/assets{?name,label}` };
      return response(release, 201);
    }
    if (options.method === "DELETE") {
      assets.splice(assets.findIndex(asset => asset.id === Number(url.pathname.split("/").at(-1))), 1);
      return response(null, 204);
    }
    if (options.method === "PATCH") {
      Object.assign(release, JSON.parse(options.body));
      return response(release);
    }
    return response(assets);
  };
  return { assets, calls, fetchImpl, get release() { return release; } };
}

describe("发布产物与恢复", () => {
  it("拒绝分支、版本不匹配和非正式版本标签", () => {
    expect(validateReleaseRef("refs/tags/v1.5.0", "1.5.0")).toBe(tag);
    for (const ref of ["refs/heads/main", "refs/tags/v1.4.0", "refs/tags/v1.5.0-beta"]) {
      expect(() => validateReleaseRef(ref, "1.5.0")).toThrow();
    }
  });

  it("仅构建输入变更触发预热", () => {
    expect(affectsBuild(["README.md", "docs/windows-release-ci.md", "CHANGELOG.md"])).toBe(false);
    for (const file of ["src/App.tsx", "src-tauri/Cargo.lock", "public/icon.png", "scripts/build-broker.mjs", ".github/workflows/quality.yml", "package-lock.json", "vite.config.ts", "tsconfig.json"]) {
      expect(affectsBuild([file])).toBe(true);
    }
  });

  it("检查签名、完整清单、文件哈希及当前提交", async () => {
    const data = await fixture();
    expect((await validateArtifacts(data.directory, { repo, tag, commit })).assets).toHaveLength(3);
    await expect(validateArtifacts(data.directory, { repo, tag, commit: "b".repeat(40) })).rejects.toThrow("不一致");
    await writeFile(join(data.directory, "FsTTY_1.5.0_x64-setup.exe"), "被替换");
    await expect(validateArtifacts(data.directory, { repo, tag, commit })).rejects.toThrow("校验失败");
    await data.save();
    await rm(join(data.directory, "FsTTY_1.5.0_x64-setup.exe.sig"));
    await expect(validateArtifacts(data.directory, { repo, tag, commit })).rejects.toThrow();
  });

  it.each(["url", "signature", "platform", "version"])("即使清单哈希被重写也拒绝错误元数据：%s", async field => {
    const data = await fixture();
    if (field === "platform") delete data.manifest.platforms["windows-x86_64-nsis"];
    else if (field === "version") data.manifest.version = "1.4.0";
    else data.manifest.platforms["windows-x86_64"][field] = "错误值";
    data.files["latest.json"] = Buffer.from(JSON.stringify(data.manifest));
    await data.save();
    await expect(validateArtifacts(data.directory, { repo, tag, commit })).rejects.toThrow("更新元数据");
  });

  it("创建草稿，核对全部附件后正式发布，并保留双语说明", async () => {
    const data = await fixture();
    const api = github();
    await publishGithubRelease({ directory: data.directory, repo, tag, commit, token: "test", fetchImpl: api.fetchImpl });
    expect(api.assets).toHaveLength(3);
    expect(api.release.draft).toBe(false);
    expect(api.release.body).toBe(data.context.notes);
    const create = api.calls.find(call => call.method === "POST" && call.path.endsWith("/releases"));
    expect(JSON.parse(create.body).draft).toBe(true);
    expect(api.calls.at(-1).method).toBe("PATCH");
  });

  it("上传失败保留草稿，重试复用已上传附件；正式发布后重试不修改附件", async () => {
    const data = await fixture();
    const api = github({ failUpload: 2 });
    const options = { directory: data.directory, repo, tag, commit, token: "test", fetchImpl: api.fetchImpl };
    await expect(publishGithubRelease(options)).rejects.toThrow("500");
    expect(api.release.draft).toBe(true);
    expect(api.calls.some(call => call.method === "PATCH")).toBe(false);
    await publishGithubRelease(options);
    expect(api.assets).toHaveLength(3);
    const count = api.calls.length;
    await publishGithubRelease(options);
    expect(api.calls.slice(count).every(call => call.method === "GET")).toBe(true);
  });

  it.each([{ corrupt: true }, { moved: true }, { live: true }])("附件损坏、标签移动或正式附件不一致均不能发布：%j", async configuration => {
    const data = await fixture();
    const api = github(configuration);
    await expect(publishGithubRelease({ directory: data.directory, repo, tag, commit, token: "test", fetchImpl: api.fetchImpl })).rejects.toThrow();
    expect(api.calls.some(call => call.method === "PATCH")).toBe(false);
  });

  it("验证与构建并行，发布同时依赖两者；预热不访问发布密钥", async () => {
    const workflow = await readFile(new URL("../.github/workflows/release-windows.yml", import.meta.url), "utf8");
    expect(workflow).toContain("needs: [prepare, verify, build]");
    expect(workflow.match(/needs: prepare/g)).toHaveLength(2);
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).not.toContain("tauri-apps/tauri-action");
    expect(workflow).toContain("secrets.WINDOWS_CERTIFICATE");
    expect(workflow).toContain("secrets.WINDOWS_CERTIFICATE_PASSWORD");
    expect(workflow).toContain("vars.WINDOWS_TIMESTAMP_URL");
    const brokerSignature = workflow.indexOf("ci-build.mjs authenticode-broker");
    const bundle = workflow.indexOf("ci-build.mjs bundle");
    const authenticodeVerification = workflow.indexOf("ci-build.mjs verify-authenticode");
    const updaterSignature = workflow.indexOf("ci-build.mjs sign");
    expect(brokerSignature).toBeGreaterThan(0);
    expect(brokerSignature).toBeLessThan(bundle);
    expect(bundle).toBeLessThan(authenticodeVerification);
    expect(authenticodeVerification).toBeLessThan(updaterSignature);
    const quality = await readFile(new URL("../.github/workflows/quality.yml", import.meta.url), "utf8");
    const warm = quality.slice(quality.indexOf("\n  warm:"));
    expect(warm).not.toContain("secrets.");
    expect(warm).not.toMatch(/ci-build\.mjs (bundle|sign)/);
  });
});
