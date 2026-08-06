import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewriteCnbUpdateManifest, syncCnbRelease } from "./sync-cnb-release.mjs";

const repo = "359956085/FsTTY";
const tag = "v1.2.1";
const changelog = `## [1.2.1] - 2026-08-06
<!-- release-notes:zh-CN:start -->
- 中文说明
<!-- release-notes:zh-CN:end -->
<!-- release-notes:en-US:start -->
- English notes
<!-- release-notes:en-US:end -->`;

function platform(signature, url) {
  return { signature, url };
}

async function withTempAssets(callback) {
  const directory = await mkdtemp(join(tmpdir(), "fstty-cnb-test-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectLocalValidationFailure(files, manifest, expectedMessage) {
  await withTempAssets(async (directory) => {
    for (const [fileName, content] of Object.entries(files)) {
      await writeFile(join(directory, fileName), content);
    }
    await writeFile(join(directory, "latest.json"), JSON.stringify(manifest));
    const fetchImpl = async () => {
      throw new Error("本地校验失败前不应请求网络");
    };
    await expect(
      syncCnbRelease({
        repo,
        tag,
        commit: "abc123",
        assetsDirectory: directory,
        changelog,
        token: "secret",
        fetchImpl,
      }),
    ).rejects.toThrow(expectedMessage);
  });
}

describe("CNB 更新元数据", () => {
  it("兼容 GitHub 页面下载地址", () => {
    const manifest = rewriteCnbUpdateManifest(
      {
        version: "1.2.1",
        notes: "说明",
        platforms: {
          "windows-x86_64": platform(
            "signed-value",
            "https://github.com/359956085/FsTTY/releases/download/v1.2.1/FsTTY_1.2.1_x64-setup.exe",
          ),
        },
      },
      repo,
      tag,
    );

    expect(manifest.platforms["windows-x86_64"]).toEqual({
      signature: "signed-value",
      url: "https://cnb.cool/359956085/FsTTY/-/releases/download/v1.2.1/FsTTY_1.2.1_x64-setup.exe",
    });
  });

  it("按签名把真实 GitHub API 资产地址映射为 MSI 与 EXE", () => {
    const manifest = rewriteCnbUpdateManifest(
      {
        version: "1.2.1",
        platforms: {
          "windows-x86_64": platform(
            "msi-signature",
            "https://api.github.com/repos/359956085/FsTTY/releases/assets/503736167",
          ),
          "windows-x86_64-msi": platform(
            "msi-signature",
            "https://api.github.com/repos/359956085/FsTTY/releases/assets/503736167",
          ),
          "windows-x86_64-nsis": platform(
            "exe-signature",
            "https://api.github.com/repos/359956085/FsTTY/releases/assets/503736184",
          ),
        },
      },
      repo,
      tag,
      new Map([
        ["msi-signature", "FsTTY_1.2.1_x64_en-US.msi"],
        ["exe-signature", "FsTTY_1.2.1_x64-setup.exe"],
      ]),
    );

    expect(manifest.platforms["windows-x86_64"].url).toContain(
      "/FsTTY_1.2.1_x64_en-US.msi",
    );
    expect(manifest.platforms["windows-x86_64-msi"].url).toContain(
      "/FsTTY_1.2.1_x64_en-US.msi",
    );
    expect(manifest.platforms["windows-x86_64-nsis"].url).toContain(
      "/FsTTY_1.2.1_x64-setup.exe",
    );
  });

  it("拒绝第三方域名、错误仓库和非数字资产 ID", () => {
    const rewrite = (url) =>
      rewriteCnbUpdateManifest(
        {
          version: "1.2.1",
          platforms: { "windows-x86_64": platform("signature", url) },
        },
        repo,
        tag,
        new Map([["signature", "app.exe"]]),
      );

    expect(() => rewrite("https://evil.example/app.exe")).toThrow("非预期下载域名");
    expect(() =>
      rewrite("https://api.github.com/repos/other/FsTTY/releases/assets/123"),
    ).toThrow("非预期仓库");
    expect(() =>
      rewrite("https://api.github.com/repos/359956085/FsTTY/releases/assets/not-a-number"),
    ).toThrow("非数字资产 ID");
  });

  it("拒绝缺失签名和非正式版本标签", () => {
    expect(() =>
      rewriteCnbUpdateManifest(
        {
          version: "1.2.1",
          platforms: {
            "windows-x86_64": {
              url: "https://github.com/359956085/FsTTY/releases/download/v1.2.1/app.exe",
            },
          },
        },
        repo,
        tag,
      ),
    ).toThrow("缺少签名");
    expect(() => rewriteCnbUpdateManifest({ version: "1", platforms: {} }, "a/b", "latest"))
      .toThrow("发布标签无效");
  });

  it("拒绝找不到匹配签名文件的 API 资产", async () => {
    await expectLocalValidationFailure(
      { "app.exe": "installer" },
      {
        version: "1.2.1",
        platforms: {
          "windows-x86_64": platform(
            "missing-signature",
            "https://api.github.com/repos/359956085/FsTTY/releases/assets/123",
          ),
        },
      },
      "找不到与更新签名匹配的安装包",
    );
  });

  it("拒绝签名内容映射多个安装包", async () => {
    await expectLocalValidationFailure(
      {
        "app.exe": "installer",
        "app.exe.sig": "same-signature\n",
        "app.msi": "installer",
        "app.msi.sig": "same-signature\n",
      },
      {
        version: "1.2.1",
        platforms: {
          "windows-x86_64": platform(
            "same-signature",
            "https://api.github.com/repos/359956085/FsTTY/releases/assets/123",
          ),
        },
      },
      "签名内容对应多个安装包",
    );
  });

  it("拒绝缺少对应安装包的签名文件", async () => {
    await expectLocalValidationFailure(
      { "app.exe.sig": "signature" },
      {
        version: "1.2.1",
        platforms: {
          "windows-x86_64": platform(
            "signature",
            "https://api.github.com/repos/359956085/FsTTY/releases/assets/123",
          ),
        },
      },
      "签名文件缺少对应安装包",
    );
  });

  it("上传安装包、签名和版本清单，并使用真实安装包文件名", async () => {
    await withTempAssets(async (directory) => {
      await writeFile(join(directory, "app.exe"), "installer");
      await writeFile(join(directory, "app.exe.sig"), "signed-value\n");
      await writeFile(
        join(directory, "latest.json"),
        JSON.stringify({
          version: "1.2.1",
          platforms: {
            "windows-x86_64": platform(
              "signed-value",
              "https://api.github.com/repos/359956085/FsTTY/releases/assets/503736184",
            ),
          },
        }),
      );
      const calls = [];
      const uploadedManifests = [];
      let releaseIndex = 0;
      const fetchImpl = async (url, options = {}) => {
        const requestUrl = String(url);
        calls.push({ url: requestUrl, method: options.method ?? "GET", body: options.body });
        if (requestUrl.includes("/releases/tags/")) {
          return new Response("", { status: 404 });
        }
        if (requestUrl.endsWith("/-/releases") && options.method === "POST") {
          releaseIndex += 1;
          return Response.json({ id: `release-${releaseIndex}` }, { status: 201 });
        }
        if (requestUrl.endsWith("/asset-upload-url")) {
          const { asset_name: assetName } = JSON.parse(options.body);
          return Response.json(
            {
              upload_url: `https://upload.cnb.test/${encodeURIComponent(assetName)}-${calls.length}`,
              verify_url: `/verify/${calls.length}`,
            },
            { status: 201 },
          );
        }
        if (requestUrl.startsWith("https://upload.cnb.test/")) {
          if (requestUrl.includes("latest.json-")) {
            uploadedManifests.push(JSON.parse(options.body.toString("utf8")));
          }
          return new Response("", { status: 200 });
        }
        if (requestUrl.startsWith("https://api.cnb.cool/verify/")) {
          return new Response("", { status: 200 });
        }
        if (requestUrl.endsWith("/updater/latest.json")) {
          return Response.json({ version: "1.2.1" });
        }
        if (options.method === "HEAD") {
          return new Response("", { status: 302 });
        }
        throw new Error(`未处理请求：${options.method ?? "GET"} ${url}`);
      };

      const result = await syncCnbRelease({
        repo,
        tag,
        commit: "abc123",
        assetsDirectory: directory,
        changelog,
        token: "secret",
        fetchImpl,
      });

      const uploadedAssetNames = calls
        .filter((call) => call.url.endsWith("/asset-upload-url"))
        .map((call) => JSON.parse(call.body).asset_name);
      expect(result.manifestUrl).toContain("/updater/latest.json");
      expect(uploadedAssetNames).toEqual(["app.exe", "app.exe.sig", "latest.json", "latest.json"]);
      expect(uploadedManifests).toHaveLength(2);
      expect(uploadedManifests[0].platforms["windows-x86_64"].url).toBe(
        "https://cnb.cool/359956085/FsTTY/-/releases/download/v1.2.1/app.exe",
      );
      expect(calls.filter((call) => call.url.endsWith("/-/releases") && call.method === "POST"))
        .toHaveLength(2);
    });
  });
});
