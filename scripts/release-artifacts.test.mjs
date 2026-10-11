import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createUpdateManifest,
  resolveReleaseRun,
  sha256,
  validateArtifacts,
  validateReleaseRef,
  validateValidationArtifacts,
} from "./release-artifacts.mjs";
import { publishGithubRelease } from "./publish-github-release.mjs";

const repo = "example/FsTTY";
const tag = "v1.5.0";
const commit = "a".repeat(40);
const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(version = "1.5.0") {
  const directory = await mkdtemp(join(tmpdir(), "fstty-release-test-"));
  directories.push(directory);
  const installer = `FsTTY_${version}_x64-setup.exe`;
  const context = {
    repo,
    tag: `v${version}`,
    commit,
    version,
    channel: version.includes("-beta.") ? "beta" : "stable",
    notes: "中文说明\nEnglish notes",
    authenticode: false,
    updaterSignature: true,
    createdAt: "2026-09-18T00:00:00.000Z",
    files: {},
  };
  const manifest = context.channel === "stable" ? createUpdateManifest({ ...context, installer, signature: "test-signature" }) : null;
  const files = { [installer]: Buffer.from("生成的测试安装包"), [`${installer}.sig`]: Buffer.from("test-signature\n"), ...(manifest ? { "latest.json": Buffer.from(JSON.stringify(manifest)) } : {}) };
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

async function validationFixture() {
  const directory = await mkdtemp(join(tmpdir(), "fstty-validation-test-"));
  directories.push(directory);
  const version = "1.6.2";
  const ref = "refs/heads/main";
  const installer = `FsTTY_${version}_x64-setup-UNSIGNED.exe`;
  const files = {
    [installer]: Buffer.from("未签名测试安装包"),
    "VALIDATION-ONLY.txt": Buffer.from(`FsTTY 未签名 / UNSIGNED\nCommit: ${commit}\n`),
  };
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
    createdAt: "2026-09-19T00:00:00.000Z",
    files: {},
  };
  async function save() {
    context.files = {};
    for (const [name, bytes] of Object.entries(files)) {
      await writeFile(join(directory, name), bytes);
      context.files[name] = { size: bytes.length, sha256: sha256(bytes) };
    }
    await writeFile(join(directory, "validation-context.json"), JSON.stringify(context));
  }
  await save();
  return { directory, context, files, installer, ref, save, version };
}

function github({ failUpload = 0, live = false, moved = false, corrupt = false, releaseTag = tag, prerelease = false } = {}) {
  const assets = [];
  const calls = [];
  let release = live ? { id: 1, tag_name: releaseTag, draft: false, prerelease, upload_url: `https://uploads.github.com/repos/${repo}/releases/1/assets{?name,label}` } : null;
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
  it("beta 标签保持完整版本且拒绝非法序号、其他预发布及错配", () => {
    expect(validateReleaseRef("refs/tags/v2.1.0-beta.1", "2.1.0-beta.1")).toBe("v2.1.0-beta.1");
    for (const version of ["2.1.0-beta", "2.1.0-beta.0", "2.1.0-beta.01", "2.1.0-rc.1", "2.1.0+build", "02.1.0"]) {
      expect(() => validateReleaseRef(`refs/tags/v${version}`, version)).toThrow();
    }
    expect(() => validateReleaseRef("refs/tags/v2.1.0", "2.1.0-beta.1")).toThrow("版本一致");
    for (const eventName of ["push", "workflow_dispatch"]) {
      expect(resolveReleaseRun({ eventName, publishRequested: true, ref: "refs/tags/v2.1.0-beta.1", version: "2.1.0-beta.1" }))
        .toEqual({ mode: "release", tag: "v2.1.0-beta.1" });
    }
  });

  it("beta 发布无更新清单，预发布不成为 Latest，失败重跑复用附件", async () => {
    const data = await fixture("2.1.0-beta.1");
    const api = github({ failUpload: 2 });
    const options = { directory: data.directory, repo, tag: data.context.tag, commit, token: "test", fetchImpl: api.fetchImpl };
    await expect(publishGithubRelease(options)).rejects.toThrow("500");
    expect(api.release).toMatchObject({ draft: true, prerelease: true, make_latest: "false" });
    await publishGithubRelease(options);
    expect(api.release).toMatchObject({ draft: false, prerelease: true, make_latest: "false" });
    expect(api.assets.map(asset => asset.name)).toEqual(Object.keys(data.files));
    expect(api.assets.some(asset => asset.name === "latest.json")).toBe(false);
    const count = api.calls.length;
    await publishGithubRelease(options);
    expect(api.calls.slice(count).every(call => call.method === "GET")).toBe(true);
    expect(() => createUpdateManifest({ ...data.context, installer: Object.keys(data.files)[0], signature: "test" })).toThrow("Beta");
  });

  it("beta 拒绝残留清单、缺少签名、产物类型及远程类型不一致", async () => {
    const data = await fixture("2.1.0-beta.1");
    const options = { directory: data.directory, repo, tag: data.context.tag, commit };
    await writeFile(join(data.directory, "latest.json"), "{}");
    await expect(validateArtifacts(data.directory, options)).rejects.toThrow("latest.json");
    await rm(join(data.directory, "latest.json"));
    data.context.channel = "stable";
    await data.save();
    await expect(validateArtifacts(data.directory, options)).rejects.toThrow("版本类型");
    data.context.channel = "beta";
    await data.save();
    const api = github({ live: true, releaseTag: data.context.tag });
    await expect(publishGithubRelease({ ...options, token: "test", fetchImpl: api.fetchImpl })).rejects.toThrow("Release 类型");
    await rm(join(data.directory, `FsTTY_${data.context.version}_x64-setup.exe.sig`));
    await expect(validateArtifacts(data.directory, options)).rejects.toThrow();
  });

  it("拒绝分支、版本不匹配和非正式版本标签", () => {
    expect(validateReleaseRef("refs/tags/v1.5.0", "1.5.0")).toBe(tag);
    for (const ref of ["refs/heads/main", "refs/tags/v1.4.0", "refs/tags/v1.5.0-beta"]) {
      expect(() => validateReleaseRef(ref, "1.5.0")).toThrow();
    }
  });

  it("手动非发布运行使用默认分支无签名验证，其他运行保持正式发布", () => {
    expect(resolveReleaseRun({
      eventName: "workflow_dispatch",
      publishRequested: "false",
      ref: "refs/heads/main",
      defaultBranch: "main",
      version: "1.6.2",
    })).toEqual({ mode: "validation", tag: "v1.6.2" });
    for (const configuration of [
      { eventName: "push", publishRequested: "", ref: "refs/tags/v1.6.2" },
      { eventName: "workflow_dispatch", publishRequested: "true", ref: "refs/tags/v1.6.2" },
    ]) {
      expect(resolveReleaseRun({ ...configuration, defaultBranch: "main", version: "1.6.2" }))
        .toEqual({ mode: "release", tag: "v1.6.2" });
    }
  });

  it("无签名验证拒绝标签和非默认分支，正式发布拒绝普通分支", () => {
    for (const ref of ["refs/tags/v1.6.2", "refs/heads/feature"]) {
      expect(() => resolveReleaseRun({
        eventName: "workflow_dispatch",
        publishRequested: false,
        ref,
        defaultBranch: "main",
        version: "1.6.2",
      })).toThrow("默认分支 main");
    }
    expect(() => resolveReleaseRun({
      eventName: "workflow_dispatch",
      publishRequested: true,
      ref: "refs/heads/main",
      defaultBranch: "main",
      version: "1.6.2",
    })).toThrow("版本一致");
  });

  it("检查签名、完整清单、文件哈希及当前提交", async () => {
    const data = await fixture();
    expect((await validateArtifacts(data.directory, { repo, tag, commit })).assets).toHaveLength(3);
    data.context.authenticode = true;
    await writeFile(join(data.directory, "release-context.json"), JSON.stringify(data.context));
    await expect(validateArtifacts(data.directory, { repo, tag, commit })).rejects.toThrow("不一致");
    data.context.authenticode = false;
    await data.save();
    await expect(validateArtifacts(data.directory, { repo, tag, commit: "b".repeat(40) })).rejects.toThrow("不一致");
    await writeFile(join(data.directory, "FsTTY_1.5.0_x64-setup.exe"), "被替换");
    await expect(validateArtifacts(data.directory, { repo, tag, commit })).rejects.toThrow("校验失败");
    await data.save();
    await rm(join(data.directory, "FsTTY_1.5.0_x64-setup.exe.sig"));
    await expect(validateArtifacts(data.directory, { repo, tag, commit })).rejects.toThrow();
  });

  it("无签名验证产物使用独立清单且不能作为正式发布产物", async () => {
    const data = await validationFixture();
    const expected = { repo, commit, version: data.version, ref: data.ref };
    expect((await validateValidationArtifacts(data.directory, expected)).publishable).toBe(false);
    await expect(validateArtifacts(data.directory, { repo, tag: `v${data.version}`, commit }))
      .rejects.toThrow();

    await writeFile(join(data.directory, data.installer), "被替换");
    await expect(validateValidationArtifacts(data.directory, expected)).rejects.toThrow("校验失败");
    await data.save();
    await writeFile(join(data.directory, "latest.json"), "{}");
    await expect(validateValidationArtifacts(data.directory, expected)).rejects.toThrow("非预期文件");
    await rm(join(data.directory, "latest.json"));
    data.context.publishable = true;
    await writeFile(join(data.directory, "validation-context.json"), JSON.stringify(data.context));
    await expect(validateValidationArtifacts(data.directory, expected)).rejects.toThrow("上下文无效");
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
    expect(api.release).toMatchObject({ prerelease: false, make_latest: "true" });
    expect(api.release.body).toBe(data.context.notes);
    const create = api.calls.find(call => call.method === "POST" && call.path.endsWith("/releases"));
    expect(JSON.parse(create.body).draft).toBe(true);
    expect(JSON.parse(create.body)).not.toHaveProperty("make_latest");
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

});
