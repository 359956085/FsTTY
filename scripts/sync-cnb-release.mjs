import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extractVersionReleaseNotes } from "./extract-release-notes.mjs";

const CNB_API_BASE = "https://api.cnb.cool";
const CNB_WEB_BASE = "https://cnb.cool";
const METADATA_TAG = "updater";

function encodeRepoPath(repo) {
  return repo
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function releaseDownloadUrl(repo, tag, fileName) {
  return `${CNB_WEB_BASE}/${encodeRepoPath(repo)}/-/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`;
}

export function rewriteCnbUpdateManifest(manifest, repo, tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`CNB 发布标签无效：${tag}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("latest.json 必须是对象");
  }
  if (typeof manifest.version !== "string" || !manifest.platforms) {
    throw new Error("latest.json 缺少版本或平台信息");
  }
  if (`v${manifest.version.replace(/^v/, "")}` !== tag) {
    throw new Error("latest.json 版本与发布标签不一致");
  }
  if (!Object.keys(manifest.platforms).some((platform) => platform.startsWith("windows-"))) {
    throw new Error("latest.json 缺少 Windows 平台");
  }

  const platforms = Object.fromEntries(
    Object.entries(manifest.platforms).map(([platform, item]) => {
      if (!item || typeof item !== "object" || typeof item.url !== "string") {
        throw new Error(`latest.json 平台 ${platform} 缺少下载地址`);
      }
      if (typeof item.signature !== "string" || !item.signature.trim()) {
        throw new Error(`latest.json 平台 ${platform} 缺少签名`);
      }
      const sourceUrl = new URL(item.url);
      if (sourceUrl.protocol !== "https:" || sourceUrl.hostname !== "github.com") {
        throw new Error(`latest.json 平台 ${platform} 包含非预期下载域名`);
      }
      const expectedPathPrefix = `/${repo}/releases/download/${tag}/`;
      if (!sourceUrl.pathname.startsWith(expectedPathPrefix)) {
        throw new Error(`latest.json 平台 ${platform} 包含非预期仓库或标签`);
      }
      const fileName = basename(decodeURIComponent(sourceUrl.pathname));
      if (!fileName || fileName === "." || fileName === "/") {
        throw new Error(`latest.json 平台 ${platform} 下载文件名无效`);
      }
      return [
        platform,
        {
          ...item,
          url: releaseDownloadUrl(repo, tag, fileName),
        },
      ];
    }),
  );
  return { ...manifest, platforms };
}

class CnbClient {
  constructor(token, fetchImpl = fetch) {
    if (!token) {
      throw new Error("缺少 CNB_TOKEN");
    }
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async request(path, options = {}, expectedStatuses = [200]) {
    const response = await this.fetchImpl(`${CNB_API_BASE}${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.cnb.api+json",
        Authorization: `Bearer ${this.token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
    if (!expectedStatuses.includes(response.status)) {
      const detail = await response.text();
      throw new Error(`CNB API ${options.method ?? "GET"} ${path} 失败（${response.status}）：${detail}`);
    }
    return response;
  }

  async ensureRelease(repo, { tag, commit, name, body, makeLatest }) {
    const repoPath = encodeRepoPath(repo);
    const tagPath = encodeURIComponent(tag);
    const existing = await this.request(
      `/${repoPath}/-/releases/tags/${tagPath}`,
      {},
      [200, 404],
    );
    if (existing.status === 200) {
      return existing.json();
    }
    const created = await this.request(
      `/${repoPath}/-/releases`,
      {
        method: "POST",
        body: JSON.stringify({
          body,
          draft: false,
          make_latest: makeLatest ? "true" : "false",
          name,
          prerelease: false,
          tag_name: tag,
          target_commitish: commit,
        }),
      },
      [201],
    );
    return created.json();
  }

  async uploadReleaseAsset(repo, releaseId, filePath, assetName = basename(filePath)) {
    const size = (await stat(filePath)).size;
    const repoPath = encodeRepoPath(repo);
    const uploadInfoResponse = await this.request(
      `/${repoPath}/-/releases/${encodeURIComponent(releaseId)}/asset-upload-url`,
      {
        method: "POST",
        body: JSON.stringify({ asset_name: assetName, overwrite: true, size, ttl: 0 }),
      },
      [201],
    );
    const uploadInfo = await uploadInfoResponse.json();
    const uploadUrl = new URL(uploadInfo.upload_url, CNB_API_BASE);
    const verifyUrl = new URL(uploadInfo.verify_url, CNB_API_BASE);
    if (uploadUrl.protocol !== "https:" || verifyUrl.origin !== CNB_API_BASE) {
      throw new Error("CNB 返回了非预期上传地址");
    }
    const uploadResponse = await this.fetchImpl(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: await readFile(filePath),
    });
    if (!uploadResponse.ok) {
      throw new Error(`上传 CNB Release 附件 ${assetName} 失败（${uploadResponse.status}）`);
    }
    await this.request(`${verifyUrl.pathname}${verifyUrl.search}`, { method: "POST" }, [200]);
  }
}

export async function syncCnbRelease({
  repo,
  tag,
  commit,
  assetsDirectory,
  changelog,
  token,
  fetchImpl = fetch,
}) {
  const client = new CnbClient(token, fetchImpl);
  const releaseBody = extractVersionReleaseNotes(changelog, tag);
  const release = await client.ensureRelease(repo, {
    tag,
    commit,
    name: `FsTTY ${tag}`,
    body: releaseBody,
    makeLatest: true,
  });
  const metadataRelease = await client.ensureRelease(repo, {
    tag: METADATA_TAG,
    commit,
    name: "FsTTY 自动更新元数据",
    body: "供 FsTTY 自动更新客户端读取的稳定元数据入口。",
    makeLatest: false,
  });

  const entries = await readdir(assetsDirectory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(assetsDirectory, entry.name));
  const latestPath = files.find((file) => basename(file) === "latest.json");
  if (!latestPath) {
    throw new Error("GitHub Release 缺少 latest.json");
  }
  const originalManifest = JSON.parse(await readFile(latestPath, "utf8"));
  const cnbManifest = rewriteCnbUpdateManifest(originalManifest, repo, tag);
  const assetNames = new Set(files.map((file) => basename(file)));
  for (const platform of Object.values(cnbManifest.platforms)) {
    const fileName = basename(new URL(platform.url).pathname);
    if (!assetNames.has(fileName)) {
      throw new Error(`GitHub Release 缺少更新包：${fileName}`);
    }
  }
  const cnbManifestPath = join(assetsDirectory, "latest-cnb.json");
  await writeFile(cnbManifestPath, `${JSON.stringify(cnbManifest, null, 2)}\n`, "utf8");

  for (const file of files.filter((file) => basename(file) !== "latest.json")) {
    await client.uploadReleaseAsset(repo, release.id, file);
  }
  await client.uploadReleaseAsset(repo, release.id, cnbManifestPath, "latest.json");
  await client.uploadReleaseAsset(repo, metadataRelease.id, cnbManifestPath, "latest.json");

  const manifestUrl = releaseDownloadUrl(repo, METADATA_TAG, "latest.json");
  const manifestResponse = await fetchImpl(manifestUrl, { redirect: "follow" });
  if (!manifestResponse.ok) {
    throw new Error(`CNB 匿名更新元数据验证失败（${manifestResponse.status}）`);
  }
  const publishedManifest = await manifestResponse.json();
  if (publishedManifest.version !== cnbManifest.version) {
    throw new Error("CNB 匿名更新元数据版本不一致");
  }
  const packageUrl = Object.values(cnbManifest.platforms)[0]?.url;
  const packageResponse = await fetchImpl(packageUrl, { method: "HEAD", redirect: "manual" });
  if (![200, 302].includes(packageResponse.status)) {
    throw new Error(`CNB 匿名更新包验证失败（${packageResponse.status}）`);
  }

  return {
    manifestUrl,
    releaseUrl: `${CNB_WEB_BASE}/${repo}/-/releases/tag/${encodeURIComponent(tag)}`,
  };
}

async function run() {
  const [repo, tag, commit, assetsDirectory = ".cnb-release"] = process.argv.slice(2);
  if (!repo || !tag || !commit) {
    throw new Error("用法：node scripts/sync-cnb-release.mjs <仓库> <标签> <提交> [附件目录]");
  }
  const result = await syncCnbRelease({
    repo,
    tag,
    commit,
    assetsDirectory: resolve(assetsDirectory),
    changelog: await readFile(resolve("CHANGELOG.md"), "utf8"),
    token: process.env.CNB_TOKEN,
  });
  process.stdout.write(`CNB Release 同步完成：${result.releaseUrl}\n更新元数据：${result.manifestUrl}\n`);
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
