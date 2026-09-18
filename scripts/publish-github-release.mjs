import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateArtifacts } from "./release-artifacts.mjs";

export async function publishGithubRelease({ directory, repo, tag, commit, token, fetchImpl = fetch }) {
  const { context, assets } = await validateArtifacts(directory, { repo, tag, commit });
  if (!token) throw new Error("缺少 GitHub 发布令牌");
  const base = `https://api.github.com/repos/${repo}`;
  async function request(url, method = "GET", body, binary = false, allowMissing = false) {
    const response = await fetchImpl(url, { method, redirect: "error", headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body === undefined ? {} : { "Content-Type": binary ? "application/octet-stream" : "application/json" }),
    }, ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }) });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub 发布请求失败：${method}（${response.status}）`);
    return response.status === 204 ? null : response.json();
  }
  const resolved = await request(`${base}/commits/${encodeURIComponent(tag)}`);
  if (resolved.sha !== commit) throw new Error("远程标签已移动，拒绝发布");
  let release = await request(`${base}/releases/tags/${encodeURIComponent(tag)}`, "GET", undefined, false, true);
  if (!release) {
    release = await request(`${base}/releases`, "POST", {
      tag_name: tag, target_commitish: commit, name: `FsTTY ${tag}`, body: context.notes,
      draft: true, prerelease: false,
    });
  }
  if (release.tag_name !== tag || release.prerelease) throw new Error("现有 Release 类型或标签不一致");
  const uploadBase = new URL(release.upload_url.replace(/\{.*$/, ""));
  if (uploadBase.origin !== "https://uploads.github.com" || uploadBase.pathname !== `/repos/${repo}/releases/${release.id}/assets`) {
    throw new Error("GitHub 返回了非预期上传地址");
  }
  let uploaded = await request(`${base}/releases/${release.id}/assets?per_page=100`);
  if (uploaded.some(asset => !assets.some(expected => expected.name === asset.name))) {
    throw new Error("现有 Release 含有非本次产物，拒绝覆盖");
  }
  for (const asset of assets) {
    const existing = uploaded.find(item => item.name === asset.name);
    if (existing?.state === "uploaded" && existing.size === asset.size && existing.digest === asset.digest) continue;
    // 正式发布过的附件不可替换；同步失败重试只能复用完全相同的产物。
    if (!release.draft) throw new Error(`正式 Release 附件不一致：${asset.name}`);
    if (existing) await request(`${base}/releases/assets/${existing.id}`, "DELETE");
    const url = new URL(uploadBase);
    url.searchParams.set("name", asset.name);
    await request(url.href, "POST", asset.bytes, true);
  }
  uploaded = await request(`${base}/releases/${release.id}/assets?per_page=100`);
  if (uploaded.length !== assets.length || new Set(uploaded.map(asset => asset.name)).size !== assets.length) {
    throw new Error("GitHub 附件数量或名称不符合发布清单");
  }
  for (const asset of assets) {
    const actual = uploaded.find(item => item.name === asset.name);
    if (!actual || actual.state !== "uploaded" || actual.size !== asset.size || actual.digest !== asset.digest) {
      throw new Error(`GitHub 附件校验失败：${asset.name}`);
    }
  }
  // 上传期间标签仍可能移动，正式发布前再次确认。
  if ((await request(`${base}/commits/${encodeURIComponent(tag)}`)).sha !== commit) throw new Error("上传期间远程标签发生变化");
  if (release.draft) {
    await request(`${base}/releases/${release.id}`, "PATCH", {
      name: `FsTTY ${tag}`, body: context.notes, draft: false, prerelease: false, make_latest: "true",
    });
  }
  return { context, assets, releaseId: release.id };
}

async function run() {
  const started = Date.now();
  const root = resolve(import.meta.dirname, "..");
  const { assets } = await publishGithubRelease({
    directory: resolve(root, "artifacts/windows-release"),
    repo: process.env.GITHUB_REPOSITORY, tag: process.env.RELEASE_TAG,
    commit: process.env.RELEASE_COMMIT, token: process.env.GITHUB_TOKEN,
  });
  const directory = resolve(root, "artifacts/release-assets");
  await mkdir(directory, { recursive: true });
  for (const asset of assets) await writeFile(join(directory, asset.name), asset.bytes);
  const line = `GitHub 产物上传与核对：${((Date.now() - started) / 1000).toFixed(1)} 秒`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run();
}
